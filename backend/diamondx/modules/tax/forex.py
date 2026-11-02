"""Exchange gain or loss on export receipts, and Tally receipt vouchers (port of server/modules/tax/forex.ts)."""

from __future__ import annotations

from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import CurrentUser
from ...core.numbers import js_number, js_string, money, to_fixed
from .closed_months import parse_month
from .rates import rate_lateral
from .shared import csv_file, csv_response, current_month, download_response, tax_reader

FOREX_LEDGER = "Foreign Exchange Gain / Loss"


async def forex_rows(pool: Pool, organization_id: str, month: str) -> list[dict]:
    rows = await pool.fetch(
        f"""SELECT p.id AS payment_id, i.id AS invoice_id, i.invoice_number, i.buyer_name,
                   to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd, p.reference, p.bank_rate_inr,
                   i.data->>'exchangeRateInr' AS invoice_rate_inr,
                   i.data->'bank'->>'bankName' AS bank_name,
                   i.data->'exporter'->>'companyName' AS company_name,
                   to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
                   pr.rate_inr AS ref_paid_rate, pr.rate_source AS ref_paid_source,
                   ir.rate_inr AS ref_invoice_rate, ir.rate_source AS ref_invoice_source
            FROM payments p
            JOIN invoices i ON i.id = p.invoice_id
            LEFT JOIN LATERAL {rate_lateral('p.organization_id', 'p.paid_on')} pr ON true
            LEFT JOIN LATERAL {rate_lateral('p.organization_id', '(COALESCE(i.invoice_date, i.created_at::date))')} ir ON true
            WHERE p.organization_id = $1 AND to_char(p.paid_on, 'YYYY-MM') = $2
            ORDER BY p.paid_on, i.invoice_number""",
        organization_id, month,
    )
    result = []
    for row in rows:
        amount_usd = money(row["amount_usd"])
        raw_invoice_rate = js_number(row["invoice_rate_inr"]) if row["invoice_rate_inr"] is not None else 0
        invoice_rate = raw_invoice_rate if raw_invoice_rate > 0 else None
        bank_rate = None if row["bank_rate_inr"] is None else float(row["bank_rate_inr"])
        invoice_inr = None if invoice_rate is None else money(amount_usd * invoice_rate)
        bank_inr = None if bank_rate is None else money(amount_usd * bank_rate)
        # A missing rate is estimated from the daily reference rate. Estimates are shown but never posted to
        # Tally or counted in the totals, because the bank's own rate decides the gain.
        ref_paid = None if row["ref_paid_rate"] is None else float(row["ref_paid_rate"])
        ref_invoice = None if row["ref_invoice_rate"] is None else float(row["ref_invoice_rate"])
        estimated_invoice = invoice_rate if invoice_rate is not None else ref_invoice
        estimated_bank = bank_rate if bank_rate is not None else ref_paid
        estimated_gain = (
            None if estimated_invoice is None or estimated_bank is None
            else money(amount_usd * estimated_bank - amount_usd * estimated_invoice)
        )
        result.append({
            "paymentId": row["payment_id"],
            "invoiceId": row["invoice_id"],
            "invoiceNumber": row["invoice_number"],
            "buyerName": row["buyer_name"],
            "paidOn": row["paid_on"],
            "amountUsd": amount_usd,
            "reference": row["reference"],
            "invoiceRateInr": invoice_rate,
            "bankRateInr": bank_rate,
            "invoiceInr": invoice_inr,
            "bankInr": bank_inr,
            "gainInr": None if invoice_inr is None or bank_inr is None else money(bank_inr - invoice_inr),
            "referenceBankRateInr": ref_paid,
            "referenceBankRateSource": row["ref_paid_source"],
            "referenceInvoiceRateInr": ref_invoice,
            "estimatedGainInr": estimated_gain,
            "bankLedger": (row["bank_name"] or "").strip() or "Bank",
            "companyName": (row["company_name"] or "").strip(),
        })
    return result


