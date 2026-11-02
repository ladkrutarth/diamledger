"""The assistant's tools (port of server/assistant/tools.ts).

Every tool only reads. The propose_* tools store a proposal; nothing changes until the user confirms it,
and confirming re-checks it against the current data (routes.py).
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

from ..core.db import Pool
from ..core.http import CurrentUser, iso
from ..core.numbers import round_to
from ..modules.accountant.workspace import compliance_items
from ..modules.banking.bank import bank_lines, current_suggestion
from ..modules.collections.reminders import DUE_DATE, list_overdue
from ..modules.tax.closed_months import parse_month
from ..modules.tax.filing import filing_summary
from ..modules.tax.forex import forex_summary
from ..modules.tax.realization import realization_summary
from ..modules.tax.shared import current_month, month_is_closed
from ..modules.tax.tax import export_register

TAX_READERS = ("admin", "tax", "ca")
BOOK_WRITERS = ("admin", "member", "tax")

# Who may confirm each kind of proposal.
CONFIRM_ROLES = {
    "record_payment": BOOK_WRITERS,
    "draft_reminder": BOOK_WRITERS,
    "match_bank_line": BOOK_WRITERS,
    "close_month": ("ca",),
}

MAX_ROWS = 20


def can_use_tax_tools(user: CurrentUser) -> bool:
    return user.role in TAX_READERS


def money(value: float) -> float:
    return round_to(value, 2)


@dataclass
class ToolContext:
    pool: Pool
    user: CurrentUser
    session_id: str


@dataclass
class ToolOutcome:
    result: Any
    sources: list[dict] = field(default_factory=list)
    action: dict | None = None


class ArgError(Exception):
    pass


# --- Arguments -------------------------------------------------------------------------------------


def _text(args: dict, key: str, *, max_length: int, required: bool = False, min_length: int = 0) -> str | None:
    if key not in args or args[key] is None:
        if required:
            raise ArgError(f"{key} Invalid input: expected string, received undefined")
        return None
    value = args[key]
    if not isinstance(value, str):
        raise ArgError(f"{key} Invalid input: expected string")
    value = value.strip()
    if len(value) < min_length:
        raise ArgError(f"{key} Too small: expected string to have >={min_length} characters")
    if len(value) > max_length:
        raise ArgError(f"{key} Too big: expected string to have <={max_length} characters")
    return value


def _iso_date(args: dict, key: str) -> str | None:
    if key not in args or args[key] is None:
        return None
    value = args[key]
    if not isinstance(value, str) or not re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        raise ArgError(f"{key} Use YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ArgError(f"{key} Invalid date") from None
    return value


def _month(args: dict, key: str, required: bool = False) -> str | None:
    if key not in args or args[key] is None:
        if required:
            raise ArgError(f"{key} Invalid input: expected string, received undefined")
        return None
    if not isinstance(args[key], str) or not parse_month(args[key]):
        raise ArgError(f"{key} Use YYYY-MM")
    return args[key]


def _invoice_number(args: dict) -> str:
    return _text(args, "invoiceNumber", max_length=60, required=True, min_length=1)  # type: ignore[return-value]


INVOICE_NUMBER_SCHEMA = {"type": "string", "minLength": 1, "maxLength": 60, "description": "Invoice number exactly as shown, e.g. XYZ/2026-27/004"}
ISO_DATE_SCHEMA = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}
MONTH_SCHEMA = {"type": "string", "description": "Calendar month, YYYY-MM"}


def _object(properties: dict | None = None, required: list[str] | None = None) -> dict:
    schema: dict = {"type": "object", "properties": properties or {}, "additionalProperties": False}
    if required:
        schema["required"] = required
    return schema


# --- Shared queries --------------------------------------------------------------------------------

INVOICE_COLUMNS = f"""
  i.id, i.invoice_number, i.status, i.buyer_name, i.destination_country,
  to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.credit_days,
  to_char({DUE_DATE}, 'YYYY-MM-DD') AS due_date, current_date - {DUE_DATE} AS days_overdue,
  i.total_usd, COALESCE(p.paid, 0) AS paid_usd"""

PAID_JOIN = "LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid FROM payments WHERE invoice_id = i.id) p ON true"


def _like(value: str) -> str:
    return "%" + re.sub(r"[\\%_]", lambda m: "\\" + m.group(0), value) + "%"


def compact_invoice(row) -> dict:
    total_usd, paid_usd = float(row["total_usd"]), float(row["paid_usd"])
    due_usd = max(0.0, money(total_usd - paid_usd))
    return {
        "invoiceNumber": row["invoice_number"],
        "status": row["status"],
        "buyer": row["buyer_name"],
        "country": row["destination_country"],
        "invoiceDate": row["invoice_date"],
        "creditDays": row["credit_days"],
        "dueDate": row["due_date"],
        "overdue": row["status"] == "issued" and due_usd > 0 and row["days_overdue"] > 0,
        "totalUsd": total_usd,
        "paidUsd": paid_usd,
        "dueUsd": due_usd,
    }


def invoice_source(row) -> dict:
    return {"kind": "invoice", "id": row["id"], "label": row["invoice_number"]}


def tax_source(label: str) -> dict:
    return {"kind": "tax", "label": label}


async def find_invoice_by_number(context: ToolContext, number: str):
    return await context.pool.fetchrow(
        f"SELECT {INVOICE_COLUMNS} FROM invoices i {PAID_JOIN} WHERE i.organization_id = $1 AND lower(i.invoice_number) = lower($2)",
        context.user.organization_id, number,
    )


async def save_proposal(context: ToolContext, kind: str, payload: dict) -> dict:
    row = await context.pool.fetchrow(
        """INSERT INTO assistant_actions (session_id, organization_id, kind, payload, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at""",
        context.session_id, context.user.organization_id, kind, payload, context.user.id,
    )
    return {"id": row["id"], "kind": kind, "status": "proposed", "payload": payload, "createdAt": iso(row["created_at"])}


def for_model(action: dict) -> dict:
    details = {k: v for k, v in action["payload"].items() if k != "invoiceId"}
    return {"proposalId": action["id"], "status": "awaiting_user_confirmation", **details}


def refused(reason: str, sources: list[dict] | None = None) -> ToolOutcome:
    return ToolOutcome({"error": reason}, sources or [])


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# --- Tools -----------------------------------------------------------------------------------------


async def search_invoices(context: ToolContext, args: dict) -> ToolOutcome:
    query = _text(args, "query", max_length=100)
    status = args.get("status")
    if status is not None and status not in ("draft", "issued", "paid", "cancelled"):
        raise ArgError('status Invalid option: expected one of "draft"|"issued"|"paid"|"cancelled"')
    start, end = _iso_date(args, "from"), _iso_date(args, "to")
    params: list = [context.user.organization_id]
    where = ["i.organization_id = $1"]
    if query:
        params.append(_like(query))
        where.append(f"(i.invoice_number ILIKE ${len(params)} OR i.buyer_name ILIKE ${len(params)})")
    if status:
        params.append(status)
        where.append(f"i.status = ${len(params)}")
    if start:
        params.append(date.fromisoformat(start))
        where.append(f"COALESCE(i.invoice_date, i.created_at::date) >= ${len(params)}")
    if end:
        params.append(date.fromisoformat(end))
        where.append(f"COALESCE(i.invoice_date, i.created_at::date) <= ${len(params)}")
    rows = await context.pool.fetch(
        f"""SELECT {INVOICE_COLUMNS} FROM invoices i {PAID_JOIN} WHERE {' AND '.join(where)}
            ORDER BY COALESCE(i.invoice_date, i.created_at::date) DESC, i.invoice_number DESC LIMIT {MAX_ROWS + 1}""",
        *params,
    )
    shown = rows[:MAX_ROWS]
    return ToolOutcome({"invoices": [compact_invoice(r) for r in shown], "truncated": len(rows) > MAX_ROWS}, [invoice_source(r) for r in shown])


async def get_invoice(context: ToolContext, args: dict) -> ToolOutcome:
    number = _invoice_number(args)
    row = await find_invoice_by_number(context, number)
    if not row:
        return refused(f"No invoice numbered {number} was found.")
    pool = context.pool
    detail, payments, reminders = await asyncio.gather(
        pool.fetchrow(
            """SELECT jsonb_array_length(COALESCE(data->'items', '[]'::jsonb)) AS items, total_carats AS carats,
                      data->'consignee'->>'email' AS email, data->'consignee'->>'contactPerson' AS contact
               FROM invoices WHERE id = $1""",
            row["id"],
        ),
        pool.fetch("SELECT amount_usd, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, reference FROM payments WHERE invoice_id = $1 ORDER BY paid_on, created_at",
                   row["id"]),
        pool.fetch("""SELECT status, sent_at, created_at FROM payment_reminders
                      WHERE invoice_id = $1 AND status IN ('draft', 'sent') ORDER BY created_at""", row["id"]),
    )
    return ToolOutcome({
        **compact_invoice(row),
        "buyerContact": detail["contact"] or "",
        "buyerEmail": detail["email"] or "",
        "lineItems": detail["items"],
        "totalCarats": float(detail["carats"]),
        "payments": [{"amountUsd": float(p["amount_usd"]), "paidOn": p["paid_on"], "reference": p["reference"]} for p in payments],
        "reminders": [{"status": r["status"], "date": iso(r["sent_at"] or r["created_at"])[:10]} for r in reminders],
    }, [invoice_source(row)])


async def list_overdue_tool(context: ToolContext, args: dict) -> ToolOutcome:
    overdue = await list_overdue(context.pool, context.user.organization_id)
    shown = overdue[:MAX_ROWS]
    return ToolOutcome({
        "invoices": [{"invoiceNumber": i["invoiceNumber"], "buyer": i["buyerName"], "dueDate": i["dueDate"], "daysOverdue": i["daysOverdue"],
                      "totalUsd": i["totalUsd"], "paidUsd": i["paidUsd"], "dueUsd": i["dueUsd"], "remindersSent": i["remindersSent"],
                      "remindedInLastWeek": i["recentlyReminded"]} for i in shown],
        "count": len(overdue),
        "truncated": len(overdue) > MAX_ROWS,
    }, [{"kind": "invoice", "id": i["id"], "label": i["invoiceNumber"]} for i in shown])


async def unpaid_summary(context: ToolContext, args: dict) -> ToolOutcome:
    buyer = _text(args, "buyer", max_length=100)
    params: list = [context.user.organization_id]
    buyer_filter = ""
    if buyer:
        params.append(_like(buyer))
        buyer_filter = f"AND i.buyer_name ILIKE ${len(params)}"
    rows = await context.pool.fetch(
        f"""SELECT i.buyer_name, COUNT(*) AS invoices,
                   SUM(i.total_usd - COALESCE(p.paid, 0)) AS due_usd,
                   SUM(CASE WHEN {DUE_DATE} < current_date THEN i.total_usd - COALESCE(p.paid, 0) ELSE 0 END) AS overdue_usd,
                   COUNT(*) FILTER (WHERE {DUE_DATE} < current_date) AS overdue_invoices
            FROM invoices i {PAID_JOIN}
            WHERE i.organization_id = $1 AND i.status = 'issued' AND i.total_usd - COALESCE(p.paid, 0) > 0 {buyer_filter}
            GROUP BY i.buyer_name ORDER BY due_usd DESC""",
        *params,
    )
    buyers = [{"buyer": r["buyer_name"], "unpaidInvoices": r["invoices"], "dueUsd": money(float(r["due_usd"])),
               "overdueInvoices": r["overdue_invoices"], "overdueUsd": money(float(r["overdue_usd"]))} for r in rows]
    total_due = overdue = 0.0
    for b in buyers:
        total_due += b["dueUsd"]
    for b in buyers:
        overdue += b["overdueUsd"]
    total_due, overdue = money(total_due), money(overdue)
    return ToolOutcome({
        "totalDueUsd": total_due,
        "overdueUsd": overdue,
        "notYetDueUsd": money(total_due - overdue),
        "unpaidInvoices": sum(b["unpaidInvoices"] for b in buyers),
        "buyers": buyers[:MAX_ROWS],
    }, [{"kind": "summary", "label": f'Unpaid invoices for "{buyer}"' if buyer else "All unpaid invoices"}])


async def find_buyer(context: ToolContext, args: dict) -> ToolOutcome:
    name = _text(args, "name", max_length=100, required=True, min_length=1)
    rows = await context.pool.fetch(
        f"SELECT id, name, data FROM buyers WHERE organization_id = $1 AND name ILIKE $2 ORDER BY lower(name) LIMIT {MAX_ROWS}",
        context.user.organization_id, _like(name),
    )

    def field_of(data, key: str) -> str:
        return (data or {}).get(key) or "" if isinstance(data, dict) else ""

    return ToolOutcome({"buyers": [{"name": r["name"], "city": field_of(r["data"], "city"), "country": field_of(r["data"], "country"),
                                    "contactPerson": field_of(r["data"], "contactPerson"), "email": field_of(r["data"], "email")} for r in rows]},
                       [{"kind": "buyer", "id": r["id"], "label": r["name"]} for r in rows])


async def propose_payment(context: ToolContext, args: dict) -> ToolOutcome:
    number = _invoice_number(args)
    amount = args.get("amountUsd")
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        raise ArgError("amountUsd Invalid input: expected number")
    if not amount > 0 or amount > 1e11:
        raise ArgError("amountUsd Too small: expected number to be >0" if not amount > 0 else "amountUsd Too big: expected number to be <=100000000000")
    paid_on = _iso_date(args, "paidOn")
    reference = _text(args, "reference", max_length=200)
    row = await find_invoice_by_number(context, number)
    if not row:
        return refused(f"No invoice numbered {number} was found.")
    invoice = compact_invoice(row)
    if row["status"] != "issued":
        return refused(f"Invoice {row['invoice_number']} is {row['status']}; payments can only be recorded on issued invoices.", [invoice_source(row)])
    amount_usd = money(float(amount))
    if amount_usd > invoice["dueUsd"]:
        return refused(f"{_num(amount_usd)} USD is more than the {_num(invoice['dueUsd'])} USD still due on {row['invoice_number']}.", [invoice_source(row)])
    action = await save_proposal(context, "record_payment", {
        "invoiceId": row["id"], "invoiceNumber": row["invoice_number"], "buyer": row["buyer_name"], "amountUsd": amount_usd,
        "paidOn": paid_on or _today(), "reference": reference or "", "dueUsdAtProposal": invoice["dueUsd"], "paidUsdAtProposal": invoice["paidUsd"],
    })
    return ToolOutcome(for_model(action), [invoice_source(row)], action)


def _num(value: float) -> str:
    """A number as JavaScript prints it in a template string."""
    from ..core.numbers import js_string

    return js_string(value)


async def propose_reminder(context: ToolContext, args: dict) -> ToolOutcome:
    number = _invoice_number(args)
    row = await find_invoice_by_number(context, number)
    if not row:
        return refused(f"No invoice numbered {number} was found.")
    overdue = next((i for i in await list_overdue(context.pool, context.user.organization_id) if i["id"] == row["id"]), None)
    if not overdue:
        return refused(f"Invoice {row['invoice_number']} is not overdue, so no reminder is needed.", [invoice_source(row)])
    action = await save_proposal(context, "draft_reminder", {
        "invoiceId": row["id"], "invoiceNumber": row["invoice_number"], "buyer": overdue["buyerName"], "dueUsd": overdue["dueUsd"],
        "daysOverdue": overdue["daysOverdue"], "remindedInLastWeek": overdue["recentlyReminded"], "paidUsdAtProposal": overdue["paidUsd"],
    })
    return ToolOutcome(for_model(action), [invoice_source(row)], action)


async def compliance_calendar(context: ToolContext, args: dict) -> ToolOutcome:
    items = await compliance_items(context.pool, {"id": context.user.organization_id, "name": context.user.organization_name}, date.today())
    keys = ("kind", "title", "dueDate", "daysLeft", "status", "detail")
    return ToolOutcome({"items": [{k: item[k] for k in keys} for item in items]}, [tax_source("Compliance calendar")])


async def filing_check(context: ToolContext, args: dict) -> ToolOutcome:
    target = _month(args, "month") or current_month()
    summary = await filing_summary(context.pool, context.user.organization_id, target)
    rows = summary["rows"]
    problems = [r for r in rows if not r["ready"]]
    shown = problems[:MAX_ROWS]
    return ToolOutcome({
        "month": target,
        "einvoiceRequired": summary["settings"]["einvoiceRequired"],
        "invoiceCount": len(rows),
        "readyCount": len(rows) - len(problems),
        "issueCount": len(problems),
        "companyIssues": [issue["message"] for issue in summary["companyIssues"]],
        "invoicesWithIssues": [{"invoiceNumber": r["invoiceNumber"], "invoiceDate": r["invoiceDate"], "issues": [i["message"] for i in r["issues"]]}
                               for r in shown],
        "truncated": len(problems) > MAX_ROWS,
    }, [tax_source(f"Filing check {target}"), *({"kind": "invoice", "id": r["id"], "label": r["invoiceNumber"]} for r in shown)])


async def export_register_tool(context: ToolContext, args: dict) -> ToolOutcome:
    target = _month(args, "month") or current_month()
    register = await export_register(context.pool, context.user.organization_id, target)
    shown = register["rows"][:MAX_ROWS]
    return ToolOutcome({
        "month": target,
        "closed": register["closed"],
        "count": register["totals"]["count"],
        "taxableUsd": register["totals"]["taxableUsd"],
        "igstUsd": register["totals"]["igstUsd"],
        "invoices": [{"invoiceNumber": r["invoiceNumber"], "invoiceDate": r["invoiceDate"], "buyer": r["buyerName"], "status": r["status"],
                      "scheme": r["exportScheme"], "taxableUsd": r["taxableUsd"], "igstUsd": r["igstUsd"], "shippingBillNo": r["shippingBillNo"],
                      "caReview": r["reviewStatus"] or "none"} for r in shown],
        "truncated": len(register["rows"]) > MAX_ROWS,
    }, [tax_source(f"Export register {target}"), *({"kind": "invoice", "id": r["id"], "label": r["invoiceNumber"]} for r in shown)])


async def realization_watch(context: ToolContext, args: dict) -> ToolOutcome:
    summary = await realization_summary(context.pool, context.user.organization_id)
    urgent = [r for r in summary["rows"] if r["flag"] in ("overdue", "due_soon")]
    shown = urgent[:MAX_ROWS]
    keys = ("realizationMonths", "openCount", "openUsd", "overdueCount", "dueSoonCount", "needsBrcCount")
    return ToolOutcome({
        **{k: summary[k] for k in keys},
        "urgent": [{"invoiceNumber": r["invoiceNumber"], "buyer": r["buyerName"], "shippedOn": r["shippedOn"], "deadline": r["deadline"],
                    "daysLeft": r["daysLeft"], "dueUsd": r["dueUsd"], "flag": r["flag"]} for r in shown],
        "truncated": len(urgent) > MAX_ROWS,
    }, [tax_source("Realization watch"), *({"kind": "invoice", "id": r["id"], "label": r["invoiceNumber"]} for r in shown)])


async def forex_summary_tool(context: ToolContext, args: dict) -> ToolOutcome:
    target = _month(args, "month") or current_month()
    summary = await forex_summary(context.pool, context.user.organization_id, target)
    shown = summary["rows"][:MAX_ROWS]
    return ToolOutcome({
        "month": target,
        "paymentCount": len(summary["rows"]),
        "missingRateCount": summary["missingRateCount"],
        "gainInr": summary["totals"]["gainInr"],
        "lossInr": summary["totals"]["lossInr"],
        "netInr": summary["totals"]["netInr"],
        "payments": [{"invoiceNumber": r["invoiceNumber"], "paidOn": r["paidOn"], "amountUsd": r["amountUsd"], "invoiceRateInr": r["invoiceRateInr"],
                      "bankRateInr": r["bankRateInr"], "gainInr": r["gainInr"]} for r in shown],
        "truncated": len(summary["rows"]) > MAX_ROWS,
    }, [tax_source(f"Forex {target}"), *({"kind": "invoice", "id": r["invoiceId"], "label": r["invoiceNumber"]} for r in shown)])


async def bank_matches(context: ToolContext, args: dict) -> ToolOutcome:
    lines = await bank_lines(context.pool, context.user.organization_id, "unmatched", MAX_ROWS + 1)
    result_lines = []
    for line in lines[:MAX_ROWS]:
        best = line["suggestions"][0] if line["suggestions"] else None
        result_lines.append({
            "lineId": line["id"], "date": line["lineDate"], "amountUsd": line["amountUsd"], "reference": line["reference"],
            "narration": line["narration"],
            "suggestion": {"invoiceNumber": best["invoiceNumber"], "buyer": best["buyerName"], "dueUsd": best["dueUsd"], "score": best["score"],
                           "reasons": best["reasons"]} if best else None,
        })
    return ToolOutcome({"lines": result_lines, "truncated": len(lines) > MAX_ROWS}, [tax_source("Unmatched bank lines")])


async def bank_match_proposal(pool: Pool, organization_id: str, line_id: str, invoice_id: str) -> dict:
    """A bank-match proposal, only when the matcher itself links this line to this invoice. {"ok", "payload" | "error"}."""
    suggestion = await current_suggestion(pool, organization_id, line_id, invoice_id)
    if not suggestion:
        return {"ok": False, "error": "The matcher does not suggest that invoice for this bank line, or the line is already dealt with."}
    row = await pool.fetchrow(
        """SELECT to_char(b.line_date, 'YYYY-MM-DD') AS line_date, b.amount_usd, b.reference, i.status,
                  COALESCE((SELECT SUM(amount_usd) FROM payments WHERE invoice_id = i.id), 0) AS paid
           FROM bank_lines b JOIN invoices i ON i.id = $3 AND i.organization_id = b.organization_id
           WHERE b.id = $1 AND b.organization_id = $2""",
        line_id, organization_id, invoice_id,
    )
    if not row:
        return {"ok": False, "error": "Bank line not found."}
    return {"ok": True, "payload": {
        "lineId": line_id, "invoiceId": invoice_id, "invoiceNumber": suggestion["invoiceNumber"], "buyer": suggestion["buyerName"],
        "amountUsd": money(float(row["amount_usd"])), "lineDate": row["line_date"], "reference": row["reference"], "score": suggestion["score"],
        "reasons": suggestion["reasons"], "dueUsdAtProposal": suggestion["dueUsd"], "paidUsdAtProposal": money(float(row["paid"])),
    }}


async def month_close_check(pool: Pool, organization_id: str, target: str) -> dict:
    """A month can be closed once it has ended, is still open, and its filing check is clean."""
    if target >= current_month():
        return {"ok": False, "error": f"{target} has not ended yet, so its books cannot be closed."}
    if await month_is_closed(pool, organization_id, target):
        return {"ok": False, "error": f"The books for {target} are already closed."}
    summary = await filing_summary(pool, organization_id, target)
    problems = sum(1 for r in summary["rows"] if not r["ready"])
    if problems or summary["companyIssues"]:
        parts = [part for part in (
            f"{problems} invoice{' has' if problems == 1 else 's have'} filing problems" if problems else "",
            "the company GSTIN needs fixing" if summary["companyIssues"] else "",
        ) if part]
        return {"ok": False, "error": f"{target} cannot be closed yet: {' and '.join(parts)}. Run the filing check for details."}
    return {"ok": True, "invoiceCount": len(summary["rows"])}


async def propose_bank_match(context: ToolContext, args: dict) -> ToolOutcome:
    line_id = args.get("lineId")
    if not isinstance(line_id, str) or not re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", line_id, re.IGNORECASE):
        raise ArgError("lineId Invalid UUID")
    number = _invoice_number(args)
    row = await find_invoice_by_number(context, number)
    if not row:
        return refused(f"No invoice numbered {number} was found.")
    proposal = await bank_match_proposal(context.pool, context.user.organization_id, line_id, row["id"])
    if not proposal["ok"]:
        return refused(proposal["error"], [invoice_source(row)])
    action = await save_proposal(context, "match_bank_line", proposal["payload"])
    return ToolOutcome(for_model(action), [invoice_source(row)], action)


async def propose_close_month(context: ToolContext, args: dict) -> ToolOutcome:
    target = _month(args, "month", required=True)
    check = await month_close_check(context.pool, context.user.organization_id, target)
    if not check["ok"]:
        return refused(check["error"], [tax_source(f"Filing check {target}")])
    action = await save_proposal(context, "close_month", {"month": target, "invoiceCount": check["invoiceCount"]})
    return ToolOutcome(for_model(action), [tax_source(f"Filing check {target}")], action)


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict
    run: Callable[[ToolContext, dict], Awaitable[ToolOutcome]]
    roles: tuple[str, ...] | None = None


TOOLS: list[Tool] = [
    Tool("search_invoices",
         f"Search the company's invoices by invoice number or buyer name, status, and invoice date range. Returns at most {MAX_ROWS} invoices, newest first.",
         _object({"query": {"type": "string", "maxLength": 100, "description": "Part of an invoice number or buyer name"},
                  "status": {"type": "string", "enum": ["draft", "issued", "paid", "cancelled"]},
                  "from": {**ISO_DATE_SCHEMA, "description": "Earliest invoice date, YYYY-MM-DD"},
                  "to": {**ISO_DATE_SCHEMA, "description": "Latest invoice date, YYYY-MM-DD"}}),
         search_invoices),
    Tool("get_invoice", "Get one invoice by its number, with its payments, reminder history, and line item summary.",
         _object({"invoiceNumber": INVOICE_NUMBER_SCHEMA}, ["invoiceNumber"]), get_invoice),
    Tool("list_overdue", f"List issued invoices that are past their due date and still have money owed, most overdue first. At most {MAX_ROWS}.",
         _object(), list_overdue_tool),
    Tool("unpaid_summary",
         "Total money still owed on issued invoices, split into overdue and not yet due, with a per-buyer breakdown. "
         "Optionally limit to buyers whose name contains the given text.",
         _object({"buyer": {"type": "string", "maxLength": 100, "description": "Part of a buyer name"}}), unpaid_summary),
    Tool("find_buyer", "Look up saved buyers whose name contains the given text. Returns their country, contact person, and email.",
         _object({"name": {"type": "string", "minLength": 1, "maxLength": 100}}, ["name"]), find_buyer),
    Tool("propose_payment",
         "Propose recording a payment received against an issued invoice. Nothing is saved until the user confirms the proposal in the app.",
         _object({"invoiceNumber": INVOICE_NUMBER_SCHEMA,
                  "amountUsd": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e11, "description": "Amount received in USD"},
                  "paidOn": {**ISO_DATE_SCHEMA, "description": "Date the money arrived, YYYY-MM-DD. Defaults to today."},
                  "reference": {"type": "string", "maxLength": 200, "description": "Bank or SWIFT reference"}},
                 ["invoiceNumber", "amountUsd"]),
         propose_payment, BOOK_WRITERS),
    Tool("propose_reminder",
         "Propose drafting a payment reminder email for an overdue invoice. On confirmation a draft is created on the Follow-ups page; no email is sent.",
         _object({"invoiceNumber": INVOICE_NUMBER_SCHEMA}, ["invoiceNumber"]), propose_reminder, BOOK_WRITERS),
    Tool("compliance_calendar",
         "List the company's tax deadlines and open compliance tasks: GSTR-1, GSTR-3B, LUT renewal, FEMA realization, ITC refund windows, "
         "and filing problems. Each item has a status and days left.",
         _object(), compliance_calendar, TAX_READERS),
    Tool("filing_check",
         f"Check whether a month's issued export invoices are ready for GSTR-1 table 6A and e-invoicing. Returns ready and problem counts, "
         f"company-level problems, and the problems on at most {MAX_ROWS} invoices.",
         _object({"month": {**MONTH_SCHEMA, "description": "Calendar month, YYYY-MM. Defaults to this month."}}), filing_check, TAX_READERS),
    Tool("export_register",
         f"The export register for a month: invoice count, taxable value and IGST in USD, whether the books for the month are closed, "
         f"and at most {MAX_ROWS} invoices.",
         _object({"month": {**MONTH_SCHEMA, "description": "Calendar month, YYYY-MM. Defaults to this month."}}), export_register_tool, TAX_READERS),
    Tool("realization_watch",
         f"FEMA export realization status: how many invoices are still unrealized, the USD still to be received, how many are past or near "
         f"the deadline, and at most {MAX_ROWS} urgent invoices.",
         _object(), realization_watch, TAX_READERS),
    Tool("forex_summary",
         f"Foreign exchange gain or loss in INR on payments received in a month, comparing the bank rate with the invoice rate. "
         f"Returns totals, how many payments lack a bank rate, and at most {MAX_ROWS} payments.",
         _object({"month": {**MONTH_SCHEMA, "description": "Calendar month, YYYY-MM. Defaults to this month."}}), forex_summary_tool, TAX_READERS),
    Tool("bank_matches",
         f"List imported bank credits that are not yet matched to an invoice, newest first, at most {MAX_ROWS}. Each line has the best "
         f"invoice the matcher suggests, with a score out of 100 and its reasons.",
         _object(), bank_matches, TAX_READERS),
    Tool("propose_bank_match",
         "Propose matching an unmatched bank credit to the invoice the matcher suggests for it. On confirmation the payment is recorded "
         "and the line is marked matched. Use a lineId from bank_matches.",
         _object({"lineId": {"type": "string", "format": "uuid", "description": "lineId from bank_matches"}, "invoiceNumber": INVOICE_NUMBER_SCHEMA},
                 ["lineId", "invoiceNumber"]),
         propose_bank_match, ("admin", "tax")),
    Tool("propose_close_month",
         "Propose closing the books for a month that has ended and whose filing check is clean. Once closed, invoices and payments in "
         "that month cannot change until a chartered accountant reopens it.",
         _object({"month": MONTH_SCHEMA}, ["month"]), propose_close_month, ("ca",)),
]


def _allowed(tool: Tool, user: CurrentUser) -> bool:
    return tool.roles is None or user.role in tool.roles


def tool_declarations(user: CurrentUser) -> list[dict]:
    return [{"name": t.name, "description": t.description, "parametersJsonSchema": t.parameters} for t in TOOLS if _allowed(t, user)]


async def run_tool(context: ToolContext, name: str, raw_args: Any) -> ToolOutcome:
    tool = next((t for t in TOOLS if t.name == name), None)
    if not tool:
        return refused(f"There is no tool named {name}.")
    if not _allowed(tool, context.user):
        return refused(f"Your role ({context.user.role}) cannot use {name}.")
    # Unknown keys are ignored, as zod's z.object() strips them.
    args = raw_args if isinstance(raw_args, dict) else {}
    try:
        return await tool.run(context, args)
    except ArgError as error:
        return refused(f"Invalid arguments for {name}: {error}")

