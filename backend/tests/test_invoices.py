"""Ported from server/tests/api.test.ts, features.test.ts and database.test.ts: invoices, payments,
company, buyers, buyer risk, dashboard, portal, and demo data."""

from __future__ import annotations

import asyncio
import copy
import re
from urllib.parse import quote

import pytest

from diamondx.core.demo_data import DEMO_INVOICE_TARGET
from diamondx.core.numbers import money, round_to, to_fixed
from diamondx.core.seed import DEMO_EMAIL, DEMO_PASSWORD, DEMO_TEAM, seed_demo_user
from diamondx.modules.company.buyer_risk import risk_grade
from diamondx.modules.invoices.schema import invoice_facts, validate_invoice

from .conftest import sign_up

from .samples import ANTWERP, DUBAI, NEW_YORK, PRICED, SAMPLE, invoice_with, line


async def test_creates_lists_updates_and_deletes_only_own_invoices(client_factory):
    owner = await sign_up(client_factory, "owner@example.com")
    other = await sign_up(client_factory, "other@example.com")

    assert (await client_factory().post("/api/invoices", json={"invoice": SAMPLE})).status_code == 401
    created = await owner.post("/api/invoices", json={"invoice": SAMPLE})
    assert created.status_code == 201
    assert created.json()["invoiceNumber"] == "EXP-100"

    listed = (await owner.get("/api/invoices")).json()["invoices"]
    assert [(i["id"], i["invoiceNumber"]) for i in listed] == [(created.json()["id"], "EXP-100")]
    assert (await other.get(f"/api/invoices/{created.json()['id']}")).status_code == 404

    updated = await owner.put(f"/api/invoices/{created.json()['id']}", json={"invoice": invoice_with(SAMPLE, shipment={"invoiceNumber": "EXP-200"})})
    assert updated.status_code == 200
    assert updated.json()["invoiceNumber"] == "EXP-200"
    assert updated.json()["invoice"]["shipment"]["invoiceNumber"] == "EXP-200"

    assert (await owner.delete(f"/api/invoices/{created.json()['id']}")).status_code == 204
    assert (await owner.get(f"/api/invoices/{created.json()['id']}")).status_code == 404


async def test_numbers_invoices_stores_totals_and_rejects_duplicates(client_factory):
    owner = await sign_up(client_factory, "owner@example.com", "xyz LLC")
    first = (await owner.post("/api/invoices", json={"invoice": PRICED})).json()
    second = (await owner.post("/api/invoices", json={"invoice": PRICED})).json()
    assert re.match(r"^EXP/\d{4}-\d{2}/0001$", first["invoiceNumber"])
    assert second["invoiceNumber"].endswith("/0002")
    assert first["invoice"]["shipment"]["invoiceNumber"] == first["invoiceNumber"]
    assert {k: first[k] for k in ("status", "buyerName", "destinationCountry", "invoiceDate", "totalUsd", "totalCarats", "dueUsd")} == {
        "status": "draft",
        "buyerName": "Antwerp Gems BVBA",
        "destinationCountry": "Belgium",
        "invoiceDate": "2026-10-15",
        "totalUsd": 1050,
        "totalCarats": 2.25,
        "dueUsd": 1050,
    }
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", first["updatedAt"])
    duplicate = await owner.post(
        "/api/invoices", json={"invoice": invoice_with(PRICED, shipment={"invoiceNumber": first["invoiceNumber"].lower()})}
    )
    assert duplicate.status_code == 409


