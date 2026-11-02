"""GST tax invoices for subscription payments.

One invoice per captured payment, issued when the payment is recorded and numbered per Indian financial year
without gaps (PREFIX/2026-27/00001: 16 characters, the GST limit). Everything printed is frozen in `data`.

Seller details come from the environment (the business that runs this site):
    BILLING_LEGAL_NAME, BILLING_GSTIN, BILLING_ADDRESS, BILLING_STATE
    BILLING_SAC            service code, default 997331 (licensing the right to use software); confirm with your CA
    BILLING_INVOICE_PREFIX up to 4 letters, default DX
    BILLING_LUT_ARN        LUT reference for zero-rated supplies to customers outside India (PayPal, USD)

Rupee prices include 18% GST, so the taxable value is worked back from the amount paid: CGST and SGST at 9%
each when the customer is in the seller's state, otherwise IGST at 18%.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Request

from ...core.db import Pool
from ...core.http import ApiError, CurrentUser, is_uuid, iso, require_admin
from ...core.numbers import js_round
from .plans import plan_by_key

log = logging.getLogger("diamondx.tax_invoice")

IST = timezone(timedelta(hours=5, minutes=30))
GST_RATE = 0.18
DEFAULT_SAC = "997331"
PAID_STATUSES = ("captured", "paid")

# GST state codes, for the place of supply.
STATE_CODES = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
    "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
    "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
    "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
    "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
    "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
}
_GSTIN = re.compile(r"^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")


def state_code_of_gstin(gstin: str) -> str | None:
    match = _GSTIN.match((gstin or "").strip().upper())
    return match.group(1) if match else None


def seller() -> dict | None:
    """The site operator's details, or None if BILLING_GSTIN is not a valid GSTIN (no invoices without one)."""
    gstin = os.environ.get("BILLING_GSTIN", "").strip().upper()
    code = state_code_of_gstin(gstin)
    if not code:
        return None
    return {
        "name": os.environ.get("BILLING_LEGAL_NAME", "").strip() or os.environ.get("BILLING_BANK_ACCOUNT_NAME", "").strip(),
        "gstin": gstin,
        "address": os.environ.get("BILLING_ADDRESS", "").strip(),
        "state": os.environ.get("BILLING_STATE", "").strip() or STATE_CODES.get(code, ""),
        "stateCode": code,
    }


def invoice_prefix() -> str:
    prefix = re.sub(r"[^A-Z]", "", os.environ.get("BILLING_INVOICE_PREFIX", "DX").upper())[:4]
    return prefix or "DX"


def financial_year_of(moment: datetime) -> str:
    local = moment.astimezone(IST)
    start = local.year if local.month >= 4 else local.year - 1
    return f"{start}-{(start + 1) % 100:02d}"


def split_tax(total_paise: int, intra_state: bool) -> dict:
    """Taxable value and tax heads, in paise, from a GST-inclusive total. The heads always add up to the total."""
    taxable = int(js_round(total_paise / (1 + GST_RATE)))
    tax = total_paise - taxable
    if intra_state:
        cgst = tax // 2
        return {"taxable": taxable, "cgst": cgst, "sgst": tax - cgst, "igst": 0}
    return {"taxable": taxable, "cgst": 0, "sgst": 0, "igst": tax}


def _rupees(paise: int) -> float:
    return paise / 100


def _buyer(organization_name: str, profile: dict | None) -> dict:
    exporter = (profile or {}).get("exporter") or {}
    gstin = (exporter.get("gstin") or "").strip().upper()
    code = state_code_of_gstin(gstin) or (exporter.get("stateCode") or "").strip()
    if code.isdigit() and len(code) == 1:
        code = code.zfill(2)
    if code not in STATE_CODES:
        code = ""
    address = ", ".join(
        part for part in (exporter.get("addressLine1"), exporter.get("addressLine2"), exporter.get("city"), exporter.get("pincode"))
        if part and part.strip()
    )
    return {
        "name": (exporter.get("companyName") or "").strip() or organization_name,
        "gstin": gstin if state_code_of_gstin(gstin) else "",
        "address": address,
        "state": (exporter.get("state") or "").strip() or STATE_CODES.get(code, ""),
        "stateCode": code,
        "country": (exporter.get("country") or "").strip() or "India",
    }


