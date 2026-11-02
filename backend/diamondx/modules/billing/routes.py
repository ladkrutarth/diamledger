"""Plan & billing: the summary, Razorpay checkout and webhook, cancelling (routes of server/modules/billing/billing.ts)."""

from __future__ import annotations

import calendar
import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import ApiError, CurrentUser, body, iso, require_admin, require_user
from ...core.numbers import js_string
from .plans import TRIAL_DAYS, is_cycle, plan_by_key, plan_json, price_for, public_plans
from .providers import is_platform_admin, payment_options
from .razorpay import RazorpayClient, RazorpayError, checkout_signature_valid, razorpay_key_id, webhook_signature_valid
from .subscription import access_of, load_subscription, usage_of

log = logging.getLogger("diamondx.billing")


def to_date(seconds) -> datetime | None:
    return datetime.fromtimestamp(seconds, timezone.utc) if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and seconds > 0 else None


def add_cycle(start: datetime, cycle: str) -> datetime:
    """setMonth(+1) or setFullYear(+1): the same day next month or year. A day the month does not have rolls
    over into the next month (31 January + 1 month = 3 March), as JavaScript dates do."""
    month_index = start.month - 1 + (1 if cycle == "monthly" else 12)
    year, month = start.year + month_index // 12, month_index % 12 + 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return start.replace(year=year, month=month, day=day) + timedelta(days=start.day - day)


async def activate(pool: Pool, razorpay: RazorpayClient, organization_id: str, subscription: dict, plan_key: str, cycle: str) -> None:
    """Makes a paid subscription the company's plan, and cancels the one it replaces."""
    start = to_date(subscription.get("current_start")) or datetime.now(timezone.utc)
    end = to_date(subscription.get("current_end")) or add_cycle(start, cycle)
    previous = await pool.fetchval("SELECT razorpay_subscription_id FROM organization_subscriptions WHERE organization_id = $1", organization_id)
    await pool.execute(
        """UPDATE organization_subscriptions
           SET plan_key = $2, billing_cycle = $3, status = $4, current_period_start = $5, current_period_end = $6,
               razorpay_subscription_id = $7, cancel_at_period_end = false, payment_method = 'razorpay',
               pending_subscription_id = NULL, pending_plan_key = NULL, pending_cycle = NULL, updated_at = now()
           WHERE organization_id = $1""",
        organization_id, plan_key, cycle, "authenticated" if subscription.get("status") == "authenticated" else "active", start, end,
        subscription["id"],
    )
    if previous and previous != subscription["id"]:
        try:
            await razorpay.cancel_subscription(previous, False)
        except Exception as error:
            log.error("Could not cancel replaced subscription %s: %s", previous, error)


async def activate_one_period(pool: Pool, razorpay: RazorpayClient, organization_id: str, plan_key: str, cycle: str, provider: str) -> dict:
    """A plan paid by bank transfer or PayPal for one period. Paying again for the same plan before it ends adds a
    period after the current one. Any Razorpay renewal is stopped, so the company is not charged twice."""
    row = await load_subscription(pool, organization_id)
    now = datetime.now(timezone.utc)
    extends = row["plan_key"] == plan_key and row["billing_cycle"] == cycle and row["current_period_end"] is not None and row["current_period_end"] > now
    start = row["current_period_end"] if extends else now
    end = add_cycle(start, cycle)
    await pool.execute(
        """UPDATE organization_subscriptions
           SET plan_key = $2, billing_cycle = $3, status = 'active', current_period_start = $4, current_period_end = $5,
               payment_method = $6, razorpay_subscription_id = NULL, cancel_at_period_end = false,
               pending_subscription_id = NULL, pending_plan_key = NULL, pending_cycle = NULL, updated_at = now()
           WHERE organization_id = $1""",
        organization_id, plan_key, cycle, (row["current_period_start"] or now) if extends else now, end, provider,
    )
    if row["razorpay_subscription_id"]:
        try:
            await razorpay.cancel_subscription(row["razorpay_subscription_id"], False)
        except Exception as error:
            log.error("Could not stop Razorpay renewal %s: %s", row["razorpay_subscription_id"], error)
    return {"start": start, "end": end}


