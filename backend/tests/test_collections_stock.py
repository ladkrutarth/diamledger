"""Ported from server/tests/api.test.ts (email, reminders), reminders.test.ts, and features.test.ts (stock)."""

from __future__ import annotations

import base64
import ssl
from datetime import date

import pytest

from diamondx.ai.call import ModelCallContext, call_model
from diamondx.ai.client import AiUnavailableError, ProviderError, TokenUsage
from diamondx.modules.collections.email_dispatch import SmtpSettings, SmtpTransport
from diamondx.modules.collections.reminders import reminder_subject, reminder_tone, render_reminder_html, template_reminder_text

from .conftest import sign_up
from .samples import ANTWERP, PRICED, invoice_with, line

SMTP_CONFIG = {"host": "smtp.example.com", "port": 587, "secure": False, "user": "desk@example.com", "pass": "secret"}


def email_body(**overrides) -> dict:
    data = {
        "smtpConfig": SMTP_CONFIG,
        "emailData": {"recipients": ["buyer@example.com"], "cc": [], "subject": "Invoice EXP-1", "htmlBody": "<p>Hi</p>", "invoiceNumber": "EXP-1"},
        "attachments": [{"filename": "invoice.pdf", "content": base64.b64encode(b"%PDF-1.4").decode(), "contentType": "application/pdf"}],
    }
    data.update(overrides)
    return data


async def days_ago(pool, days: int) -> str:
    return await pool.fetchval("SELECT to_char(current_date - $1::int, 'YYYY-MM-DD')", days)


async def issued_invoice(agent, invoice_date: str, credit_days: int) -> dict:
    created = await agent.post("/api/invoices", json={"invoice": invoice_with(PRICED, shipment={"invoiceDate": invoice_date, "creditDays": credit_days})})
    assert created.status_code == 201, created.text
    assert (await agent.patch(f"/api/invoices/{created.json()['id']}/status", json={"status": "issued"})).status_code == 200
    return created.json()


# --- Email -----------------------------------------------------------------------------------------


async def test_sends_invoice_email_with_verified_tls_and_logs_it(client_factory, pool, smtp):
    owner = await sign_up(client_factory, "owner@example.com", "xyz LLC")
    sent = await owner.post("/api/send-email", json=email_body())
    assert sent.status_code == 200, sent.text
    assert sent.json()["mode"] == "live_smtp"
    assert smtp.calls[0]["settings"].allow_invalid_certificates is False
    message = smtp.calls[0]["message"]
    assert (message.to, message.subject, message.from_name) == (["buyer@example.com"], "Invoice EXP-1", "xyz LLC")
    assert message.attachments[0].content == b"%PDF-1.4"

    rows = await pool.fetch("SELECT mode, recipients, subject, attachment_count FROM email_dispatches")
    assert [dict(r) for r in rows] == [{"mode": "live_smtp", "recipients": ["buyer@example.com"], "subject": "Invoice EXP-1", "attachment_count": 1}]

    await owner.post("/api/send-email", json=email_body(smtpConfig={**SMTP_CONFIG, "allowInvalidCertificates": True}))
    assert smtp.calls[1]["settings"].allow_invalid_certificates is True

    simulated = await owner.post("/api/send-email", json=email_body(smtpConfig={}))
    assert simulated.json()["mode"] == "preview_simulated"
    assert simulated.json()["log"]["attachmentsCount"] == 1
    assert await pool.fetchval("SELECT COUNT(*) FROM email_dispatches") == 3