async def test_accepts_every_sample_and_rejects_malformed_invoices(client_factory):
    owner = await sign_up(client_factory, "owner@example.com")
    for preset in (ANTWERP, NEW_YORK, DUBAI):
        saved = await owner.post("/api/invoices", json={"invoice": preset})
        assert saved.status_code == 201, saved.text
        assert saved.json()["invoice"] == preset

    async def reject(invoice, message: str):
        response = await owner.post("/api/invoices", json={"invoice": invoice})
        assert response.status_code == 400, response.text
        assert message in response.json()["error"], response.json()["error"]
        assert response.json()["error"].startswith("Invoice data is invalid. ")

    no_bank = copy.deepcopy(SAMPLE)
    del no_bank["bank"]
    await reject(no_bank, "bank")
    await reject({**PRICED, "items": [{**line(1, 100), "totalAmount": 999}]}, "items › line 1 › totalAmount")
    await reject({**PRICED, "items": [{**line(1, 100), "carats": -1, "totalAmount": -100}]}, "carats")
    await reject({**PRICED, "currency": "EUR"}, "currency")
    await reject(invoice_with(PRICED, shipment={"incoterms": "XYZ"}), "incoterms")
    await reject({**PRICED, "freightUsd": "lots"}, "freightUsd")
    await reject(invoice_with(PRICED, consignee={"companyName": "x" * 201}), "companyName")
    await reject(invoice_with(PRICED, consignee={"buyerName": None}), "buyerName")

    extra = await owner.post("/api/invoices", json={"invoice": {**PRICED, "injected": "<script>"}})
    assert extra.status_code == 201
    assert "injected" not in extra.json()["invoice"]


def test_numbers_as_strings_and_blanks_are_read_like_zod():
    invoice = {**PRICED, "freightUsd": "30", "insuranceUsd": None, "otherChargesUsd": "", "exchangeRateInr": " 86.5 "}
    result = validate_invoice(invoice)
    assert result.ok, result.error
    assert (result.invoice["freightUsd"], result.invoice["insuranceUsd"], result.invoice["otherChargesUsd"]) == (30, 0, 0)
    assert result.invoice["exchangeRateInr"] == 86.5
    assert invoice_facts(result.invoice)["totalUsd"] == 1030
    assert not validate_invoice({**PRICED, "freightUsd": True}).ok
    assert not validate_invoice(invoice_with(PRICED, consignee={"buyerOtherThanConsignee": "true"})).ok


async def test_company_prefix_and_locked_issued_invoices(client_factory):
    owner = await sign_up(client_factory, "owner@example.com", "xyz LLC")
    saved = await owner.put(
        "/api/company",
        json={"name": "xyz LLC", "profile": {"invoicePrefix": "X Y/Z!", "exporter": {"companyName": "xyz LLC", "city": "Surat"}, "bank": {"bankName": "HDFC"}}},
    )
    assert saved.status_code == 200
    assert saved.json()["profile"]["invoicePrefix"] == "XYZ"
    company = (await owner.get("/api/company")).json()
    assert company["profile"]["exporter"]["city"] == "Surat"
    assert company["profile"]["exporter"]["iec"] == ""

    created = (await owner.post("/api/invoices", json={"invoice": PRICED})).json()
    assert created["invoiceNumber"].startswith("XYZ/")
    issued = await owner.patch(f"/api/invoices/{created['id']}/status", json={"status": "issued"})
    assert issued.status_code == 200 and issued.json()["status"] == "issued"
    assert (await owner.put(f"/api/invoices/{created['id']}", json={"invoice": PRICED})).status_code == 409
    back = await owner.patch(f"/api/invoices/{created['id']}/status", json={"status": "draft"})
    assert back.status_code == 400
    assert back.json()["error"] == "A issued invoice cannot be marked draft."
    cancelled = await owner.patch(f"/api/invoices/{created['id']}/status", json={"status": "cancelled"})
    assert cancelled.json()["status"] == "cancelled"


async def test_only_admins_change_the_company(client_factory):
    owner = await sign_up(client_factory, "owner@example.com")
    await owner.post("/api/team/members", json={"email": "clerk@example.com", "password": "temporary1"})
    clerk = client_factory()
    await clerk.post("/api/auth/login", json={"email": "clerk@example.com", "password": "temporary1"})
    assert (await clerk.put("/api/company", json={"name": "x", "profile": {}})).status_code == 403
    assert (await owner.put("/api/company", json={"name": "", "profile": {}})).status_code == 400
    assert (await owner.put("/api/company", json={"name": "x", "profile": {"exporter": {"city": 3}}})).status_code == 400


