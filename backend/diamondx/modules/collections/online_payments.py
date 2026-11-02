"""Buyers paying export invoices from the buyer portal.

Online: through the exporter's own Razorpay account (UPI, debit and credit cards, net banking), in rupees. The
USD balance is converted at the exporter's collection rate, else the company or reference rate for the day.
Money goes straight to the exporter; this site never holds it. A payment is only recorded on the invoice after
it is proved genuine twice over: the Checkout signature (HMAC with the exporter's key secret) and Razorpay's own
record of the payment, fetched with the exporter's keys, matching the order's amount and currency. The signed
webhook does the same if the buyer closes the page early. Settling is idempotent: an order is claimed once.

Bank transfer: the buyer sends the bank reference (UTR, or SWIFT/MT103 reference); nothing is recorded until
someone at the exporter confirms the money arrived, with the amount actually credited.
"""

from __future__ import annotations

import json
import logging
import math
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import asyncpg
from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.crypto import SecretUnavailableError, decrypt_secret, encrypt_secret, encryption_ready
from ...core.db import Pool
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, public_base_url, require_admin, require_roles, require_user
from ...core.numbers import js_number, js_round, round_to, to_fixed
from ..billing.razorpay import RazorpayClient, RazorpayError, order_signature_valid, webhook_signature_valid
from ..invoices.payments import payment_state, record_payment
from ..invoices.portal import find_link
from ..tax.rates import rate_on

log = logging.getLogger("diamondx.collections")

IST = timezone(timedelta(hours=5, minutes=30))
KEY_ID = re.compile(r"^rzp_(test|live)_[A-Za-z0-9]{6,32}$")
WEBHOOK_TOKEN = re.compile(r"^[A-Za-z0-9_-]{20,64}$")
RAZORPAY_ID = re.compile(r"^[A-Za-z0-9_]{6,64}$")
METHOD_NAMES = {"upi": "UPI", "card": "Card", "netbanking": "Net banking", "wallet": "Wallet", "emi": "EMI", "paylater": "Pay later"}
claim_reviewer = require_roles("admin", "member", "tax")
UNAVAILABLE = "Online payment is not available for this exporter right now. Pay by bank transfer instead."


def today_ist() -> date:
    return datetime.now(IST).date()


# --- The exporter's Razorpay account ------------------------------------------------------------------------

async def load_gateway(pool: Pool, organization_id: str):
    return await pool.fetchrow("SELECT * FROM payment_gateways WHERE organization_id = $1", organization_id)


def online_available(gateway) -> bool:
    return bool(gateway and gateway["enabled"] and encryption_ready())


def gateway_client(request: Request, gateway) -> RazorpayClient:
    return RazorpayClient(request.app.state.options.razorpay_transport, gateway["key_id"], decrypt_secret(gateway["key_secret_encrypted"]))


def gateway_json(request: Request, gateway) -> dict:
    if not gateway:
        return {"connected": False, "encryptionReady": encryption_ready()}
    return {
        "connected": True,
        "keyId": gateway["key_id"],
        "mode": "live" if gateway["key_id"].startswith("rzp_live_") else "test",
        "enabled": gateway["enabled"],
        "inrRate": None if gateway["inr_rate"] is None else float(gateway["inr_rate"]),
        "webhookUrl": f"{public_base_url(request)}/api/collections/webhook/{gateway['webhook_token']}",
        "webhookSecretSet": bool(gateway["webhook_secret_encrypted"]),
        "encryptionReady": encryption_ready(),
        "updatedAt": iso(gateway["updated_at"]),
    }


async def collection_rate(pool: Pool, organization_id: str, gateway) -> dict | None:
    """Rupees per USD for a buyer paying today: the exporter's collection rate, else the day's company or reference rate."""
    if gateway["inr_rate"] is not None:
        return {"rateInr": float(gateway["inr_rate"]), "source": "Exporter's rate"}
    return await rate_on(pool, organization_id, today_ist())


async def portal_payment_options(pool: Pool, organization_id: str) -> dict:
    """What the buyer portal offers: online payment (if set up) and bank transfer (always)."""
    gateway = await load_gateway(pool, organization_id)
    online = online_available(gateway)
    rate = await collection_rate(pool, organization_id, gateway) if online else None
    return {
        "online": online and rate is not None,
        "methods": ["upi", "card", "netbanking"] if online and rate else [],
        "currency": "INR",
        "rateInr": rate["rateInr"] if rate else None,
        "rateSource": rate["source"] if rate else None,
        "testMode": bool(gateway and gateway["key_id"].startswith("rzp_test_")),
        "bankTransfer": True,
    }