async def test_rejects_unsafe_email_requests(client_factory, pool, smtp):
    owner = await sign_up(client_factory, "owner@example.com")
    base = email_body()["emailData"]
    too_many = [f"r{i}@example.com" for i in range(11)]
    assert (await client_factory().post("/api/send-email", json=email_body())).status_code == 401
    for bad in (
        email_body(emailData={**base, "recipients": too_many}),
        email_body(emailData={**base, "recipients": ["not-an-email"]}),
        email_body(emailData={**base, "subject": "a\r\nBcc: x@y.z"}),
        email_body(smtpConfig={**SMTP_CONFIG, "port": 6379}),
        email_body(smtpConfig={**SMTP_CONFIG, "host": "127.0.0.1:6379"}),
        email_body(attachments=[{"filename": "x.html", "content": "PGI+", "contentType": "text/html"}]),
    ):
        response = await owner.post("/api/send-email", json=bad)
        assert response.status_code == 400, bad
    assert smtp.calls == []
    assert await pool.fetchval("SELECT COUNT(*) FROM email_dispatches") == 0


def test_smtp_certificates_are_verified_unless_the_sender_opts_out():
    settings = SmtpSettings("smtp.example.com", 587, False, "u", "p", allow_invalid_certificates=False)
    assert SmtpTransport(settings).tls_context().verify_mode == ssl.CERT_REQUIRED
    opted_out = SmtpSettings("smtp.example.com", 587, False, "u", "p", allow_invalid_certificates=True)
    assert SmtpTransport(opted_out).tls_context().verify_mode == ssl.CERT_NONE


async def test_verify_smtp(client_factory, smtp):
    owner = await sign_up(client_factory, "owner@example.com")
    assert (await owner.post("/api/verify-smtp", json={"host": "smtp.example.com"})).status_code == 400
    ok = await owner.post("/api/verify-smtp", json=SMTP_CONFIG)
    assert ok.json() == {"success": True, "message": "SMTP connection verified successfully."}
    assert smtp.calls[0]["settings"].port == 587


# --- Reminders -------------------------------------------------------------------------------------


async def test_lists_only_overdue_invoices_per_company(client_factory, pool):
    owner = await sign_up(client_factory, "owner@example.com")
    other = await sign_up(client_factory, "other@example.com")
    long_ago = await days_ago(pool, 45)

    overdue = await issued_invoice(owner, long_ago, 30)
    await issued_invoice(owner, await days_ago(pool, 10), 30)
    await issued_invoice(owner, long_ago, 45)
    await owner.post("/api/invoices", json={"invoice": invoice_with(PRICED, shipment={"invoiceDate": long_ago, "creditDays": 0})})
    paid = await issued_invoice(owner, long_ago, 0)
    await owner.post(f"/api/invoices/{paid['id']}/payments", json={"amountUsd": 1050, "paidOn": await days_ago(pool, 1)})
    cancelled = await issued_invoice(owner, long_ago, 0)
    await owner.patch(f"/api/invoices/{cancelled['id']}/status", json={"status": "cancelled"})
    other_company = await issued_invoice(other, long_ago, 0)

    listed = (await owner.get("/api/reminders/overdue")).json()["invoices"]
    assert len(listed) == 1
    assert {k: listed[0][k] for k in ("id", "buyerEmail", "invoiceDate", "dueDate", "daysOverdue", "dueUsd", "remindersSent", "recentlyReminded")} == {
        "id": overdue["id"],
        "buyerEmail": "procurement@rosenfeld-diamonds.be",
        "invoiceDate": long_ago,
        "dueDate": await days_ago(pool, 15),
        "daysOverdue": 15,
        "dueUsd": 1050,
        "remindersSent": 0,
        "recentlyReminded": False,
    }
    assert [row["id"] for row in (await other.get("/api/reminders/overdue")).json()["invoices"]] == [other_company["id"]]
    assert (await other.post("/api/reminders/draft", json={"invoiceId": overdue["id"]})).status_code == 404

    flags = {row["id"]: row["overdue"] for row in (await owner.get("/api/dashboard")).json()["unpaid"]["invoices"]}
    assert flags[overdue["id"]] is True
    assert sum(1 for v in flags.values() if v) == 1


