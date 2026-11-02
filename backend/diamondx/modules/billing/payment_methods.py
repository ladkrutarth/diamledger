"""Paying for a plan by bank transfer (approved by the site operator) or PayPal, one period at a time
(port of server/modules/billing/paymentMethods.ts)."""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import secrets
import uuid
from urllib.parse import quote

import asyncpg
import httpx
from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import form_reader
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, public_base_url, require_admin, require_user
from ...core.numbers import js_number, js_round, to_fixed
from .plans import is_cycle, plan_by_key, price_for, usd_price_for
from .providers import is_platform_admin, paypal_configured, seller_bank_account
from .razorpay import RazorpayClient
from .routes import activate_one_period, billing_summary, record_payment

log = logging.getLogger("diamondx.payments")


# --- PayPal (customers outside India, US dollars) ----------------------------------------------------


class PaypalError(Exception):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def paypal_base() -> str:
    return "https://api-m.paypal.com" if os.environ.get("PAYPAL_ENV") == "live" else "https://api-m.sandbox.paypal.com"


class PaypalClient:
    """PayPal Orders v2. One payment per plan period."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport

    async def _token(self, client: httpx.AsyncClient) -> str:
        if not paypal_configured():
            raise PaypalError("PayPal is not set up on this server.", 503)
        auth = base64.b64encode(f"{os.environ['PAYPAL_CLIENT_ID']}:{os.environ['PAYPAL_CLIENT_SECRET']}".encode()).decode()
        response = await client.post(f"{paypal_base()}/v1/oauth2/token", headers={
            "Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"}, content="grant_type=client_credentials")
        if response.status_code >= 400:
            raise PaypalError("PayPal did not accept the server credentials.", 502)
        return response.json()["access_token"]

    async def call(self, method: str, path: str, payload: dict | None = None, idempotency_key: str | None = None) -> dict:
        async with httpx.AsyncClient(transport=self.transport, timeout=20.0) as client:
            headers = {"Authorization": f"Bearer {await self._token(client)}", "Content-Type": "application/json"}
            if idempotency_key:
                headers["PayPal-Request-Id"] = idempotency_key
            response = await client.request(method, f"{paypal_base()}{path}", headers=headers,
                                            content=None if payload is None else json.dumps(payload))
        try:
            parsed = response.json()
        except ValueError:
            parsed = None
        if response.status_code >= 400:
            details = parsed.get("details") if isinstance(parsed, dict) else None
            issue = details[0].get("issue") if isinstance(details, list) and details and isinstance(details[0], dict) else None
            log.error("PayPal %s %s failed (%s): %s", method, path, response.status_code, issue or (parsed or {}).get("message", "") if isinstance(parsed, dict) else "")
            raise PaypalError("PayPal declined that payment method. Try another one." if issue == "INSTRUMENT_DECLINED"
                              else "PayPal did not complete the payment. Try again.", 502)
        return parsed or {}

    async def create_order(self, payload: dict, request_id: str) -> dict:
        return await self.call("POST", "/v2/checkout/orders", payload, request_id)

    async def capture_order(self, order_id: str) -> dict:
        return await self.call("POST", f"/v2/checkout/orders/{quote(order_id, safe='')}/capture", {}, f"capture-{order_id}")




# --- Bank transfer -----------------------------------------------------------------------------------

REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def reference_code() -> str:
    """A short code the customer writes in the transfer remarks, so the operator can match the credit."""
    return "DX-" + "".join(REFERENCE_ALPHABET[byte % len(REFERENCE_ALPHABET)] for byte in secrets.token_bytes(6))


TRANSFER_COLUMNS = """t.id, t.organization_id, t.plan_key, t.billing_cycle, t.amount_inr, t.reference_code, t.status, t.utr,
  to_char(t.paid_on, 'YYYY-MM-DD') AS paid_on, t.payer_bank, t.note, t.created_by_email, t.reviewed_by_email, t.reviewed_at, t.review_note, t.created_at"""
BARE_COLUMNS = TRANSFER_COLUMNS.replace("t.", "")


def to_transfer(row) -> dict:
    plan = plan_by_key(row["plan_key"])
    result = {
        "id": row["id"],
        "organizationId": row["organization_id"],
        "planKey": row["plan_key"],
        "planName": plan.name if plan else row["plan_key"],
        "cycle": row["billing_cycle"],
        "amountInr": row["amount_inr"],
        "referenceCode": row["reference_code"],
        "status": row["status"],
        "utr": row["utr"],
        "paidOn": row["paid_on"],
        "payerBank": row["payer_bank"],
        "note": row["note"],
        "createdByEmail": row["created_by_email"],
        "reviewedByEmail": row["reviewed_by_email"],
        "reviewedAt": iso(row["reviewed_at"]),
        "reviewNote": row["review_note"],
        "createdAt": iso(row["created_at"]),
    }
    if "organization_name" in row.keys():
        result["organizationName"] = row["organization_name"]
    return result


async def open_bank_transfer(pool: Pool, organization_id: str) -> dict | None:
    """The company's latest bank transfer that is still waiting on someone."""
    row = await pool.fetchrow(
        f"""SELECT {TRANSFER_COLUMNS} FROM bank_transfer_requests t
            WHERE t.organization_id = $1 AND t.status IN ('awaiting', 'submitted', 'rejected')
            ORDER BY t.created_at DESC LIMIT 1""",
        organization_id,
    )
    return to_transfer(row) if row else None