# --- Recording a payment ------------------------------------------------------------------------------------

def to_order(row) -> dict:
    return {
        "id": row["id"],
        "invoiceId": row["invoice_id"],
        "invoiceNumber": row["invoice_number"],
        "buyerName": row["buyer_name"],
        "amountUsd": float(row["amount_usd"]),
        "amountInr": row["amount_paise"] / 100,
        "rateInr": float(row["rate_inr"]),
        "method": row["method"],
        "razorpayPaymentId": row["razorpay_payment_id"],
        "recorded": row["payment_id"] is not None,
        "recordError": row["record_error"],
        "paidAt": iso(row["paid_at"]),
    }


async def settle(pool: Pool, order, payment: dict) -> None:
    """Records a genuine Razorpay payment for an order on its invoice, once. `payment` is Razorpay's payment
    entity, fetched with the exporter's keys or taken from a signed webhook."""
    if (payment.get("order_id") != order["razorpay_order_id"] or payment.get("currency") != "INR"
            or int(js_number(payment.get("amount"))) != int(order["amount_paise"])):
        log.error("Razorpay payment %s does not match order %s (%s %s)", payment.get("id"), order["razorpay_order_id"],
                  payment.get("amount"), payment.get("currency"))
        raise ApiError(409, "Razorpay reports a different amount for this payment. Send the payment ID to the exporter.")
    if payment.get("status") != "captured":
        raise ApiError(409, "The payment is not complete yet. If money was taken, it will show here within a few minutes.")
    method = str(payment.get("method") or "")[:20]
    claimed = await pool.fetchrow(
        """UPDATE collection_orders SET status = 'paid', razorpay_payment_id = $2, method = $3, paid_at = now()
           WHERE id = $1 AND status = 'created' RETURNING id""",
        order["id"], payment["id"], method,
    )
    if not claimed:
        return  # Already recorded, by the other of the page and the webhook.
    system = SimpleNamespace(organization_id=order["organization_id"], id=None)
    try:
        # within_balance: two open orders for the same invoice (two tabs, a retry) can both be paid. The second
        # is not booked as an overpayment; it is flagged so the exporter refunds or records it by hand.
        result = await record_payment(pool, system, order["invoice_id"], {
            "amountUsd": float(order["amount_usd"]),
            "paidOn": today_ist().isoformat(),
            "reference": f"Razorpay {payment['id']} ({METHOD_NAMES.get(method, method or 'online')})",
            "bankRateInr": float(order["rate_inr"]),
        }, within_balance=True)
    except Exception:
        # The order is already claimed, so a retry would not record it: leave a note instead of losing it.
        log.exception("Online payment %s received but recording it failed", payment["id"])
        await pool.execute("UPDATE collection_orders SET record_error = $2 WHERE id = $1", order["id"],
                           "Could not be recorded automatically. Record it by hand.")
        return
    if result.ok:
        await pool.execute("UPDATE collection_orders SET payment_id = $2 WHERE id = $1", order["id"], result.payment_id)
    else:
        # The money is in the exporter's account either way; leave a note so someone records it by hand.
        log.warning("Online payment %s received but not recorded: %s", payment["id"], result.error)
        error = result.error or "Not recorded."
        if "more than the balance" in error:
            error = "More than the balance still due (the invoice was already paid). Refund it from Razorpay, or record it by hand."
        await pool.execute("UPDATE collection_orders SET record_error = $2 WHERE id = $1", order["id"], error)


# --- Buyer side (public, by portal token) -------------------------------------------------------------------

async def portal_invoice(pool: Pool, link, invoice_id: str):
    if not is_uuid(invoice_id):
        return None
    return await pool.fetchrow(
        """SELECT id, invoice_number, status, to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date
           FROM invoices
           WHERE id = $1 AND organization_id = $2 AND LOWER(TRIM(buyer_name)) = LOWER(TRIM($3)) AND status IN ('issued', 'paid')""",
        invoice_id, link["organization_id"], link["buyer_name"],
    )