async def test_drafts_wording_with_the_model_but_figures_from_the_database(client_factory, pool, drafter):
    owner = await sign_up(client_factory, "owner@example.com")
    invoice = await issued_invoice(owner, await days_ago(pool, 40), 30)
    await owner.post(f"/api/invoices/{invoice['id']}/payments", json={"amountUsd": 50, "paidOn": await days_ago(pool, 5)})

    drafter.reply = {"subject": "Friendly payment reminder", "greeting": "Dear Mr. Rosenfeld,", "paragraphs": ["Please settle the outstanding balance <b>soon</b>."]}
    drafted = await owner.post("/api/reminders/draft", json={"invoiceId": invoice["id"]})
    assert drafted.status_code == 201, drafted.text
    body = drafted.json()
    assert (body["source"], body["tone"]) == ("model", "gentle")
    assert body["fullSubject"] == f"Friendly payment reminder - Invoice {invoice['invoiceNumber']}"
    assert body["recipients"] == ["procurement@rosenfeld-diamonds.be"]
    assert {k: body["figures"][k] for k in ("dueUsd", "paidUsd", "totalUsd", "daysOverdue")} == {"dueUsd": 1000, "paidUsd": 50, "totalUsd": 1050, "daysOverdue": 10}
    assert "$1,000.00" in body["html"]
    assert "STATE BANK OF INDIA" in body["html"]
    assert "&lt;b&gt;soon&lt;/b&gt;" in body["html"]
    assert drafter.prompts == [{"buyerName": "Antwerp Gems BVBA", "contactPerson": "Marc Rosenfeld", "exporterName": "Meridian Diamond Exports", "tone": "gentle"}]

    drafter.reply = {"subject": "Payment reminder", "greeting": "Dear Mr. Rosenfeld,", "paragraphs": ["Please pay USD 9,999 today."]}
    invented = (await owner.post("/api/reminders/draft", json={"invoiceId": invoice["id"]})).json()
    assert invented["source"] == "template"
    assert "9,999" not in invented["html"] and "$1,000.00" in invented["html"]

    drafter.reply = RuntimeError("Gemini is down")
    fallback = await owner.post("/api/reminders/draft", json={"invoiceId": invoice["id"]})
    assert fallback.status_code == 201
    assert (fallback.json()["source"], fallback.json()["greeting"]) == ("template", "Dear Marc Rosenfeld,")

    rows = await pool.fetch("SELECT model, prompt_version, status FROM payment_reminders ORDER BY created_at")
    assert [r["model"] for r in rows] == ["gemini-3.8-flash", "template", "template"]
    assert all(r["status"] == "draft" and r["prompt_version"] == "reminder-v1" for r in rows)
    calls = await pool.fetch("SELECT feature, outcome FROM ai_calls ORDER BY created_at")
    assert [(c["feature"], c["outcome"]) for c in calls] == [("payment_reminder", "ok"), ("payment_reminder", "ok"), ("payment_reminder", "error")]


