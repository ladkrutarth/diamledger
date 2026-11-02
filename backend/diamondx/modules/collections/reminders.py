"""Payment reminders for overdue invoices (port of server/modules/collections/reminders.ts).

The model writes only the wording, and wording with any digit is rejected for a written template.
Every figure in the email (amounts, dates, bank details) is filled in from the database. Nothing
is sent until a person approves the draft.
"""

from __future__ import annotations

import html
import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...ai.call import ModelCallContext, call_model
from ...ai.client import TokenUsage, active_model_name, ai_provider, gemini_generate, gemini_text, usage_from
from ...ai.huggingface import REMINDER_SHAPE, hf_json
from ...core.context import api_router
from ...core.db import Pool
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, require_user
from ...core.numbers import js_round, usd
from .email_dispatch import InputError, dispatch_email, parse_email_request

log = logging.getLogger("diamondx.reminders")

REMINDER_PROMPT_VERSION = "reminder-v1"
REPEAT_WINDOW_DAYS = 7

# (facts) -> {"subject", "greeting", "paragraphs", "usage"?}. Facts: buyerName, contactPerson, exporterName, tone.
DraftReminderText = Callable[[dict[str, str]], Awaitable[dict[str, Any]]]

SYSTEM_PROMPT = """You write short, courteous payment reminder emails for a diamond exporter writing to an overseas buyer.
Write only the wording. The invoice number, amounts, dates, and bank details are added to the email by the system below your text.
Never write any digits, amounts, currencies, dates, account numbers, or invoice numbers. Refer to "the invoice" and "the outstanding balance" instead.
Match the requested tone: gentle is a friendly nudge, firm asks for payment or a payment date this week, final says further reminders will be followed by a call from the accounts team.
Keep it professional and brief: one to three short paragraphs, no sign-off (the system adds it)."""


def _prompt(facts: dict[str, str]) -> str:
    return (
        f"Tone: {facts['tone']}\nBuyer company: {facts['buyerName'] or 'not given'}\n"
        f"Buyer contact person: {facts['contactPerson'] or 'not given'}\nExporter company: {facts['exporterName'] or 'not given'}"
    )


async def gemini_reminder_text(facts: dict[str, str]) -> dict[str, Any]:
    response = await gemini_generate(
        {
            "contents": [{"role": "user", "parts": [{"text": _prompt(facts)}]}],
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "OBJECT",
                    "properties": {
                        "subject": {"type": "STRING", "description": "Email subject line without any invoice number"},
                        "greeting": {"type": "STRING", "description": "Opening line, e.g. Dear Mr. Peeters,"},
                        "paragraphs": {"type": "ARRAY", "items": {"type": "STRING"}},
                    },
                    "required": ["subject", "greeting", "paragraphs"],
                },
            },
        }
    )
    text = gemini_text(response) or "{}"
    return {**json.loads(text), "usage": usage_from(response.get("usageMetadata"))}


async def hf_reminder_text(facts: dict[str, str]) -> dict[str, Any]:
    value, usage = await hf_json(SYSTEM_PROMPT, _prompt(facts), REMINDER_SHAPE)
    return {**(value if isinstance(value, dict) else {}), "usage": usage}


async def default_reminder_text(facts: dict[str, str]) -> dict[str, Any]:
    """The drafter for the configured AI_PROVIDER."""
    return await (hf_reminder_text(facts) if ai_provider() == "huggingface" else gemini_reminder_text(facts))


def reminder_tone(days_overdue: int, reminders_sent: int) -> str:
    if reminders_sent >= 2 or days_overdue > 60:
        return "final"
    if reminders_sent >= 1 or days_overdue > 21:
        return "firm"
    return "gentle"


_OPENINGS = {
    "gentle": "We hope you are well. Our records show that the invoice below has not yet been paid in full and is now past its due date.",
    "firm": "We are following up on the invoice below, which remains unpaid past its due date despite our earlier reminder.",
    "final": "Despite our earlier reminders, the invoice below is still outstanding. We would ask you to treat this as a priority.",
}


