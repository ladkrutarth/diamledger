"""Ported from server/tests/tax.test.ts and advancedTax.test.ts (sections 1–5; the accountant workspace is in test_accountant.py)."""

from __future__ import annotations

import base64
import io
import json
import zipfile

from diamondx.core.form_input import parse_loose_date
from diamondx.modules.banking.bank import suggest_matches
from diamondx.modules.tax.shared import parse_csv

from .conftest import sign_up
from .samples import ANTWERP, invoice_with


def one_line_invoice(buyer: str = "Rosenfeld & Sons BVBA", amount: float = 1000, rate: float | None = None) -> dict:
    extra = {"exchangeRateInr": rate} if rate else {}
    return invoice_with(
        ANTWERP,
        items=[{**ANTWERP["items"][0], "carats": 1, "ratePerCarat": amount, "totalAmount": amount}],
        freightUsd=0,
        insuranceUsd=0,
        otherChargesUsd=0,
        shipment={"invoiceNumber": "", "invoiceDate": "2026-10-15", "countryOfDestination": "Belgium"},
        consignee={"companyName": buyer},
        **extra,
    )


async def login(client_factory, email: str):
    agent = client_factory()
    response = await agent.post("/api/auth/login", json={"email": email, "password": "password123"})
    assert response.status_code == 200, response.text
    return agent, response.json()["user"]


def zip_names(content: bytes) -> list[str]:
    return zipfile.ZipFile(io.BytesIO(content)).namelist()


async def test_tax_and_ca_roles_and_closing_a_month(client_factory):
    owner = await sign_up(client_factory, "owner@example.com", "Meridian Diamond Exports")
    for email, role in (("tax.desk@example.com", "tax"), ("ca.review@example.com", "ca"), ("desk@example.com", "member")):
        assert (await owner.post("/api/team/members", json={"email": email, "password": "password123", "role": role})).status_code == 201
    created = (await owner.post("/api/invoices", json={"invoice": one_line_invoice()})).json()
    assert (await owner.patch(f"/api/invoices/{created['id']}/status", json={"status": "issued"})).status_code == 200

    tax, tax_user = await login(client_factory, "tax.desk@example.com")
    assert tax_user["role"] == "tax"
    saved = await tax.put(f"/api/invoices/{created['id']}/tax",
                          json={"exportScheme": "igst", "shippingBillNo": "SB-1001", "shippingBillDate": "2026-10-16", "igstUsd": 18})
    assert saved.status_code == 200, saved.text
    attached = await tax.post(f"/api/invoices/{created['id']}/documents", json={
        "kind": "shipping_bill", "fileName": "../sb-1001.pdf", "contentType": "application/pdf",
        "dataBase64": base64.b64encode(b"%PDF-1.4 shipping bill").decode(),
    })
    assert attached.status_code == 201 and attached.json()["fileName"] == "sb-1001.pdf"
    details = (await tax.get(f"/api/invoices/{created['id']}/tax")).json()
    assert details["exportScheme"] == "igst" and details["documents"][0]["kind"] == "shipping_bill"
    document = await tax.get(f"/api/invoices/{created['id']}/documents/{details['documents'][0]['id']}")
    assert document.content == b"%PDF-1.4 shipping bill"

    register = (await tax.get("/api/tax/register?month=2026-10")).json()
    assert [(r["invoiceNumber"], r["exportScheme"], r["shippingBillNo"], r["taxableUsd"]) for r in register["rows"]] == [
        (created["invoiceNumber"], "igst", "SB-1001", 1000)
    ]
    assert register["rows"][0]["documents"] == ["shipping_bill"]
    row = (await tax.get("/api/tax/realization")).json()["rows"][0]
    assert (row["open"], row["dueUsd"], row["missingReference"]) == (True, 1000, False)

    member, _ = await login(client_factory, "desk@example.com")
    assert (await member.get("/api/tax/register")).status_code == 403

    ca, ca_user = await login(client_factory, "ca.review@example.com")
    assert ca_user["role"] == "ca"
    assert (await ca.post("/api/invoices", json={"invoice": one_line_invoice()})).status_code == 403
    assert (await ca.post("/api/buyers", json={"consignee": {"companyName": "Blocked"}})).status_code == 403
    review = await ca.put(f"/api/invoices/{created['id']}/review", json={"status": "query", "comment": "Shipping bill date does not match the invoice."})
    assert review.status_code == 200

    assert (await ca.post("/api/tax/months/2026-10/close")).status_code == 200
    months = (await ca.get("/api/tax/months")).json()["months"]
    assert months[0]["month"] == "2026-10" and months[0]["closedBy"] == "ca.review@example.com"
    blocked = await owner.post(f"/api/invoices/{created['id']}/payments", json={"amountUsd": 1000, "paidOn": "2026-10-20", "reference": "SWIFT-1"})
    assert blocked.status_code == 409
    assert (await tax.put(f"/api/invoices/{created['id']}/tax", json={"exportScheme": "lut", "shippingBillNo": "SB-2"})).status_code == 409

    pack = await ca.get("/api/tax/gst-pack?month=2026-10")
    assert pack.status_code == 200 and "application/zip" in pack.headers["content-type"]
    archive = zipfile.ZipFile(io.BytesIO(pack.content))
    assert archive.namelist() == ["export-register.csv", "payments.csv"]
    assert "SB-1001" in archive.read("export-register.csv").decode("utf-8-sig")

    year = await ca.get("/api/tax/year-pack?year=2026-27")
    assert zip_names(year.content) == ["sales-register.csv", "receipts.csv", "outstanding.csv", "cancelled.csv"]
    assert (await ca.get("/api/tax/year-pack?year=2026")).status_code == 400

    assert (await ca.post("/api/tax/months/2026-10/open")).status_code == 200
    paid = await owner.post(f"/api/invoices/{created['id']}/payments", json={"amountUsd": 1000, "paidOn": "2026-10-20", "reference": "SWIFT-1"})
    assert paid.status_code == 201
    after = (await tax.get("/api/tax/realization")).json()["rows"][0]
    assert (after["open"], after["bankReferences"]) == (False, "SWIFT-1")