async def record_payment(pool: Pool, organization_id: str, payment: dict, subscription_id: str, plan_key: str, cycle: str | None,
                         provider: str = "razorpay", currency: str = "INR") -> None:
    await pool.execute(
        """INSERT INTO subscription_payments (razorpay_payment_id, organization_id, razorpay_subscription_id, razorpay_invoice_id, plan_key,
             billing_cycle, amount_paise, status, method, paid_at, provider, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (razorpay_payment_id) DO UPDATE SET status = EXCLUDED.status""",
        payment["id"], organization_id, subscription_id, payment.get("invoice_id"), plan_key, cycle, int(payment["amount"]), payment["status"],
        payment.get("method") or "", to_date(payment.get("created_at")) or datetime.now(timezone.utc), provider, currency,
    )


async def billing_summary(pool: Pool, organization_id: str, include_history: bool) -> dict:
    row = await load_subscription(pool, organization_id)
    info = access_of(row)
    usage = await usage_of(pool, organization_id)
    history = await pool.fetch(
        """SELECT razorpay_payment_id, plan_key, billing_cycle, amount_paise, status, method, paid_at, provider, currency
           FROM subscription_payments WHERE organization_id = $1 ORDER BY paid_at DESC LIMIT 50""",
        organization_id,
    ) if include_history else []
    options = payment_options()
    plan = plan_json(info.plan)
    return {
        "planKey": row["plan_key"],
        "planName": info.plan.name,
        "cycle": row["billing_cycle"],
        "status": row["status"],
        "access": info.access,
        "daysLeft": info.days_left,
        "trialEndsAt": iso(row["trial_ends_at"]) if row["plan_key"] == "trial" else None,
        "currentPeriodEnd": iso(row["current_period_end"]),
        "cancelAtPeriodEnd": row["cancel_at_period_end"],
        "paymentMethod": row["payment_method"],
        "limits": plan["limits"],
        "features": plan["features"],
        "usage": usage,
        "paymentOptions": options,
        "paymentsEnabled": any(options.values()),
        "payments": [
            {"id": p["razorpay_payment_id"], "planKey": p["plan_key"], "cycle": p["billing_cycle"], "amount": p["amount_paise"] / 100,
             "currency": p["currency"], "provider": p["provider"], "status": p["status"], "method": p["method"], "paidAt": iso(p["paid_at"])}
            for p in history
        ],
    }


def _razorpay(request: Request) -> RazorpayClient:
    return RazorpayClient(request.app.state.options.razorpay_transport)