async def _open(request: Request, token: str, invoice_id: str):
    pool: Pool = request.app.state.pool
    link = await find_link(pool, token)
    if not link:
        raise ApiError(404, "This link has expired or was withdrawn. Ask the exporter for a new one.")
    invoice = await portal_invoice(pool, link, invoice_id)
    if not invoice:
        raise ApiError(404, "Invoice not found.")
    due = (await payment_state(pool, invoice["id"]))["dueUsd"]
    if invoice["status"] != "issued" or due <= 0:
        raise ApiError(409, "This invoice is already paid.")
    return pool, link, invoice, due


def read_amount(value, due: float) -> float:
    """The USD amount to pay: the whole balance unless a smaller part is given."""
    if value is None or value == "":
        return due
    amount = round_to(js_number(value), 2)
    if not math.isfinite(amount) or amount <= 0:
        raise ApiError(400, "Enter an amount greater than zero.")
    if amount > due + 0.001:
        raise ApiError(400, f"The balance due is USD {to_fixed(due, 2)}. Enter that or less.")
    return amount


def _text(data: dict, key: str, limit: int) -> str:
    value = data.get(key)
    return value.strip()[:limit] if isinstance(value, str) else ""


def build_router():
    router = api_router(prefix="")

    @router.post("/api/portal/{token}/invoices/{invoice_id}/order")
    async def create_order(token: str, invoice_id: str, request: Request):
        """Starts paying an invoice online. The page opens Razorpay Checkout with the answer."""
        pool, link, invoice, due = await _open(request, token, invoice_id)
        gateway = await load_gateway(pool, link["organization_id"])
        if not online_available(gateway):
            raise ApiError(409, UNAVAILABLE)
        amount_usd = read_amount(body(request).get("amountUsd"), due)
        rate = await collection_rate(pool, link["organization_id"], gateway)
        if not rate:
            raise ApiError(409, "The exporter has not set an exchange rate for online payment yet. Pay by bank transfer instead.")
        rate_inr = round_to(rate["rateInr"], 4)
        amount_paise = int(js_round(amount_usd * rate_inr * 100))
        if amount_paise < 100:
            raise ApiError(400, "The amount is too small to pay online.")
        order_id = str(uuid4())
        try:
            client = gateway_client(request, gateway)
            order = await client.create_order(amount_paise, invoice["invoice_number"], {
                "invoice_number": invoice["invoice_number"], "collection_order_id": order_id, "amount_usd": to_fixed(amount_usd, 2),
            })
        except SecretUnavailableError as error:
            log.error("Gateway for %s unusable: %s", link["organization_id"], error)
            raise ApiError(503, UNAVAILABLE) from None
        except RazorpayError as error:
            raise ApiError(error.status, error.message) from None
        await pool.execute(
            """INSERT INTO collection_orders (id, organization_id, invoice_id, portal_link_id, razorpay_order_id, amount_usd, amount_paise, rate_inr)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
            order_id, link["organization_id"], invoice["id"], link["id"], order["id"], amount_usd, amount_paise, rate_inr,
        )
        return JSONResponse({
            "orderId": order["id"],
            "keyId": gateway["key_id"],
            "amount": amount_paise,
            "currency": "INR",
            "amountInr": amount_paise / 100,
            "amountUsd": amount_usd,
            "rateInr": rate_inr,
            "rateSource": rate["source"],
            "name": link["organization_name"],
            "description": f"Invoice {invoice['invoice_number']}",
        }, status_code=201)

    @router.post("/api/portal/{token}/payments/verify")
    async def verify(token: str, request: Request):
        """Called by the page when Checkout reports success. Records the payment once it is proved genuine."""
        pool: Pool = request.app.state.pool
        link = await find_link(pool, token)
        if not link:
            raise ApiError(404, "This link has expired or was withdrawn.")
        data = body(request)
        order_id, payment_id, signature = (_text(data, key, 200) for key in ("razorpay_order_id", "razorpay_payment_id", "razorpay_signature"))
        if not RAZORPAY_ID.match(order_id) or not RAZORPAY_ID.match(payment_id):
            raise ApiError(400, "The payment could not be verified.")
        order = await pool.fetchrow(
            "SELECT * FROM collection_orders WHERE razorpay_order_id = $1 AND organization_id = $2 AND portal_link_id = $3",
            order_id, link["organization_id"], link["id"],
        )
        gateway = await load_gateway(pool, link["organization_id"])
        if not order or not gateway:
            raise ApiError(404, "Payment not found.")
        try:
            client = gateway_client(request, gateway)
        except SecretUnavailableError:
            raise ApiError(503, "The payment could not be checked right now. If money was taken, it will show here within a few minutes.") from None
        if not order_signature_valid(order_id, payment_id, signature, client.credentials[1]):
            raise ApiError(400, "The payment could not be verified. If money was taken, it will show here within a few minutes.")
        if order["status"] == "created":
            try:
                payment = await client.fetch_payment(payment_id)
                if payment.get("status") == "authorized":
                    payment = await client.capture_payment(payment_id, int(order["amount_paise"]))
            except RazorpayError as error:
                raise ApiError(error.status, error.message) from None
            await settle(pool, order, payment)
        state = await payment_state(pool, order["invoice_id"])
        return {"paid": True, "status": state["status"], "dueUsd": state["dueUsd"]}

    @router.post("/api/portal/{token}/invoices/{invoice_id}/claims")
    async def submit_claim(token: str, invoice_id: str, request: Request):
        """The buyer reports a bank transfer. It waits for the exporter to confirm the money arrived."""
        pool, link, invoice, due = await _open(request, token, invoice_id)
        data = body(request)
        amount = read_amount(data.get("amountUsd"), due)
        reference = _text(data, "reference", 60)
        if len(reference) < 4:
            raise ApiError(400, "Enter the bank reference: the UTR, or the SWIFT (MT103) reference.")
        paid_on_text = _text(data, "paidOn", 10)
        try:
            paid_on = date.fromisoformat(paid_on_text)
        except ValueError:
            raise ApiError(400, "Enter the date the money was sent.") from None
        if paid_on > today_ist() + timedelta(days=1) or paid_on < date.fromisoformat(invoice["invoice_date"]) - timedelta(days=366):
            raise ApiError(400, "Enter the date the money was sent.")
        try:
            row = await pool.fetchrow(
                """INSERT INTO payment_claims (organization_id, invoice_id, portal_link_id, amount_usd, paid_on, reference, payer_note)
                   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, status""",
                link["organization_id"], invoice["id"], link["id"], amount, paid_on, reference, _text(data, "note", 500),
            )
        except asyncpg.UniqueViolationError:
            raise ApiError(409, "This bank reference has already been sent to the exporter.") from None
        return JSONResponse({"id": row["id"], "status": row["status"]}, status_code=201)

    @router.post("/api/collections/webhook/{webhook_token}")
    async def webhook(webhook_token: str, request: Request):
        """The exporter's Razorpay webhook (payment.authorized, payment.captured, order.paid). Signed with the
        exporter's webhook secret. An authorized payment is captured here, so it is not refunded by Razorpay
        when the buyer closes the page before it reports back."""
        raw = await request.body()
        pool: Pool = request.app.state.pool
        gateway = await pool.fetchrow("SELECT * FROM payment_gateways WHERE webhook_token = $1", webhook_token) if WEBHOOK_TOKEN.match(webhook_token) else None
        if not gateway or not gateway["webhook_secret_encrypted"]:
            raise ApiError(404, "Unknown webhook.")
        try:
            secret = decrypt_secret(gateway["webhook_secret_encrypted"])
        except SecretUnavailableError:
            log.error("Webhook secret for %s cannot be read; check ENCRYPTION_KEY.", gateway["organization_id"])
            raise ApiError(503, "Webhook secret unavailable.") from None
        if not webhook_signature_valid(raw, request.headers.get("x-razorpay-signature"), secret):
            raise ApiError(400, "Bad signature.")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "Bad body.") from None
        event = payload.get("event") if isinstance(payload, dict) else None
        if event not in ("payment.authorized", "payment.captured", "order.paid"):
            return {"ok": True, "ignored": event}
        entity = ((payload.get("payload") or {}).get("payment") or {}).get("entity")
        if not isinstance(entity, dict) or not entity.get("id") or not entity.get("order_id"):
            return {"ok": True, "ignored": "no payment"}
        order = await pool.fetchrow(
            "SELECT * FROM collection_orders WHERE razorpay_order_id = $1 AND organization_id = $2", entity["order_id"], gateway["organization_id"]
        )
        if not order:
            return {"ok": True, "ignored": "unknown order"}
        if order["status"] != "created":
            return {"ok": True}
        if entity.get("status") == "authorized":
            # Capture the amount on our order, never what the webhook says; settle then checks Razorpay's answer.
            try:
                entity = await gateway_client(request, gateway).capture_payment(str(entity["id"]), int(order["amount_paise"]))
            except SecretUnavailableError:
                log.error("Key secret for %s cannot be read; check ENCRYPTION_KEY.", gateway["organization_id"])
                raise ApiError(503, "Gateway keys unavailable.") from None
            except RazorpayError as error:
                # 5xx: Razorpay retries the webhook. Anything else (already captured, ...) waits for payment.captured.
                if error.status >= 500:
                    raise ApiError(503, error.message) from None
                return {"ok": False, "error": error.message}
        try:
            await settle(pool, order, entity)
        except ApiError as error:
            # A mismatch will not fix itself on retry; answer 200 so Razorpay stops, and keep the log.
            return {"ok": False, "error": error.message}
        return {"ok": True}

    # --- Exporter side ---------------------------------------------------------------------------------------

    @router.get("/api/payment-gateway")
    async def get_gateway(request: Request, user: CurrentUser = Depends(require_admin)):
        return gateway_json(request, await load_gateway(request.app.state.pool, user.organization_id))

    @router.put("/api/payment-gateway")
    async def save_gateway(request: Request, user: CurrentUser = Depends(require_admin)):
        if not encryption_ready():
            raise ApiError(503, "Set ENCRYPTION_KEY on the server before connecting Razorpay.")
        pool: Pool = request.app.state.pool
        data = body(request)
        existing = await load_gateway(pool, user.organization_id)
        key_id = _text(data, "keyId", 64)
        if not KEY_ID.match(key_id):
            raise ApiError(400, "Enter the Razorpay key ID. It starts with rzp_live_ or rzp_test_.")
        key_secret = _text(data, "keySecret", 200)
        if not key_secret:
            if not existing or existing["key_id"] != key_id:
                raise ApiError(400, "Enter the key secret for this key ID.")
            try:
                key_secret = decrypt_secret(existing["key_secret_encrypted"])
            except SecretUnavailableError as error:
                raise ApiError(400, str(error)) from None
        webhook_secret = _text(data, "webhookSecret", 200)
        rate_value = data.get("inrRate")
        inr_rate = None
        if rate_value not in (None, ""):
            inr_rate = round_to(js_number(rate_value), 4)
            if not math.isfinite(inr_rate) or not 0 < inr_rate < 1000:
                raise ApiError(400, "Enter the exchange rate in rupees per USD, or leave it blank to use the day's rate.")
        enabled = data.get("enabled") is not False
        try:
            await RazorpayClient(request.app.state.options.razorpay_transport, key_id, key_secret).check_keys()
        except RazorpayError as error:
            raise ApiError(400, error.message) from None
        webhook_encrypted = encrypt_secret(webhook_secret) if webhook_secret else (existing["webhook_secret_encrypted"] if existing else None)
        row = await pool.fetchrow(
            """INSERT INTO payment_gateways (organization_id, key_id, key_secret_encrypted, webhook_secret_encrypted, webhook_token, inr_rate, enabled, updated_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (organization_id) DO UPDATE SET key_id = EXCLUDED.key_id, key_secret_encrypted = EXCLUDED.key_secret_encrypted,
                 webhook_secret_encrypted = EXCLUDED.webhook_secret_encrypted, inr_rate = EXCLUDED.inr_rate, enabled = EXCLUDED.enabled,
                 updated_by = EXCLUDED.updated_by, updated_at = now()
               RETURNING *""",
            user.organization_id, key_id, encrypt_secret(key_secret), webhook_encrypted,
            existing["webhook_token"] if existing else secrets.token_urlsafe(24), inr_rate, enabled, user.id,
        )
        return gateway_json(request, row)

    @router.delete("/api/payment-gateway")
    async def remove_gateway(request: Request, user: CurrentUser = Depends(require_admin)):
        await request.app.state.pool.execute("DELETE FROM payment_gateways WHERE organization_id = $1", user.organization_id)
        return gateway_json(request, None)

    @router.get("/api/collections/incoming")
    async def incoming(request: Request, user: CurrentUser = Depends(require_user)):
        """Bank transfers buyers have reported, and payments received online."""
        pool: Pool = request.app.state.pool
        claims = await pool.fetch(
            """SELECT c.*, to_char(c.paid_on, 'YYYY-MM-DD') AS paid_on_text, i.invoice_number, i.buyer_name
               FROM payment_claims c JOIN invoices i ON i.id = c.invoice_id
               WHERE c.organization_id = $1 ORDER BY (c.status = 'submitted') DESC, c.created_at DESC LIMIT 200""",
            user.organization_id,
        )
        online = await pool.fetch(
            """SELECT o.*, i.invoice_number, i.buyer_name FROM collection_orders o JOIN invoices i ON i.id = o.invoice_id
               WHERE o.organization_id = $1 AND o.status = 'paid' ORDER BY o.paid_at DESC LIMIT 200""",
            user.organization_id,
        )
        return {"claims": [to_claim(row) for row in claims], "online": [to_order(row) for row in online]}

    async def _decide(request: Request, claim_id: str, user: CurrentUser, status: str):
        if not is_uuid(claim_id):
            raise ApiError(404, "Report not found.")
        pool: Pool = request.app.state.pool
        claim = await pool.fetchrow(
            f"""UPDATE payment_claims SET status = '{status}', reviewed_by = $3, reviewed_at = now(), review_note = $4
                WHERE id = $1 AND organization_id = $2 AND status = 'submitted' RETURNING *""",
            claim_id, user.organization_id, user.id, _text(body(request), "note", 500),
        )
        if claim:
            return pool, claim
        if await pool.fetchval("SELECT 1 FROM payment_claims WHERE id = $1 AND organization_id = $2", claim_id, user.organization_id):
            raise ApiError(409, "This report has already been dealt with.")
        raise ApiError(404, "Report not found.")

    async def _claim_row(pool: Pool, claim_id: str):
        return await pool.fetchrow(
            """SELECT c.*, to_char(c.paid_on, 'YYYY-MM-DD') AS paid_on_text, i.invoice_number, i.buyer_name
               FROM payment_claims c JOIN invoices i ON i.id = c.invoice_id WHERE c.id = $1""",
            claim_id,
        )

    @router.post("/api/collections/claims/{claim_id}/confirm")
    async def confirm_claim(claim_id: str, request: Request, user: CurrentUser = Depends(claim_reviewer)):
        """The money arrived: records it on the invoice, with the amount actually credited if it differs."""
        pool, claim = await _decide(request, claim_id, user, "confirmed")
        data = body(request)
        result = await record_payment(pool, user, claim["invoice_id"], {
            "amountUsd": data["amountUsd"] if data.get("amountUsd") not in (None, "") else float(claim["amount_usd"]),
            "paidOn": data["paidOn"] if isinstance(data.get("paidOn"), str) and data["paidOn"] else claim["paid_on"].isoformat(),
            "reference": claim["reference"],
            "bankRateInr": data.get("bankRateInr"),
        })
        if not result.ok:
            await pool.execute(
                "UPDATE payment_claims SET status = 'submitted', reviewed_by = NULL, reviewed_at = NULL, review_note = '' WHERE id = $1", claim["id"]
            )
            raise ApiError(result.status, result.error)
        await pool.execute("UPDATE payment_claims SET payment_id = $2 WHERE id = $1", claim["id"], result.payment_id)
        return {"claim": to_claim(await _claim_row(pool, claim["id"])), "invoice": result.state}

    @router.post("/api/collections/claims/{claim_id}/reject")
    async def reject_claim(claim_id: str, request: Request, user: CurrentUser = Depends(claim_reviewer)):
        pool, claim = await _decide(request, claim_id, user, "rejected")
        return {"claim": to_claim(await _claim_row(pool, claim["id"]))}

    return router


def to_claim(row) -> dict:
    return {
        "id": row["id"],
        "invoiceId": row["invoice_id"],
        "invoiceNumber": row["invoice_number"],
        "buyerName": row["buyer_name"],
        "amountUsd": float(row["amount_usd"]),
        "paidOn": row["paid_on_text"],
        "reference": row["reference"],
        "payerNote": row["payer_note"],
        "status": row["status"],
        "reviewNote": row["review_note"],
        "reviewedAt": iso(row["reviewed_at"]),
        "createdAt": iso(row["created_at"]),
    }
