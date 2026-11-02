"""Ported from advancedTax.test.ts (section 6) and features.test.ts (requests, practice, health score)."""

from __future__ import annotations

import base64
from datetime import date

from diamondx.modules.accountant.practice import health_score

from .conftest import sign_up
from .test_tax import one_line_invoice


def test_health_score():
    zero = dict(overdue=0, dueSoon=0, actions=0, noticesOverdue=0, noticesDueSoon=0, requestsOverdue=0)
    assert health_score(**zero) == {"score": 100, "grade": "good"}
    assert health_score(**{**zero, "overdue": 2, "dueSoon": 1})["grade"] == "watch"
    assert health_score(**{**zero, "overdue": 1, "noticesOverdue": 2})["grade"] == "at_risk"


async def test_one_accountant_several_companies(client_factory):
    owner = await sign_up(client_factory, "owner@example.com", "Meridian Diamond Exports")
    for amount in (1000, 2000):
        created = (await owner.post("/api/invoices", json={"invoice": one_line_invoice(amount=amount, rate=84)})).json()
        await owner.patch(f"/api/invoices/{created['id']}/status", json={"status": "issued"})

    firm = await sign_up(client_factory, "shah@example.com", "Shah & Co")
    assert (await owner.post("/api/team/accountants", json={"email": "nobody@example.com"})).status_code == 404
    assert (await owner.post("/api/team/accountants", json={"email": "owner@example.com"})).status_code == 409
    assert (await owner.post("/api/team/accountants", json={"email": "shah@example.com", "role": "ca"})).status_code == 201
    companies = (await firm.get("/api/workspace/companies")).json()["companies"]
    assert [c["name"] for c in companies] == ["Shah & Co", "Meridian Diamond Exports"]
    meridian = companies[1]["id"]
    switched = (await firm.post("/api/workspace/switch", json={"organizationId": meridian})).json()
    assert (switched["user"]["role"], switched["user"]["organizationName"]) == ("ca", "Meridian Diamond Exports")
    assert len((await firm.get("/api/tax/register?month=2026-10")).json()["rows"]) == 2
    assert (await firm.post("/api/invoices", json={"invoice": one_line_invoice("Blocked", 1)})).status_code == 403
    me = (await firm.get("/api/auth/me")).json()["user"]
    assert (me["organizationName"], me["role"]) == ("Meridian Diamond Exports", "ca")

    calendar = (await firm.get("/api/workspace/calendar")).json()
    meridian_kinds = {i["kind"] for i in calendar["items"] if i["organizationName"] == "Meridian Diamond Exports"}
    assert {"gstr1", "gstr3b", "lut"} <= meridian_kinds
    assert any(i["organizationName"] == "Shah & Co" and i["kind"] == "lut" and i["status"] == "action" for i in calendar["items"])

    accountants = (await owner.get("/api/team/accountants")).json()["accountants"]
    assert [(a["email"], a["firm"], a["role"]) for a in accountants] == [("shah@example.com", "Shah & Co", "ca")]
    assert (await owner.delete(f"/api/team/accountants/{accountants[0]['userId']}")).status_code == 204
    me = (await firm.get("/api/auth/me")).json()["user"]
    assert (me["organizationName"], me["role"]) == ("Shah & Co", "admin")
    assert (await firm.post("/api/workspace/switch", json={"organizationId": meridian})).status_code == 404