async def test_payments_move_invoices_between_issued_and_paid(client_factory):
    owner = await sign_up(client_factory, "owner@example.com")
    invoice_id = (await owner.post("/api/invoices", json={"invoice": PRICED})).json()["id"]
    url = f"/api/invoices/{invoice_id}/payments"

    assert (await owner.post(url, json={"amountUsd": 100, "paidOn": "2026-10-20"})).status_code == 409
    await owner.patch(f"/api/invoices/{invoice_id}/status", json={"status": "issued"})
    assert (await owner.post(url, json={"amountUsd": -5, "paidOn": "2026-10-20"})).status_code == 400
    assert (await owner.post(url, json={"amountUsd": 5, "paidOn": "2026-02-30"})).status_code == 400
    assert (await owner.post(url, json={"amountUsd": 5, "paidOn": "2026-10-20", "bankRateInr": 5000})).status_code == 400

    partial = await owner.post(url, json={"amountUsd": 400, "paidOn": "2026-10-20", "reference": "SWIFT 1"})
    assert partial.status_code == 201
    assert {k: partial.json()[k] for k in ("status", "paidUsd", "dueUsd")} == {"status": "issued", "paidUsd": 400, "dueUsd": 650}
    rest = (await owner.post(url, json={"amountUsd": "650", "paidOn": "2026-10-25"})).json()
    assert {k: rest[k] for k in ("status", "paidUsd", "dueUsd")} == {"status": "paid", "paidUsd": 1050, "dueUsd": 0}

    rate = await owner.patch(f"{url}/{rest['payments'][0]['id']}", json={"bankRateInr": "84.12345"})
    assert rate.json()["payments"][0]["bankRateInr"] == 84.1235

    removed = await owner.delete(f"{url}/{rest['payments'][1]['id']}")
    assert removed.status_code == 200
    assert (removed.json()["status"], removed.json()["paidUsd"]) == ("issued", 400)

    dashboard = (await owner.get("/api/dashboard")).json()
    assert (dashboard["unpaid"]["count"], dashboard["unpaid"]["dueUsd"]) == (1, 650)
    assert dashboard["byCountry"] == [{"country": "Belgium", "count": 1, "totalUsd": 1050}]
    assert dashboard["statusCounts"]["issued"] == 1 and dashboard["statusCounts"]["draft"] == 0
    assert [a["key"] for a in dashboard["aging"]] == ["current", "1-30", "31-60", "61-90", "90+"]
    assert len(dashboard["months"]) == 6

    forecast = (await owner.get("/api/dashboard/forecast")).json()
    assert len(forecast["weeks"]) == 12
    assert forecast["totals"]["openUsd"] == 650


async def test_search_filter_and_csv_export(client_factory):
    owner = await sign_up(client_factory, "owner@example.com")
    await owner.post("/api/invoices", json={"invoice": PRICED})
    dubai = await owner.post(
        "/api/invoices",
        json={
            "invoice": invoice_with(
                PRICED,
                consignee={"companyName": "=Dubai Diamonds LLC", "country": ""},
                shipment={"invoiceNumber": "DXB-1", "invoiceDate": "2026-09-01", "countryOfDestination": ""},
            )
        },
    )
    await owner.patch(f"/api/invoices/{dubai.json()['id']}/status", json={"status": "issued"})

    by_text = (await owner.get("/api/invoices", params={"q": "dubai"})).json()["invoices"]
    assert [row["invoiceNumber"] for row in by_text] == ["DXB-1"]
    assert len((await owner.get("/api/invoices", params={"status": "draft"})).json()["invoices"]) == 1
    by_date = (await owner.get("/api/invoices", params={"from": "2026-10-01", "to": "2026-10-31"})).json()["invoices"]
    assert [row["buyerName"] for row in by_date] == ["Antwerp Gems BVBA"]

    csv = await owner.get("/api/invoices/export", params={"status": "issued"})
    assert csv.status_code == 200
    assert "text/csv" in csv.headers["content-type"]
    assert "attachment" in csv.headers["content-disposition"]
    assert csv.content.startswith("﻿".encode())
    lines = csv.text.lstrip("﻿").strip().split("\r\n")
    assert len(lines) == 2
    assert lines[1] == "DXB-1,2026-09-01,issued,'=Dubai Diamonds LLC,,2.250,1050.00,0.00,1050.00"


