"""Buyers paying invoices from the portal: the exporter's own Razorpay account (a stand-in here), and bank
transfers the exporter confirms."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from datetime import date

import httpx
import pytest

from diamondx.app import AppOptions, create_app

from .samples import ANTWERP, invoice_with

KEY_ID = "rzp_test_Exporter01"
KEY_SECRET = "exporter_key_secret"
WEBHOOK_SECRET = "exporter_webhook_secret"
BUYER = "Antwerp Gems BVBA"


class ExporterRazorpay:
    """The exporter's Razorpay account. Answers 401 to any other keys, like the real API."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.orders: dict[str, dict] = {}
        self.payments: dict[str, dict] = {}
        self.next_order = 0

    def pay(self, order_id: str, payment_id: str, *, status: str = "captured", method: str = "upi", amount: int | None = None) -> dict:
        """The buyer pays in Checkout: Razorpay now knows the payment."""
        payment = {"id": payment_id, "order_id": order_id, "amount": amount if amount is not None else self.orders[order_id]["amount"],
                   "currency": "INR", "status": status, "method": method}
        self.payments[payment_id] = payment
        return payment

    def __call__(self, request: httpx.Request) -> httpx.Response:
        expected = "Basic " + base64.b64encode(f"{KEY_ID}:{KEY_SECRET}".encode()).decode()
        if request.headers.get("authorization") != expected:
            return httpx.Response(401, json={"error": {"description": "Authentication failed"}})
        path = request.url.path.replace("/v1", "", 1)
        body = json.loads(request.content) if request.content else None
        self.calls.append({"method": request.method, "path": path, "body": body})
        if request.method == "GET" and path == "/orders":
            return httpx.Response(200, json={"items": []})
        if request.method == "POST" and path == "/orders":
            self.next_order += 1
            order = {"id": f"order_{self.next_order:04d}", "amount": body["amount"], "currency": body["currency"], "notes": body["notes"]}
            self.orders[order["id"]] = order
            return httpx.Response(200, json=order)
        fetched = re.match(r"^/payments/([^/]+)$", path)
        if request.method == "GET" and fetched and fetched.group(1) in self.payments:
            return httpx.Response(200, json=self.payments[fetched.group(1)])
        captured = re.match(r"^/payments/([^/]+)/capture$", path)
        if request.method == "POST" and captured and captured.group(1) in self.payments:
            payment = self.payments[captured.group(1)]
            payment["status"] = "captured"
            return httpx.Response(200, json=payment)
        return httpx.Response(404, json={"error": {"description": "not found"}})


def checkout_signature(order_id: str, payment_id: str, secret: str = KEY_SECRET) -> str:
    return hmac.new(secret.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()


@pytest.fixture
def razorpay():
    return ExporterRazorpay()


@pytest.fixture
def make(pool, razorpay, monkeypatch):
    monkeypatch.setenv("ENCRYPTION_KEY", "a-test-encryption-key-of-at-least-32-chars")
    for name in ("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "APP_URL"):
        monkeypatch.delenv(name, raising=False)
    app = create_app(pool, AppOptions(razorpay_transport=httpx.MockTransport(razorpay)))

    def client() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 5000)), base_url="http://test")

    return client


async def register(make, pool, email: str, company: str):
    await pool.execute("DELETE FROM rate_limits")
    agent = make()
    response = await agent.post("/api/auth/register", json={"email": email, "password": "password123", "companyName": company})
    assert response.status_code == 201, response.text
    return agent, response.json()["user"]["organizationId"]


async def issue(agent, amount: float, buyer: str = BUYER, invoice_date: str | None = None) -> dict:
    invoice_date = invoice_date or date.today().isoformat()
    created = await agent.post("/api/invoices", json={"invoice": invoice_with(
        ANTWERP, exchangeRateInr=84, items=[{**ANTWERP["items"][0], "carats": 1, "ratePerCarat": amount, "totalAmount": amount}],
        freightUsd=0, insuranceUsd=0, otherChargesUsd=0,
        shipment={"invoiceNumber": "", "invoiceDate": invoice_date, "countryOfDestination": "Belgium"}, consignee={"companyName": buyer})})
    assert created.status_code == 201, created.text
    assert (await agent.patch(f"/api/invoices/{created.json()['id']}/status", json={"status": "issued"})).status_code == 200
    return created.json()