async def test_requests_and_practice_tools(client_factory):
    owner = await sign_up(client_factory, "owner@example.com", "Meridian Diamond Exports")
    for email, role in (("ca@example.com", "ca"), ("member@example.com", "member")):
        await owner.post("/api/team/members", json={"email": email, "password": "password123", "role": role})
    ca, member = client_factory(), client_factory()
    await ca.post("/api/auth/login", json={"email": "ca@example.com", "password": "password123"})
    await member.post("/api/auth/login", json={"email": "member@example.com", "password": "password123"})
    first = (await owner.post("/api/invoices", json={"invoice": one_line_invoice()})).json()

    # Requests: the accountant asks, the company answers with a file.
    asked = await ca.post("/api/requests", json={"title": "Bank statement for October", "detail": "PDF from the bank, all accounts.",
                                                  "dueDate": "2026-11-05", "invoiceId": first["id"]})
    assert asked.status_code == 201, asked.text
    request_id = asked.json()["id"]
    assert (await ca.post("/api/requests", json={"title": ""})).status_code == 400
    pdf = base64.b64encode(b"%PDF-1.4 statement").decode()
    answered = await owner.post(f"/api/requests/{request_id}/messages", json={"body": "Attached.", "file": {"name": "october.pdf", "type": "application/pdf", "base64": pdf}})
    assert answered.status_code == 201
    bad = await owner.post(f"/api/requests/{request_id}/messages", json={"file": {"name": "x.exe", "type": "application/x-msdownload", "base64": pdf}})
    assert bad.status_code == 400
    listed = (await ca.get("/api/requests")).json()["requests"][0]
    assert {k: listed[k] for k in ("title", "status", "messages", "invoiceNumber")} == {
        "title": "Bank statement for October", "status": "answered", "messages": 1, "invoiceNumber": first["invoiceNumber"]}
    messages = (await ca.get(f"/api/requests/{request_id}/messages")).json()["messages"]
    assert messages[0]["file"]["name"] == "october.pdf"
    file = await ca.get(f"/api/requests/{request_id}/messages/{messages[0]['id']}/file")
    assert file.content == b"%PDF-1.4 statement"
    assert (await member.post(f"/api/requests/{request_id}/status", json={"status": "closed"})).status_code == 403
    assert (await ca.post(f"/api/requests/{request_id}/status", json={"status": "closed"})).status_code == 200
    assert (await owner.post(f"/api/requests/{request_id}/messages", json={"body": "More"})).status_code == 409
    assert (await ca.get("/api/requests")).json()["requests"] == []

    await ca.post("/api/notices", json={"authority": "gst", "formType": "ASMT-10", "replyDue": "2026-11-05"})

    # Practice tools for an outside firm
    firm = await sign_up(client_factory, "partner@shahco.example", "Shah & Co")
    assert (await firm.get("/api/practice/clients")).status_code == 403
    assert (await owner.post("/api/team/accountants", json={"email": "partner@shahco.example", "role": "ca"})).status_code == 201
    clients = (await firm.get("/api/practice/clients")).json()
    client = clients["clients"][0]
    assert (client["name"], client["engagement"]) == ("Meridian Diamond Exports", None)
    assert client["health"]["openNotices"] == 1 and client["health"]["score"] <= 100

    assert (await firm.put(f"/api/practice/clients/{client['id']}/engagement", json={"feeInr": 15000, "billing": "monthly"})).status_code == 200
    assert (await firm.post("/api/practice/time", json={"clientId": client["id"], "minutes": 90, "task": "GSTR-1 review",
                                                        "workDate": date.today().isoformat()})).status_code == 201
    assert (await firm.post("/api/practice/time", json={"clientId": "00000000-0000-4000-8000-000000000000", "minutes": 5, "task": "x"})).status_code == 400
    bill = await firm.post("/api/practice/bills", json={"clientId": client["id"], "billNo": "SC/26/101", "amountInr": 15000})
    assert bill.status_code == 201
    assert (await firm.post("/api/practice/bills", json={"clientId": client["id"], "billNo": "SC/26/101", "amountInr": 1})).status_code == 409

    after = (await firm.get("/api/practice/clients")).json()["clients"][0]
    assert after["engagement"]["feeInr"] == 15000
    assert (after["fees"]["unpaidInr"], after["fees"]["unpaidBills"]) == (15000, 1)
    assert after["time"]["monthMinutes"] == 90
    assert (await firm.post(f"/api/practice/bills/{bill.json()['id']}/paid", json={})).status_code == 200
    assert (await firm.get("/api/practice/clients")).json()["totals"]["unpaidInr"] == 0
    bills = (await firm.get("/api/practice/bills")).json()["bills"]
    assert bills[0]["paidOn"] == date.today().isoformat() and bills[0]["daysUnpaid"] is None

    # Inside the client's workspace the CA guard still lets practice records through.
    assert (await firm.post("/api/workspace/switch", json={"organizationId": client["id"]})).status_code == 200
    assert (await firm.post("/api/practice/time", json={"clientId": client["id"], "minutes": 15, "task": "Call about notice"})).status_code == 201
    assert (await firm.post("/api/purchases", json={"kind": "local", "supplierName": "X", "documentNo": "Z", "documentDate": "2026-10-10",
                                                     "taxableInr": 1})).status_code == 403
    assert (await owner.get("/api/practice/clients")).status_code == 403
    assert len((await firm.get("/api/practice/time")).json()["entries"]) == 2