async def test_buyer_address_book_per_company(client_factory):
    owner = await sign_up(client_factory, "owner@example.com")
    other = await sign_up(client_factory, "other@example.com")
    created = await owner.post("/api/buyers", json={"consignee": {"companyName": "Antwerp Gems BVBA", "country": "Belgium", "taxIdVat": "BE0123"}})
    assert created.status_code == 201
    assert created.json()["consignee"]["taxIdVat"] == "BE0123"
    assert (await owner.post("/api/buyers", json={"consignee": {"companyName": " "}})).status_code == 400

    updated = await owner.put(f"/api/buyers/{created.json()['id']}", json={"consignee": {**created.json()["consignee"], "city": "Antwerp"}})
    assert updated.json()["consignee"]["city"] == "Antwerp"
    assert (await other.get("/api/buyers")).json()["buyers"] == []
    assert (await other.delete(f"/api/buyers/{created.json()['id']}")).status_code == 404
    assert (await owner.delete(f"/api/buyers/{created.json()['id']}")).status_code == 204
    assert (await owner.get("/api/buyers")).json()["buyers"] == []


async def test_credit_days_default_to_30(client_factory, pool):
    owner = await sign_up(client_factory, "owner@example.com")
    old_shipment = {k: v for k, v in PRICED["shipment"].items() if k != "creditDays"}
    saved = await owner.post("/api/invoices", json={"invoice": {**PRICED, "shipment": old_shipment}})
    assert saved.status_code == 201
    assert saved.json()["invoice"]["shipment"]["creditDays"] == 30
    assert await pool.fetchval("SELECT credit_days FROM invoices WHERE id = $1", saved.json()["id"]) == 30
    assert (await owner.post("/api/invoices", json={"invoice": invoice_with(PRICED, shipment={"creditDays": 400})})).status_code == 400


async def test_only_one_of_simultaneous_requests_gets_a_number(client_factory, pool):
    owner = await sign_up(client_factory, "db-owner@example.com")
    invoice = invoice_with(ANTWERP, consignee={"companyName": "Race BVBA"}, shipment={"invoiceNumber": "RACE-1"}, items=[])
    responses = await asyncio.gather(*(owner.post("/api/invoices", json={"invoice": invoice}) for _ in range(3)))
    assert sorted(r.status_code for r in responses) == [201, 409, 409]
    assert await pool.fetchval("SELECT COUNT(*) FROM invoices WHERE lower(invoice_number) = 'race-1'") == 1


async def test_closed_month_locks_its_invoices(client_factory, pool):
    owner = await sign_up(client_factory, "owner@example.com")
    created = (await owner.post("/api/invoices", json={"invoice": PRICED})).json()
    organization_id = await pool.fetchval("SELECT organization_id FROM invoices WHERE id = $1", created["id"])
    await pool.execute("INSERT INTO closed_months (organization_id, month) VALUES ($1, '2026-10-01')", organization_id)
    blocked = await owner.patch(f"/api/invoices/{created['id']}/status", json={"status": "issued"})
    assert blocked.status_code == 409
    assert "2026-10 are closed" in blocked.json()["error"]
    assert (await owner.post("/api/invoices", json={"invoice": PRICED})).status_code == 409
    assert (await owner.delete(f"/api/invoices/{created['id']}")).status_code == 409