def test_parses_quoted_csv_and_indian_dates():
    assert parse_csv('a,b\r\n"x, y","say ""hi"""\n') == [["a", "b"], ["x, y", 'say "hi"']]
    assert parse_loose_date("20/10/2026") == "2026-10-20"
    assert parse_loose_date("2026-02-30") is None


def test_ranks_the_invoice_named_in_the_narration_first():
    suggestions = suggest_matches(
        {"amountUsd": 1985, "reference": "FT123", "narration": "BLUE STAR GEMS INV XYZ/2026-27/0002"},
        [
            {"id": "a", "invoiceNumber": "XYZ/2026-27/0001", "buyerName": "Rosenfeld", "dueUsd": 1985},
            {"id": "b", "invoiceNumber": "XYZ/2026-27/0002", "buyerName": "Blue Star Gems DMCC", "dueUsd": 2000},
        ],
    )
    assert suggestions[0]["invoiceId"] == "b"
    assert "Short by $15.00" in " ".join(suggestions[0]["reasons"])


async def test_filing_check_bank_matching_realization_and_forex(client_factory):
    owner = await sign_up(client_factory, "owner@example.com", "Meridian Diamond Exports")
    created = []
    for buyer, amount in (("Rosenfeld & Sons BVBA", 1000), ("Blue Star Gems DMCC", 2000)):
        response = await owner.post("/api/invoices", json={"invoice": one_line_invoice(buyer, amount, 84)})
        assert response.status_code == 201
        assert (await owner.patch(f"/api/invoices/{response.json()['id']}/status", json={"status": "issued"})).status_code == 200
        created.append(response.json())
    a, b = created

    # 1. Shipping bill against the GSTR-1 check
    check = (await owner.get("/api/tax/filing-check?month=2026-10")).json()
    codes = [issue["code"] for issue in next(r for r in check["rows"] if r["id"] == a["id"])["issues"]]
    assert {"shipping_bill_missing", "irn_missing"} <= set(codes)
    assert (await owner.put(f"/api/invoices/{a['id']}/tax", json={
        "exportScheme": "lut", "shippingBillNo": "SB-1001", "shippingBillDate": "2026-10-16", "portCode": "inbom4",
        "sbInvoiceNumber": a["invoiceNumber"], "sbValueUsd": 1000,
    })).status_code == 200
    assert (await owner.put(f"/api/invoices/{b['id']}/tax", json={
        "exportScheme": "lut", "shippingBillNo": "SB-1002", "shippingBillDate": "2026-10-16", "portCode": "INBOM4",
        "sbInvoiceNumber": "WRONG/1", "sbValueUsd": 1500,
    })).status_code == 200
    assert (await owner.put(f"/api/invoices/{a['id']}/einvoice", json={"irn": "xyz"})).status_code == 400
    assert (await owner.put(f"/api/invoices/{a['id']}/einvoice",
                            json={"irn": "a" * 64, "ackNo": "112610000000001", "ackDate": "2026-10-15"})).status_code == 200
    check = (await owner.get("/api/tax/filing-check?month=2026-10")).json()
    assert check["readyCount"] == 1
    second_codes = {issue["code"] for issue in next(r for r in check["rows"] if r["id"] == b["id"])["issues"]}
    assert {"sb_invoice_mismatch", "sb_value_mismatch", "irn_missing"} <= second_codes

    # 2. GSTR-1 table 6A and e-invoice JSON
    gstr1 = await owner.get("/api/tax/gstr1-6a?month=2026-10")
    assert gstr1.status_code == 200 and gstr1.headers["x-left-out"] == "1"
    gstr1_body = json.loads(gstr1.text)
    assert gstr1_body["fp"] == "102026"
    assert '"val": 84000,' in gstr1.text  # whole numbers without .0, as JSON.stringify writes them
    assert len(gstr1_body["exp"]) == 1 and gstr1_body["exp"][0]["exp_typ"] == "WOPAY"
    inv = gstr1_body["exp"][0]["inv"][0]
    assert {k: inv[k] for k in ("inum", "idt", "val", "sbpcode", "sbnum", "sbdt")} == {
        "inum": a["invoiceNumber"], "idt": "15-10-2026", "val": 84000, "sbpcode": "INBOM4", "sbnum": "SB-1001", "sbdt": "16-10-2026"
    }
    payload = json.loads((await owner.get(f"/api/invoices/{b['id']}/einvoice.json")).text)
    assert payload["TranDtls"]["SupTyp"] == "EXPWOP"
    assert payload["DocDtls"] == {"Typ": "INV", "No": b["invoiceNumber"], "Dt": "15/10/2026"}
    assert {k: payload["BuyerDtls"][k] for k in ("Gstin", "Pos", "Stcd")} == {"Gstin": "URP", "Pos": "96", "Stcd": "96"}
    assert (payload["ValDtls"]["AssVal"], payload["ValDtls"]["TotInvValFc"]) == (168000, 2000)
    assert {k: payload["ExpDtls"][k] for k in ("ForCur", "CntCode", "Port")} == {"ForCur": "USD", "CntCode": "BE", "Port": "INBOM4"}
    assert "Addr2" in payload["SellerDtls"]  # present in the preset
    batch = json.loads((await owner.get("/api/tax/einvoice-batch?month=2026-10")).text)
    assert [p["DocDtls"]["No"] for p in batch] == [b["invoiceNumber"]]

    # 3. Bank statement matching
    csv = "\n".join([
        "Value Date,Credit,Reference,Narration,Rate",
        '20/10/2026,"1,000.00",SWIFT-A1,REMITTANCE ROSENFELD,85.50',
        f"21/10/2026,1985.00,SWIFT-B1,BLUE STAR payment {b['invoiceNumber']},83.00",
        "21/10/2026,,CHQ-9,Debit card,",
    ])
    assert (await owner.post("/api/bank/import", json={"csv": csv})).json() == {"imported": 2, "duplicates": 0, "skipped": 1}
    assert (await owner.post("/api/bank/import", json={"csv": csv})).json() == {"imported": 0, "duplicates": 2, "skipped": 1}
    lines = (await owner.get("/api/bank/lines")).json()
    assert lines["counts"] == {"unmatched": 2}
    line_a = next(line for line in lines["lines"] if line["reference"] == "SWIFT-A1")
    line_b = next(line for line in lines["lines"] if line["reference"] == "SWIFT-B1")
    assert line_a["suggestions"][0]["invoiceId"] == a["id"]
    assert (line_b["suggestions"][0]["invoiceId"], line_b["suggestions"][0]["shortByUsd"]) == (b["id"], 15)
    assert (await owner.post(f"/api/bank/lines/{line_a['id']}/match", json={"invoiceId": a["id"]})).json() == {
        "matched": True, "dueUsd": 0, "status": "paid"}
    assert (await owner.post(f"/api/bank/lines/{line_b['id']}/match", json={"invoiceId": b["id"]})).json()["dueUsd"] == 15
    assert (await owner.post(f"/api/bank/lines/{line_b['id']}/match", json={"invoiceId": b["id"]})).status_code == 409

    # 5. Exchange gain and loss
    forex = (await owner.get("/api/tax/forex?month=2026-10")).json()
    assert forex["totals"] == {"gainInr": 1500, "lossInr": -1985, "netInr": -485}
    first_payment = next(r for r in forex["rows"] if r["invoiceId"] == a["id"])
    assert (await owner.patch(f"/api/invoices/{a['id']}/payments/{first_payment['paymentId']}", json={"bankRateInr": 86})).status_code == 200
    assert (await owner.get("/api/tax/forex?month=2026-10")).json()["totals"]["gainInr"] == 2000
    xml = (await owner.get("/api/tax/forex/tally?month=2026-10")).text
    for expected in ('VCHTYPE="Receipt"', "<LEDGERNAME>Foreign Exchange Gain / Loss</LEDGERNAME>", "<AMOUNT>-86000.00</AMOUNT>",
                     "<AMOUNT>84000.00</AMOUNT>", "<AMOUNT>2000.00</AMOUNT>", "bank rate 86 (invoice rate 84)"):
        assert expected in xml

    # 4. FEMA realization deadlines and e-BRC
    realization = (await owner.get("/api/tax/realization")).json()
    assert realization["realizationMonths"] == 9
    row_a = next(r for r in realization["rows"] if r["id"] == a["id"])
    assert (row_a["deadline"], row_a["flag"]) == ("2027-07-16", "needs_brc")
    brc = await owner.post("/api/tax/ebrc/import", json={
        "csv": "e-BRC Number,Shipping Bill No,Realisation Date,Realised Value\nBRC0001,SB-1001,20-10-2026,1000\nBRC0002,SB-404,20-10-2026,5"})
    assert brc.json() == {"matched": 1, "unmatched": ["SB-404"]}
    assert (await owner.put("/api/tax/settings", json={"realizationMonths": 1, "lutValidUntil": "2027-03-31"})).status_code == 200
    assert (await owner.put("/api/tax/settings", json={"realizationMonths": 1.5})).status_code == 400
    realization = (await owner.get("/api/tax/realization")).json()
    row_a = next(r for r in realization["rows"] if r["id"] == a["id"])
    row_b = next(r for r in realization["rows"] if r["id"] == b["id"])
    assert (row_a["flag"], row_a["brcNumber"]) == ("done", "BRC0001")
    assert (row_b["deadline"], row_b["dueUsd"]) == ("2026-11-16", 15)

    # Refund statement and activity history read from the same data.
    refund = (await owner.get("/api/tax/refund-summary?from=2026-10&to=2026-10")).json()
    assert refund["totals"]["invoices"] == 2 and refund["totals"]["ready"] == 1
    audit_response = await owner.get("/api/audit?limit=5")
    assert audit_response.status_code == 200, audit_response.text
    events = audit_response.json()["events"]
    assert events and all(e["userEmail"] == "owner@example.com" for e in events)
