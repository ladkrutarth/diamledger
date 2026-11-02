"""Tax and regulatory notices, with replies drafted from the records (port of server/modules/tax/notices.ts).

As with the assistant, a drafted reply whose amounts are not in the facts is replaced by a template
written from the records.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...ai.call import ModelCallContext, call_model
from ...ai.client import TokenUsage, active_model_name, ai_provider, gemini_generate, gemini_text, usage_from
from ...ai.huggingface import hf_json
from ...assistant.grounding import is_grounded
from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import days_between, form_reader, iso_today
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, require_roles
from ...core.numbers import js_json, money, to_fixed

NOTICE_PROMPT_VERSION = "notice-reply-v1"
AUTHORITIES = ("gst", "income_tax", "customs", "dgft", "rbi", "other")
STATUSES = ("open", "replied", "closed")
AUTHORITY_LABELS = {
    "gst": "GST department",
    "income_tax": "Income Tax department",
    "customs": "Customs",
    "dgft": "DGFT",
    "rbi": "RBI / AD bank",
    "other": "Other authority",
}

# (facts) -> {"paragraphs": [...], "usage"?}
DraftNoticeReply = Callable[[dict], Awaitable[dict[str, Any]]]

SYSTEM_PROMPT = """You draft a formal reply from an Indian diamond exporter to a tax or regulatory notice.
Use only the facts given: the notice details, and the export invoices with their shipping bills and bank realization (BRC).
Never invent an amount, date, number, section, or document that is not in the facts. If something needed is missing, say the
company will furnish it, and name what it is. Write in plain, respectful English, in short paragraphs, starting with the subject
of the notice and ending before the sign-off (the system adds the signature). Do not give legal opinions; state facts and enclosures."""


async def gemini_notice_reply(facts: dict) -> dict:
    response = await gemini_generate(
        {
            "contents": [{"role": "user", "parts": [{"text": f"Facts (JSON):\n{js_json(facts, 2)}"}]}],
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "OBJECT",
                    "properties": {"paragraphs": {"type": "ARRAY", "items": {"type": "STRING"}}},
                    "required": ["paragraphs"],
                },
            },
        }
    )
    return {**json.loads(gemini_text(response) or "{}"), "usage": usage_from(response.get("usageMetadata"))}


async def default_notice_reply(facts: dict) -> dict:
    if ai_provider() != "huggingface":
        return await gemini_notice_reply(facts)
    value, usage = await hf_json(SYSTEM_PROMPT, f"Facts (JSON):\n{js_json(facts, 2)}", '{"paragraphs": string[]}')
    return {**(value if isinstance(value, dict) else {}), "usage": usage}


def parse_reply(value: Any) -> list[str] | None:
    if not isinstance(value, dict) or not isinstance(value.get("paragraphs"), list):
        return None
    paragraphs = value["paragraphs"]
    if not 1 <= len(paragraphs) <= 12 or not all(isinstance(p, str) for p in paragraphs):
        return None
    trimmed = [p.strip() for p in paragraphs]
    return trimmed if all(1 <= len(p) <= 2000 for p in trimmed) else None


def _usd(value: float) -> str:
    return f"USD {to_fixed(value, 2)}"


def template_notice_reply(facts: dict) -> list[str]:
    """A reply written from the facts alone, used when the model is unavailable or its draft cannot be trusted."""
    subject = ", ".join(
        part for part in (
            facts["formType"],
            facts["referenceNo"] and f"reference {facts['referenceNo']}",
            facts["issuedOn"] and f"dated {facts['issuedOn']}",
        ) if part
    )
    period = f" for the period {facts['period']}" if facts["period"] else ""
    gstin = f" (GSTIN {facts['gstin']})" if facts["gstin"] else ""
    paragraphs = [
        f"Subject: Reply to {subject or 'your notice'}{period}.",
        f"With reference to the above, {facts['companyName'] or 'we'}{gstin} submit the following for your kind consideration.",
    ]
    if facts["invoices"]:
        paragraphs.append("The exports in question are listed below with their shipping bills and bank realization:")
        for invoice in facts["invoices"]:
            country = f", {invoice['destinationCountry']}" if invoice["destinationCountry"] else ""
            if invoice["shippingBillNo"]:
                bill = f"shipping bill {invoice['shippingBillNo']}"
                bill += f" dated {invoice['shippingBillDate']}" if invoice["shippingBillDate"] else ""
                bill += f" at port {invoice['portCode']}" if invoice["portCode"] else ""
            else:
                bill = "shipping bill details to be furnished"
            if invoice["brcNumber"]:
                realized = f"realized under BRC {invoice['brcNumber']}" + (f" dated {invoice['brcDate']}" if invoice["brcDate"] else "")
            elif invoice["receivedUsd"] > 0:
                realized = f"{_usd(invoice['receivedUsd'])} received so far"
            else:
                realized = "realization pending"
            parts = [
                f"Invoice {invoice['invoiceNumber']} dated {invoice['invoiceDate']} to {invoice['buyerName']}{country}, value {_usd(invoice['totalUsd'])}",
                "exported on payment of IGST" if invoice["exportScheme"] == "igst" else "exported under LUT without payment of IGST",
                bill,
                realized,
            ]
            paragraphs.append(f"• {'; '.join(parts)}.")
    paragraphs.append(
        "Copies of the invoices, shipping bills, and bank realization certificates are enclosed. We request you to take the above on "
        "record and drop the proceedings. We will furnish any further information you may require."
    )
    return paragraphs


def to_notice(row, today: str) -> dict:
    days_left = days_between(today, row["reply_due"]) if row["reply_due"] else None
    if row["status"] != "open" or days_left is None:
        urgency = "none"
    elif days_left < 0:
        urgency = "overdue"
    elif days_left <= 7:
        urgency = "due_soon"
    else:
        urgency = "upcoming"
    return {
        "id": row["id"],
        "authority": row["authority"],
        "authorityLabel": AUTHORITY_LABELS[row["authority"]],
        "formType": row["form_type"],
        "referenceNo": row["reference_no"],
        "period": row["period"],
        "issuedOn": row["issued_on"],
        "replyDue": row["reply_due"],
        "daysLeft": days_left,
        "urgency": urgency,
        "amountInr": None if row["amount_inr"] is None else money(row["amount_inr"]),
        "status": row["status"],
        "summary": row["summary"],
        "reply": row["reply"],
        "replySource": row["reply_source"],
        "invoiceIds": list(row["invoice_ids"] or []),
        "invoiceNumbers": list(row["invoice_numbers"] or []),
        "createdAt": iso(row["created_at"]),
        "updatedAt": iso(row["updated_at"]),
    }


NOTICE_COLUMNS = """n.id, n.authority, n.form_type, n.reference_no, n.period, to_char(n.issued_on, 'YYYY-MM-DD') AS issued_on,
    to_char(n.reply_due, 'YYYY-MM-DD') AS reply_due, n.amount_inr, n.status, n.summary, n.reply, n.reply_source, n.invoice_ids,
    n.created_at, n.updated_at,
    (SELECT ARRAY_AGG(i.invoice_number ORDER BY i.invoice_number) FROM invoices i WHERE i.id = ANY(n.invoice_ids)) AS invoice_numbers"""


async def open_notice_counts(pool: Pool, organization_id: str) -> dict:
    row = await pool.fetchrow(
        """SELECT COUNT(*) FILTER (WHERE status = 'open') AS open,
                  COUNT(*) FILTER (WHERE status = 'open' AND reply_due BETWEEN current_date AND current_date + 7) AS due_soon,
                  COUNT(*) FILTER (WHERE status = 'open' AND reply_due < current_date) AS overdue
           FROM tax_notices WHERE organization_id = $1""",
        organization_id,
    )
    return {"open": row["open"], "dueSoon": row["due_soon"], "overdue": row["overdue"]}


async def read_notice(pool: Pool, organization_id: str, data: dict) -> dict:
    form = form_reader(data)
    raw = form.raw.get("invoiceNumbers")
    if isinstance(raw, list):
        numbers = [v for v in raw if isinstance(v, str) and v.strip()][:50]
    elif isinstance(raw, str):
        numbers = [v for v in re.split(r"[\s,;]+", raw) if v][:50]
    else:
        numbers = []
    invoice_ids: list[str] = []
    if numbers:
        found = await pool.fetch(
            "SELECT id, invoice_number FROM invoices WHERE organization_id = $1 AND UPPER(invoice_number) = ANY($2::text[])",
            organization_id, [n.strip().upper() for n in numbers],
        )
        known = {row["invoice_number"].upper() for row in found}
        missing = [n for n in numbers if n.strip().upper() not in known]
        if missing:
            raise ApiError(400, f"No invoice numbered {', '.join(missing)}.")
        invoice_ids = [row["id"] for row in found]
    issued_on = form.date("issuedOn", "Enter the notice date as YYYY-MM-DD.", True)
    reply_due = form.date("replyDue", "Enter the reply due date as YYYY-MM-DD.", True)
    return {
        "authority": form.choice("authority", AUTHORITIES, "gst"),
        "formType": form.required("formType", "Enter the notice form or type, for example ASMT-10, DRC-01, or section 143(2).", 100),
        "referenceNo": form.text("referenceNo", 100),
        "period": form.text("period", 50),
        "issuedOn": date.fromisoformat(issued_on) if issued_on else None,
        "replyDue": date.fromisoformat(reply_due) if reply_due else None,
        "amountInr": form.number("amountInr", "The amount must be zero or more rupees.", min=0, optional=True),
        "status": form.choice("status", STATUSES, "open"),
        "summary": form.text("summary", 4000),
        "reply": form.text("reply", 20000),
        "invoiceIds": invoice_ids,
    }


async def notice_facts(pool: Pool, organization_id: str, notice_id: str) -> dict | None:
    row = await pool.fetchrow(
        f"""SELECT {NOTICE_COLUMNS}, o.name AS company_name,
                   COALESCE(o.profile->'exporter'->>'gstin', o.profile->>'gstin', '') AS gstin
            FROM tax_notices n JOIN organizations o ON o.id = n.organization_id
            WHERE n.id = $1 AND n.organization_id = $2""",
        notice_id, organization_id,
    )
    if not row:
        return None
    invoices = await pool.fetch(
        """SELECT i.invoice_number, to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date, i.buyer_name,
                  i.destination_country, i.total_usd, COALESCE(t.export_scheme, 'lut') AS export_scheme,
                  COALESCE(t.shipping_bill_no, '') AS shipping_bill_no, to_char(t.shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date,
                  COALESCE(t.port_code, '') AS port_code, COALESCE(b.brc_number, '') AS brc_number,
                  to_char(b.realised_on, 'YYYY-MM-DD') AS brc_date,
                  COALESCE((SELECT SUM(amount_usd) FROM payments p WHERE p.invoice_id = i.id), 0) AS received_usd
           FROM invoices i LEFT JOIN invoice_tax t ON t.invoice_id = i.id LEFT JOIN invoice_brcs b ON b.invoice_id = i.id
           WHERE i.organization_id = $1 AND i.id = ANY($2::uuid[])
           ORDER BY i.invoice_number""",
        organization_id, list(row["invoice_ids"] or []),
    )
    return {
        "companyName": row["company_name"],
        "gstin": row["gstin"],
        "authority": AUTHORITY_LABELS[row["authority"]],
        "formType": row["form_type"],
        "referenceNo": row["reference_no"],
        "period": row["period"],
        "issuedOn": row["issued_on"],
        "replyDue": row["reply_due"],
        "amountInr": None if row["amount_inr"] is None else money(row["amount_inr"]),
        "summary": row["summary"],
        "invoices": [
            {
                "invoiceNumber": i["invoice_number"],
                "invoiceDate": i["invoice_date"],
                "buyerName": i["buyer_name"],
                "destinationCountry": i["destination_country"],
                "totalUsd": money(i["total_usd"]),
                "exportScheme": i["export_scheme"],
                "shippingBillNo": i["shipping_bill_no"],
                "shippingBillDate": i["shipping_bill_date"],
                "portCode": i["port_code"],
                "brcNumber": i["brc_number"],
                "brcDate": i["brc_date"],
                "receivedUsd": money(i["received_usd"]),
            }
            for i in invoices
        ],
    }


notice_reader = require_roles("admin", "tax", "ca")
notice_writer = require_roles("admin", "tax", "ca")
notice_deleter = require_roles("admin", "tax")


def _values(notice: dict) -> list:
    return [notice["authority"], notice["formType"], notice["referenceNo"], notice["period"], notice["issuedOn"], notice["replyDue"],
            notice["amountInr"], notice["status"], notice["summary"], notice["reply"], notice["invoiceIds"]]


def build_router():
    router = api_router(prefix="/api/notices")

    @router.get("")
    async def list_notices(request: Request, user: CurrentUser = Depends(notice_reader)):
        rows = await request.app.state.pool.fetch(
            f"""SELECT {NOTICE_COLUMNS} FROM tax_notices n WHERE n.organization_id = $1
                ORDER BY (n.status <> 'open'), n.reply_due NULLS LAST, n.created_at DESC LIMIT 500""",
            user.organization_id,
        )
        today = iso_today()
        return {"notices": [to_notice(row, today) for row in rows], "authorities": AUTHORITY_LABELS}

    @router.post("")
    async def create(request: Request, user: CurrentUser = Depends(notice_writer)):
        pool: Pool = request.app.state.pool
        notice = await read_notice(pool, user.organization_id, body(request))
        new_id = await pool.fetchval(
            """INSERT INTO tax_notices (organization_id, authority, form_type, reference_no, period, issued_on, reply_due, amount_inr, status,
                 summary, reply, invoice_ids, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id""",
            user.organization_id, *_values(notice), user.id,
        )
        return JSONResponse({"id": new_id}, status_code=201)

    @router.put("/{notice_id}")
    async def update(notice_id: str, request: Request, user: CurrentUser = Depends(notice_writer)):
        if not is_uuid(notice_id):
            raise ApiError(404, "Notice not found.")
        pool: Pool = request.app.state.pool
        notice = await read_notice(pool, user.organization_id, body(request))
        result = await pool.execute(
            """UPDATE tax_notices SET authority = $3, form_type = $4, reference_no = $5, period = $6, issued_on = $7, reply_due = $8,
                 amount_inr = $9, status = $10, summary = $11, reply = $12, invoice_ids = $13,
                 reply_source = CASE WHEN reply = $12 THEN reply_source ELSE 'edited' END, updated_at = now()
               WHERE id = $1 AND organization_id = $2""",
            notice_id, user.organization_id, *_values(notice),
        )
        if result == "UPDATE 0":
            raise ApiError(404, "Notice not found.")
        return {"id": notice_id}

    @router.delete("/{notice_id}")
    async def delete(notice_id: str, request: Request, user: CurrentUser = Depends(notice_deleter)):
        if not is_uuid(notice_id):
            raise ApiError(404, "Notice not found.")
        result = await request.app.state.pool.execute("DELETE FROM tax_notices WHERE id = $1 AND organization_id = $2", notice_id, user.organization_id)
        if result == "DELETE 0":
            raise ApiError(404, "Notice not found.")
        return {"deleted": True}

    @router.post("/{notice_id}/draft-reply")
    async def draft_reply(notice_id: str, request: Request, user: CurrentUser = Depends(notice_writer)):
        """Drafts a reply from the notice and its linked invoices. The draft is saved but nothing is sent."""
        if not is_uuid(notice_id):
            raise ApiError(404, "Notice not found.")
        pool: Pool = request.app.state.pool
        facts = await notice_facts(pool, user.organization_id, notice_id)
        if not facts:
            raise ApiError(404, "Notice not found.")
        drafter: DraftNoticeReply = request.app.state.options.draft_notice_reply
        context = ModelCallContext("notice_reply", NOTICE_PROMPT_VERSION, active_model_name(), user.organization_id, user.id)

        async def run() -> tuple[dict, TokenUsage | None]:
            drafted = dict(await drafter(facts))
            usage = drafted.pop("usage", None)
            return drafted, usage if isinstance(usage, TokenUsage) else None

        paragraphs, source, note = None, "template", ""
        try:
            parsed = parse_reply(await call_model(pool, context, run))
            if parsed is None:
                note = "The AI draft was not in the expected shape, so a draft written from your records is shown."
            elif not is_grounded("\n".join(parsed), [facts]):
                note = "The AI draft mentioned an amount that is not in your records, so a draft written from your records is shown."
            else:
                paragraphs, source = parsed, "model"
        except Exception as error:
            note = f"AI drafting was not available ({error}). A draft written from your records is shown."
        reply = "\n\n".join(paragraphs or template_notice_reply(facts))
        await pool.execute(
            "UPDATE tax_notices SET reply = $3, reply_source = $4, updated_at = now() WHERE id = $1 AND organization_id = $2",
            notice_id, user.organization_id, reply, source,
        )
        return {"reply": reply, "source": source, "note": note}

    return router
