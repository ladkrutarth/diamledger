"""Figures a tax auditor needs for Form 3CD, collected from the books (port of server/modules/tax/auditPack.ts).

Each section names the clause it helps with. The auditor still checks and signs; this saves gathering numbers.
"""

from __future__ import annotations

import asyncio
from datetime import date

from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import current_financial_year, financial_year_dates
from ...core.http import ApiError, CurrentUser
from ...core.numbers import js_string, money, round_to, to_fixed
from ..stock.stock import stock_csv, stock_register
from .audit_checks import audit_checks, findings_csv, summarize_findings
from .foreign_payments import foreign_payment_totals, foreign_payments_between
from .forex import forex_summary
from .purchases import purchase_csv, purchase_summary
from .shared import csv_file, tax_reader, tax_settings, zip_response


def months_of(start: str) -> list[str]:
    year = int(start[:4])
    return [f"{year + (3 + i) // 12}-{(3 + i) % 12 + 1:02d}" for i in range(12)]


def _sum(items, key) -> float:
    total = 0.0
    for item in items:
        total += key(item)
    return total


async def audit_pack(pool: Pool, organization_id: str, year: str) -> dict:
    period = financial_year_dates(year)
    if not period:
        raise ApiError(400, "Financial year should look like 2026-27.")
    start, end = period["start"], period["end"]
    start_date, end_date = date.fromisoformat(start), date.fromisoformat(end)
    settings = await tax_settings(pool, organization_id)

    sales = await pool.fetch(
        """SELECT COALESCE(t.export_scheme, 'lut') AS scheme,
                  COUNT(*) FILTER (WHERE i.status IN ('issued', 'paid')) AS count,
                  COALESCE(SUM(i.total_usd) FILTER (WHERE i.status IN ('issued', 'paid')), 0) AS usd,
                  COALESCE(SUM(i.total_usd * NULLIF(i.data->>'exchangeRateInr', '')::numeric)
                    FILTER (WHERE i.status IN ('issued', 'paid') AND COALESCE(NULLIF(i.data->>'exchangeRateInr', '')::numeric, 0) > 0), 0) AS inr,
                  COUNT(*) FILTER (WHERE i.status IN ('issued', 'paid') AND COALESCE(NULLIF(i.data->>'exchangeRateInr', '')::numeric, 0) <= 0) AS missing_rate,
                  COUNT(*) FILTER (WHERE i.status = 'cancelled') AS cancelled,
                  COALESCE(SUM(i.total_carats) FILTER (WHERE i.status IN ('issued', 'paid')), 0) AS carats
           FROM invoices i LEFT JOIN invoice_tax t ON t.invoice_id = i.id
           WHERE i.organization_id = $1 AND i.status <> 'draft' AND COALESCE(i.invoice_date, i.created_at::date) BETWEEN $2 AND $3
           GROUP BY 1""",
        organization_id, start_date, end_date,
    )

    def scheme(name: str) -> dict:
        row = next((r for r in sales if r["scheme"] == name), None)
        return {
            "invoices": row["count"] if row else 0,
            "valueUsd": money(row["usd"] if row else 0),
            "valueInr": money(row["inr"] if row else 0),
            "missingRate": row["missing_rate"] if row else 0,
            "carats": round_to(float(row["carats"]) if row else 0, 3),
        }

    lut, igst = scheme("lut"), scheme("igst")
    turnover = {
        "lut": lut,
        "igst": igst,
        "totalUsd": money(lut["valueUsd"] + igst["valueUsd"]),
        "totalInr": money(lut["valueInr"] + igst["valueInr"]),
        "missingRate": lut["missingRate"] + igst["missingRate"],
        "cancelled": sum(r["cancelled"] for r in sales),
    }

    # Receivables outstanding at the year end, and those past the FEMA realization period at that date.
    receivables = await pool.fetch(
        """SELECT i.id, i.invoice_number, i.buyer_name, to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
                  to_char(COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS shipped_on,
                  i.total_usd, COALESCE((SELECT SUM(amount_usd) FROM payments p WHERE p.invoice_id = i.id AND p.paid_on <= $2), 0) AS paid_usd,
                  (COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date) + make_interval(months => $3))::date < $2::date AS past_deadline
           FROM invoices i LEFT JOIN invoice_tax t ON t.invoice_id = i.id
           WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND COALESCE(i.invoice_date, i.created_at::date) <= $2
           ORDER BY 5""",
        organization_id, end_date, settings["realizationMonths"],
    )
    outstanding = [
        {
            "invoiceId": r["id"],
            "invoiceNumber": r["invoice_number"],
            "buyerName": r["buyer_name"],
            "invoiceDate": r["invoice_date"],
            "shippedOn": r["shipped_on"],
            "dueUsd": money(float(r["total_usd"]) - float(r["paid_usd"])),
            "pastRealizationPeriod": r["past_deadline"],
        }
        for r in receivables
    ]
    outstanding = [row for row in outstanding if row["dueUsd"] > 0.009]

    forex_months = [await forex_summary(pool, organization_id, month) for month in months_of(start)]
    forex = {
        "gainInr": money(_sum(forex_months, lambda m: m["totals"]["gainInr"])),
        "lossInr": money(_sum(forex_months, lambda m: m["totals"]["lossInr"])),
        "netInr": money(_sum(forex_months, lambda m: m["totals"]["netInr"])),
        "paymentsWithoutRate": sum(m["missingRateCount"] for m in forex_months),
        "byMonth": [{"month": m["month"], "netInr": m["totals"]["netInr"], "missing": m["missingRateCount"]} for m in forex_months],
    }

    purchases, stock, foreign_payments, findings = await asyncio.gather(
        purchase_summary(pool, organization_id, start_date, end_date),
        stock_register(pool, organization_id, year),
        foreign_payments_between(pool, organization_id, start_date, end_date),
        audit_checks(pool, organization_id, start_date, end_date),
    )
    related_foreign = [p for p in foreign_payments if p["relatedParty"]]

    return {
        "year": year,
        "start": start,
        "end": end,
        "turnover": turnover,
        "receivables": {
            "rows": outstanding,
            "totalUsd": money(_sum(outstanding, lambda r: r["dueUsd"])),
            "pastRealizationUsd": money(_sum([r for r in outstanding if r["pastRealizationPeriod"]], lambda r: r["dueUsd"])),
            "realizationMonths": settings["realizationMonths"],
        },
        "forex": forex,
        "purchases": {k: purchases[k] for k in ("imports", "registered", "unregistered", "total")},
        "stock": {k: stock[k] for k in ("rough", "polished", "yieldPercent", "processLossCarats", "negativeParcels")},
        "tds": foreign_payment_totals(foreign_payments),
        "relatedParty": {
            "purchases": purchases["relatedParty"],
            "foreignPayments": {"count": len(related_foreign), "amountInr": money(_sum(related_foreign, lambda p: p["amountInr"]))},
        },
        "checks": summarize_findings(findings),
        "_detail": {"purchases": purchases["purchases"], "stock": stock, "foreignPayments": foreign_payments, "findings": findings},
    }


