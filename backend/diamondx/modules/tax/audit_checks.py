"""Checks a tax auditor would otherwise sample by hand (port of server/modules/tax/auditChecks.ts)."""

from __future__ import annotations

import re
from datetime import date

from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import CurrentUser
from ...core.numbers import js_number, money, to_fixed
from .export_reports import month_range
from .foreign_payments import foreign_payments_between
from .shared import csv_file, csv_response, tax_reader

CHECK_LABELS = {
    "numbering_gap": "Gap in invoice numbers",
    "numbering_duplicate": "Same invoice number twice",
    "edited_while_reopened": "Changed while a closed month was reopened",
    "rate_outlier": "Rate per carat far from normal",
    "payment_unmatched": "Payment with no bank credit",
    "overpaid": "Received more than the invoice total",
    "payment_before_invoice": "Payment dated before the invoice",
    "round_amount": "Round-figure amount",
    "sunday_invoice": "Invoice dated on a Sunday",
    "no_shipping_bill": "Issued over 30 days ago with no shipping bill",
    "foreign_no_tds": "Foreign payment without TDS",
    "foreign_no_15ca": "Foreign payment without Form 15CA",
}

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}
MAX_GAPS_LISTED = 25
INVOICE_DATE = "COALESCE(i.invoice_date, i.created_at::date)"


def median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def invoice_series(invoice_number: str) -> dict | None:
    """Splits EXP/2026-27/0012 into its series (EXP/2026-27/) and number (12)."""
    match = re.match(r"^(.*?)(\d+)$", invoice_number.strip(), re.DOTALL)
    if not match:
        return None
    return {"prefix": match.group(1), "series": match.group(1).upper(), "number": int(match.group(2)), "width": len(match.group(2))}


def numbering_gaps(numbers: list[str]) -> list[dict]:
    """Missing numbers in each invoice series. Drafts hold numbers too, so they count as used."""
    by_series: dict[str, dict] = {}
    for invoice_number in numbers:
        parsed = invoice_series(invoice_number)
        if not parsed:
            continue
        entry = by_series.setdefault(parsed["series"], {"numbers": set(), "width": parsed["width"], "prefix": parsed["prefix"]})
        entry["numbers"].add(parsed["number"])
    gaps = []
    for series, entry in by_series.items():
        if len(entry["numbers"]) < 2:
            continue
        ordered = sorted(entry["numbers"])
        missing = [f"{entry['prefix']}{str(n).zfill(entry['width'])}" for n in range(ordered[0] + 1, ordered[-1]) if n not in entry["numbers"]]
        if missing:
            gaps.append({"series": series, "missing": missing})
    return gaps