async def test_invoice_changes_are_in_the_activity_history(client_factory, pool):
    owner = await sign_up(client_factory, "owner@example.com")
    created = (await owner.post("/api/invoices", json={"invoice": SAMPLE})).json()
    await owner.patch(f"/api/invoices/{created['id']}/status", json={"status": "issued"})
    await owner.post(f"/api/invoices/{created['id']}/payments", json={"amountUsd": 12.5, "paidOn": "2026-10-20"})
    rows = await pool.fetch("SELECT action, summary FROM audit_events ORDER BY created_at")
    assert [(r["action"], r["summary"]) for r in rows] == [
        ("invoice.create", "Created an invoice draft"),  # no id in the path, so no number (as on Node)
        ("invoice.status", "Issued an invoice EXP-100"),
        ("payment.record", "Recorded a payment of USD 12.50 EXP-100"),
    ]


def test_grades_buyers_from_payment_history():
    base = {"invoices": 4, "paidInvoices": 3, "outstandingUsd": 1000, "overdueUsd": 0, "maxDaysOverdue": 0, "avgDaysLate": 0, "onTimePercent": 100}
    assert risk_grade(base) == "A"
    assert risk_grade({**base, "avgDaysLate": 10}) == "B"
    assert risk_grade({**base, "overdueUsd": 200, "maxDaysOverdue": 45}) == "C"
    assert risk_grade({**base, "overdueUsd": 800, "maxDaysOverdue": 95}) == "D"
    assert risk_grade({**base, "invoices": 0, "paidInvoices": 0}) == "new"


async def test_warns_before_shipping_over_the_credit_limit(client_factory):
    owner = await sign_up(client_factory, "owner@example.com")
    await owner.post("/api/team/members", json={"email": "member@example.com", "password": "temporary1"})
    member = client_factory()
    await member.post("/api/auth/login", json={"email": "member@example.com", "password": "temporary1"})
    for _ in range(2):
        created = await owner.post(
            "/api/invoices",
            json={"invoice": invoice_with(PRICED, consignee={"companyName": "Rosenfeld & Sons BVBA"}, items=[line(1, 1000)], freightUsd=0, insuranceUsd=0)},
        )
        await owner.patch(f"/api/invoices/{created.json()['id']}/status", json={"status": "issued"})

    buyer = await owner.post("/api/buyers", json={"consignee": {"companyName": "Rosenfeld & Sons BVBA", "country": "Belgium"}})
    assert (await member.put(f"/api/buyers/{buyer.json()['id']}/credit-limit", json={"creditLimitUsd": 1500})).status_code == 403
    assert (await owner.put(f"/api/buyers/{buyer.json()['id']}/credit-limit", json={"creditLimitUsd": -1})).status_code == 400
    assert (await owner.put(f"/api/buyers/{buyer.json()['id']}/credit-limit", json={"creditLimitUsd": 1500})).status_code == 200

    risk = (await member.get("/api/buyers/risk")).json()["buyers"][0]
    assert {k: risk[k] for k in ("buyerName", "invoices", "outstandingUsd", "creditLimitUsd", "headroomUsd")} == {
        "buyerName": "Rosenfeld & Sons BVBA",
        "invoices": 2,
        "outstandingUsd": 2000,
        "creditLimitUsd": 1500,
        "headroomUsd": -500,
    }
    check = (await member.get(f"/api/buyers/risk/check?buyer={quote('rosenfeld & sons bvba')}&amountUsd=500")).json()
    assert len(check["warnings"]) == 1 and "over the credit limit" in check["warnings"][0]
    fresh = (await member.get("/api/buyers/risk/check?buyer=Brand%20New&amountUsd=10")).json()
    assert (fresh["grade"], fresh["warnings"]) == ("new", [])