async def test_sends_an_approved_reminder_once(client_factory, pool, smtp, drafter):
    owner = await sign_up(client_factory, "owner@example.com")
    invoice = await issued_invoice(owner, await days_ago(pool, 40), 30)
    drafter.reply = {"subject": "Payment reminder", "greeting": "Dear Mr. Rosenfeld,", "paragraphs": ["The balance below is now past due."]}
    draft = (await owner.post("/api/reminders/draft", json={"invoiceId": invoice["id"]})).json()
    send_body = {
        "subject": "Edited reminder",
        "greeting": "Dear Marc,",
        "paragraphs": ["Could you confirm the payment date?", ""],
        "recipients": ["buyer@example.com"],
        "smtpConfig": SMTP_CONFIG,
    }
    url = f"/api/reminders/{draft['id']}"
    assert (await owner.post(f"{url}/send", json={**send_body, "recipients": []})).status_code == 400
    assert (await owner.post(f"{url}/send", json={**send_body, "subject": " "})).json() == {"error": "Subject is required."}
    assert smtp.calls == []

    sent = await owner.post(f"{url}/send", json=send_body)
    assert sent.status_code == 200, sent.text
    assert (sent.json()["status"], sent.json()["mode"]) == ("sent", "live_smtp")
    message = smtp.calls[0]["message"]
    assert message.to == ["buyer@example.com"]
    assert message.subject == f"Edited reminder - Invoice {invoice['invoiceNumber']}"
    assert "Could you confirm the payment date?" in message.html and "$1,050.00" in message.html

    logged = await pool.fetch("SELECT invoice_number, mode FROM email_dispatches")
    assert [dict(r) for r in logged] == [{"invoice_number": invoice["invoiceNumber"], "mode": "live_smtp"}]
    stored = await pool.fetchrow("SELECT status, message_id, sent_at FROM payment_reminders WHERE id = $1", draft["id"])
    assert (stored["status"], stored["message_id"]) == ("sent", "<test@mail>") and stored["sent_at"] is not None
    assert (await owner.post(f"{url}/send", json=send_body)).status_code == 409
    assert (await owner.post(f"{url}/discard")).status_code == 409

    listed = (await owner.get("/api/reminders/overdue")).json()["invoices"][0]
    assert (listed["remindersSent"], listed["recentlyReminded"]) == (1, True)
    repeat = await owner.post("/api/reminders/draft", json={"invoiceId": invoice["id"]})
    assert repeat.status_code == 409 and repeat.json()["recentlyReminded"] is True
    second = await owner.post("/api/reminders/draft", json={"invoiceId": invoice["id"], "confirmRepeat": True})
    assert second.status_code == 201 and second.json()["tone"] == "firm"

    await owner.post(f"/api/invoices/{invoice['id']}/payments", json={"amountUsd": 1050, "paidOn": await days_ago(pool, 0)})
    assert (await owner.post(f"/api/reminders/{second.json()['id']}/send", json=send_body)).status_code == 409
    assert len(smtp.calls) == 1
    assert (await owner.get("/api/reminders/overdue")).json()["invoices"] == []
    assert (await owner.post(f"/api/reminders/{second.json()['id']}/discard")).status_code == 200


FIGURES = {
    "invoiceNumber": "EXP/2026-27/0007",
    "invoiceDate": "2026-09-01",
    "dueDate": "2026-10-01",
    "daysOverdue": 31,
    "totalUsd": 125000,
    "paidUsd": 25000.5,
    "dueUsd": 99999.5,
    "paymentTerms": "T/T within 30 days",
    "exporterName": "xyz LLC",
    "signatoryName": "A. Shah",
    "signatoryDesignation": "",
    "bank": {"bankName": "HDFC <Bank>", "accountNumber": "123", "swiftCode": "", "iban": ""},
}


def test_tone_escalates_with_days_overdue_and_reminders_sent():
    assert [reminder_tone(5, 0), reminder_tone(22, 0), reminder_tone(5, 1), reminder_tone(61, 0), reminder_tone(5, 2)] == [
        "gentle", "firm", "firm", "final", "final"
    ]


def test_renders_figures_escapes_text_and_skips_empty_rows():
    text = template_reminder_text({"buyerName": "B&B", "contactPerson": "", "exporterName": "xyz LLC", "tone": "gentle"})
    html = render_reminder_html(text, FIGURES)
    assert "Dear B&amp;B," in html
    assert "$99,999.50" in html
    assert "HDFC &lt;Bank&gt;" in html
    assert "SWIFT" not in html
    assert "A. Shah<br />xyz LLC" in html


def test_subject_stays_on_one_line():
    assert reminder_subject("Payment\r\nreminder", "EXP-1") == "Payment reminder - Invoice EXP-1"


# --- AI calls --------------------------------------------------------------------------------------


