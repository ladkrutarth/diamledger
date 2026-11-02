"""Ported from server/tests/billing.test.ts. Razorpay and PayPal are stand-ins (httpx.MockTransport) that record what was asked."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from diamondx.app import AppOptions, create_app
from diamondx.modules.billing.plans import PLANS, feature_for_path, plan_by_key, price_for
from diamondx.modules.billing.routes import add_cycle
from diamondx.modules.billing.subscription import access_of

from .samples import ANTWERP, invoice_with

KEY_SECRET = "test_key_secret"
WEBHOOK_SECRET = "test_webhook_secret"
BILLING_ENV = ("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "BILLING_BANK_ACCOUNT_NUMBER", "BILLING_BANK_IFSC",
               "BILLING_BANK_ACCOUNT_NAME", "PLATFORM_ADMIN_EMAILS", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET")


class FakeRazorpay:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.plans = self.subscriptions = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.replace("/v1", "", 1)
        body = json.loads(request.content) if request.content else None
        self.calls.append({"method": request.method, "path": path, "body": body})
        now = int(time.time())
        if request.method == "POST" and path == "/plans":
            self.plans += 1
            return httpx.Response(200, json={"id": f"plan_{self.plans}"})
        if request.method == "POST" and path == "/subscriptions":
            self.subscriptions += 1
            return httpx.Response(200, json={"id": f"sub_{self.subscriptions}", "plan_id": body["plan_id"], "status": "created",
                                             "current_start": None, "current_end": None, "notes": body["notes"]})
        fetched = re.match(r"^/subscriptions/([^/]+)$", path)
        if request.method == "GET" and fetched:
            return httpx.Response(200, json={"id": fetched.group(1), "status": "active", "current_start": now, "current_end": now + 30 * 86400})
        cancelled = re.match(r"^/subscriptions/([^/]+)/cancel$", path)
        if request.method == "POST" and cancelled:
            return httpx.Response(200, json={"id": cancelled.group(1), "status": "cancelled"})
        return httpx.Response(404, json={"error": {"description": "not found"}})


class FakePaypal:
    def __init__(self, capture_amount: str | None = None, prefix: str = "ORDER") -> None:
        self.calls: list[dict] = []
        self.orders: dict[str, str] = {}
        self.next = 0
        self.capture_amount, self.prefix = capture_amount, prefix

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        raw = request.content.decode() if request.content else ""
        body = json.loads(raw) if raw.startswith("{") else raw or None
        self.calls.append({"method": request.method, "path": path, "body": body})
        if path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "paypal-token"})
        if request.method == "POST" and path == "/v2/checkout/orders":
            self.next += 1
            order_id = f"{self.prefix}{self.next}"
            self.orders[order_id] = body["purchase_units"][0]["amount"]["value"]
            return httpx.Response(201, json={"id": order_id, "status": "PAYER_ACTION_REQUIRED",
                                             "links": [{"rel": "payer-action", "href": f"https://www.sandbox.paypal.com/checkoutnow?token={order_id}"}]})
        capture = re.match(r"^/v2/checkout/orders/([^/]+)/capture$", path)
        if request.method == "POST" and capture:
            value = self.capture_amount or self.orders.get(capture.group(1), "0.00")
            return httpx.Response(201, json={"id": capture.group(1), "status": "COMPLETED", "purchase_units": [{"payments": {"captures": [
                {"id": f"CAP-{capture.group(1)}", "status": "COMPLETED", "amount": {"value": value, "currency_code": "USD"}}]}}]})
        return httpx.Response(404, json={"message": "not found"})


def signature(payment_id: str, subscription_id: str) -> str:
    return hmac.new(KEY_SECRET.encode(), f"{payment_id}|{subscription_id}".encode(), hashlib.sha256).hexdigest()


def test_prices_with_gst_and_two_months_free():
    assert price_for(plan_by_key("growth"), "monthly") == {"baseInr": 3999, "gstInr": 720, "totalInr": 4719, "totalPaise": 471900}
    assert all(plan.yearlyInr == plan.monthlyInr * 10 for plan in PLANS)


def test_features_by_path():
    assert feature_for_path("/api/purchases/itc-match") == "advanced_tax"
    assert feature_for_path("/api/tax/audit-pack/zip") == "audit"
    assert feature_for_path("/api/practice/clients") == "practice"
    assert feature_for_path("/api/reminders/draft") is None
    assert feature_for_path("/api/invoices") is None


def test_grace_days_then_read_only():
    now = datetime.now(timezone.utc)
    day = timedelta(days=1)
    base = {"plan_key": "growth", "billing_cycle": "monthly", "status": "halted", "trial_ends_at": datetime.fromtimestamp(0, timezone.utc)}
    assert access_of({**base, "current_period_end": now + day}).access == "active"
    assert access_of({**base, "current_period_end": now - day}).access == "grace"
    assert access_of({**base, "current_period_end": now - 5 * day}).access == "lapsed"
    assert access_of({**base, "status": "cancelled", "current_period_end": now - day}).access == "lapsed"
    assert access_of({**base, "plan_key": "trial", "trial_ends_at": now + 3 * day, "current_period_end": None}).access == "trial"


def test_add_cycle_rolls_over_like_javascript():
    start = datetime(2026, 1, 31, 10, tzinfo=timezone.utc)
    assert add_cycle(start, "monthly") == datetime(2026, 3, 3, 10, tzinfo=timezone.utc)
    assert add_cycle(datetime(2028, 2, 29, tzinfo=timezone.utc), "yearly") == datetime(2029, 3, 1, tzinfo=timezone.utc)


@pytest.fixture
def billing_env(monkeypatch):
    for key in BILLING_ENV:
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


def make_client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 5000)), base_url="http://test")


async def test_subscriptions_end_to_end(pool, billing_env):
    razorpay, paypal = FakeRazorpay(), FakePaypal()
    app = create_app(pool, AppOptions(razorpay_transport=httpx.MockTransport(razorpay),
                                      paypal_transport=httpx.MockTransport(paypal)))

    async def register(email: str, company: str):
        await pool.execute("DELETE FROM rate_limits")  # sign-up is limited to 5 an hour per address
        agent = make_client(app)
        response = await agent.post("/api/auth/register", json={"email": email, "password": "password123", "companyName": company})
        assert response.status_code == 201, response.text
        return agent, response.json()["user"]["organizationId"]

    async def webhook(event: str, payload: dict, event_id: str, secret: str = WEBHOOK_SECRET):
        raw = json.dumps({"event": event, "payload": payload}).encode()
        sig = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        return await make_client(app).post("/api/billing/webhook", content=raw, headers={
            "Content-Type": "application/json", "X-Razorpay-Signature": sig, "X-Razorpay-Event-Id": event_id})

    owner, organization_id = await register("owner@example.com", "Meridian Diamond Exports")

    # Public plans and the 14-day trial
    plans = (await make_client(app).get("/api/billing/plans")).json()
    assert [p["key"] for p in plans["plans"]] == ["starter", "growth", "business", "ca_firm"]
    assert (plans["plans"][1]["prices"]["yearly"]["baseInr"], plans["plans"][1]["prices"]["yearly"]["totalInr"]) == (39990, 47188)
    assert plans["paymentsEnabled"] is False
    billing = (await owner.get("/api/billing")).json()
    assert (billing["planKey"], billing["access"], billing["daysLeft"], billing["paymentsEnabled"]) == ("trial", "trial", 14, False)
    assert "audit" in billing["features"]

    # No checkout until Razorpay keys are set
    refused = await owner.post("/api/billing/checkout", json={"plan": "growth", "cycle": "monthly"})
    assert refused.status_code == 503 and "not set up" in refused.json()["error"]

    # Checkout, verify, switch
    billing_env.setenv("RAZORPAY_KEY_ID", "rzp_test_key")
    billing_env.setenv("RAZORPAY_KEY_SECRET", KEY_SECRET)
    billing_env.setenv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET)
    assert (await owner.post("/api/billing/checkout", json={"plan": "gold", "cycle": "monthly"})).status_code == 400
    checkout = await owner.post("/api/billing/checkout", json={"plan": "growth", "cycle": "monthly"})
    assert checkout.status_code == 201, checkout.text
    assert {k: checkout.json()[k] for k in ("subscriptionId", "keyId", "amountInr")} == {"subscriptionId": "sub_1", "keyId": "rzp_test_key", "amountInr": 4719}
    plan_call = next(c for c in razorpay.calls if c["path"] == "/plans")
    assert (plan_call["body"]["period"], plan_call["body"]["interval"], plan_call["body"]["item"]["amount"], plan_call["body"]["item"]["currency"]) == (
        "monthly", 1, 471900, "INR")
    sub_call = next(c for c in razorpay.calls if c["path"] == "/subscriptions")["body"]
    assert (sub_call["plan_id"], sub_call["total_count"], sub_call["notes"]["organization_id"], sub_call["notes"]["plan_key"]) == (
        "plan_1", 120, organization_id, "growth")
    assert (await owner.get("/api/billing")).json()["planKey"] == "trial"
    bad = await owner.post("/api/billing/verify", json={"razorpay_payment_id": "pay_1", "razorpay_subscription_id": "sub_1", "razorpay_signature": "forged"})
    assert bad.status_code == 400
    verified = await owner.post("/api/billing/verify", json={"razorpay_payment_id": "pay_1", "razorpay_subscription_id": "sub_1",
                                                              "razorpay_signature": signature("pay_1", "sub_1")})
    assert verified.status_code == 200, verified.text
    assert {k: verified.json()[k] for k in ("planKey", "cycle", "access")} == {"planKey": "growth", "cycle": "monthly", "access": "active"}
    payment = verified.json()["payments"][0]
    assert (payment["id"], payment["amount"], payment["currency"], payment["provider"]) == ("pay_1", 4719, "INR", "razorpay")
    assert (await owner.post("/api/billing/checkout", json={"plan": "growth", "cycle": "monthly"})).status_code == 409

    # Features the plan does not include are locked
    assert (await owner.get("/api/purchases")).status_code == 200
    audit = await owner.get("/api/tax/audit-checks")
    assert audit.status_code == 402
    assert (audit.json()["code"], audit.json()["feature"]) == ("plan_feature", "audit") and "Business" in audit.json()["error"]
    assert (await owner.get("/api/practice/clients")).status_code == 402

    # Webhooks: signature, charges recorded once, upgrade on activation
    assert (await webhook("subscription.charged", {}, "evt_bad", "wrong-secret")).status_code == 400
    now = int(time.time())
    charged = {
        "subscription": {"entity": {"id": "sub_1", "status": "active", "current_start": 1, "current_end": now + 60 * 86400}},
        "payment": {"entity": {"id": "pay_2", "amount": 471900, "status": "captured", "method": "upi", "created_at": now + 60}},
    }
    assert (await webhook("subscription.charged", charged, "evt_1")).json() == {"ok": True}
    assert (await webhook("subscription.charged", charged, "evt_1")).json() == {"ok": True, "duplicate": True}
    billing = (await owner.get("/api/billing")).json()
    assert [p["id"] for p in billing["payments"]] == ["pay_2", "pay_1"] and billing["payments"][0]["method"] == "upi"
    upgrade = await owner.post("/api/billing/checkout", json={"plan": "business", "cycle": "yearly"})
    assert upgrade.json()["subscriptionId"] == "sub_2"
    assert [c for c in razorpay.calls if c["path"] == "/subscriptions"][-1]["body"]["total_count"] == 10
    activated = {"subscription": {"entity": {"id": "sub_2", "status": "active", "current_start": now, "current_end": now + 365 * 86400,
                                             "notes": {"organization_id": organization_id}}}}
    assert (await webhook("subscription.activated", activated, "evt_2")).status_code == 200
    billing = (await owner.get("/api/billing")).json()
    assert {k: billing[k] for k in ("planKey", "cycle", "access")} == {"planKey": "business", "cycle": "yearly", "access": "active"}
    assert {"method": "POST", "path": "/subscriptions/sub_1/cancel", "body": {"cancel_at_cycle_end": 0}} in razorpay.calls
    assert (await owner.get("/api/tax/audit-checks")).status_code == 200

    # Turning off renewal keeps the plan until the period ends
    cancelled = (await owner.post("/api/billing/cancel")).json()
    assert (cancelled["cancelAtPeriodEnd"], cancelled["access"]) == (True, "active")
    assert razorpay.calls[-1] == {"method": "POST", "path": "/subscriptions/sub_2/cancel", "body": {"cancel_at_cycle_end": 1}}

    # Starter limits: users and issued invoices a month
    await pool.execute(
        """UPDATE organization_subscriptions SET plan_key = 'starter', billing_cycle = 'monthly', status = 'active',
             current_period_end = now() + interval '20 days', cancel_at_period_end = false WHERE organization_id = $1""",
        organization_id,
    )
    assert (await owner.post("/api/team/members", json={"email": "one@example.com", "password": "password123", "role": "member"})).status_code == 201
    third = await owner.post("/api/team/members", json={"email": "two@example.com", "password": "password123", "role": "member"})
    assert third.status_code == 402 and "2 users" in third.json()["error"]
    today = datetime.now(timezone.utc).date().isoformat()
    created = await owner.post("/api/invoices", json={"invoice": invoice_with(
        ANTWERP, items=[{**ANTWERP["items"][0], "carats": 1, "ratePerCarat": 1000, "totalAmount": 1000}], freightUsd=0, insuranceUsd=0,
        otherChargesUsd=0, shipment={"invoiceNumber": "", "invoiceDate": today})})
    assert created.status_code == 201
    await pool.execute(
        """INSERT INTO invoices (user_id, organization_id, invoice_number, data, status, issued_at)
           SELECT user_id, organization_id, invoice_number || '-' || n, data, 'issued', now()
           FROM invoices, generate_series(1, 30) AS n WHERE id = $1""",
        created.json()["id"],
    )
    issued = await owner.patch(f"/api/invoices/{created.json()['id']}/status", json={"status": "issued"})
    assert issued.status_code == 402 and "30 issued invoices" in issued.json()["error"]

    # A lapsed trial is read-only but can still pay
    late, late_org = await register("late@example.com", "Late Gems")
    await late.get("/api/billing")
    await pool.execute("UPDATE organization_subscriptions SET trial_ends_at = now() - interval '1 day' WHERE organization_id = $1", late_org)
    assert (await late.get("/api/billing")).json()["access"] == "lapsed"
    write = await late.post("/api/buyers", json={"consignee": {"companyName": "Blocked BVBA"}})
    assert write.status_code == 402 and write.json()["code"] == "subscription_lapsed" and "free trial has ended" in write.json()["error"]
    assert (await late.get("/api/invoices")).status_code == 200
    assert (await late.post("/api/billing/checkout", json={"plan": "starter", "cycle": "monthly"})).status_code == 201
    assert (await late.post("/api/auth/logout")).status_code < 400

    # Client companies count against the accountant firm's plan
    firm, firm_org = await register("partner@firm.example", "Shah & Co")
    await firm.get("/api/billing")
    await pool.execute("UPDATE organization_subscriptions SET plan_key = 'growth', status = 'active', current_period_end = now() + interval '20 days' "
                       "WHERE organization_id = $1", firm_org)
    assert (await owner.post("/api/team/accountants", json={"email": "partner@firm.example", "role": "ca"})).status_code == 402
    await pool.execute("UPDATE organization_subscriptions SET plan_key = 'business' WHERE organization_id = $1", organization_id)
    blocked = await owner.post("/api/team/accountants", json={"email": "partner@firm.example", "role": "ca"})
    assert blocked.status_code == 402 and "not on the CA Firm plan" in blocked.json()["error"]
    await pool.execute("UPDATE organization_subscriptions SET plan_key = 'ca_firm' WHERE organization_id = $1", firm_org)
    assert (await owner.post("/api/team/accountants", json={"email": "partner@firm.example", "role": "ca"})).status_code == 201

    # Bank transfer: account, UTR, operator approval
    company, _ = await register("neft@example.com", "Neft Gems")
    assert (await company.post("/api/billing/bank-transfer", json={"plan": "growth", "cycle": "yearly"})).status_code == 503
    billing_env.setenv("BILLING_BANK_ACCOUNT_NAME", "DiamondX Software Pvt Ltd")
    billing_env.setenv("BILLING_BANK_ACCOUNT_NUMBER", "50200012345678")
    billing_env.setenv("BILLING_BANK_IFSC", "hdfc0000123")
    billing_env.setenv("PLATFORM_ADMIN_EMAILS", "ops@example.com")
    options = (await company.get("/api/billing/plans")).json()["paymentOptions"]
    assert options["bankTransfer"] and options["upi"]
    started = await company.post("/api/billing/bank-transfer", json={"plan": "growth", "cycle": "yearly"})
    assert started.status_code == 201
    assert (started.json()["account"]["accountNumber"], started.json()["account"]["ifsc"]) == ("50200012345678", "HDFC0000123")
    transfer = started.json()["transfer"]
    assert (transfer["amountInr"], transfer["status"]) == (47188, "awaiting") and re.match(r"^DX-[A-Z2-9]{6}$", transfer["referenceCode"])
    transfer_id = transfer["id"]
    assert (await company.post(f"/api/billing/bank-transfer/{transfer_id}/submit", json={"utr": "abc", "paidOn": "2026-11-01"})).status_code == 400
    sent = await company.post(f"/api/billing/bank-transfer/{transfer_id}/submit", json={"utr": "hdfcr 5202611011234", "paidOn": "2026-11-01", "payerBank": "HDFC"})
    assert sent.status_code == 200 and (sent.json()["transfer"]["status"], sent.json()["transfer"]["utr"]) == ("submitted", "HDFCR5202611011234")
    assert (await company.get("/api/billing")).json()["planKey"] == "trial"
    assert (await company.get("/api/platform/bank-transfers")).status_code == 403
    ops, _ = await register("ops@example.com", "DiamondX Ops")
    assert (await ops.get("/api/billing")).json()["platformAdmin"] is True
    queue = (await ops.get("/api/platform/bank-transfers")).json()["transfers"]
    assert [(t["id"], t["organizationName"], t["utr"]) for t in queue] == [(transfer_id, "Neft Gems", "HDFCR5202611011234")]
    assert (await ops.post(f"/api/platform/bank-transfers/{transfer_id}/reject", json={})).status_code == 400
    assert (await ops.post(f"/api/platform/bank-transfers/{transfer_id}/approve", json={"note": "Credit seen"})).status_code == 200
    assert (await ops.post(f"/api/platform/bank-transfers/{transfer_id}/approve", json={})).status_code == 409
    billing = (await company.get("/api/billing")).json()
    assert {k: billing[k] for k in ("planKey", "cycle", "access", "paymentMethod")} == {
        "planKey": "growth", "cycle": "yearly", "access": "active", "paymentMethod": "bank_transfer"}
    assert {k: billing["payments"][0][k] for k in ("provider", "amount", "currency")} == {"provider": "bank_transfer", "amount": 47188, "currency": "INR"}
    end = datetime.fromisoformat(billing["currentPeriodEnd"].replace("Z", "+00:00"))
    assert end - datetime.now(timezone.utc) > timedelta(days=360)
    assert (await company.post("/api/billing/cancel")).status_code == 409
    again = (await company.post("/api/billing/bank-transfer", json={"plan": "growth", "cycle": "yearly"})).json()["transfer"]["id"]
    assert (await company.post(f"/api/billing/bank-transfer/{again}/submit", json={"utr": "HDFCR5202611011234", "paidOn": "2026-11-02"})).status_code == 409
    await company.post(f"/api/billing/bank-transfer/{again}/submit", json={"utr": "HDFCR5202611029999", "paidOn": "2026-11-02"})
    await ops.post(f"/api/platform/bank-transfers/{again}/approve", json={})
    renewed = datetime.fromisoformat((await company.get("/api/billing")).json()["currentPeriodEnd"].replace("Z", "+00:00"))
    assert renewed - end > timedelta(days=360)

    # PayPal in US dollars
    dubai, _ = await register("dubai@example.com", "Dubai Diamonds FZE")
    assert (await dubai.post("/api/billing/paypal/order", json={"plan": "business", "cycle": "monthly"})).status_code == 503
    billing_env.setenv("PAYPAL_CLIENT_ID", "client")
    billing_env.setenv("PAYPAL_CLIENT_SECRET", "secret")
    order = await dubai.post("/api/billing/paypal/order", json={"plan": "business", "cycle": "monthly"})
    assert order.status_code == 201
    assert order.json() == {"orderId": "ORDER1", "approveUrl": "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1", "amountUsd": 99}
    created_order = next(c for c in paypal.calls if c["path"] == "/v2/checkout/orders")["body"]
    assert created_order["purchase_units"][0]["amount"] == {"currency_code": "USD", "value": "99.00"}
    assert created_order["payment_source"]["paypal"]["experience_context"]["return_url"].endswith("/?billing=paypal")
    assert (await owner.post("/api/billing/paypal/capture", json={"orderId": "ORDER1"})).status_code == 404
    captured = await dubai.post("/api/billing/paypal/capture", json={"orderId": "ORDER1"})
    assert captured.status_code == 200, captured.text
    assert {k: captured.json()[k] for k in ("planKey", "cycle", "paymentMethod", "access")} == {
        "planKey": "business", "cycle": "monthly", "paymentMethod": "paypal", "access": "active"}
    assert {k: captured.json()["payments"][0][k] for k in ("provider", "amount", "currency")} == {"provider": "paypal", "amount": 99, "currency": "USD"}
    assert len((await dubai.post("/api/billing/paypal/capture", json={"orderId": "ORDER1"})).json()["payments"]) == 1

    # A PayPal capture for less than the plan price changes nothing
    short_app = create_app(pool, AppOptions(razorpay_transport=httpx.MockTransport(razorpay),
                                            paypal_transport=httpx.MockTransport(FakePaypal(capture_amount="1.00", prefix="SHORT"))))
    await pool.execute("DELETE FROM rate_limits")
    short = make_client(short_app)
    await short.post("/api/auth/register", json={"email": "short@example.com", "password": "password123", "companyName": "Short Pay LLC"})
    short_order = (await short.post("/api/billing/paypal/order", json={"plan": "starter", "cycle": "monthly"})).json()
    assert (await short.post("/api/billing/paypal/capture", json={"orderId": short_order["orderId"]})).status_code == 402
    assert (await short.get("/api/billing")).json()["planKey"] == "trial"