async def test_buyer_portal_shows_one_buyers_invoices_until_revoked(client_factory):
    owner = await sign_up(client_factory, "owner@example.com", "xyz LLC")
    created = await owner.post("/api/invoices", json={"invoice": PRICED})
    await owner.patch(f"/api/invoices/{created.json()['id']}/status", json={"status": "issued"})
    await owner.post("/api/invoices", json={"invoice": invoice_with(PRICED, consignee={"companyName": "Someone Else"})})

    assert (await owner.post("/api/portal-links", json={"buyerName": " "})).status_code == 400
    link = await owner.post("/api/portal-links", json={"buyerName": "antwerp gems bvba", "days": 7})
    assert link.status_code == 201
    token = link.json()["url"].split("portal=")[1]

    public = client_factory()
    page = await public.get(f"/api/portal/{token}")
    assert page.status_code == 200
    assert page.headers["cache-control"] == "no-store"
    assert (page.json()["exporterName"], page.json()["totals"]["invoices"], page.json()["totals"]["dueUsd"]) == ("xyz LLC", 1, 1050)
    assert (await public.get("/api/portal/short")).status_code == 404

    links = (await owner.get("/api/portal-links")).json()["links"]
    assert links[0]["active"] is True and links[0]["lastViewedAt"] is not None
    assert (await owner.delete(f"/api/portal-links/{link.json()['id']}")).json() == {"revoked": True}
    assert (await public.get(f"/api/portal/{token}")).status_code == 404


async def test_seeds_demo_data_once_with_valid_invoices(pool, client_factory, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "development")
    await seed_demo_user(pool)
    await seed_demo_user(pool)
    organization_id = await pool.fetchval("SELECT organization_id FROM users WHERE email = $1", DEMO_EMAIL)
    rows = await pool.fetch("SELECT data, status, invoice_number, total_usd FROM invoices WHERE organization_id = $1", organization_id)
    assert len(rows) == DEMO_INVOICE_TARGET
    assert {r["status"] for r in rows} == {"draft", "issued", "paid", "cancelled"}
    for row in rows:
        validation = validate_invoice(row["data"])
        assert validation.ok, validation.error
        assert invoice_facts(validation.invoice)["totalUsd"] == float(row["total_usd"])
        assert row["invoice_number"].startswith("XYZ/")
    buyers = await pool.fetch("SELECT data->>'email' AS email FROM buyers WHERE organization_id = $1", organization_id)
    assert len(buyers) == 6 and all(b["email"].endswith("@example.com") for b in buyers)
    team = await pool.fetch("SELECT email, role FROM users WHERE organization_id = $1", organization_id)
    assert sorted(r["email"] for r in team) == sorted(e for e, _ in DEMO_TEAM)
    assert await pool.fetchval("SELECT COUNT(*) FROM payment_reminders WHERE organization_id = $1", organization_id) == 1

    agent = client_factory()
    assert (await agent.post("/api/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})).status_code == 200
    dashboard = (await agent.get("/api/dashboard")).json()
    assert dashboard["unpaid"]["count"] > 0
    assert any(row["paidUsd"] > 0 for row in dashboard["unpaid"]["invoices"])


@pytest.mark.parametrize(
    ("value", "places", "expected"),
    [(0.125, 2, "0.13"), (1.005, 2, "1.00"), (2.25, 3, "2.250"), (1050, 2, "1050.00"), (-0.001, 2, "-0.00")],
)
def test_to_fixed_matches_javascript(value, places, expected):
    assert to_fixed(value, places) == expected


def test_money_rounds_like_math_round():
    # 2.675 * 100 is exactly 267.5 in binary, so Math.round gives 268; Python's round() would give 268 too
    # here but 2.5 → 2. 1.005 * 100 is 100.49999999999999, so both give 1.0.
    assert money(2.675) == 2.68
    assert money("1.005") == 1.0
    assert round_to(0.49999999999999994, 0) == 0
    assert money(0.125) == 0.13
    assert round_to(0.5, 0) == 1 and round_to(-0.5, 0) == 0 and round_to(2.5, 0) == 3
    assert to_fixed(-0.0, 2) == "0.00"
