"""Payments abroad: TDS, Form 15CA/15CB and treaty checks (port of server/modules/tax/foreignPayments.ts)."""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import current_financial_year, financial_year_dates, form_reader
from ...core.http import ApiError, CurrentUser, body, is_uuid
from ...core.numbers import js_string, money, to_fixed
from .closed_months import closed_month_message
from .export_reports import month_range
from .shared import csv_file, csv_response, tax_manager, tax_reader, tax_writer

PAYMENT_NATURES = ("commission", "freight", "professional", "royalty", "interest", "other")

# Above this total paid to one payee in a financial year, a taxable remittance needs a CA certificate (Form 15CB).
FORM_15CB_THRESHOLD_INR = 500_000


def form15ca_part(taxable: bool, payee_year_inr: float) -> str:
    """Which part of Form 15CA usually applies. Part B (a lower-deduction order) is chosen by the accountant."""
    if not taxable:
        return "D"
    return "C" if payee_year_inr > FORM_15CB_THRESHOLD_INR else "A"


def to_payment(row) -> dict:
    amount_fc = money(row["amount_fc"])
    rate_inr = float(row["rate_inr"])
    amount_inr = money(amount_fc * rate_inr)
    tds_rate = float(row["tds_rate"])
    tds_inr = money(row["tds_inr"])
    part = form15ca_part(row["taxable_in_india"], float(row["payee_year_inr"]))
    issues = []
    if row["taxable_in_india"] and tds_inr == 0:
        issues.append({"tone": "red", "text": "Marked taxable in India but no TDS deducted. The expense can be disallowed (section 40(a)(i))."})
    if tds_inr > 0 and tds_rate > 0 and abs(money(amount_inr * tds_rate / 100) - tds_inr) > 10:
        issues.append({"tone": "amber", "text": f"TDS of ₹{to_fixed(tds_inr, 2)} does not match {js_string(tds_rate)}% of ₹{to_fixed(amount_inr, 2)}."})
    if row["dtaa_applied"] and not row["trc_received"]:
        issues.append({"tone": "red", "text": "Treaty (DTAA) rate used without a Tax Residency Certificate from the payee."})
    if not row["form_15ca_ack"]:
        issues.append({"tone": "amber", "text": f"Form 15CA (Part {part}) acknowledgement not recorded."})
    if part == "C" and not row["form_15cb_no"]:
        issues.append({"tone": "red", "text": "Over ₹5 lakh to this payee this year: Form 15CB from a CA is needed."})
    return {
        "id": row["id"],
        "payeeName": row["payee_name"],
        "payeeCountry": row["payee_country"],
        "nature": row["nature"],
        "paidOn": row["paid_on"],
        "currency": row["currency"],
        "amountFc": amount_fc,
        "rateInr": rate_inr,
        "amountInr": amount_inr,
        "taxableInIndia": row["taxable_in_india"],
        "tdsRate": tds_rate,
        "tdsInr": tds_inr,
        "dtaaApplied": row["dtaa_applied"],
        "trcReceived": row["trc_received"],
        "form15caAck": row["form_15ca_ack"],
        "form15cbNo": row["form_15cb_no"],
        "relatedParty": row["related_party"],
        "reference": row["reference"],
        "notes": row["notes"],
        "payeeYearInr": money(row["payee_year_inr"]),
        "form15caPart": part,
        "issues": issues,
    }


async def foreign_payments_between(pool: Pool, organization_id: str, start: date, end: date) -> list[dict]:
    """Payments in a date range, each with the payee's running total for its own financial year."""
    rows = await pool.fetch(
        """SELECT p.id, p.payee_name, p.payee_country, p.nature, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.currency, p.amount_fc,
                  p.rate_inr, p.taxable_in_india, p.tds_rate, p.tds_inr, p.dtaa_applied, p.trc_received, p.form_15ca_ack, p.form_15cb_no,
                  p.related_party, p.reference, p.notes,
                  (SELECT COALESCE(SUM(o.amount_fc * o.rate_inr), 0) FROM foreign_payments o
                    WHERE o.organization_id = p.organization_id AND LOWER(TRIM(o.payee_name)) = LOWER(TRIM(p.payee_name))
                      AND o.paid_on >= make_date(CASE WHEN EXTRACT(MONTH FROM p.paid_on) >= 4 THEN EXTRACT(YEAR FROM p.paid_on)::int
                                                      ELSE EXTRACT(YEAR FROM p.paid_on)::int - 1 END, 4, 1)
                      AND o.paid_on <= p.paid_on) AS payee_year_inr
           FROM foreign_payments p
           WHERE p.organization_id = $1 AND p.paid_on BETWEEN $2 AND $3
           ORDER BY p.paid_on, p.payee_name""",
        organization_id, start, end,
    )
    return [to_payment(row) for row in rows]