def build_router():
    router = api_router(prefix="/api/billing")

    @router.get("/plans")
    async def plans():
        options = payment_options()
        return {"plans": public_plans(), "gstRate": 0.18, "trialDays": TRIAL_DAYS, "paymentOptions": options, "paymentsEnabled": any(options.values())}

    @router.get("")
    async def summary(request: Request, user: CurrentUser = Depends(require_user)):
        result = await billing_summary(request.app.state.pool, user.organization_id, user.role == "admin")
        return {**result, "platformAdmin": is_platform_admin(user.email)}

    @router.post("/checkout")
    async def checkout(request: Request, user: CurrentUser = Depends(require_admin)):
        """Starts a Razorpay subscription for the chosen plan. The browser opens Razorpay Checkout with it."""
        data = body(request)
        plan, cycle = plan_by_key(data.get("plan")), data.get("cycle")
        if not plan or not is_cycle(cycle):
            raise ApiError(400, "Choose a plan and monthly or yearly billing.")
        pool: Pool = request.app.state.pool
        current = await load_subscription(pool, user.organization_id)
        access = access_of(current).access
        if (current["payment_method"] == "razorpay" and current["plan_key"] == plan.key and current["billing_cycle"] == cycle
                and access in ("active", "grace") and not current["cancel_at_period_end"]):
            raise ApiError(409, f"You are already on {plan.name} ({cycle}).")
        usage = await usage_of(pool, user.organization_id)
        if usage["users"] > plan.limits.users:
            raise ApiError(409, f"{plan.name} allows {plan.limits.users} users and this company has {usage['users']}. "
                                "Remove some team members first, or choose a larger plan.")
        razorpay = _razorpay(request)
        try:
            plan_id = await razorpay.plan_id(pool, plan, cycle)
            subscription = await razorpay.create_subscription(plan_id, cycle, {"organization_id": user.organization_id, "plan_key": plan.key,
                                                                               "billing_cycle": cycle})
        except RazorpayError as error:
            raise ApiError(error.status, error.message) from None
        await pool.execute(
            """UPDATE organization_subscriptions SET pending_subscription_id = $2, pending_plan_key = $3, pending_cycle = $4, updated_at = now()
               WHERE organization_id = $1""",
            user.organization_id, subscription["id"], plan.key, cycle,
        )
        return JSONResponse({
            "subscriptionId": subscription["id"],
            "keyId": razorpay_key_id(),
            "name": "DiamondX-A1005",
            "description": f"{plan.name} plan, billed {'monthly' if cycle == 'monthly' else 'yearly'}",
            "amountInr": price_for(plan, cycle)["totalInr"],
            "prefill": {"email": user.email, "name": user.organization_name},
        }, status_code=201)

    @router.post("/verify")
    async def verify(request: Request, user: CurrentUser = Depends(require_admin)):
        """Confirms the first payment from Checkout, so the plan starts at once instead of waiting for the webhook."""
        data = body(request)

        def text(key: str) -> str:
            return "" if data.get(key) is None else js_string(data.get(key))

        payment_id, subscription_id, signature = text("razorpay_payment_id"), text("razorpay_subscription_id"), text("razorpay_signature")
        if not checkout_signature_valid(payment_id, subscription_id, signature):
            raise ApiError(400, "The payment could not be verified. If money was taken, it will show here within a few minutes.")
        pool: Pool = request.app.state.pool
        row = await load_subscription(pool, user.organization_id)
        if row["razorpay_subscription_id"] == subscription_id:
            return await billing_summary(pool, user.organization_id, True)
        if row["pending_subscription_id"] != subscription_id or not row["pending_plan_key"] or not row["pending_cycle"]:
            raise ApiError(409, "That payment is not for the plan you chose last. Refresh and try again.")
        razorpay = _razorpay(request)
        try:
            subscription = await razorpay.fetch_subscription(subscription_id)
            plan = plan_by_key(row["pending_plan_key"])
            await activate(pool, razorpay, user.organization_id, subscription, plan.key, row["pending_cycle"])
            await record_payment(pool, user.organization_id,
                                 {"id": payment_id, "amount": price_for(plan, row["pending_cycle"])["totalPaise"], "status": "captured"},
                                 subscription_id, plan.key, row["pending_cycle"])
        except RazorpayError as error:
            raise ApiError(error.status, error.message) from None
        return await billing_summary(pool, user.organization_id, True)

    @router.post("/cancel")
    async def cancel(request: Request, user: CurrentUser = Depends(require_admin)):
        """Stops renewal. The plan keeps working until the paid period ends."""
        pool: Pool = request.app.state.pool
        row = await load_subscription(pool, user.organization_id)
        if row["payment_method"] in ("bank_transfer", "paypal"):
            raise ApiError(409, "This plan was paid for one period and does not renew on its own, so there is nothing to cancel.")
        if not row["razorpay_subscription_id"] or row["plan_key"] == "trial":
            raise ApiError(409, "There is no paid plan to cancel.")
        if row["cancel_at_period_end"]:
            return await billing_summary(pool, user.organization_id, True)
        try:
            await _razorpay(request).cancel_subscription(row["razorpay_subscription_id"], True)
        except RazorpayError as error:
            raise ApiError(error.status, error.message) from None
        await pool.execute("UPDATE organization_subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE organization_id = $1",
                           user.organization_id)
        return await billing_summary(pool, user.organization_id, True)

    @router.post("/webhook")
    async def webhook(request: Request):
        """Razorpay webhook, for subscription.activated, .charged, .pending, .halted, .cancelled, .completed, and .resumed."""
        raw = await request.body()
        if not webhook_signature_valid(raw, request.headers.get("x-razorpay-signature")):
            raise ApiError(400, "Bad signature.")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "Bad body.") from None
        payload = payload if isinstance(payload, dict) else {}
        event = payload.get("event") or ""
        entities = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
        subscription = (entities.get("subscription") or {}).get("entity") if isinstance(entities.get("subscription"), dict) else None
        event_id = request.headers.get("x-razorpay-event-id") or hashlib.sha256(raw).hexdigest()
        if not isinstance(subscription, dict) or not subscription.get("id"):
            return {"ok": True, "ignored": event}
        notes = subscription.get("notes") if isinstance(subscription.get("notes"), dict) else {}
        pool: Pool = request.app.state.pool
        row = await pool.fetchrow(
            """SELECT * FROM organization_subscriptions
               WHERE razorpay_subscription_id = $1 OR pending_subscription_id = $1 OR organization_id::text = $2 LIMIT 1""",
            subscription["id"], notes.get("organization_id") or "",
        )
        fresh = await pool.execute(
            "INSERT INTO billing_events (event_id, event, organization_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING",
            event_id, event, row["organization_id"] if row else None,
        )
        if fresh == "INSERT 0 0":
            return {"ok": True, "duplicate": True}
        if not row:
            return {"ok": True, "ignored": "unknown subscription"}

        is_pending = row["pending_subscription_id"] == subscription["id"]
        is_current = row["razorpay_subscription_id"] == subscription["id"]
        plan_key = (row["pending_plan_key"] if is_pending else row["plan_key"]) or notes.get("plan_key")
        cycle = (row["pending_cycle"] if is_pending else row["billing_cycle"]) or (notes.get("billing_cycle") if is_cycle(notes.get("billing_cycle")) else None)
        razorpay = _razorpay(request)

        if event in ("subscription.activated", "subscription.charged", "subscription.resumed", "subscription.authenticated"):
            if is_pending and plan_key and plan_key != "trial" and cycle:
                await activate(pool, razorpay, row["organization_id"], subscription, plan_key, cycle)
            elif is_current:
                await pool.execute(
                    """UPDATE organization_subscriptions SET status = $2, current_period_start = COALESCE($3, current_period_start),
                         current_period_end = COALESCE($4, current_period_end), updated_at = now() WHERE organization_id = $1""",
                    row["organization_id"], subscription.get("status"), to_date(subscription.get("current_start")), to_date(subscription.get("current_end")),
                )
            payment_entity = (entities.get("payment") or {}).get("entity") if isinstance(entities.get("payment"), dict) else None
            if event == "subscription.charged" and isinstance(payment_entity, dict) and payment_entity.get("id") and plan_key:
                await record_payment(pool, row["organization_id"], payment_entity, subscription["id"], plan_key, cycle)
        elif event in ("subscription.pending", "subscription.halted") and is_current:
            await pool.execute("UPDATE organization_subscriptions SET status = $2, updated_at = now() WHERE organization_id = $1",
                               row["organization_id"], subscription.get("status"))
        elif event in ("subscription.cancelled", "subscription.completed", "subscription.expired"):
            if is_current:
                await pool.execute(
                    "UPDATE organization_subscriptions SET status = $2, cancel_at_period_end = true, updated_at = now() WHERE organization_id = $1",
                    row["organization_id"], subscription.get("status"),
                )
            elif is_pending:
                await pool.execute(
                    """UPDATE organization_subscriptions SET pending_subscription_id = NULL, pending_plan_key = NULL, pending_cycle = NULL,
                         updated_at = now() WHERE organization_id = $1""",
                    row["organization_id"],
                )
        return {"ok": True}

    return router
