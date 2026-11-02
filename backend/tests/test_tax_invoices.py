"""GST tax invoices for subscription payments."""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from diamondx.app import AppOptions, create_app
from diamondx.modules.billing.tax_invoice import financial_year_of, split_tax, state_code_of_gstin

from .test_billing import KEY_SECRET, FakeRazorpay, make_client, signature

SELLER_GSTIN = "24AAACD1234E1Z5"  # Gujarat
GUJARAT_CUSTOMER = "24AABCM5678F1Z2"
MAHARASHTRA_CUSTOMER = "27AABCK9012G1Z8"


def test_tax_is_worked_back_from_the_gst_inclusive_price():
    assert split_tax(471900, intra_state=True) == {"taxable": 399915, "cgst": 35992, "sgst": 35993, "igst": 0}
    assert split_tax(471900, intra_state=False) == {"taxable": 399915, "cgst": 0, "sgst": 0, "igst": 71985}
    for total in (1, 99, 118, 4719_00, 47188_00, 123457):
        heads = split_tax(total, True)
        assert heads["taxable"] + heads["cgst"] + heads["sgst"] == total


def test_gstin_and_financial_year():
    assert state_code_of_gstin(SELLER_GSTIN) == "24"
    assert state_code_of_gstin(" 27aabck9012g1z8 ") == "27"
    assert state_code_of_gstin("NOT-A-GSTIN") is None
    assert financial_year_of(datetime(2026, 3, 31, 18, 29, tzinfo=timezone.utc)) == "2025-26"
    assert financial_year_of(datetime(2026, 3, 31, 18, 31, tzinfo=timezone.utc)) == "2026-27"  # 1 April in India


@pytest.fixture
def env(monkeypatch):
    for name in ("BILLING_GSTIN", "BILLING_LEGAL_NAME", "BILLING_ADDRESS", "BILLING_STATE", "BILLING_SAC", "BILLING_INVOICE_PREFIX",
                 "BILLING_LUT_ARN", "PLATFORM_ADMIN_EMAILS", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_test_key")
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", KEY_SECRET)
    return monkeypatch


async def subscribe(pool, app, email: str, company: str, gstin: str, state: str):
    await pool.execute("DELETE FROM rate_limits")
    agent = make_client(app)
    assert (await agent.post("/api/auth/register", json={"email": email, "password": "password123", "companyName": company})).status_code == 201
    profile = {"exporter": {"companyName": f"{company} Pvt Ltd", "gstin": gstin, "state": state, "addressLine1": "Opera House", "city": "Mumbai"},
               "bank": {}, "invoicePrefix": "", "authorizedSignatoryName": "", "authorizedSignatoryDesignation": ""}
    assert (await agent.put("/api/company", json={"name": company, "profile": profile})).status_code == 200
    subscription_id = (await agent.post("/api/billing/checkout", json={"plan": "growth", "cycle": "monthly"})).json()["subscriptionId"]
    payment_id = f"pay_{email.split('@')[0]}"
    verified = await agent.post("/api/billing/verify", json={
        "razorpay_payment_id": payment_id, "razorpay_subscription_id": subscription_id, "razorpay_signature": signature(payment_id, subscription_id)})
    assert verified.status_code == 200, verified.text
    return agent, verified.json()["payments"][0]


async def test_each_payment_gets_a_numbered_gst_invoice(pool, env):
    env.setenv("BILLING_GSTIN", SELLER_GSTIN)
    env.setenv("BILLING_LEGAL_NAME", "DiamondX Software Pvt Ltd")
    env.setenv("BILLING_ADDRESS", "Surat, Gujarat")
    app = create_app(pool, AppOptions(razorpay_transport=httpx.MockTransport(FakeRazorpay())))
    year = financial_year_of(datetime.now(timezone.utc))

    # Same state as the seller: CGST + SGST.
    local, payment = await subscribe(pool, app, "surat@example.com", "Surat Gems", GUJARAT_CUSTOMER, "Gujarat")
    assert payment["invoiceNumber"] == f"DX/{year}/00001" and len(payment["invoiceNumber"]) <= 16
    invoice = (await local.get(f"/api/billing/invoices/{payment['invoiceId']}")).json()
    assert invoice["seller"] == {"name": "DiamondX Software Pvt Ltd", "gstin": SELLER_GSTIN, "address": "Surat, Gujarat", "state": "Gujarat", "stateCode": "24"}
    assert (invoice["buyer"]["gstin"], invoice["buyer"]["name"], invoice["placeOfSupply"]) == (GUJARAT_CUSTOMER, "Surat Gems Pvt Ltd", "24 - Gujarat")
    assert (invoice["taxableValue"], invoice["cgst"], invoice["sgst"], invoice["igst"], invoice["total"]) == (3999.15, 359.92, 359.93, 0, 4719)
    assert (invoice["cgstRate"], invoice["sgstRate"], invoice["igstRate"]) == (9, 9, 0)
    assert invoice["lines"][0]["sac"] == "997331" and "Growth plan, monthly" in invoice["lines"][0]["description"]
    assert invoice["payment"]["id"] == payment["id"]

    # Another state: IGST. Numbers run on without gaps.
    other, payment = await subscribe(pool, app, "mumbai@example.com", "Mumbai Diamonds", MAHARASHTRA_CUSTOMER, "Maharashtra")
    assert payment["invoiceNumber"] == f"DX/{year}/00002"
    invoice = (await other.get(f"/api/billing/invoices/{payment['invoiceId']}")).json()
    assert (invoice["placeOfSupply"], invoice["cgst"], invoice["sgst"], invoice["igst"], invoice["igstRate"]) == ("27 - Maharashtra", 0, 0, 719.85, 18)

    # Each company sees only its own; the stored invoice does not change when the profile does.
    first_id = (await local.get("/api/billing")).json()["payments"][0]["invoiceId"]
    assert (await other.get(f"/api/billing/invoices/{first_id}")).status_code == 404
    profile = {"exporter": {"companyName": "Renamed Ltd"}, "bank": {}, "invoicePrefix": "", "authorizedSignatoryName": "", "authorizedSignatoryDesignation": ""}
    await local.put("/api/company", json={"name": "Renamed", "profile": profile})
    assert (await local.get(f"/api/billing/invoices/{first_id}")).json()["buyer"]["name"] == "Surat Gems Pvt Ltd"

    # Issuing again for the same payment returns the same invoice.
    from diamondx.modules.billing.tax_invoice import issue_subscription_invoice

    assert await issue_subscription_invoice(pool, "pay_surat") == first_id
    assert await pool.fetchval("SELECT last_number FROM subscription_invoice_counters WHERE financial_year = $1", year) == 2


async def test_no_invoice_without_the_sellers_gstin_but_the_payment_still_counts(pool, env):
    app = create_app(pool, AppOptions(razorpay_transport=httpx.MockTransport(FakeRazorpay())))
    agent, payment = await subscribe(pool, app, "owner@example.com", "Meridian", GUJARAT_CUSTOMER, "Gujarat")
    assert payment["invoiceId"] is None
    assert (await agent.get("/api/billing")).json()["planKey"] == "growth"