def foreign_payment_totals(payments: list[dict]) -> dict:
    def total(selected, key) -> float:
        acc = 0.0
        for p in selected:
            acc += p[key]
        return money(acc)

    without_tds = [p for p in payments if p["taxableInIndia"] and p["tdsInr"] == 0]
    return {
        "count": len(payments),
        "amountInr": total(payments, "amountInr"),
        "tdsInr": total(payments, "tdsInr"),
        "withoutTds": len(without_tds),
        "withoutTdsInr": total(without_tds, "amountInr"),
        "missing15ca": sum(1 for p in payments if not p["form15caAck"]),
        "missing15cb": sum(1 for p in payments if p["form15caPart"] == "C" and not p["form15cbNo"]),
        "relatedParty": sum(1 for p in payments if p["relatedParty"]),
        "issues": sum(1 for p in payments if p["issues"]),
    }


def read_payment(data: dict) -> dict:
    form = form_reader(data)
    amount_fc = form.number("amountFc", "Enter the amount paid in the foreign currency.", min=0.01)
    rate_inr = form.number("rateInr", "Enter the exchange rate used (rupees per unit).", min=0.0001, places=4)
    tds_rate = form.number("tdsRate", "TDS rate must be between 0 and 100.", min=0, max=100, optional=True, places=3)
    tds_rate = 0 if tds_rate is None else tds_rate
    tds_inr = form.number("tdsInr", "TDS amount must be zero or more.", min=0, optional=True)
    if tds_inr is None:
        tds_inr = money(amount_fc * rate_inr * tds_rate / 100)
    return {
        "payeeName": form.required("payeeName", "Enter who was paid.", 200),
        "payeeCountry": form.text("payeeCountry", 100),
        "nature": form.choice("nature", PAYMENT_NATURES, "other"),
        "paidOn": form.date("paidOn", "Enter the payment date as YYYY-MM-DD."),
        "currency": (form.text("currency", 3) or "USD").upper(),
        "amountFc": amount_fc,
        "rateInr": rate_inr,
        "taxableInIndia": True if "taxableInIndia" not in form.raw else form.flag("taxableInIndia"),
        "tdsRate": tds_rate,
        "tdsInr": tds_inr,
        "dtaaApplied": form.flag("dtaaApplied"),
        "trcReceived": form.flag("trcReceived"),
        "form15caAck": form.text("form15caAck", 50),
        "form15cbNo": form.text("form15cbNo", 50),
        "relatedParty": form.flag("relatedParty"),
        "reference": form.text("reference", 100),
        "notes": form.text("notes", 500),
    }


def _values(p: dict) -> list:
    return [p["payeeName"], p["payeeCountry"], p["nature"], date.fromisoformat(p["paidOn"]), p["currency"], p["amountFc"], p["rateInr"],
            p["taxableInIndia"], p["tdsRate"], p["tdsInr"], p["dtaaApplied"], p["trcReceived"], p["form15caAck"], p["form15cbNo"],
            p["relatedParty"], p["reference"], p["notes"]]


async def _closed(pool: Pool, organization_id: str, paid_on: str | None) -> None:
    message = await closed_month_message(pool, organization_id, paid_on)
    if message:
        raise ApiError(409, message.replace("this invoice", "this payment", 1))


async def _existing(pool: Pool, payment_id: str, organization_id: str) -> str:
    if not is_uuid(payment_id):
        raise ApiError(404, "Payment not found.")
    found = await pool.fetchval(
        "SELECT to_char(paid_on, 'YYYY-MM-DD') FROM foreign_payments WHERE id = $1 AND organization_id = $2", payment_id, organization_id
    )
    if not found:
        raise ApiError(404, "Payment not found.")
    return found


def _year(token: str) -> dict:
    return financial_year_dates(token) or financial_year_dates(current_financial_year())  # type: ignore[return-value]


