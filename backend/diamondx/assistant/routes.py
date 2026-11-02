"""Assistant conversations, month reviews, and confirming or rejecting proposals (port of server/assistant/routes.ts).

Confirming re-checks a proposal against the current data, so a stale proposal fails instead of acting.
"""

from __future__ import annotations

import json
import logging

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ..ai.client import AiUnavailableError
from ..core.context import api_router
from ..core.db import Pool
from ..core.http import ApiError, CurrentUser, body, is_uuid, iso, require_roles, require_user
from ..core.numbers import js_number, round_to
from ..modules.banking.bank import current_suggestion, match_bank_line
from ..modules.collections.reminders import create_reminder_draft
from ..modules.invoices.payments import record_payment
from ..modules.tax.closed_months import parse_month
from ..modules.tax.tax import close_month
from .agent import SessionFullError, run_turn
from .review import run_review
from .tools import CONFIRM_ROLES, TAX_READERS, month_close_check

log = logging.getLogger("diamondx.assistant")

MAX_MESSAGE_LENGTH = 2000
ACTION_COLUMNS = "id, kind, status, payload, result, created_at"


def to_action(row) -> dict:
    action = {"id": row["id"], "kind": row["kind"], "status": row["status"], "payload": row["payload"], "createdAt": iso(row["created_at"])}
    if row["result"] is not None:
        action["result"] = row["result"]
    return action


async def own_session(pool: Pool, session_id: str, user: CurrentUser):
    if not is_uuid(session_id):
        return None
    return await pool.fetchrow("SELECT id, created_at FROM assistant_sessions WHERE id = $1 AND organization_id = $2 AND user_id = $3",
                               session_id, user.organization_id, user.id)


async def own_action(pool: Pool, action_id: str, user: CurrentUser):
    if not is_uuid(action_id):
        return None
    return await pool.fetchrow(
        f"""SELECT a.{ACTION_COLUMNS.replace(', ', ', a.')}
            FROM assistant_actions a JOIN assistant_sessions s ON s.id = a.session_id
            WHERE a.id = $1 AND a.organization_id = $2 AND s.organization_id = $2 AND s.user_id = $3""",
        action_id, user.organization_id, user.id,
    )


async def paid_so_far(pool: Pool, invoice_id: str, organization_id: str) -> dict | None:
    if not is_uuid(invoice_id):
        return None
    row = await pool.fetchrow(
        """SELECT i.status, COALESCE((SELECT SUM(amount_usd) FROM payments WHERE invoice_id = i.id), 0) AS paid
           FROM invoices i WHERE i.id = $1 AND i.organization_id = $2""",
        invoice_id, organization_id,
    )
    return {"status": row["status"], "paidUsd": round_to(float(row["paid"]), 2)} if row else None


def visible_text(content) -> str:
    parts = (content or {}).get("parts") or [] if isinstance(content, dict) else []
    return "".join(p["text"] for p in parts if isinstance(p.get("text"), str) and not p.get("thought")).strip()


CHANGED = "This invoice has changed since the assistant proposed this. Ask the assistant again for an up-to-date proposal."


async def execute(pool: Pool, user: CurrentUser, action, drafter) -> dict:
    """{"ok": True, "result": ...} or {"ok": False, "error": ...}."""
    payload = action["payload"] or {}
    if action["kind"] == "close_month":
        month = parse_month(payload.get("month"))
        if not month:
            return {"ok": False, "error": "This proposal has no valid month."}
        check = await month_close_check(pool, user.organization_id, month)
        if not check["ok"]:
            return {"ok": False, "error": check["error"]}
        await close_month(pool, user.organization_id, month, user.id)
        return {"ok": True, "result": {"month": month, "closed": True}}

    invoice_id = str(payload.get("invoiceId") or "")
    current = await paid_so_far(pool, invoice_id, user.organization_id)
    if not current:
        return {"ok": False, "error": "This invoice no longer exists."}
    if current["status"] != "issued" or current["paidUsd"] != js_number(payload.get("paidUsdAtProposal")):
        return {"ok": False, "error": CHANGED}

    if action["kind"] == "record_payment":
        outcome = await record_payment(pool, user, invoice_id, {k: payload.get(k) for k in ("amountUsd", "paidOn", "reference")}, within_balance=True)
        if not outcome.ok:
            return {"ok": False, "error": outcome.error}
        state = outcome.state
        return {"ok": True, "result": {"invoiceStatus": state["status"], "paidUsd": state["paidUsd"], "dueUsd": state["dueUsd"]}}

    if action["kind"] == "match_bank_line":
        line_id = str(payload.get("lineId") or "")
        if not is_uuid(line_id) or not await current_suggestion(pool, user.organization_id, line_id, invoice_id):
            return {"ok": False, "error": "This bank line or invoice has changed since the assistant proposed this. "
                                          "Ask the assistant again for an up-to-date proposal."}
        outcome = await match_bank_line(pool, user, line_id, invoice_id)
        if not outcome.ok:
            return {"ok": False, "error": outcome.error}
        return {"ok": True, "result": {"invoiceStatus": outcome.status, "dueUsd": outcome.due_usd}}

    try:
        draft = await create_reminder_draft(pool, user, drafter, invoice_id, confirm_repeat=True)
    except ApiError as error:
        return {"ok": False, "error": error.message}
    return {"ok": True, "result": {"reminderId": draft["id"], "subject": draft["fullSubject"]}}