def audit_pack_summary_rows(pack: dict) -> list[list]:
    """One row per figure, with the Form 3CD clause it supports."""

    def ct(value: float) -> str:
        return to_fixed(value, 3)

    def f2(value: float) -> str:
        return to_fixed(value, 2)

    t, s, p, tds, rp, fx, rec, checks = (pack["turnover"], pack["stock"], pack["purchases"], pack["tds"], pack["relatedParty"],
                                          pack["forex"], pack["receivables"], pack["checks"])
    rough, polished = s["rough"], s["polished"]
    return [
        ["Turnover", "Exports under LUT (zero rated)", f"{t['lut']['invoices']} invoices", f2(t["lut"]["valueUsd"]), f2(t["lut"]["valueInr"])],
        ["Turnover", "Exports with IGST paid", f"{t['igst']['invoices']} invoices", f2(t["igst"]["valueUsd"]), f2(t["igst"]["valueInr"])],
        ["Turnover", "Invoices with no exchange rate (INR not counted)", str(t["missingRate"]), "", ""],
        ["Turnover", "Cancelled invoices", str(t["cancelled"]), "", ""],
        ["Clause 35", "Rough: opening / purchased / used in manufacture / sold / closing (ct)",
         " / ".join(ct(v) for v in (rough["opening"], rough["purchased"], rough["consumed"], rough["sold"], rough["closing"])), "",
         f2(rough["closingValueInr"])],
        ["Clause 35", "Polished: opening / purchased / produced / sold / closing (ct)",
         " / ".join(ct(v) for v in (polished["opening"], polished["purchased"], polished["produced"], polished["sold"], polished["closing"])), "",
         f2(polished["closingValueInr"])],
        ["Clause 35", "Yield from rough to polished",
         "No manufacturing recorded" if s["yieldPercent"] is None else f"{js_string(s['yieldPercent'])}%", "", ""],
        ["Clause 35", "Process loss (ct)", ct(s["processLossCarats"]), "", ""],
        ["Clause 44", "Imports (Bill of Entry)", f"{p['imports']['count']} entries", "", f2(p["imports"]["taxableInr"])],
        ["Clause 44", "Purchases from GST-registered suppliers", f"{p['registered']['count']} invoices", "", f2(p["registered"]["taxableInr"])],
        ["Clause 44", "Purchases from unregistered suppliers", f"{p['unregistered']['count']} invoices", "", f2(p["unregistered"]["taxableInr"])],
        ["Clause 44", "GST paid on purchases", "", "", f2(p["total"]["taxInr"])],
        ["Clause 34", "Payments outside India / TDS deducted", f"{tds['count']} payments", "", f"{f2(tds['amountInr'])} / {f2(tds['tdsInr'])}"],
        ["Clause 34 / 21", "Taxable foreign payments with no TDS (possible disallowance u/s 40(a)(i))", f"{tds['withoutTds']} payments", "",
         f2(tds["withoutTdsInr"])],
        ["Clause 34", "Form 15CA / 15CB not recorded", f"{tds['missing15ca']} / {tds['missing15cb']}", "", ""],
        ["Clause 23", "Purchases from related parties", f"{rp['purchases']['count']} invoices", "", f2(rp["purchases"]["taxableInr"])],
        ["Clause 23", "Payments abroad to related parties", f"{rp['foreignPayments']['count']} payments", "", f2(rp["foreignPayments"]["amountInr"])],
        ["Forex", "Exchange gain / loss / net on realization", "", "", f"{f2(fx['gainInr'])} / {f2(fx['lossInr'])} / {f2(fx['netInr'])}"],
        ["Forex", "Receipts without a bank rate (not counted)", str(fx["paymentsWithoutRate"]), "", ""],
        ["FEMA", f"Receivables at year end / past the {rec['realizationMonths']}-month realization period (USD)", "",
         f"{f2(rec['totalUsd'])} / {f2(rec['pastRealizationUsd'])}", ""],
        ["Checks", "Audit check findings (high / medium / low)", f"{checks['high']} / {checks['medium']} / {checks['low']}", "", ""],
    ]