def template_reminder_text(facts: dict[str, str]) -> dict[str, Any]:
    return {
        "subject": "Payment reminder",
        "greeting": f"Dear {facts['contactPerson'] or facts['buyerName'] or 'Sir or Madam'},",
        "paragraphs": [
            _OPENINGS[facts["tone"]],
            "Please arrange payment of the outstanding balance to the bank account below, or let us know the date payment will be made if it is already on its way.",
            "Thank you for your continued business.",
        ],
    }


def _model_text(value: Any, max_length: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > max_length or re.search(r"\d", value):
        return None
    return value


def parse_model_text(value: Any) -> dict[str, Any] | None:
    """The model's wording, or None when it is missing, too long, or contains any figure."""
    if not isinstance(value, dict):
        return None
    subject, greeting = _model_text(value.get("subject"), 120), _model_text(value.get("greeting"), 200)
    paragraphs = value.get("paragraphs")
    if subject is None or greeting is None or not isinstance(paragraphs, list) or not 1 <= len(paragraphs) <= 4:
        return None
    checked = [_model_text(p, 800) for p in paragraphs]
    if any(p is None for p in checked):
        return None
    return {"subject": subject, "greeting": greeting, "paragraphs": checked}


async def draft_text(produce: Callable[[], Awaitable[Any]], facts: dict[str, str]) -> tuple[dict[str, Any], str]:
    try:
        parsed = parse_model_text(await produce())
        if parsed:
            return parsed, "model"
        log.warning("Reminder draft rejected: wording missing, too long, or with figures")
    except Exception as error:
        log.warning("Reminder draft failed: %s", error)
    return template_reminder_text(facts), "template"


def reminder_subject(subject: str, invoice_number: str) -> str:
    one_line = re.sub(r"[\r\n]+", " ", subject).strip()
    return f"{one_line} - Invoice {invoice_number}"


def _escape(value: str) -> str:
    return html.escape(value, quote=True).replace("&#x27;", "&#39;")


def render_reminder_html(text: dict[str, Any], figures: dict[str, Any]) -> str:
    cell = "padding: 4px 12px 4px 0; vertical-align: top;"

    def row(label: str, value: str) -> str:
        if not value:
            return ""
        return f'<tr><td style="{cell} color: #64748b;">{_escape(label)}</td><td style="{cell} font-weight: 600;">{_escape(value)}</td></tr>'

    paragraphs = "\n".join(f"<p>{_escape(p)}</p>" for p in text["paragraphs"])
    bank = figures["bank"]
    signature = [_escape(v) for v in (figures["signatoryName"], figures["signatoryDesignation"], figures["exporterName"]) if v]
    return f"""<div style="font-family: Arial, sans-serif; font-size: 14px; color: #1e293b; max-width: 650px; line-height: 1.6;">
<p>{_escape(text["greeting"])}</p>
{paragraphs}
<table style="border-collapse: collapse; margin: 12px 0;">
{row("Invoice number", figures["invoiceNumber"])}
{row("Invoice date", figures["invoiceDate"] or "")}
{row("Due date", figures["dueDate"])}
{row("Invoice total", usd(figures["totalUsd"]))}
{row("Received", usd(figures["paidUsd"]))}
{row("Balance due", usd(figures["dueUsd"]))}
{row("Payment terms", figures["paymentTerms"])}
</table>
<table style="border-collapse: collapse; margin: 12px 0;">
{row("Bank", bank["bankName"])}
{row("Account number", bank["accountNumber"])}
{row("SWIFT", bank["swiftCode"])}
{row("IBAN", bank["iban"])}
</table>
<p>Kind regards,<br />{"<br />".join(signature)}</p>
</div>"""


DUE_DATE = "(COALESCE(i.invoice_date, i.created_at::date) + i.credit_days)"


async def load_invoice_for_reminder(pool: Pool, invoice_id: str, organization_id: str):
    if not is_uuid(invoice_id):
        return None
    return await pool.fetchrow(
        f"""SELECT i.id, i.invoice_number, i.status, i.data, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
                   to_char({DUE_DATE}, 'YYYY-MM-DD') AS due_date, current_date - {DUE_DATE} AS days_overdue,
                   i.total_usd,
                   COALESCE((SELECT SUM(p.amount_usd) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_usd,
                   (SELECT COUNT(*) FROM payment_reminders r WHERE r.invoice_id = i.id AND r.status = 'sent') AS sent_count,
                   (SELECT MAX(r.sent_at) FROM payment_reminders r WHERE r.invoice_id = i.id AND r.status = 'sent') AS last_sent_at
            FROM invoices i WHERE i.id = $1 AND i.organization_id = $2""",
        invoice_id,
        organization_id,
    )


def _section(data: dict, key: str) -> dict:
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def _str(section: dict, key: str) -> str:
    value = section.get(key)
    return value if value is not None else ""


def to_figures(row) -> dict[str, Any]:
    total_usd, paid_usd = float(row["total_usd"]), float(row["paid_usd"])
    data = row["data"] if isinstance(row["data"], dict) else {}
    bank = _section(data, "bank")
    return {
        "invoiceNumber": row["invoice_number"],
        "invoiceDate": row["invoice_date"],
        "dueDate": row["due_date"],
        "daysOverdue": row["days_overdue"],
        "totalUsd": total_usd,
        "paidUsd": paid_usd,
        "dueUsd": max(0.0, js_round((total_usd - paid_usd) * 100) / 100),
        "paymentTerms": _str(_section(data, "shipment"), "paymentTerms"),
        "exporterName": _str(_section(data, "exporter"), "companyName"),
        "signatoryName": _str(data, "authorizedSignatoryName"),
        "signatoryDesignation": _str(data, "authorizedSignatoryDesignation"),
        "bank": {k: _str(bank, k) for k in ("bankName", "accountNumber", "swiftCode", "iban")},
    }


def recently_reminded(last_sent_at: datetime | None) -> bool:
    return bool(last_sent_at) and datetime.now(timezone.utc) - last_sent_at < timedelta(days=REPEAT_WINDOW_DAYS)


def cannot_remind(row, figures: dict) -> str | None:
    if row["status"] != "issued":
        return f"This invoice is {row['status']}, so no reminder is needed."
    if figures["dueUsd"] <= 0:
        return "This invoice has no balance due."
    return None


async def list_overdue(pool: Pool, organization_id: str) -> list[dict]:
    rows = await pool.fetch(
        f"""SELECT i.id, i.invoice_number, i.buyer_name, i.data->'consignee'->>'email' AS buyer_email,
                   to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
                   to_char({DUE_DATE}, 'YYYY-MM-DD') AS due_date, current_date - {DUE_DATE} AS days_overdue,
                   i.total_usd, COALESCE(p.paid, 0) AS paid_usd,
                   COALESCE(r.sent_count, 0) AS sent_count, r.last_sent_at
            FROM invoices i
            LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid FROM payments WHERE invoice_id = i.id) p ON true
            LEFT JOIN LATERAL (
              SELECT COUNT(*) AS sent_count, MAX(sent_at) AS last_sent_at
              FROM payment_reminders WHERE invoice_id = i.id AND status = 'sent'
            ) r ON true
            WHERE i.organization_id = $1 AND i.status = 'issued'
              AND {DUE_DATE} < current_date
              AND i.total_usd - COALESCE(p.paid, 0) > 0
            ORDER BY days_overdue DESC, i.invoice_number""",
        organization_id,
    )
    result = []
    for row in rows:
        total_usd, paid_usd = float(row["total_usd"]), float(row["paid_usd"])
        result.append(
            {
                "id": row["id"],
                "invoiceNumber": row["invoice_number"],
                "buyerName": row["buyer_name"],
                "buyerEmail": row["buyer_email"] or "",
                "invoiceDate": row["invoice_date"],
                "dueDate": row["due_date"],
                "daysOverdue": row["days_overdue"],
                "totalUsd": total_usd,
                "paidUsd": paid_usd,
                "dueUsd": max(0.0, js_round((total_usd - paid_usd) * 100) / 100),
                "remindersSent": row["sent_count"],
                "lastReminderAt": iso(row["last_sent_at"]),
                "recentlyReminded": recently_reminded(row["last_sent_at"]),
            }
        )
    return result


async def create_reminder_draft(
    pool: Pool, user: CurrentUser, drafter: DraftReminderText, invoice_id: str, *, confirm_repeat: bool = False
) -> dict:
    """The new draft. Raises ApiError (404/409) when there is nothing to remind."""
    row = await load_invoice_for_reminder(pool, invoice_id, user.organization_id)
    if not row:
        raise ApiError(404, "Invoice not found.")
    figures = to_figures(row)
    blocked = cannot_remind(row, figures)
    if blocked:
        raise ApiError(409, blocked)
    if recently_reminded(row["last_sent_at"]) and not confirm_repeat:
        raise ApiError(
            409,
            f"A reminder for this invoice was sent in the last {REPEAT_WINDOW_DAYS} days. Confirm to draft another.",
            recentlyReminded=True,
        )

    consignee = _section(row["data"] if isinstance(row["data"], dict) else {}, "consignee")
    facts = {
        "buyerName": _str(consignee, "companyName"),
        "contactPerson": _str(consignee, "contactPerson"),
        "exporterName": figures["exporterName"],
        "tone": reminder_tone(figures["daysOverdue"], row["sent_count"]),
    }
    context = ModelCallContext("payment_reminder", REMINDER_PROMPT_VERSION, active_model_name(), user.organization_id, user.id)

    async def run() -> tuple[dict, TokenUsage | None]:
        drafted = dict(await drafter(facts))
        usage = drafted.pop("usage", None)
        return drafted, usage if isinstance(usage, TokenUsage) else None

    text, source = await draft_text(lambda: call_model(pool, context, run), facts)
    subject = reminder_subject(text["subject"], figures["invoiceNumber"])
    body_html = render_reminder_html(text, figures)
    inserted = await pool.fetchrow(
        """INSERT INTO payment_reminders (organization_id, invoice_id, created_by, model, prompt_version, subject, body_html)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at""",
        user.organization_id, row["id"], user.id, active_model_name() if source == "model" else "template",
        REMINDER_PROMPT_VERSION, subject, body_html,
    )
    log.info(json.dumps({"event": "reminder_drafted", "source": source, "tone": facts["tone"],
                         "organizationId": user.organization_id, "invoiceNumber": figures["invoiceNumber"]}))
    email = consignee.get("email")
    phone = consignee.get("phone")
    return {
        "id": inserted["id"],
        "invoiceId": row["id"],
        "status": "draft",
        "source": source,
        "tone": facts["tone"],
        "subject": text["subject"],
        "greeting": text["greeting"],
        "paragraphs": text["paragraphs"],
        "fullSubject": subject,
        "html": body_html,
        "recipients": [email] if email else [],
        "phone": phone if isinstance(phone, str) else "",
        "figures": figures,
        "createdAt": iso(inserted["created_at"]),
    }


def _edited_text(data: dict) -> dict[str, Any]:
    """The text a person approved, with the same limits the Node server used."""

    def field(key: str, label: str, max_length: int) -> str:
        value = data.get(key)
        value = value.strip() if isinstance(value, str) else ""
        if not value:
            raise ApiError(400, f"{label} is required.")
        if len(value) > max_length:
            raise ApiError(400, f"{label} is too long.")
        return value

    subject = field("subject", "Subject", 200)
    greeting = field("greeting", "Greeting", 300)
    paragraphs = data.get("paragraphs")
    if not isinstance(paragraphs, list) or not all(isinstance(p, str) for p in paragraphs):
        raise ApiError(400, "Paragraphs must be a list of text.")
    if len(paragraphs) > 10:
        raise ApiError(400, "Use at most 10 paragraphs.")
    trimmed = [p.strip() for p in paragraphs]
    if any(len(p) > 2000 for p in trimmed):
        raise ApiError(400, "A paragraph is too long.")
    return {"subject": subject, "greeting": greeting, "paragraphs": [p for p in trimmed if p]}


def build_router():
    router = api_router(prefix="/api/reminders")

    @router.get("/overdue")
    async def overdue(request: Request, user: CurrentUser = Depends(require_user)):
        return {"invoices": await list_overdue(request.app.state.pool, user.organization_id)}

    @router.post("/draft")
    async def draft(request: Request, user: CurrentUser = Depends(require_user)):
        data = body(request)
        invoice_id = data["invoiceId"] if isinstance(data.get("invoiceId"), str) else ""
        result = await create_reminder_draft(
            request.app.state.pool, user, request.app.state.options.draft_reminder_text, invoice_id,
            confirm_repeat=data.get("confirmRepeat") is True,
        )
        return JSONResponse(result, status_code=201)

    async def find_reminder(pool: Pool, reminder_id: str, user: CurrentUser):
        if not is_uuid(reminder_id):
            raise ApiError(404, "Reminder not found.")
        found = await pool.fetchrow(
            "SELECT id, invoice_id, status FROM payment_reminders WHERE id = $1 AND organization_id = $2", reminder_id, user.organization_id
        )
        if not found:
            raise ApiError(404, "Reminder not found.")
        return found

    @router.post("/{reminder_id}/send")
    async def send(reminder_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        found = await find_reminder(pool, reminder_id, user)
        if found["status"] != "draft":
            raise ApiError(409, f"This reminder was already {found['status']}.")
        row = await load_invoice_for_reminder(pool, found["invoice_id"], user.organization_id)
        if not row:
            raise ApiError(404, "Invoice not found.")
        figures = to_figures(row)
        blocked = cannot_remind(row, figures)
        if blocked:
            raise ApiError(409, blocked)

        data = body(request)
        text = _edited_text(data)
        subject = reminder_subject(text["subject"], figures["invoiceNumber"])
        body_html = render_reminder_html(text, figures)
        try:
            email = parse_email_request(
                {
                    "emailData": {
                        "recipients": data.get("recipients"),
                        "cc": data.get("cc"),
                        "subject": subject,
                        "htmlBody": body_html,
                        "invoiceNumber": figures["invoiceNumber"],
                    },
                    "smtpConfig": data["smtpConfig"] if isinstance(data.get("smtpConfig"), dict) else None,
                }
            )
        except InputError as error:
            raise ApiError(400, str(error)) from None

        result = await dispatch_email(pool, user, email, request.app.state.options.create_mail_transport)
        if not result.ok:
            raise ApiError(result.status, result.error or "")
        sent_at = await pool.fetchval(
            """UPDATE payment_reminders SET status = 'sent', subject = $3, body_html = $4, message_id = $5, sent_at = now()
               WHERE id = $1 AND organization_id = $2 AND status = 'draft'
               RETURNING sent_at""",
            found["id"], user.organization_id, subject, body_html, result.message_id,
        )
        return {"id": found["id"], "status": "sent", "mode": result.mode, "sentAt": iso(sent_at or datetime.now(timezone.utc))}

    @router.post("/{reminder_id}/discard")
    async def discard(reminder_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        if not is_uuid(reminder_id):
            raise ApiError(404, "Reminder not found.")
        updated = await pool.fetchval(
            """UPDATE payment_reminders SET status = 'discarded'
               WHERE id = $1 AND organization_id = $2 AND status = 'draft' RETURNING status""",
            reminder_id, user.organization_id,
        )
        if not updated:
            exists = await pool.fetchval("SELECT 1 FROM payment_reminders WHERE id = $1 AND organization_id = $2", reminder_id, user.organization_id)
            raise ApiError(409, "Only a draft reminder can be discarded.") if exists else ApiError(404, "Reminder not found.")
        return {"id": reminder_id, "status": "discarded"}

    return router