async def test_call_model_retries_once_records_and_enforces_the_budget(client_factory, pool, monkeypatch):
    await sign_up(client_factory, "owner@example.com")
    organization_id, user_id = await pool.fetchrow("SELECT organization_id, id FROM users")
    context = ModelCallContext("payment_reminder", "test-v1", "test-model", organization_id, user_id)
    attempts = []

    async def flaky():
        attempts.append(1)
        if len(attempts) == 1:
            raise ProviderError("busy", 503)
        return "answer", TokenUsage(100, 50)

    assert await call_model(pool, context, flaky) == "answer"
    assert len(attempts) == 2
    row = await pool.fetchrow("SELECT outcome, input_tokens, output_tokens FROM ai_calls")
    assert (row["outcome"], row["input_tokens"], row["output_tokens"]) == ("ok", 100, 50)

    monkeypatch.setenv("AI_DAILY_TOKEN_BUDGET", "150")
    with pytest.raises(AiUnavailableError, match="allowance"):
        await call_model(pool, context, flaky)

    monkeypatch.setenv("AI_DAILY_TOKEN_BUDGET", "1000000")
    monkeypatch.setenv("AI_TIMEOUT_MS", "50")

    async def slow():
        import asyncio

        await asyncio.sleep(1)
        return "late", None

    with pytest.raises(AiUnavailableError) as raised:
        await call_model(pool, context, slow)
    assert raised.value.reason == "timeout"

    monkeypatch.setenv("AI_ENABLED", "false")
    with pytest.raises(AiUnavailableError, match="turned off"):
        await call_model(pool, context, flaky)
    outcomes = [r["outcome"] for r in await pool.fetch("SELECT outcome FROM ai_calls ORDER BY created_at")]
    assert outcomes == ["ok", "blocked", "timeout", "blocked"]


# --- Stock -----------------------------------------------------------------------------------------


def stock_invoice(parcel_id: str, carats: float, rate: float, invoice_date: str = "2026-10-15") -> dict:
    return invoice_with(
        ANTWERP,
        items=[{**line(carats, rate), "parcelId": parcel_id}],
        freightUsd=0,
        insuranceUsd=0,
        otherChargesUsd=0,
        shipment={"invoiceNumber": "", "invoiceDate": invoice_date, "countryOfDestination": "Belgium", "creditDays": 30},
        consignee={"companyName": "Rosenfeld & Sons BVBA"},
    )