async def audit_checks(pool: Pool, organization_id: str, start: date, end: date) -> list[dict]:
    findings: list[dict] = []

    def add(id: str, check: str, severity: str, detail: str, invoice_id: str | None = None, invoice_number: str | None = None) -> None:
        findings.append({"id": id, "check": check, "severity": severity, "title": CHECK_LABELS.get(check, check), "detail": detail,
                         "invoiceId": invoice_id, "invoiceNumber": invoice_number})

    invoices = await pool.fetch(
        f"""SELECT i.id, i.invoice_number, i.status, to_char({INVOICE_DATE}, 'YYYY-MM-DD') AS invoice_date, i.total_usd,
                   EXTRACT(DOW FROM {INVOICE_DATE})::int AS dow, t.shipping_bill_no, i.data->'items' AS items,
                   COALESCE((SELECT SUM(amount_usd) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_usd,
                   (SELECT to_char(MIN(paid_on), 'YYYY-MM-DD') FROM payments p WHERE p.invoice_id = i.id) AS first_paid
            FROM invoices i LEFT JOIN invoice_tax t ON t.invoice_id = i.id
            WHERE i.organization_id = $1 AND {INVOICE_DATE} BETWEEN $2 AND $3
            ORDER BY {INVOICE_DATE}, i.invoice_number""",
        organization_id, start, end,
    )

    # Numbering: every number in a series between the lowest and highest should exist.
    for gap in numbering_gaps([row["invoice_number"] for row in invoices]):
        missing = gap["missing"]
        listed = ", ".join(missing[:MAX_GAPS_LISTED])
        more = ", …" if len(missing) > MAX_GAPS_LISTED else ""
        add(f"numbering_gap:{gap['series']}", "numbering_gap", "high",
            f"{len(missing)} number{'' if len(missing) == 1 else 's'} missing in {gap['series']}…: {listed}{more}. "
            "Keep a note of why (deleted draft, typing error) for the auditor.")
    seen: dict[str, list[str]] = {}
    for row in invoices:
        seen.setdefault(row["invoice_number"].strip().upper(), []).append(row["invoice_number"])
    for normalized, numbers in seen.items():
        if len(numbers) > 1:
            add(f"numbering_duplicate:{normalized}", "numbering_duplicate", "high",
                f"{' and '.join(numbers)} differ only in capitals or spaces.", None, numbers[0])

    issued = [row for row in invoices if row["status"] in ("issued", "paid")]
    today = date.today()
    for row in issued:
        total_usd, paid_usd = money(row["total_usd"]), money(row["paid_usd"])
        base = (row["id"], row["invoice_number"])
        if paid_usd > total_usd + 0.01:
            add(f"overpaid:{row['id']}", "overpaid", "medium",
                f"Received USD {to_fixed(paid_usd, 2)} against a total of USD {to_fixed(total_usd, 2)}. "
                "Refund, adjust against another invoice, or record it as an advance.", *base)
        if row["first_paid"] and row["first_paid"] < row["invoice_date"]:
            add(f"payment_before_invoice:{row['id']}", "payment_before_invoice", "low",
                f"First payment on {row['first_paid']}, invoice dated {row['invoice_date']}. Fine for an advance; keep the bank advice (FIRC) on file.", *base)
        if total_usd >= 5000 and total_usd % 1000 == 0:
            add(f"round_amount:{row['id']}", "round_amount", "low", f"Invoice total is exactly USD {to_fixed(total_usd, 2)}.", *base)
        if row["dow"] == 0:
            add(f"sunday_invoice:{row['id']}", "sunday_invoice", "low",
                f"Dated {row['invoice_date']}, a Sunday. Check the date against the shipping bill and airway bill.", *base)
        age_days = (today - date.fromisoformat(row["invoice_date"])).days
        if not row["shipping_bill_no"] and age_days > 30:
            add(f"no_shipping_bill:{row['id']}", "no_shipping_bill", "medium",
                f"Issued {row['invoice_date']} and no shipping bill number recorded. Without it the export cannot be shown in GSTR-1 table 6A.", *base)

    # Rate per carat: compare each line with lines of the same HS code and shape.
    groups: dict[str, list[dict]] = {}
    for row in issued:
        for index, item in enumerate(row["items"] if isinstance(row["items"], list) else []):
            rate = js_number(item.get("ratePerCarat")) if "ratePerCarat" in item else float("nan")
            if not rate > 0:
                continue
            hs = re.sub(r"\D", "", "" if item.get("hsCode") is None else str(item.get("hsCode")))
            shape = ("" if item.get("shape") is None else str(item.get("shape"))).strip().lower()
            sr_no = js_number(item.get("srNo")) if item.get("srNo") is not None else 0
            groups.setdefault(f"{hs}|{shape}", []).append({
                "rate": rate, "invoiceId": row["id"], "invoiceNumber": row["invoice_number"],
                "line": int(sr_no) if sr_no == sr_no and sr_no else index + 1,
                "description": "" if item.get("description") is None else str(item.get("description")),
            })
    for group_key, lines in groups.items():
        if len(lines) < 5:
            continue
        middle = median([line["rate"] for line in lines])
        for line in lines:
            if line["rate"] > middle * 3 or line["rate"] < middle / 3:
                add(f"rate_outlier:{line['invoiceId']}:{line['line']}", "rate_outlier", "medium",
                    f"Line {line['line']} ({line['description'] or group_key}) at USD {to_fixed(line['rate'], 2)}/ct; similar lines are around "
                    f"USD {to_fixed(middle, 2)}/ct. Keep the reason (quality, size) for valuation queries.",
                    line["invoiceId"], line["invoiceNumber"])

    # Payments with no bank credit, once a statement covering that date has been imported.
    payments = await pool.fetch(
        """SELECT p.id, p.invoice_id, i.invoice_number, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd,
                  EXISTS (SELECT 1 FROM bank_lines b WHERE b.organization_id = p.organization_id
                            AND b.line_date BETWEEN p.paid_on - 15 AND p.paid_on + 15) AS covered,
                  EXISTS (SELECT 1 FROM bank_lines b WHERE b.payment_id = p.id) AS matched
           FROM payments p JOIN invoices i ON i.id = p.invoice_id
           WHERE p.organization_id = $1 AND p.paid_on BETWEEN $2 AND $3""",
        organization_id, start, end,
    )
    for payment in payments:
        if not payment["matched"] and payment["covered"]:
            add(f"payment_unmatched:{payment['id']}", "payment_unmatched", "medium",
                f"USD {to_fixed(money(payment['amount_usd']), 2)} recorded on {payment['paid_on']} is not matched to any imported bank credit.",
                payment["invoice_id"], payment["invoice_number"])

    # Changes made while a closed month was open again.
    reopened = await pool.fetch(
        f"""SELECT e.id, e.entity_id, i.invoice_number, e.summary, e.user_email, e.created_at, to_char({INVOICE_DATE}, 'YYYY-MM') AS month
            FROM audit_events e
            JOIN invoices i ON i.id::text = e.entity_id AND i.organization_id = e.organization_id
            WHERE e.organization_id = $1 AND e.entity_type = 'invoice' AND {INVOICE_DATE} BETWEEN $2 AND $3
              AND (SELECT m.action FROM audit_events m
                   WHERE m.organization_id = e.organization_id AND m.entity_type = 'month'
                     AND m.entity_id = to_char({INVOICE_DATE}, 'YYYY-MM') AND m.created_at < e.created_at
                   ORDER BY m.created_at DESC LIMIT 1) = 'month.open'
            ORDER BY e.created_at""",
        organization_id, start, end,
    )
    for event in reopened:
        add(f"edited_while_reopened:{event['id']}", "edited_while_reopened", "high",
            f"{event['summary']} by {event['user_email'] or 'someone'} on {event['created_at'].date().isoformat()}, "
            f"after {event['month']} had been closed and reopened.",
            event["entity_id"], event["invoice_number"])

    for payment in await foreign_payments_between(pool, organization_id, start, end):
        if payment["taxableInIndia"] and payment["tdsInr"] == 0:
            add(f"foreign_no_tds:{payment['id']}", "foreign_no_tds", "high",
                f"₹{to_fixed(payment['amountInr'], 2)} to {payment['payeeName']} on {payment['paidOn']} ({payment['nature']}) with no TDS.")
        if not payment["form15caAck"]:
            add(f"foreign_no_15ca:{payment['id']}", "foreign_no_15ca", "medium",
                f"{payment['payeeName']}, {payment['paidOn']}: no Form 15CA acknowledgement recorded.")

    return sorted(findings, key=lambda f: (SEVERITY_ORDER[f["severity"]], f["check"]))


