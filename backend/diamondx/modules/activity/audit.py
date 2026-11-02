"""Activity history: which changes are recorded and how they are described (from server/modules/activity/audit.ts).

Only requests answered by the Python API are recorded here; proxied requests are recorded by Node.
The /api/audit read routes are still served by Node.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ...core.db import Pool
from ...core.http import CurrentUser

log = logging.getLogger("diamondx.audit")

UUID = "([0-9a-f-]{36})"


def _s(value: Any) -> str:
    """`${value ?? ''}` in JavaScript."""
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _num(value: Any) -> float:
    try:
        return float(value if value is not None else 0)
    except (TypeError, ValueError):
        return float("nan")


Summary = Callable[[dict, re.Match], str]


@dataclass(frozen=True)
class Rule:
    method: str
    pattern: re.Pattern
    action: str
    entity_type: str
    summary: Summary


def _rule(method: str, pattern: str, action: str, entity_type: str, summary: Summary | str) -> Rule:
    fn = summary if callable(summary) else (lambda _b, _m, text=summary: text)
    return Rule(method, re.compile(f"^{pattern}$"), action, entity_type, fn)


def _consignee(body: dict) -> str:
    consignee = body.get("consignee")
    return _s(consignee.get("companyName")) if isinstance(consignee, dict) else ""


def _status_summary(body: dict, _m) -> str:
    status = body.get("status")
    if status == "issued":
        return "Issued an invoice"
    if status == "cancelled":
        return "Cancelled an invoice"
    return "Changed an invoice status"


def _payment_summary(body: dict, _m) -> str:
    amount = _num(body.get("amountUsd"))
    return f"Recorded a payment of USD {'NaN' if amount != amount else f'{amount:.2f}'}"


def _truthy(value: Any) -> bool:
    """JavaScript truthiness for JSON values."""
    return value not in (None, False, 0, "") and not (isinstance(value, float) and value != value)


def _request_reply(body: dict, _m) -> str:
    file = body.get("file")
    if not _truthy(file):
        return "Replied to a request"
    name = file.get("name") if isinstance(file, dict) else None
    return f"Replied to a request with {_s(name) if name is not None else 'a file'}"


def _credit_limit(body: dict, _m) -> str:
    limit = body.get("creditLimitUsd")
    return f"Set a buyer credit limit of USD {_s(limit)}" if _truthy(limit) else "Removed a buyer credit limit"


RULES: list[Rule] = [
    _rule("POST", r"/api/invoices", "invoice.create", "invoice", "Created an invoice draft"),
    _rule("PUT", f"/api/invoices/{UUID}", "invoice.edit", "invoice", "Edited an invoice draft"),
    _rule("PATCH", f"/api/invoices/{UUID}/status", "invoice.status", "invoice", _status_summary),
    _rule("DELETE", f"/api/invoices/{UUID}", "invoice.delete", "invoice", "Deleted an invoice draft"),
    _rule("POST", f"/api/invoices/{UUID}/payments", "payment.record", "invoice", _payment_summary),
    _rule("PATCH", f"/api/invoices/{UUID}/payments/{UUID}", "payment.edit", "invoice", "Changed a payment (bank rate or details)"),
    _rule("DELETE", f"/api/invoices/{UUID}/payments/{UUID}", "payment.delete", "invoice", "Deleted a payment"),
    _rule("PUT", f"/api/invoices/{UUID}/tax", "invoice.tax", "invoice", "Updated shipping bill and tax details"),
    _rule("PUT", f"/api/invoices/{UUID}/einvoice", "invoice.einvoice", "invoice", "Recorded the e-invoice IRN"),
    _rule("POST", f"/api/invoices/{UUID}/documents", "document.upload", "invoice", lambda b, _m: f"Uploaded a {_s(b.get('kind') if b.get('kind') is not None else 'document').replace('_', ' ')}"),
    _rule("DELETE", f"/api/invoices/{UUID}/documents/{UUID}", "document.delete", "invoice", "Deleted a document"),
    _rule("PUT", f"/api/invoices/{UUID}/review", "invoice.review", "invoice", lambda b, _m: "Accepted an invoice (CA review)" if b.get("status") == "accepted" else "Raised a query on an invoice (CA review)"),
    _rule("POST", r"/api/bank/import", "bank.import", "bank", "Imported a bank statement"),
    _rule("POST", r"/api/bank/import-lines", "bank.import", "bank", lambda b, _m: f"Imported {len(b['lines']) if isinstance(b.get('lines'), list) else 0} bank lines read by AI"),
    _rule("POST", f"/api/bank/lines/{UUID}/match", "bank.match", "bank_line", "Matched a bank credit to an invoice"),
    _rule("POST", f"/api/bank/lines/{UUID}/ignore", "bank.ignore", "bank_line", "Ignored a bank line"),
    _rule("POST", r"/api/tax/months/(\d{4}-\d{2})/close", "month.close", "month", lambda _b, m: f"Closed the books for {m.group(1)}"),
    _rule("POST", r"/api/tax/months/(\d{4}-\d{2})/open", "month.open", "month", lambda _b, m: f"Reopened {m.group(1)}"),
    _rule("PUT", r"/api/tax/settings", "tax.settings", "settings", "Changed tax settings (LUT, realization period)"),
    _rule("POST", r"/api/tax/ebrc/import", "ebrc.import", "ebrc", "Imported e-BRCs"),
    _rule("PUT", r"/api/company", "company.edit", "company", "Edited the company profile"),
    _rule("POST", r"/api/buyers", "buyer.create", "buyer", lambda b, _m: f"Added buyer {_consignee(b)}".strip()),
    _rule("PUT", f"/api/buyers/{UUID}", "buyer.edit", "buyer", lambda b, _m: f"Edited buyer {_consignee(b)}".strip()),
    _rule("DELETE", f"/api/buyers/{UUID}", "buyer.delete", "buyer", "Deleted a buyer"),
    _rule("POST", r"/api/team/members", "team.add", "user", lambda b, _m: f"Added team member {_s(b.get('email'))}".strip()),
    _rule("PATCH", f"/api/team/members/{UUID}", "team.role", "user", lambda b, _m: f"Changed a team member's role to {_s(b.get('role'))}".strip()),
    _rule("DELETE", f"/api/team/members/{UUID}", "team.remove", "user", "Removed a team member"),
    _rule("POST", r"/api/team/accountants", "team.ca", "user", lambda b, _m: f"Gave {_s(b['email']) if b.get('email') is not None else 'an accountant'} access".strip()),
    _rule("DELETE", f"/api/team/accountants/{UUID}", "team.ca_remove", "user", "Removed an accountant's access"),
    _rule("POST", r"/api/send-email", "email.send", "email", "Emailed an invoice"),
    _rule("POST", f"/api/reminders/{UUID}/send", "reminder.send", "reminder", "Sent a payment reminder"),
    _rule("POST", f"/api/assistant/actions/{UUID}/confirm", "assistant.confirm", "assistant_action", "Confirmed a change proposed by the assistant"),
    _rule("PUT", r"/api/rates/company", "rate.set", "rate", lambda b, _m: f"Set the company rate for {_s(b.get('date'))} to ₹{_s(b.get('rateInr'))}"),
    _rule("DELETE", r"/api/rates/company/([0-9-]+)", "rate.delete", "rate", lambda _b, m: f"Removed the company rate for {m.group(1)}"),
    _rule("POST", r"/api/parcels", "parcel.create", "parcel", lambda b, _m: f"Received parcel {_s(b.get('parcelId'))} ({_s(b.get('caratsIn'))} ct)"),
    _rule("PUT", f"/api/parcels/{UUID}", "parcel.edit", "parcel", lambda b, _m: f"Edited parcel {_s(b.get('parcelId'))}".strip()),
    _rule("DELETE", f"/api/parcels/{UUID}", "parcel.delete", "parcel", "Deleted a parcel"),
    _rule("POST", r"/api/portal-links", "portal.create", "portal_link", lambda b, _m: f"Created a buyer portal link for {_s(b.get('buyerName'))}".strip()),
    _rule("DELETE", f"/api/portal-links/{UUID}", "portal.revoke", "portal_link", "Revoked a buyer portal link"),
    _rule("POST", r"/api/purchases", "purchase.create", "purchase", lambda b, _m: f"Recorded purchase {_s(b.get('documentNo'))} from {_s(b.get('supplierName'))}".strip()),
    _rule("PUT", f"/api/purchases/{UUID}", "purchase.edit", "purchase", lambda b, _m: f"Edited purchase {_s(b.get('documentNo'))}".strip()),
    _rule("DELETE", f"/api/purchases/{UUID}", "purchase.delete", "purchase", "Deleted a purchase"),
    _rule("POST", r"/api/purchases/gstr2b", "gstr2b.import", "gstr2b", lambda b, _m: f"Imported GSTR-2B for {_s(b.get('month'))}".strip()),
    _rule("POST", r"/api/foreign-payments", "foreign_payment.create", "foreign_payment", lambda b, _m: f"Recorded a payment abroad to {_s(b.get('payeeName'))}".strip()),
    _rule("PUT", f"/api/foreign-payments/{UUID}", "foreign_payment.edit", "foreign_payment", lambda b, _m: f"Edited a payment abroad to {_s(b.get('payeeName'))}".strip()),
    _rule("DELETE", f"/api/foreign-payments/{UUID}", "foreign_payment.delete", "foreign_payment", "Deleted a payment abroad"),
    _rule("POST", r"/api/tally/import", "tally.import", "tally", "Imported vouchers from Tally"),
    _rule("DELETE", r"/api/tally/vouchers", "tally.clear", "tally", "Cleared imported Tally vouchers"),
    _rule("POST", r"/api/requests", "request.create", "request", lambda b, _m: f"Asked: {_s(b.get('title') if b.get('title') is not None else '')[:120]}"),
    _rule("POST", f"/api/requests/{UUID}/messages", "request.reply", "request", _request_reply),
    _rule("POST", f"/api/requests/{UUID}/status", "request.status", "request", lambda b, _m: "Closed a request" if b.get("status") == "closed" else "Reopened a request"),
    _rule("POST", r"/api/notices", "notice.create", "notice", lambda b, _m: f"Logged notice {_s(b.get('formType'))} {_s(b.get('referenceNo'))}".strip()),
    _rule("PUT", f"/api/notices/{UUID}", "notice.edit", "notice", lambda b, _m: f"Updated notice {_s(b.get('formType'))} ({_s(b.get('status')) if b.get('status') is not None else 'open'})".strip()),
    _rule("DELETE", f"/api/notices/{UUID}", "notice.delete", "notice", "Deleted a notice"),
    _rule("POST", f"/api/notices/{UUID}/draft-reply", "notice.draft", "notice", "Drafted a notice reply"),
    _rule("POST", r"/api/billing/checkout", "billing.checkout", "billing", lambda b, _m: f"Started checkout for the {_s(b.get('plan'))} plan ({_s(b.get('cycle'))})"),
    _rule("POST", r"/api/billing/verify", "billing.paid", "billing", "Paid for a plan"),
    _rule("POST", r"/api/billing/bank-transfer", "billing.bank_transfer", "billing", lambda b, _m: f"Chose to pay the {_s(b.get('plan'))} plan ({_s(b.get('cycle'))}) by bank transfer"),
    _rule("POST", f"/api/billing/bank-transfer/{UUID}/submit", "billing.bank_transfer_sent", "billing", lambda b, _m: f"Sent bank transfer UTR {_s(b.get('utr') if b.get('utr') is not None else '')[:30]} for checking"),
    _rule("POST", r"/api/billing/paypal/capture", "billing.paypal", "billing", "Paid for a plan by PayPal"),
    _rule("POST", r"/api/billing/cancel", "billing.cancel", "billing", "Turned off plan renewal"),
    _rule("PUT", f"/api/buyers/{UUID}/credit-limit", "buyer.credit_limit", "buyer", _credit_limit),
]


@dataclass(frozen=True)
class PendingAudit:
    user: CurrentUser
    rule: Rule
    entity_id: str
    summary: str
    method: str
    path: str


def describe_change(method: str, path: str, user: CurrentUser | None, body: dict) -> PendingAudit | None:
    if not user:
        return None
    for rule in RULES:
        if rule.method != method:
            continue
        match = rule.pattern.match(path)
        if match:
            entity_id = match.group(1) if match.groups() and match.group(1) else ""
            return PendingAudit(user, rule, entity_id, rule.summary(body, match)[:300], method, path)
    return None


async def record_change(pool: Pool, pending: PendingAudit) -> None:
    """Written before the response is sent, so the entry is not lost when a serverless function freezes."""
    try:
        await pool.execute(
            """INSERT INTO audit_events (organization_id, user_id, user_email, action, summary, entity_type, entity_id, method, path)
               VALUES ($1, $2, $3, $4,
                 $5 || COALESCE((SELECT ' ' || invoice_number FROM invoices WHERE $6 = 'invoice' AND id::text = $7 AND organization_id = $1), ''),
                 $6, $7, $8, $9)""",
            pending.user.organization_id,
            pending.user.id,
            pending.user.email,
            pending.rule.action,
            pending.summary,
            pending.rule.entity_type,
            pending.entity_id,
            pending.method,
            pending.path,
        )
    except Exception as error:  # the change itself succeeded; losing the history line must not fail it
        log.error("Could not record activity: %s", error)