def build_invoice_data(payment: dict, organization_name: str, profile: dict | None, seller_details: dict, number: str, financial_year: str) -> dict:
    plan = plan_by_key(payment["plan_key"])
    cycle = payment["billing_cycle"]
    description = f"DiamondX {plan.name if plan else payment['plan_key']} plan, {'yearly' if cycle == 'yearly' else 'monthly'} subscription"
    buyer = _buyer(organization_name, profile)
    currency = payment["currency"]
    total = int(payment["amount_paise"])
    paid_at = payment["paid_at"]
    notes: list[str] = []

    if currency == "INR":
        # Place of supply: the customer's state (from its GSTIN, else its profile), else the seller's.
        place = buyer["stateCode"] or seller_details["stateCode"]
        heads = split_tax(total, place == seller_details["stateCode"])
        rates = {"cgst": 9 if heads["cgst"] or heads["sgst"] else 0, "sgst": 9 if heads["cgst"] or heads["sgst"] else 0, "igst": 18 if heads["igst"] else 0}
    else:
        # Paid in foreign currency from outside India: export of services, zero-rated.
        place = "96"
        heads = {"taxable": total, "cgst": 0, "sgst": 0, "igst": 0}
        rates = {"cgst": 0, "sgst": 0, "igst": 0}
        lut = os.environ.get("BILLING_LUT_ARN", "").strip()
        notes.append(f"Supply meant for export under LUT {lut} without payment of IGST." if lut
                     else "Export of services: zero-rated supply.")

    return {
        "invoiceNumber": number,
        "financialYear": financial_year,
        "invoiceDate": paid_at.astimezone(IST).date().isoformat(),
        "seller": seller_details,
        "buyer": buyer,
        "placeOfSupply": "96 - Other Country" if place == "96" else f"{place} - {STATE_CODES.get(place, '')}",
        "reverseCharge": False,
        "currency": currency,
        "lines": [{"description": description, "sac": os.environ.get("BILLING_SAC", "").strip() or DEFAULT_SAC, "quantity": 1,
                   "taxableValue": _rupees(heads["taxable"])}],
        "taxableValue": _rupees(heads["taxable"]),
        "cgstRate": rates["cgst"], "cgst": _rupees(heads["cgst"]),
        "sgstRate": rates["sgst"], "sgst": _rupees(heads["sgst"]),
        "igstRate": rates["igst"], "igst": _rupees(heads["igst"]),
        "total": _rupees(total),
        "payment": {"id": payment["razorpay_payment_id"], "provider": payment["provider"], "method": payment["method"], "paidAt": iso(paid_at)},
        "notes": notes,
    }


async def issue_subscription_invoice(pool: Pool, payment_id: str) -> str | None:
    """Issues the tax invoice for a captured subscription payment. Safe to call again: returns the existing one.
    None when the payment is not captured yet or the seller's GSTIN is not configured."""
    existing = await pool.fetchval("SELECT id FROM subscription_invoices WHERE subscription_payment_id = $1", payment_id)
    if existing:
        return existing
    seller_details = seller()
    if not seller_details:
        log.warning("BILLING_GSTIN is not set to a valid GSTIN, so no tax invoice was issued for payment %s.", payment_id)
        return None
    async with pool.acquire() as connection:
        async with connection.transaction():
            payment = await connection.fetchrow(
                """SELECT p.razorpay_payment_id, p.organization_id, p.plan_key, p.billing_cycle, p.amount_paise, p.status, p.method,
                          p.paid_at, p.provider, p.currency, o.name AS organization_name, o.profile
                   FROM subscription_payments p JOIN organizations o ON o.id = p.organization_id
                   WHERE p.razorpay_payment_id = $1 FOR UPDATE OF p""",
                payment_id,
            )
            if not payment or payment["status"] not in PAID_STATUSES or payment["amount_paise"] <= 0:
                return None
            # Checked again under the row lock, so two callers cannot both issue one.
            existing = await connection.fetchval("SELECT id FROM subscription_invoices WHERE subscription_payment_id = $1", payment_id)
            if existing:
                return existing
            financial_year = financial_year_of(payment["paid_at"])
            sequence = await connection.fetchval(
                """INSERT INTO subscription_invoice_counters (financial_year, last_number) VALUES ($1, 1)
                   ON CONFLICT (financial_year) DO UPDATE SET last_number = subscription_invoice_counters.last_number + 1
                   RETURNING last_number""",
                financial_year,
            )
            number = f"{invoice_prefix()}/{financial_year}/{sequence:05d}"
            data = build_invoice_data(dict(payment), payment["organization_name"], payment["profile"], seller_details, number, financial_year)
            return await connection.fetchval(
                """INSERT INTO subscription_invoices (organization_id, subscription_payment_id, invoice_number, financial_year, sequence, issued_at, data)
                   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id""",
                payment["organization_id"], payment_id, number, financial_year, sequence, payment["paid_at"], data,
            )


async def issue_quietly(pool: Pool, payment_id: str) -> None:
    """Issues the invoice but never fails the payment flow that called it; a later call retries."""
    try:
        await issue_subscription_invoice(pool, payment_id)
    except Exception:
        log.exception("Could not issue the tax invoice for subscription payment %s", payment_id)


def add_routes(router) -> None:
    @router.get("/invoices/{invoice_id}")
    async def tax_invoice(invoice_id: str, request: Request, user: CurrentUser = Depends(require_admin)):
        if not is_uuid(invoice_id):
            raise ApiError(404, "Invoice not found.")
        row = await request.app.state.pool.fetchrow(
            "SELECT id, data FROM subscription_invoices WHERE id = $1 AND organization_id = $2", invoice_id, user.organization_id
        )
        if not row:
            raise ApiError(404, "Invoice not found.")
        return {"id": row["id"], **row["data"]}