async def portal_token(agent, buyer: str = BUYER) -> str:
    link = await agent.post("/api/portal-links", json={"buyerName": buyer, "days": 30})
    assert link.status_code == 201
    return link.json()["url"].split("portal=")[1]


async def connect(agent, **extra):
    return await agent.put("/api/payment-gateway", json={"keyId": KEY_ID, "keySecret": KEY_SECRET, "webhookSecret": WEBHOOK_SECRET, **extra})


async def webhook(make, url_path: str, event: str, payment: dict, secret: str = WEBHOOK_SECRET):
    raw = json.dumps({"event": event, "payload": {"payment": {"entity": payment}}}).encode()
    signature = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return await make().post(url_path, content=raw, headers={"Content-Type": "application/json", "X-Razorpay-Signature": signature})


async def payments_of(agent, invoice_id: str) -> dict:
    return (await agent.get(f"/api/invoices/{invoice_id}/payments")).json()


# --- Connecting the exporter's Razorpay account ---------------------------------------------------------

async def test_connecting_razorpay_checks_and_encrypts_the_keys(make, pool, monkeypatch):
    owner, organization_id = await register(make, pool, "owner@example.com", "Meridian")
    assert (await owner.get("/api/payment-gateway")).json() == {"connected": False, "encryptionReady": True}
    assert (await owner.put("/api/payment-gateway", json={"keyId": "nope", "keySecret": "x"})).status_code == 400
    wrong = await owner.put("/api/payment-gateway", json={"keyId": KEY_ID, "keySecret": "wrong-secret"})
    assert wrong.status_code == 400 and "rejected" in wrong.json()["error"]
    assert (await owner.put("/api/payment-gateway", json={"keyId": KEY_ID, "keySecret": KEY_SECRET, "inrRate": 5000})).status_code == 400

    saved = await connect(owner, inrRate=85)
    assert saved.status_code == 200, saved.text
    gateway = saved.json()
    assert (gateway["connected"], gateway["keyId"], gateway["mode"], gateway["inrRate"], gateway["webhookSecretSet"]) == (True, KEY_ID, "test", 85.0, True)
    assert re.match(r"^http://test/api/collections/webhook/[A-Za-z0-9_-]{20,}$", gateway["webhookUrl"])
    assert "keySecret" not in gateway and KEY_SECRET not in json.dumps(gateway)

    stored = await pool.fetchrow("SELECT key_secret_encrypted, webhook_secret_encrypted FROM payment_gateways WHERE organization_id = $1", organization_id)
    assert KEY_SECRET not in stored["key_secret_encrypted"] and WEBHOOK_SECRET not in stored["webhook_secret_encrypted"]

    # Saving again without the secret keeps it (same key ID) and keeps the webhook URL.
    again = await owner.put("/api/payment-gateway", json={"keyId": KEY_ID, "inrRate": "86.5"})
    assert again.status_code == 200 and again.json()["inrRate"] == 86.5 and again.json()["webhookUrl"] == gateway["webhookUrl"]
    assert again.json()["webhookSecretSet"] is True
    assert (await owner.put("/api/payment-gateway", json={"keyId": "rzp_live_Different1"})).status_code == 400

    # Only admins manage it; nothing is stored without ENCRYPTION_KEY.
    await owner.post("/api/team/members", json={"email": "member@example.com", "password": "temporary1", "role": "member"})
    member = make()
    await member.post("/api/auth/login", json={"email": "member@example.com", "password": "temporary1"})
    assert (await member.get("/api/payment-gateway")).status_code == 403
    monkeypatch.delenv("ENCRYPTION_KEY")
    assert (await connect(owner)).status_code == 503
    assert (await owner.delete("/api/payment-gateway")).json()["connected"] is False


# --- Paying online --------------------------------------------------------------------------------------

