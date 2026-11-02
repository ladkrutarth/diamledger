"""Payments received against an invoice (port of server/modules/invoices/payments.ts).

`record_payment` is also used by bank matching and the assistant once those are ported.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date
from typing import Any

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, require_admin, require_user
from ...core.numbers import js_number, js_round, round_to
from ..tax.closed_months import closed_month_message
from .invoices import refresh_paid_status

BANK_RATE_ERROR = "Enter the bank exchange rate in rupees per USD, or leave it blank."


def to_payment(row) -> dict:
    return {
        "id": row["id"],
        "amountUsd": float(row["amount_usd"]),
        "paidOn": row["paid_on"],
        "reference": row["reference"],
        "bankRateInr": None if row["bank_rate_inr"] is None else float(row["bank_rate_inr"]),
        "createdAt": iso(row["created_at"]),
    }


async def find_invoice(pool: Pool, invoice_id: str, organization_id: str):
    if not is_uuid(invoice_id):
        return None
    return await pool.fetchrow(
        """SELECT id, status, total_usd, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date
           FROM invoices WHERE id = $1 AND organization_id = $2""",
        invoice_id,
        organization_id,
    )


async def list_payments(pool: Pool, invoice_id: str) -> list[dict]:
    rows = await pool.fetch(
        """SELECT id, amount_usd, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, reference, bank_rate_inr, created_at
           FROM payments WHERE invoice_id = $1 ORDER BY paid_on, created_at""",
        invoice_id,
    )
    return [to_payment(row) for row in rows]


async def payment_state(pool: Pool, invoice_id: str) -> dict:
    invoice = await pool.fetchrow("SELECT status, total_usd FROM invoices WHERE id = $1", invoice_id)
    payments = await list_payments(pool, invoice_id)
    total_usd = float(invoice["total_usd"])
    paid = 0.0
    for payment in payments:
        paid += payment["amountUsd"]
    paid_usd = round_to(paid, 2)
    return {
        "status": invoice["status"],
        "totalUsd": total_usd,
        "paidUsd": paid_usd,
        "dueUsd": max(0.0, js_round((total_usd - paid_usd) * 100) / 100),
        "payments": payments,
    }


def parse_bank_rate(value: Any) -> float | None | bool:
    """None when blank; False when it is not a sensible rupee rate."""
    if value is None or value == "":
        return None
    rate = round_to(js_number(value), 4)
    return rate if math.isfinite(rate) and 0 < rate < 1000 else False


@dataclass
class PaymentResult:
    ok: bool
    state: dict | None = None
    payment_id: str | None = None
    status: int = 200
    error: str | None = None


def _valid_date(value: str) -> bool:
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


async def record_payment(pool: Pool, user: CurrentUser, invoice_id: str, data: dict, *, within_balance: bool = False) -> PaymentResult:
    invoice = await find_invoice(pool, invoice_id, user.organization_id)
    if not invoice:
        return PaymentResult(False, status=404, error="Invoice not found.")
    if invoice["status"] not in ("issued", "paid"):
        return PaymentResult(False, status=409, error="Issue the invoice before recording payments.")
    closed = await closed_month_message(pool, user.organization_id, invoice["invoice_date"])
    if closed:
        return PaymentResult(False, status=409, error=closed)

    raw_amount = data.get("amountUsd")
    amount = math.nan if raw_amount is None else round_to(js_number(raw_amount), 2)
    paid_on = data.get("paidOn") if isinstance(data.get("paidOn"), str) else ""
    reference = data["reference"].strip()[:200] if isinstance(data.get("reference"), str) else ""
    if not math.isfinite(amount) or amount <= 0 or amount > 1e11:
        return PaymentResult(False, status=400, error="Enter a payment amount greater than zero.")
    if not _valid_date(paid_on):
        return PaymentResult(False, status=400, error="Enter the date the payment was received.")
    bank_rate = parse_bank_rate(data.get("bankRateInr"))
    if bank_rate is False:
        return PaymentResult(False, status=400, error=BANK_RATE_ERROR)
    if within_balance and amount > (await payment_state(pool, invoice["id"]))["dueUsd"]:
        return PaymentResult(False, status=409, error="The payment is more than the balance due on this invoice.")

    payment_id = await pool.fetchval(
        """INSERT INTO payments (invoice_id, organization_id, amount_usd, paid_on, reference, bank_rate_inr, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id""",
        invoice["id"], user.organization_id, amount, date.fromisoformat(paid_on), reference, bank_rate, user.id,
    )
    await refresh_paid_status(pool, invoice["id"])
    return PaymentResult(True, state=await payment_state(pool, invoice["id"]), payment_id=payment_id)


def build_router():
    router = api_router(prefix="/api/invoices/{invoice_id}/payments")

    @router.get("")
    async def get_payments(invoice_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool = request.app.state.pool
        invoice = await find_invoice(pool, invoice_id, user.organization_id)
        if not invoice:
            raise ApiError(404, "Invoice not found.")
        return await payment_state(pool, invoice["id"])

    @router.post("")
    async def add_payment(invoice_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        result = await record_payment(request.app.state.pool, user, invoice_id, body(request))
        if not result.ok:
            raise ApiError(result.status, result.error)
        return JSONResponse(result.state, status_code=201)

    async def payment_invoice(request: Request, invoice_id: str, payment_id: str, user: CurrentUser):
        pool = request.app.state.pool
        invoice = await find_invoice(pool, invoice_id, user.organization_id)
        if not invoice or not is_uuid(payment_id):
            raise ApiError(404, "Payment not found.")
        closed = await closed_month_message(pool, user.organization_id, invoice["invoice_date"])
        if closed:
            raise ApiError(409, closed)
        return invoice

    @router.patch("/{payment_id}")
    async def edit_payment(invoice_id: str, payment_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        invoice = await payment_invoice(request, invoice_id, payment_id, user)
        bank_rate = parse_bank_rate(body(request).get("bankRateInr"))
        if bank_rate is False:
            raise ApiError(400, BANK_RATE_ERROR)
        pool = request.app.state.pool
        result = await pool.execute(
            "UPDATE payments SET bank_rate_inr = $3 WHERE id = $1 AND invoice_id = $2", payment_id, invoice["id"], bank_rate
        )
        if result == "UPDATE 0":
            raise ApiError(404, "Payment not found.")
        return await payment_state(pool, invoice["id"])

    @router.delete("/{payment_id}")
    async def delete_payment(invoice_id: str, payment_id: str, request: Request, user: CurrentUser = Depends(require_admin)):
        invoice = await payment_invoice(request, invoice_id, payment_id, user)
        pool = request.app.state.pool
        result = await pool.execute("DELETE FROM payments WHERE id = $1 AND invoice_id = $2", payment_id, invoice["id"])
        if result == "DELETE 0":
            raise ApiError(404, "Payment not found.")
        await refresh_paid_status(pool, invoice["id"])
        return await payment_state(pool, invoice["id"])

    return router