def escape_xml(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&apos;")


def _ledger_entry(ledger: str, amount: float) -> str:
    return f"""            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>{escape_xml(ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>{"Yes" if amount > 0 else "No"}</ISDEEMEDPOSITIVE>
              <AMOUNT>{to_fixed(-amount, 2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>"""


def forex_tally_xml(rows: list[dict]) -> str:
    """Receipt vouchers: debit bank at the bank rate, credit the buyer at the invoice rate, post the difference."""
    vouchers = []
    for row in rows:
        if row["bankInr"] is None or row["invoiceInr"] is None or row["gainInr"] is None:
            continue
        entries = [_ledger_entry(row["bankLedger"], row["bankInr"]), _ledger_entry(row["buyerName"], -row["invoiceInr"])]
        if row["gainInr"] != 0:
            entries.append(_ledger_entry(FOREX_LEDGER, -row["gainInr"]))
        narration = (
            f"Export realization against {row['invoiceNumber']}: USD {to_fixed(row['amountUsd'], 2)} at bank rate "
            f"{js_string(row['bankRateInr'])} (invoice rate {js_string(row['invoiceRateInr'])}). Ref {row['reference'] or '-'}."
        )
        joined = "\n".join(entries)
        vouchers.append(f"""          <VOUCHER VCHTYPE="Receipt" ACTION="Create">
            <DATE>{row["paidOn"].replace("-", "")}</DATE>
            <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
            <REFERENCE>{escape_xml(row["invoiceNumber"])}</REFERENCE>
            <NARRATION>{escape_xml(narration)}</NARRATION>
{joined}
          </VOUCHER>""")
    company = rows[0]["companyName"] if rows else ""
    joined_vouchers = "\n".join(vouchers)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>{escape_xml(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
{joined_vouchers}
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
"""


async def forex_summary(pool: Pool, organization_id: str, month: str) -> dict:
    rows = await forex_rows(pool, organization_id, month)
    priced = [r for r in rows if r["gainInr"] is not None]
    gains = losses = 0.0
    for row in priced:
        gains += max(0, row["gainInr"])
    for row in priced:
        losses += min(0, row["gainInr"])
    estimated = [r for r in rows if r["gainInr"] is None and r["estimatedGainInr"] is not None]
    estimated_net = 0.0
    for row in estimated:
        estimated_net += row["estimatedGainInr"]
    return {
        "month": month,
        "rows": rows,
        "missingRateCount": len(rows) - len(priced),
        "estimatedCount": len(estimated),
        "estimatedNetInr": money(estimated_net),
        "totals": {"gainInr": money(gains), "lossInr": money(losses), "netInr": money(gains + losses)},
    }


def build_router():
    router = api_router(prefix="/api/tax/forex")

    def month_of(request: Request) -> str:
        return parse_month(request.query_params.get("month")) or current_month()

    @router.get("")
    async def forex(request: Request, user: CurrentUser = Depends(tax_reader)):
        return await forex_summary(request.app.state.pool, user.organization_id, month_of(request))

    @router.get("/tally")
    async def tally(request: Request, user: CurrentUser = Depends(tax_reader)):
        month = month_of(request)
        rows = await forex_rows(request.app.state.pool, user.organization_id, month)
        return download_response(f"tally-forex-{month}.xml", "application/xml", forex_tally_xml(rows))

    @router.get("/csv")
    async def forex_csv(request: Request, user: CurrentUser = Depends(tax_reader)):
        month = month_of(request)
        rows = await forex_rows(request.app.state.pool, user.organization_id, month)

        def fixed(value) -> str:
            return "" if value is None else to_fixed(value, 2)

        body = csv_file(
            ["Invoice number", "Buyer", "Date received", "USD", "Invoice rate", "Bank rate", "INR at invoice rate", "INR at bank rate",
             "Gain (loss) INR", "Bank reference"],
            [[r["invoiceNumber"], r["buyerName"], r["paidOn"], to_fixed(r["amountUsd"], 2),
              "" if r["invoiceRateInr"] is None else r["invoiceRateInr"], "" if r["bankRateInr"] is None else r["bankRateInr"],
              fixed(r["invoiceInr"]), fixed(r["bankInr"]), fixed(r["gainInr"]), r["reference"]] for r in rows],
        )
        return csv_response(f"forex-{month}.csv", body)

    return router