async def test_stock_register_with_rough_used_yield_and_closing_value(client_factory, pool):
    owner = await sign_up(client_factory, "owner@example.com")
    post = lambda data: owner.post("/api/parcels", json=data)  # noqa: E731
    assert (await post({"parcelId": "R-1", "stockKind": "rough", "caratsIn": 100, "costInr": 1000000, "receivedOn": "2026-05-01"})).status_code == 201
    polished = {"parcelId": "P-1", "stockKind": "polished", "caratsIn": 24, "receivedOn": "2026-06-01"}
    assert (await post({**polished, "madeFrom": "R-9", "roughCaratsUsed": 60})).status_code == 400
    assert (await post({**polished, "madeFrom": "R-1", "roughCaratsUsed": 20})).status_code == 400
    assert (await post({**polished, "madeFrom": "R-1", "roughCaratsUsed": 60})).status_code == 201
    assert (await post({**polished, "madeFrom": "R-1", "roughCaratsUsed": 60})).status_code == 409

    created = await owner.post("/api/invoices", json={"invoice": stock_invoice("P-1", 10, 100)})
    assert (await owner.patch(f"/api/invoices/{created.json()['id']}/status", json={"status": "issued"})).status_code == 200
    unknown = await owner.post("/api/invoices", json={"invoice": stock_invoice("X-404", 2, 100)})
    await owner.patch(f"/api/invoices/{unknown.json()['id']}/status", json={"status": "issued"})

    register = (await owner.get("/api/parcels")).json()
    rough = next(p for p in register["parcels"] if p["parcelId"] == "R-1")
    assert {k: rough[k] for k in ("stockKind", "consumedCarats", "balanceCarats", "status")} == {
        "stockKind": "rough", "consumedCarats": 60, "balanceCarats": 40, "status": "partial"
    }
    polished_row = next(p for p in register["parcels"] if p["parcelId"] == "P-1")
    assert (polished_row["caratsOut"], polished_row["balanceCarats"], polished_row["invoices"]) == (10, 14, [created.json()["invoiceNumber"]])
    assert register["unregistered"] == [{"parcelId": "X-404", "carats": 2, "invoices": [unknown.json()["invoiceNumber"]]}]

    organization_id = await pool.fetchval("SELECT organization_id FROM users")
    await pool.execute(
        """INSERT INTO purchases (organization_id, kind, supplier_name, document_no, document_date, carats, taxable_inr)
           VALUES ($1, 'import', 'Supplier', 'BOE-1', $2, 420, 100)""",
        organization_id, date(2026, 5, 1),
    )
    stock = (await owner.get("/api/stock/register?year=2026-27")).json()
    assert {k: stock["rough"][k] for k in ("opening", "purchased", "consumed", "sold", "closing", "closingValueInr")} == {
        "opening": 0, "purchased": 100, "consumed": 60, "sold": 0, "closing": 40, "closingValueInr": 400000
    }
    assert {k: stock["polished"][k] for k in ("produced", "sold", "closing", "closingValueInr")} == {
        "produced": 24, "sold": 10, "closing": 14, "closingValueInr": 350000
    }
    assert stock["yieldPercent"] == 40
    assert stock["processLossCarats"] == 36
    assert stock["purchaseRegisterCarats"] == 420
    assert stock["soldWithoutParcel"] == {"rough": 0, "polished": 0}
    assert (await owner.get("/api/stock/register?year=2026")).status_code == 400

    csv = await owner.get("/api/stock/register/csv?year=2026-27")
    assert csv.status_code == 200 and 'filename="stock-register-2026-27.csv"' in csv.headers["content-disposition"]
    lines = csv.content.decode("utf-8-sig").strip().split("\r\n")
    assert lines[-1] == "Yield (polished produced / rough used),,,,,,,,40%,,"
    assert "Total rough,,,,0.000,100.000,60.000,0.000,40.000,,400000.00" in lines
    parcel_csv = (await owner.get("/api/parcels/csv")).content.decode("utf-8-sig")
    assert "R-1,rough,,2026-05-01,,,0,100.000,1000000.00,0,0.000,60.000,40.000,," in parcel_csv


async def test_parcel_permissions_and_validation(client_factory):
    owner = await sign_up(client_factory, "owner@example.com")
    await owner.post("/api/team/members", json={"email": "ca@example.com", "password": "temporary1", "role": "ca"})
    await owner.post("/api/team/members", json={"email": "member@example.com", "password": "temporary1"})
    ca, member = client_factory(), client_factory()
    await ca.post("/api/auth/login", json={"email": "ca@example.com", "password": "temporary1"})
    await member.post("/api/auth/login", json={"email": "member@example.com", "password": "temporary1"})

    assert (await ca.post("/api/parcels", json={"parcelId": "A", "caratsIn": 1})).status_code == 403
    for bad, message in (
        ({"caratsIn": 1}, "Enter the parcel or lot number."),
        ({"parcelId": "A"}, "Enter the carats received."),
        ({"parcelId": "A", "caratsIn": 1, "piecesIn": 1.5}, "Pieces must be a whole number."),
        ({"parcelId": "A", "caratsIn": 1, "receivedOn": "31/02/2026"}, "Enter the received date as YYYY-MM-DD."),
        ({"parcelId": "A", "caratsIn": 1, "costInr": -1}, "Cost must be zero or more rupees."),
    ):
        response = await member.post("/api/parcels", json=bad)
        assert (response.status_code, response.json()["error"]) == (400, message)
    created = await member.post("/api/parcels", json={"parcelId": "A", "caratsIn": "1.5", "receivedOn": "01/05/2026"})
    assert created.status_code == 201
    assert (await member.delete(f"/api/parcels/{created.json()['id']}")).status_code == 403
    assert (await owner.put(f"/api/parcels/{created.json()['id']}", json={"parcelId": "A2", "caratsIn": 2})).status_code == 200
    assert (await owner.delete(f"/api/parcels/{created.json()['id']}")).json() == {"deleted": True}