async def test_buyer_pays_online_and_it_is_recorded_once(make, pool, razorpay):
    owner, organization_id = await register(make, pool, "owner@example.com", "Meridian")
    invoice = await issue(owner, 1000)
    token = await portal_token(owner)
    buyer = make()

    page = (await buyer.get(f"/api/portal/{token}")).json()
    assert page["payment"]["online"] is False and page["payment"]["bankTransfer"] is True
    assert (await buyer.post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={})).status_code == 409

    webhook_url = (await connect(owner, inrRate=85)).json()["webhookUrl"].replace("http://test", "")
    page = (await buyer.get(f"/api/portal/{token}")).json()
    assert {k: page["payment"][k] for k in ("online", "methods", "rateInr", "testMode")} == {
        "online": True, "methods": ["upi", "card", "netbanking"], "rateInr": 85.0, "testMode": True}

    # More than the balance is refused; a part payment is converted at the exporter's rate.
    assert (await buyer.post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={"amountUsd": 1000.01})).status_code == 400
    order = await buyer.post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={"amountUsd": 400})
    assert order.status_code == 201, order.text
    assert {k: order.json()[k] for k in ("keyId", "amount", "currency", "amountInr", "amountUsd", "rateInr")} == {
        "keyId": KEY_ID, "amount": 3400000, "currency": "INR", "amountInr": 34000.0, "amountUsd": 400.0, "rateInr": 85.0}
    order_id = order.json()["orderId"]
    assert razorpay.orders[order_id]["currency"] == "INR" and razorpay.orders[order_id]["amount"] == 3400000

    # A forged signature records nothing; a genuine one is checked against Razorpay, captured if needed, and recorded.
    razorpay.pay(order_id, "pay_A1", status="authorized", method="upi")
    forged = await buyer.post(f"/api/portal/{token}/payments/verify", json={
        "razorpay_order_id": order_id, "razorpay_payment_id": "pay_A1", "razorpay_signature": checkout_signature(order_id, "pay_A1", "guess")})
    assert forged.status_code == 400
    assert (await payments_of(owner, invoice["id"]))["paidUsd"] == 0
    verified = await buyer.post(f"/api/portal/{token}/payments/verify", json={
        "razorpay_order_id": order_id, "razorpay_payment_id": "pay_A1", "razorpay_signature": checkout_signature(order_id, "pay_A1")})
    assert verified.status_code == 200, verified.text
    assert verified.json() == {"paid": True, "status": "issued", "dueUsd": 600.0}
    assert {"method": "POST", "path": "/payments/pay_A1/capture", "body": {"amount": 3400000, "currency": "INR"}} in razorpay.calls
    recorded = await payments_of(owner, invoice["id"])
    assert len(recorded["payments"]) == 1
    assert (recorded["payments"][0]["amountUsd"], recorded["payments"][0]["bankRateInr"]) == (400.0, 85.0)
    assert recorded["payments"][0]["reference"] == "Razorpay pay_A1 (UPI)"

    # The page calling again, and the webhook for the same payment, do not record it twice.
    assert (await buyer.post(f"/api/portal/{token}/payments/verify", json={
        "razorpay_order_id": order_id, "razorpay_payment_id": "pay_A1", "razorpay_signature": checkout_signature(order_id, "pay_A1")})).status_code == 200
    assert (await webhook(make, webhook_url, "payment.captured", razorpay.payments["pay_A1"])).json() == {"ok": True}
    assert len((await payments_of(owner, invoice["id"]))["payments"]) == 1

    # The rest is paid but the buyer closes the page: the webhook records it.
    second = (await buyer.post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={})).json()
    assert second["amountUsd"] == 600.0
    assert (await webhook(make, webhook_url, "payment.captured", razorpay.pay(second["orderId"], "pay_A2"), secret="forged")).status_code == 400
    assert (await webhook(make, "/api/collections/webhook/" + "x" * 32, "payment.captured", razorpay.payments["pay_A2"])).status_code == 404
    assert (await webhook(make, webhook_url, "payment.captured", razorpay.payments["pay_A2"])).json() == {"ok": True}
    state = await payments_of(owner, invoice["id"])
    assert (state["status"], state["dueUsd"], len(state["payments"])) == ("paid", 0, 2)
    assert (await buyer.post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={})).status_code == 409

    incoming = (await owner.get("/api/collections/incoming")).json()
    assert [(o["razorpayPaymentId"], o["recorded"], o["method"]) for o in incoming["online"]] == [("pay_A2", True, "upi"), ("pay_A1", True, "upi")]


