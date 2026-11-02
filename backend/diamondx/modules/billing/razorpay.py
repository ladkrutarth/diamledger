"""Razorpay Subscriptions over its REST API (port of server/modules/billing/razorpay.ts).

Needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET; webhooks also need RAZORPAY_WEBHOOK_SECRET.
Use test-mode keys (rzp_test_...) until you are ready to take real payments.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
from urllib.parse import quote

import httpx

from ...core.db import Pool
from .plans import Plan, price_for
from .providers import razorpay_configured

log = logging.getLogger("diamondx.razorpay")

API = "https://api.razorpay.com/v1"
# Monthly subscriptions renew for up to 10 years, yearly ones for 10 years. Either can be cancelled any time.
TOTAL_COUNT = {"monthly": 120, "yearly": 10}


class RazorpayError(Exception):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def razorpay_key_id() -> str:
    return os.environ.get("RAZORPAY_KEY_ID", "")


class RazorpayClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport

    async def call(self, method: str, path: str, body: dict | None = None) -> dict:
        if not razorpay_configured():
            raise RazorpayError("Online payments are not set up on this server yet.", 503)
        async with httpx.AsyncClient(transport=self.transport, timeout=20.0) as client:
            response = await client.request(
                method,
                f"{API}{path}",
                auth=(os.environ["RAZORPAY_KEY_ID"], os.environ["RAZORPAY_KEY_SECRET"]),
                headers={"Content-Type": "application/json"},
                content=None if body is None else json.dumps(body),
            )
        text = response.text
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        if response.status_code >= 400:
            description = parsed.get("error", {}).get("description") if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict) else None
            log.error("Razorpay %s %s failed (%s): %s", method, path, response.status_code, description or text[:200])
            raise RazorpayError(f"Razorpay: {description}" if description else "The payment service did not answer. Try again in a minute.", 502)
        return parsed or {}

    async def plan_id(self, pool: Pool, plan: Plan, cycle: str) -> str:
        """The Razorpay plan for this plan, cycle and price, created the first time it is needed."""
        price = price_for(plan, cycle)
        query = "SELECT razorpay_plan_id FROM razorpay_plans WHERE plan_key = $1 AND billing_cycle = $2 AND amount_paise = $3"
        found = await pool.fetchval(query, plan.key, cycle, price["totalPaise"])
        if found:
            return found
        created = await self.call("POST", "/plans", {
            "period": cycle,
            "interval": 1,
            "item": {"name": f"DiamondX {plan.name} ({cycle})", "amount": price["totalPaise"], "currency": "INR",
                     "description": f"₹{price['baseInr']} + 18% GST ₹{price['gstInr']}"},
            "notes": {"plan_key": plan.key, "billing_cycle": cycle},
        })
        await pool.execute(
            """INSERT INTO razorpay_plans (plan_key, billing_cycle, amount_paise, razorpay_plan_id) VALUES ($1, $2, $3, $4)
               ON CONFLICT (plan_key, billing_cycle, amount_paise) DO NOTHING""",
            plan.key, cycle, price["totalPaise"], created["id"],
        )
        # Another server may have created one at the same moment; use whichever was stored first.
        return await pool.fetchval(query, plan.key, cycle, price["totalPaise"])

    async def create_subscription(self, razorpay_plan_id: str, cycle: str, notes: dict) -> dict:
        return await self.call("POST", "/subscriptions", {
            "plan_id": razorpay_plan_id, "total_count": TOTAL_COUNT[cycle], "quantity": 1, "customer_notify": 1, "notes": notes,
        })

    async def fetch_subscription(self, subscription_id: str) -> dict:
        return await self.call("GET", f"/subscriptions/{quote(subscription_id, safe='')}")

    async def cancel_subscription(self, subscription_id: str, at_cycle_end: bool) -> dict:
        return await self.call("POST", f"/subscriptions/{quote(subscription_id, safe='')}/cancel", {"cancel_at_cycle_end": 1 if at_cycle_end else 0})


def _safe_equal(expected: str, actual: str) -> bool:
    return hmac.compare_digest(expected.encode(), actual.encode())


def checkout_signature_valid(payment_id: str, subscription_id: str, signature: str) -> bool:
    """The signature Checkout returns after the first payment: HMAC-SHA256 of "payment_id|subscription_id"."""
    secret = os.environ.get("RAZORPAY_KEY_SECRET")
    if not secret or not payment_id or not subscription_id or not signature:
        return False
    expected = hmac.new(secret.encode(), f"{payment_id}|{subscription_id}".encode(), hashlib.sha256).hexdigest()
    return _safe_equal(expected, signature)


def webhook_signature_valid(raw_body: bytes, signature: str | None) -> bool:
    """The X-Razorpay-Signature header on a webhook: HMAC-SHA256 of the exact request body."""
    secret = os.environ.get("RAZORPAY_WEBHOOK_SECRET")
    if not secret or not signature:
        return False
    return _safe_equal(hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest(), signature)