def platform_admin(user: CurrentUser = Depends(require_user)) -> CurrentUser:
    if not is_platform_admin(user.email):
        raise ApiError(403, "Only the people who run this site can do this.")
    return user


def _plan_and_cycle(data: dict):
    plan, cycle = plan_by_key(data.get("plan")), data.get("cycle")
    if not plan or not is_cycle(cycle):
        raise ApiError(400, "Choose a plan and monthly or yearly billing.")
    return plan, cycle


def build_router():
    router = api_router()

    def razorpay(request: Request) -> RazorpayClient:
        return RazorpayClient(request.app.state.options.razorpay_transport)

    def paypal(request: Request) -> PaypalClient:
        return PaypalClient(request.app.state.options.paypal_transport)

    @router.get("/api/billing/bank-transfer")
    async def current_transfer(request: Request, user: CurrentUser = Depends(require_admin)):
        return {"transfer": await open_bank_transfer(request.app.state.pool, user.organization_id), "account": seller_bank_account()}

    # Bank transfer: 1) ask for the account and a reference code, 2) enter the UTR after paying, 3) the operator approves.
    @router.post("/api/billing/bank-transfer")
    async def start_transfer(request: Request, user: CurrentUser = Depends(require_admin)):
        account = seller_bank_account()
        if not account:
            raise ApiError(503, "Payment by bank transfer is not set up on this site.")
        plan, cycle = _plan_and_cycle(body(request))
        pool: Pool = request.app.state.pool
        # One open request at a time; starting a new one replaces any that has not been paid.
        await pool.execute(
            "UPDATE bank_transfer_requests SET status = 'cancelled' WHERE organization_id = $1 AND status IN ('awaiting', 'rejected')",
            user.organization_id,
        )
        if await pool.fetchval("SELECT 1 FROM bank_transfer_requests WHERE organization_id = $1 AND status = 'submitted'", user.organization_id):
            raise ApiError(409, "A bank transfer is already waiting to be checked. You will see the plan change once it is approved.")
        row = await pool.fetchrow(
            f"""INSERT INTO bank_transfer_requests (organization_id, plan_key, billing_cycle, amount_inr, reference_code, created_by, created_by_email)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {BARE_COLUMNS}""",
            user.organization_id, plan.key, cycle, price_for(plan, cycle)["totalInr"], reference_code(), user.id, user.email,
        )
        return JSONResponse({"transfer": to_transfer(row), "account": account}, status_code=201)

    @router.post("/api/billing/bank-transfer/{transfer_id}/submit")
    async def submit_transfer(transfer_id: str, request: Request, user: CurrentUser = Depends(require_admin)):
        if not is_uuid(transfer_id):
            raise ApiError(404, "Transfer not found.")
        form = form_reader(body(request))
        utr = re.sub(r"\s+", "", form.required("utr", "Enter the UTR or transaction reference from your bank.", 40).upper())
        if not re.match(r"^[A-Z0-9]{8,30}$", utr):
            raise ApiError(400, "A UTR is 8 to 30 letters and digits, like HDFCR52026110112345678 or 412345678901.")
        from datetime import date

        paid_on = date.fromisoformat(form.date("paidOn", "Enter the date you paid as YYYY-MM-DD."))
        try:
            row = await request.app.state.pool.fetchrow(
                f"""UPDATE bank_transfer_requests SET status = 'submitted', utr = $3, paid_on = $4, payer_bank = $5, note = $6
                    WHERE id = $1 AND organization_id = $2 AND status IN ('awaiting', 'rejected')
                    RETURNING {BARE_COLUMNS}""",
                transfer_id, user.organization_id, utr, paid_on, form.text("payerBank", 100), form.text("note", 500),
            )
        except asyncpg.UniqueViolationError:
            raise ApiError(409, "That UTR has already been used for a payment.") from None
        if not row:
            raise ApiError(409, "This transfer has already been sent for checking.")
        return {"transfer": to_transfer(row)}

    @router.post("/api/billing/bank-transfer/{transfer_id}/cancel")
    async def cancel_transfer(transfer_id: str, request: Request, user: CurrentUser = Depends(require_admin)):
        if not is_uuid(transfer_id):
            raise ApiError(404, "Transfer not found.")
        result = await request.app.state.pool.execute(
            "UPDATE bank_transfer_requests SET status = 'cancelled' WHERE id = $1 AND organization_id = $2 AND status IN ('awaiting', 'rejected')",
            transfer_id, user.organization_id,
        )
        if result == "UPDATE 0":
            raise ApiError(409, "Only a transfer that has not been sent for checking can be cancelled.")
        return {"cancelled": True}

    # The site operator's queue of transfers to check against the bank statement.
    @router.get("/api/platform/bank-transfers")
    async def queue(request: Request, user: CurrentUser = Depends(platform_admin)):
        status = None if request.query_params.get("status") == "all" else "submitted"
        rows = await request.app.state.pool.fetch(
            f"""SELECT {TRANSFER_COLUMNS}, o.name AS organization_name FROM bank_transfer_requests t JOIN organizations o ON o.id = t.organization_id
                WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.created_at DESC LIMIT 200""",
            status,
        )
        return {"transfers": [to_transfer(row) for row in rows]}

    @router.post("/api/platform/bank-transfers/{transfer_id}/approve")
    async def approve(transfer_id: str, request: Request, user: CurrentUser = Depends(platform_admin)):
        if not is_uuid(transfer_id):
            raise ApiError(404, "Transfer not found.")
        data = body(request)
        pool: Pool = request.app.state.pool
        transfer = await pool.fetchrow(
            f"""UPDATE bank_transfer_requests SET status = 'approved', reviewed_by_email = $2, reviewed_at = now(), review_note = $3
                WHERE id = $1 AND status = 'submitted' RETURNING {BARE_COLUMNS}""",
            transfer_id, user.email, data["note"][:500] if isinstance(data.get("note"), str) else "",
        )
        if not transfer:
            raise ApiError(409, "Only a transfer waiting to be checked can be approved.")
        period = await activate_one_period(pool, razorpay(request), transfer["organization_id"], transfer["plan_key"], transfer["billing_cycle"], "bank_transfer")
        await record_payment(
            pool, transfer["organization_id"],
            {"id": f"bank_{transfer['utr']}", "amount": transfer["amount_inr"] * 100, "status": "captured", "method": "neft/rtgs/imps"},
            transfer["reference_code"], transfer["plan_key"], transfer["billing_cycle"], "bank_transfer", "INR",
        )
        return {"transfer": to_transfer(transfer), "periodEnd": iso(period["end"])}

    @router.post("/api/platform/bank-transfers/{transfer_id}/reject")
    async def reject(transfer_id: str, request: Request, user: CurrentUser = Depends(platform_admin)):
        if not is_uuid(transfer_id):
            raise ApiError(404, "Transfer not found.")
        data = body(request)
        note = data["note"].strip()[:500] if isinstance(data.get("note"), str) else ""
        if not note:
            raise ApiError(400, 'Say why, for example "No credit with this UTR" or "Amount short by ₹500".')
        result = await request.app.state.pool.execute(
            """UPDATE bank_transfer_requests SET status = 'rejected', reviewed_by_email = $2, reviewed_at = now(), review_note = $3
               WHERE id = $1 AND status = 'submitted'""",
            transfer_id, user.email, note,
        )
        if result == "UPDATE 0":
            raise ApiError(409, "Only a transfer waiting to be checked can be rejected.")
        return {"rejected": True}

    # PayPal: create an order, send the buyer to PayPal, then capture it when they come back.
    @router.post("/api/billing/paypal/order")
    async def paypal_order(request: Request, user: CurrentUser = Depends(require_admin)):
        plan, cycle = _plan_and_cycle(body(request))
        amount = usd_price_for(plan, cycle)
        origin = public_base_url(request)
        try:
            order = await paypal(request).create_order({
                "intent": "CAPTURE",
                "purchase_units": [{
                    "reference_id": user.organization_id,
                    "custom_id": f"{user.organization_id}|{plan.key}|{cycle}",
                    "description": f"DiamondX-A1005 {plan.name} plan, {'1 month' if cycle == 'monthly' else '1 year'}",
                    "amount": {"currency_code": "USD", "value": to_fixed(amount, 2)},
                }],
                "payment_source": {"paypal": {"experience_context": {
                    "brand_name": "DiamondX-A1005", "user_action": "PAY_NOW", "shipping_preference": "NO_SHIPPING",
                    "return_url": f"{origin}/?billing=paypal", "cancel_url": f"{origin}/?billing=paypal-cancelled",
                }}},
            }, str(uuid.uuid4()))
        except PaypalError as error:
            raise ApiError(error.status, error.message) from None
        approve_url = next((link.get("href") for link in order.get("links") or [] if link.get("rel") in ("payer-action", "approve")), None)
        if not approve_url:
            raise ApiError(502, "PayPal did not return a payment page. Try again.")
        await request.app.state.pool.execute(
            "INSERT INTO paypal_orders (order_id, organization_id, plan_key, billing_cycle, amount_usd) VALUES ($1, $2, $3, $4, $5)",
            order["id"], user.organization_id, plan.key, cycle, amount,
        )
        return JSONResponse({"orderId": order["id"], "approveUrl": approve_url, "amountUsd": amount}, status_code=201)

    @router.post("/api/billing/paypal/capture")
    async def paypal_capture(request: Request, user: CurrentUser = Depends(require_admin)):
        data = body(request)
        order_id = data["orderId"].strip()[:40] if isinstance(data.get("orderId"), str) else ""
        pool: Pool = request.app.state.pool
        order = await pool.fetchrow(
            "SELECT order_id, plan_key, billing_cycle, amount_usd, status FROM paypal_orders WHERE order_id = $1 AND organization_id = $2",
            order_id, user.organization_id,
        )
        if not order:
            raise ApiError(404, "That PayPal payment was not started from this company.")
        if order["status"] == "captured":
            return await billing_summary(pool, user.organization_id, True)
        try:
            captured = await paypal(request).capture_order(order["order_id"])
        except PaypalError as error:
            raise ApiError(error.status, error.message) from None
        units = captured.get("purchase_units") or [{}]
        captures = ((units[0].get("payments") or {}).get("captures") or [None]) if units else [None]
        capture = captures[0] if captures else None
        amount = (capture or {}).get("amount") or {}
        paid_usd = js_number(amount.get("value")) if amount.get("value") is not None else float("nan")
        if (captured.get("status") != "COMPLETED" or not capture or capture.get("status") != "COMPLETED"
                or amount.get("currency_code") != "USD" or not abs(paid_usd - float(order["amount_usd"])) <= 0.001):
            await pool.execute("UPDATE paypal_orders SET status = 'failed' WHERE order_id = $1", order["order_id"])
            raise ApiError(402, "PayPal did not confirm the full payment, so the plan was not changed.")
        # Claim the order so a second capture request cannot apply it twice.
        claimed = await pool.execute(
            "UPDATE paypal_orders SET status = 'captured', capture_id = $2, captured_at = now() WHERE order_id = $1 AND status = 'created'",
            order["order_id"], capture["id"],
        )
        if claimed != "UPDATE 0":
            await activate_one_period(pool, razorpay(request), user.organization_id, order["plan_key"], order["billing_cycle"], "paypal")
            await record_payment(
                pool, user.organization_id,
                {"id": f"paypal_{capture['id']}", "amount": int(js_round(paid_usd * 100)), "status": "captured", "method": "paypal"},
                order["order_id"], order["plan_key"], order["billing_cycle"], "paypal", "USD",
            )
        return await billing_summary(pool, user.organization_id, True)

    return router