async def test_a_payment_that_does_not_match_its_order_is_not_recorded(make, pool, razorpay):
    owner, _ = await register(make, pool, "owner@example.com", "Meridian")
    invoice = await issue(owner, 1000)
    token = await portal_token(owner)
    webhook_url = (await connect(owner, inrRate=85)).json()["webhookUrl"].replace("http://test", "")
    order_id = (await make().post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={"amountUsd": 100})).json()["orderId"]

    short = razorpay.pay(order_id, "pay_short", amount=100)  # one rupee instead of 8,500
    answer = await webhook(make, webhook_url, "payment.captured", short)
    assert answer.status_code == 200 and answer.json()["ok"] is False
    verify = await make().post(f"/api/portal/{token}/payments/verify", json={
        "razorpay_order_id": order_id, "razorpay_payment_id": "pay_short", "razorpay_signature": checkout_signature(order_id, "pay_short")})
    assert verify.status_code == 409
    assert (await payments_of(owner, invoice["id"]))["paidUsd"] == 0


async def test_money_received_for_a_closed_month_is_flagged_not_lost(make, pool, razorpay):
    owner, organization_id = await register(make, pool, "owner@example.com", "Meridian")
    invoice = await issue(owner, 500, invoice_date="2026-04-10")
    token = await portal_token(owner)
    webhook_url = (await connect(owner, inrRate=85)).json()["webhookUrl"].replace("http://test", "")
    order_id = (await make().post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={})).json()["orderId"]
    await pool.execute("INSERT INTO closed_months (organization_id, month) VALUES ($1, $2)", organization_id, date(2026, 4, 1))

    assert (await webhook(make, webhook_url, "payment.captured", razorpay.pay(order_id, "pay_C1"))).json() == {"ok": True}
    online = (await owner.get("/api/collections/incoming")).json()["online"]
    assert len(online) == 1 and online[0]["recorded"] is False and "closed" in online[0]["recordError"].lower()


async def test_an_authorized_payment_is_captured_by_the_webhook(make, pool, razorpay):
    owner, _ = await register(make, pool, "owner@example.com", "Meridian")
    invoice = await issue(owner, 1000)
    token = await portal_token(owner)
    webhook_url = (await connect(owner, inrRate=85)).json()["webhookUrl"].replace("http://test", "")
    order_id = (await make().post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={})).json()["orderId"]

    # The buyer closes the page before it reports back; only the webhook hears about the payment.
    authorized = razorpay.pay(order_id, "pay_W1", status="authorized", method="card")
    assert (await webhook(make, webhook_url, "payment.authorized", authorized)).json() == {"ok": True}
    assert {"method": "POST", "path": "/payments/pay_W1/capture", "body": {"amount": 8500000, "currency": "INR"}} in razorpay.calls
    state = await payments_of(owner, invoice["id"])
    assert (state["status"], len(state["payments"])) == ("paid", 1)
    assert state["payments"][0]["reference"] == "Razorpay pay_W1 (Card)"

    # payment.captured arriving afterwards records nothing more.
    assert (await webhook(make, webhook_url, "payment.captured", razorpay.payments["pay_W1"])).json() == {"ok": True}
    assert len((await payments_of(owner, invoice["id"]))["payments"]) == 1


async def test_paying_twice_is_flagged_not_booked_as_overpayment(make, pool, razorpay):
    owner, _ = await register(make, pool, "owner@example.com", "Meridian")
    invoice = await issue(owner, 1000)
    token = await portal_token(owner)
    webhook_url = (await connect(owner, inrRate=85)).json()["webhookUrl"].replace("http://test", "")
    # Two tabs each start paying the full balance.
    first = (await make().post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={})).json()["orderId"]
    second = (await make().post(f"/api/portal/{token}/invoices/{invoice['id']}/order", json={})).json()["orderId"]

    assert (await webhook(make, webhook_url, "payment.captured", razorpay.pay(first, "pay_D1"))).json() == {"ok": True}
    assert (await webhook(make, webhook_url, "payment.captured", razorpay.pay(second, "pay_D2"))).json() == {"ok": True}
    state = await payments_of(owner, invoice["id"])
    assert (state["paidUsd"], len(state["payments"])) == (1000, 1)
    online = {o["razorpayPaymentId"]: o for o in (await owner.get("/api/collections/incoming")).json()["online"]}
    assert online["pay_D1"]["recorded"] is True
    assert online["pay_D2"]["recorded"] is False and "Refund" in online["pay_D2"]["recordError"]