def summarize_findings(findings: list[dict]) -> dict:
    by_check: dict[str, int] = {}
    for finding in findings:
        by_check[finding["check"]] = by_check.get(finding["check"], 0) + 1
    return {
        "high": sum(1 for f in findings if f["severity"] == "high"),
        "medium": sum(1 for f in findings if f["severity"] == "medium"),
        "low": sum(1 for f in findings if f["severity"] == "low"),
        "byCheck": by_check,
    }


def findings_csv(findings: list[dict]) -> bytes:
    return csv_file(["Severity", "Check", "Invoice", "Detail"], [[f["severity"], f["title"], f["invoiceNumber"] or "", f["detail"]] for f in findings])


def build_router():
    router = api_router(prefix="/api/tax/audit-checks")

    @router.get("")
    async def checks(request: Request, user: CurrentUser = Depends(tax_reader)):
        r = month_range(request)
        findings = await audit_checks(request.app.state.pool, user.organization_id, r["start"], r["end"])
        return {"from": r["from"], "to": r["to"], "findings": findings, "summary": summarize_findings(findings), "labels": CHECK_LABELS}

    @router.get("/csv")
    async def checks_csv(request: Request, user: CurrentUser = Depends(tax_reader)):
        r = month_range(request)
        findings = await audit_checks(request.app.state.pool, user.organization_id, r["start"], r["end"])
        return csv_response(f"audit-checks-{r['from']}-to-{r['to']}.csv", findings_csv(findings))

    return router