def build_router():
    router = api_router(prefix="/api/assistant")

    @router.post("/sessions")
    async def new_session(request: Request, user: CurrentUser = Depends(require_user)):
        row = await request.app.state.pool.fetchrow(
            "INSERT INTO assistant_sessions (organization_id, user_id) VALUES ($1, $2) RETURNING id, created_at", user.organization_id, user.id
        )
        return JSONResponse({"id": row["id"], "createdAt": iso(row["created_at"]), "messages": [], "actions": []}, status_code=201)

    @router.get("/sessions/{session_id}")
    async def get_session(session_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        session = await own_session(pool, session_id, user)
        if not session:
            raise ApiError(404, "Conversation not found.")
        messages = await pool.fetch(
            """SELECT id, role, content, created_at FROM assistant_messages
               WHERE session_id = $1 AND role IN ('user', 'model') ORDER BY created_at, id""",
            session["id"],
        )
        actions = await pool.fetch(
            f"SELECT {ACTION_COLUMNS} FROM assistant_actions WHERE session_id = $1 AND organization_id = $2 ORDER BY created_at",
            session["id"], user.organization_id,
        )
        shown = [{"id": m["id"], "role": m["role"], "text": visible_text(m["content"]), "createdAt": iso(m["created_at"])} for m in messages]
        return {"id": session["id"], "createdAt": iso(session["created_at"]), "messages": [m for m in shown if m["text"]],
                "actions": [to_action(a) for a in actions]}

    @router.post("/sessions/{session_id}/messages")
    async def ask(session_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        session = await own_session(pool, session_id, user)
        if not session:
            raise ApiError(404, "Conversation not found.")
        data = body(request)
        text = data["text"].strip() if isinstance(data.get("text"), str) else ""
        if not text:
            raise ApiError(400, "Type a question for the assistant.")
        if len(text) > MAX_MESSAGE_LENGTH:
            raise ApiError(400, f"Keep questions under {MAX_MESSAGE_LENGTH} characters.")
        try:
            return await run_turn(pool, user, session["id"], request.app.state.options.assistant_model, text)
        except AiUnavailableError as error:
            raise ApiError(503, error.message, reason=error.reason) from None
        except SessionFullError as error:
            raise ApiError(409, str(error), sessionFull=True) from None
        except ApiError:
            raise
        except Exception as error:
            if isinstance(getattr(error, "status", None), int):
                raise ApiError(502, "The AI service returned an error. Try again in a moment.") from None
            raise

    @router.post("/reviews")
    async def review(request: Request, user: CurrentUser = Depends(require_roles(*TAX_READERS))):
        month = parse_month(body(request).get("month"))
        if not month:
            raise ApiError(400, "Choose a month like 2026-10.")
        result = await run_review(request.app.state.pool, user, request.app.state.options.assistant_model, month)
        return JSONResponse(result, status_code=201)

    @router.post("/actions/{action_id}/confirm")
    async def confirm(action_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        action = await own_action(pool, action_id, user)
        if not action:
            raise ApiError(404, "Proposal not found.")
        if user.role not in CONFIRM_ROLES[action["kind"]]:
            raise ApiError(403, "Your role cannot confirm this kind of proposal.")
        claimed = await pool.execute(
            "UPDATE assistant_actions SET status = 'confirmed', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'proposed'",
            action["id"], user.id,
        )
        if claimed == "UPDATE 0":
            raise ApiError(409, f"This proposal was already {action['status']}.")
        try:
            outcome = await execute(pool, user, action, request.app.state.options.draft_reminder_text)
        except Exception:
            await pool.execute("UPDATE assistant_actions SET status = 'failed', result = $2 WHERE id = $1", action["id"], {"error": "Something went wrong."})
            raise
        saved = await pool.fetchrow(
            f"UPDATE assistant_actions SET status = $2, result = $3 WHERE id = $1 RETURNING {ACTION_COLUMNS}",
            action["id"], "confirmed" if outcome["ok"] else "failed", outcome["result"] if outcome["ok"] else {"error": outcome["error"]},
        )
        log.info(json.dumps({"event": "assistant_action_decided", "kind": action["kind"], "status": saved["status"], "organizationId": user.organization_id}))
        if not outcome["ok"]:
            return JSONResponse({"error": outcome["error"], "action": to_action(saved)}, status_code=409)
        return {"action": to_action(saved)}

    @router.post("/actions/{action_id}/reject")
    async def reject(action_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        action = await own_action(pool, action_id, user)
        if not action:
            raise ApiError(404, "Proposal not found.")
        saved = await pool.fetchrow(
            f"""UPDATE assistant_actions SET status = 'rejected', decided_by = $2, decided_at = now()
                WHERE id = $1 AND status = 'proposed' RETURNING {ACTION_COLUMNS}""",
            action["id"], user.id,
        )
        if not saved:
            raise ApiError(409, f"This proposal was already {action['status']}.")
        return {"action": to_action(saved)}

    return router