def build_router():
    router = api_router(prefix="/api/tax/audit-pack")

    def year_of(request: Request) -> str:
        return request.query_params.get("year") or current_financial_year()

    @router.get("")
    async def pack(request: Request, user: CurrentUser = Depends(tax_reader)):
        result = await audit_pack(request.app.state.pool, user.organization_id, year_of(request))
        summary = audit_pack_summary_rows(result)
        result.pop("_detail")
        return {**result, "summary": summary}

    @router.get("/zip")
    async def pack_zip(request: Request, user: CurrentUser = Depends(tax_reader)):
        year = year_of(request)
        result = await audit_pack(request.app.state.pool, user.organization_id, year)
        detail = result["_detail"]
        yes = lambda value: "Yes" if value else "No"  # noqa: E731
        files = [
            ("summary.csv", csv_file(["Area / clause", "Item", "Count or quantity", "USD", "INR"], audit_pack_summary_rows(result))),
            ("stock-register-clause-35.csv", stock_csv(detail["stock"])),
            ("purchase-register.csv", purchase_csv(detail["purchases"])),
            ("foreign-payments-tds.csv", csv_file(
                ["Paid on", "Payee", "Country", "Nature", "Amount INR", "TDS INR", "Form 15CA part", "15CA ack", "15CB no", "Related party", "Issues"],
                [[p["paidOn"], p["payeeName"], p["payeeCountry"], p["nature"], to_fixed(p["amountInr"], 2), to_fixed(p["tdsInr"], 2),
                  p["form15caPart"], p["form15caAck"], p["form15cbNo"], yes(p["relatedParty"]), "; ".join(i["text"] for i in p["issues"])]
                 for p in detail["foreignPayments"]],
            )),
            ("receivables-at-year-end.csv", csv_file(
                ["Invoice", "Buyer", "Invoice date", "Shipped on", "Due USD", "Past realization period"],
                [[r["invoiceNumber"], r["buyerName"], r["invoiceDate"], r["shippedOn"], to_fixed(r["dueUsd"], 2), yes(r["pastRealizationPeriod"])]
                 for r in result["receivables"]["rows"]],
            )),
            ("forex-by-month.csv", csv_file(
                ["Month", "Net gain (loss) INR", "Receipts without bank rate"],
                [[m["month"], to_fixed(m["netInr"], 2), m["missing"]] for m in result["forex"]["byMonth"]],
            )),
            ("audit-checks.csv", findings_csv(detail["findings"])),
        ]
        return zip_response(f"tax-audit-pack-{year}.zip", files)

    return router