def build_router():
    router = api_router(prefix="/api/foreign-payments")

    @router.get("")
    async def list_payments(request: Request, user: CurrentUser = Depends(tax_reader)):
        year = _year(request.query_params.get("year", ""))
        if request.query_params.get("from") or request.query_params.get("to"):
            r = month_range(request)
            start, end = r["start"].isoformat(), r["end"].isoformat()
        else:
            start, end = year["start"], year["end"]
        payments = await foreign_payments_between(request.app.state.pool, user.organization_id, date.fromisoformat(start), date.fromisoformat(end))
        return {"start": start, "end": end, "payments": payments, "totals": foreign_payment_totals(payments),
                "threshold15cbInr": FORM_15CB_THRESHOLD_INR}

    @router.get("/csv")
    async def csv(request: Request, user: CurrentUser = Depends(tax_reader)):
        year = _year(request.query_params.get("year", ""))
        payments = await foreign_payments_between(
            request.app.state.pool, user.organization_id, date.fromisoformat(year["start"]), date.fromisoformat(year["end"])
        )

        def yes(value: bool) -> str:
            return "Yes" if value else "No"

        body_csv = csv_file(
            ["Paid on", "Payee", "Country", "Nature", "Currency", "Amount", "Rate", "Amount INR", "Taxable in India", "TDS %", "TDS INR",
             "DTAA", "TRC", "Form 15CA part", "15CA ack", "15CB no", "Related party", "Reference", "Issues"],
            [[p["paidOn"], p["payeeName"], p["payeeCountry"], p["nature"], p["currency"], to_fixed(p["amountFc"], 2), p["rateInr"],
              to_fixed(p["amountInr"], 2), yes(p["taxableInIndia"]), p["tdsRate"], to_fixed(p["tdsInr"], 2), yes(p["dtaaApplied"]),
              yes(p["trcReceived"]), p["form15caPart"], p["form15caAck"], p["form15cbNo"], yes(p["relatedParty"]), p["reference"],
              "; ".join(issue["text"] for issue in p["issues"])] for p in payments],
        )
        return csv_response(f"foreign-payments-{year['label']}.csv", body_csv)

    @router.post("")
    async def create(request: Request, user: CurrentUser = Depends(tax_writer)):
        payment = read_payment(body(request))
        pool: Pool = request.app.state.pool
        await _closed(pool, user.organization_id, payment["paidOn"])
        new_id = await pool.fetchval(
            """INSERT INTO foreign_payments (organization_id, payee_name, payee_country, nature, paid_on, currency, amount_fc, rate_inr,
                 taxable_in_india, tds_rate, tds_inr, dtaa_applied, trc_received, form_15ca_ack, form_15cb_no, related_party, reference,
                 notes, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id""",
            user.organization_id, *_values(payment), user.id,
        )
        return JSONResponse({"id": new_id}, status_code=201)

    @router.put("/{payment_id}")
    async def update(payment_id: str, request: Request, user: CurrentUser = Depends(tax_writer)):
        if not is_uuid(payment_id):
            raise ApiError(404, "Payment not found.")
        payment = read_payment(body(request))
        pool: Pool = request.app.state.pool
        await _closed(pool, user.organization_id, await _existing(pool, payment_id, user.organization_id))
        await _closed(pool, user.organization_id, payment["paidOn"])
        await pool.execute(
            """UPDATE foreign_payments SET payee_name = $3, payee_country = $4, nature = $5, paid_on = $6, currency = $7, amount_fc = $8,
                 rate_inr = $9, taxable_in_india = $10, tds_rate = $11, tds_inr = $12, dtaa_applied = $13, trc_received = $14,
                 form_15ca_ack = $15, form_15cb_no = $16, related_party = $17, reference = $18, notes = $19
               WHERE id = $1 AND organization_id = $2""",
            payment_id, user.organization_id, *_values(payment),
        )
        return {"id": payment_id}

    @router.delete("/{payment_id}")
    async def delete(payment_id: str, request: Request, user: CurrentUser = Depends(tax_manager)):
        pool: Pool = request.app.state.pool
        await _closed(pool, user.organization_id, await _existing(pool, payment_id, user.organization_id))
        await pool.execute("DELETE FROM foreign_payments WHERE id = $1 AND organization_id = $2", payment_id, user.organization_id)
        return {"deleted": True}

    return router