async def test_another_buyers_link_cannot_pay_or_see_an_invoice(make, pool):
    owner, _ = await register(make, pool, "owner@example.com", "Meridian")
    invoice = await issue(owner, 1000)
    await connect(owner, inrRate=85)
    other_buyer = await portal_token(owner, "Somebody Else Ltd")
    assert (await make().post(f"/api/portal/{other_buyer}/invoices/{invoice['id']}/order", json={})).status_code == 404
    assert (await make().post(f"/api/portal/{other_buyer}/invoices/{invoice['id']}/claims",
                              json={"reference": "UTR123456", "paidOn": date.today().isoformat()})).status_code == 404

    rival, _ = await register(make, pool, "rival@example.com", "Rival")
    rival_link = await portal_token(rival)
    assert (await make().post(f"/api/portal/{rival_link}/invoices/{invoice['id']}/order", json={})).status_code == 404


# --- Bank transfer --------------------------------------------------------------------------------------

async def test_bank_transfer_reported_by_buyer_and_confirmed_by_exporter(make, pool):
    owner, _ = await register(make, pool, "owner@example.com", "Meridian")
    invoice = await issue(owner, 1000)
    token = await portal_token(owner)
    buyer = make()
    claims_url = f"/api/portal/{token}/invoices/{invoice['id']}/claims"
    today = date.today().isoformat()

    assert (await buyer.post(claims_url, json={"reference": "", "paidOn": today})).status_code == 400
    assert (await buyer.post(claims_url, json={"reference": "MT103-778899", "paidOn": "2099-01-01"})).status_code == 400
    sent = await buyer.post(claims_url, json={"reference": "MT103-778899", "paidOn": today, "note": "Sent from KBC Antwerp"})
    assert sent.status_code == 201, sent.text
    assert (await buyer.post(claims_url, json={"reference": "mt103-778899", "paidOn": today})).status_code == 409
    assert (await buyer.get(f"/api/portal/{token}")).json()["invoices"][0]["claimPending"] is True
    assert (await payments_of(owner, invoice["id"]))["paidUsd"] == 0  # nothing until the exporter confirms

    claims = (await owner.get("/api/collections/incoming")).json()["claims"]
    assert [(c["reference"], c["status"], c["amountUsd"], c["payerNote"]) for c in claims] == [("MT103-778899", "submitted", 1000.0, "Sent from KBC Antwerp")]

    # Another company cannot touch it; the exporter confirms the amount actually credited.
    rival, _ = await register(make, pool, "rival@example.com", "Rival")
    assert (await rival.post(f"/api/collections/claims/{claims[0]['id']}/confirm", json={})).status_code == 404
    confirmed = await owner.post(f"/api/collections/claims/{claims[0]['id']}/confirm", json={"amountUsd": 985, "bankRateInr": 84.2})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["claim"]["status"] == "confirmed"
    state = await payments_of(owner, invoice["id"])
    assert (state["paidUsd"], state["payments"][0]["reference"], state["payments"][0]["bankRateInr"]) == (985.0, "MT103-778899", 84.2)
    assert (await owner.post(f"/api/collections/claims/{claims[0]['id']}/confirm", json={})).status_code == 409

    # A report that never arrived is rejected and records nothing.
    second = await buyer.post(claims_url, json={"reference": "UTR-NOT-REAL", "paidOn": today, "amountUsd": 15})
    assert second.status_code == 201
    rejected = await owner.post(f"/api/collections/claims/{second.json()['id']}/reject", json={"note": "Not received"})
    assert rejected.json()["claim"]["status"] == "rejected" and rejected.json()["claim"]["reviewNote"] == "Not received"
    assert (await payments_of(owner, invoice["id"]))["paidUsd"] == 985.0

    activity = (await owner.get("/api/audit")).json()
    actions = {event["action"] for event in activity.get("events", activity if isinstance(activity, list) else [])}
    assert {"payments.claim_confirmed", "payments.claim_rejected"} <= actions
