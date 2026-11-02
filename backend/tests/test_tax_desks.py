"""Ported from server/tests/features.test.ts: purchases and GSTR-2B, payments abroad, audit checks, the audit pack,
Tally, notices, and the activity history. The steps build on each other, as in the Node suite."""

from __future__ import annotations

import io
import zipfile

from diamondx.core.form_input import document_key
from diamondx.modules.banking.tally_sync import parse_tally_amount, parse_tally_csv, parse_tally_xml
from diamondx.modules.tax.audit_checks import invoice_series, numbering_gaps
from diamondx.modules.tax.foreign_payments import form15ca_part
from diamondx.modules.tax.purchases import parse_gstr2b_csv

from .conftest import sign_up
from .samples import ANTWERP, invoice_with


def invoice(parcel_id: str = "", carats: float = 1, rate: float = 1000, day: str = "2026-10-15") -> dict:
    return invoice_with(
        ANTWERP,
        items=[{**ANTWERP["items"][0], "parcelId": parcel_id, "carats": carats, "ratePerCarat": rate, "totalAmount": round(carats * rate, 2)}],
        freightUsd=0,
        insuranceUsd=0,
        otherChargesUsd=0,
        shipment={"invoiceNumber": "", "invoiceDate": day, "countryOfDestination": "Belgium", "creditDays": 30},
        consignee={"companyName": "Rosenfeld & Sons BVBA"},
    )


def test_document_keys():
    assert document_key("INV/007") == document_key("inv-7")
    assert document_key("INV-077") == "INV77"
    assert document_key("1234567") == "1234567"
    assert document_key("INV-10") != document_key("INV-1")


def test_numbering_gaps():
    assert invoice_series("EXP/2026-27/0012") == {"prefix": "EXP/2026-27/", "series": "EXP/2026-27/", "number": 12, "width": 4}
    assert numbering_gaps(["EXP/2026-27/0001", "EXP/2026-27/0004", "EXP/2026-27/0002", "OTHER-9"]) == [
        {"series": "EXP/2026-27/", "missing": ["EXP/2026-27/0003"]}
    ]


def test_tally_amounts_and_day_book_csv():
    assert parse_tally_amount("-108125.00") == {"inr": 108125, "usd": None}
    assert parse_tally_amount("-$ 1,250.00 @ ₹ 86.50/$ = -₹ 1,08,125.00") == {"inr": 108125, "usd": 1250}
    assert parse_tally_amount("$ 1000.00") == {"inr": 0, "usd": 1000}
    assert parse_tally_amount("") is None
    csv = ('Day Book\nDate,Particulars,Vch Type,Vch No.,Debit Amount,Credit Amount\n1-Oct-26,Rosenfeld,Sales,EXP/1,"86,650.00",\n'
           '2-Oct-26,HDFC Bank,Receipt,R-1,,"50,000.00"\n')
    vouchers = parse_tally_csv(csv)
    assert [(v["date"], v["kind"], v["amountInr"]) for v in vouchers] == [("2026-10-01", "sales", 86650), ("2026-10-02", "receipt", 50000)]
    assert vouchers[0]["number"] == "EXP/1"
    assert "Date and Vch Type" in parse_tally_csv("a,b\n1,2")


def test_gstr2b_csv():
    parsed = parse_gstr2b_csv(
        "GSTIN of supplier,Trade/Legal name,Invoice number,Invoice date,Taxable Value (₹),Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹),ITC Availability\n"
        '24ABCDE1234F1Z5,Gem Traders,INV-077,05-10-2026,"1,00,000.00",250.00,0,0,Yes\n'
        ",,,,,,,,\n"
        "27ABCDE1234F1Z5,Blocked Co,B-1,06-10-2026,1000,0,10,10,No\n"
    )
    assert parsed["skipped"] == 0
    first, second = parsed["lines"]
    assert (first["section"], first["documentNo"], first["documentDate"], first["taxableInr"], first["igstInr"], first["itcAvailable"]) == (
        "b2b", "INV-077", "2026-10-05", 100000, 250, True)
    assert (second["supplierName"], second["cgstInr"], second["itcAvailable"]) == ("Blocked Co", 10, False)


def test_form15ca_part():
    assert form15ca_part(False, 900000) == "D"
    assert form15ca_part(True, 400000) == "A"
    assert form15ca_part(True, 500001) == "C"


async def test_tax_desks_end_to_end(client_factory, drafter_notice):
    owner = await sign_up(client_factory, "owner@example.com", "Meridian Diamond Exports")
    agents = {}
    for email, role in (("tax@example.com", "tax"), ("ca@example.com", "ca"), ("member@example.com", "member")):
        assert (await owner.post("/api/team/members", json={"email": email, "password": "password123", "role": role})).status_code == 201
        agents[role] = client_factory()
        await agents[role].post("/api/auth/login", json={"email": email, "password": "password123"})
    tax, ca, member = agents["tax"], agents["ca"], agents["member"]

    # Stock and the first invoice (as in the stock test of the Node suite).
    await owner.post("/api/parcels", json={"parcelId": "R-1", "stockKind": "rough", "caratsIn": 100, "costInr": 1000000, "receivedOn": "2026-05-01"})
    await owner.post("/api/parcels", json={"parcelId": "P-1", "stockKind": "polished", "caratsIn": 24, "madeFrom": "R-1", "roughCaratsUsed": 60,
                                            "receivedOn": "2026-06-01"})
    created = (await owner.post("/api/invoices", json={"invoice": invoice("P-1", 10, 100)})).json()
    await owner.patch(f"/api/invoices/{created['id']}/status", json={"status": "issued"})
    first_invoice = created

    # Purchases and GSTR-2B
    local = await member.post("/api/purchases", json={
        "kind": "local", "supplierName": "Gem Traders", "supplierGstin": "24ABCDE1234F1Z5", "documentNo": "INV-77",
        "documentDate": "2026-10-05", "taxableInr": 100000, "igstInr": 250, "carats": 120})
    assert local.status_code == 201, local.text
    assert (await member.post("/api/purchases", json={"kind": "local", "supplierName": "Gem Traders", "supplierGstin": "24ABCDE1234F1Z5",
                                                      "documentNo": "INV-77", "documentDate": "2026-10-05", "taxableInr": 1})).status_code == 409
    assert (await member.post("/api/purchases", json={
        "kind": "import", "supplierName": "Antwerp Rough NV", "supplierCountry": "Belgium", "documentNo": "1234567", "documentDate": "2026-10-08",
        "portCode": "INBOM4", "taxableInr": 500000, "igstInr": 1250, "carats": 300, "relatedParty": True})).status_code == 201
    assert (await member.post("/api/purchases", json={"kind": "local", "supplierName": "Late Filer", "supplierGstin": "24LATEF1234F1Z5",
                                                      "documentNo": "LF-80", "documentDate": "2026-10-09", "taxableInr": 40000, "igstInr": 100})).status_code == 201
    bad = await member.post("/api/purchases", json={"kind": "local", "supplierName": "Bad GSTIN", "supplierGstin": "XYZ", "documentNo": "B-1",
                                                    "documentDate": "2026-10-09", "taxableInr": 1})
    assert bad.status_code == 400 and "GSTIN" in bad.json()["error"]

    csv = ("Section,GSTIN of supplier,Trade/Legal name,Invoice number,Bill of entry number,Invoice date,Taxable value,Integrated tax,"
           "Central tax,State/UT tax,ITC availability\n"
           "B2B,24ABCDE1234F1Z5,Gem Traders,INV-077,,05-10-2026,100000,250,0,0,Yes\n"
           "IMPG,,,,1234567,08-10-2026,500000,1000,0,0,Yes\n"
           "B2B,24NEWSU1234F1Z5,New Supplier,NS-99,,10-10-2026,120000,300,0,0,Yes\n")
    imported = await tax.post("/api/purchases/gstr2b", json={"month": "2026-10", "csv": csv})
    assert imported.status_code == 201 and imported.json()["imported"] == 3
    assert (await member.get("/api/purchases/itc-match?month=2026-10")).status_code == 403
    match = (await tax.get("/api/purchases/itc-match?month=2026-10")).json()
    status = {row["documentNo"]: row["status"] for row in match["rows"]}
    assert (status["INV-77"], status["1234567"], status["LF-80"], status["NS-99"]) == ("matched", "mismatch", "missing_in_2b", "not_in_books")
    assert {k: match["totals"][k] for k in ("booksItcInr", "matchedItcInr", "atRiskItcInr", "unclaimedItcInr", "mismatches")} == {
        "booksItcInr": 1600, "matchedItcInr": 250, "atRiskItcInr": 100, "unclaimedItcInr": 300, "mismatches": 1}
    assert (await ca.post("/api/tax/months/2026-09/close")).status_code == 200
    blocked = await member.post("/api/purchases", json={"kind": "local", "supplierName": "Gem Traders", "documentNo": "OLD-1",
                                                        "documentDate": "2026-09-10", "taxableInr": 10})
    assert blocked.status_code == 409 and "this purchase" in blocked.json()["error"]
    assert (await ca.post("/api/purchases", json={"kind": "local", "supplierName": "X", "documentNo": "CA-1", "documentDate": "2026-10-10",
                                                  "taxableInr": 10})).status_code == 403

    # Payments abroad
    assert (await tax.post("/api/foreign-payments", json={
        "payeeName": "Antwerp Brokers BV", "payeeCountry": "Belgium", "nature": "commission", "paidOn": "2026-10-20", "amountFc": 7000,
        "rateInr": 85, "relatedParty": True})).status_code == 201
    assert (await tax.post("/api/foreign-payments", json={"payeeName": "Malca-Amit", "nature": "freight", "paidOn": "2026-10-21", "amountFc": 500,
                                                          "rateInr": 85, "taxableInIndia": False, "form15caAck": "ACK123"})).status_code == 201
    assert (await tax.post("/api/foreign-payments", json={"payeeName": "Lab", "nature": "professional", "paidOn": "2026-10-22", "amountFc": 100,
                                                          "rateInr": 85, "tdsRate": 10, "dtaaApplied": True})).status_code == 201
    listed = (await tax.get("/api/foreign-payments?year=2026-27")).json()
    by_payee = {p["payeeName"]: p for p in listed["payments"]}
    brokers = by_payee["Antwerp Brokers BV"]
    assert (brokers["amountInr"], brokers["form15caPart"]) == (595000, "C")
    texts = " | ".join(issue["text"] for issue in brokers["issues"])
    assert "no TDS" in texts and "Form 15CB" in texts
    assert (by_payee["Malca-Amit"]["form15caPart"], by_payee["Malca-Amit"]["issues"]) == ("D", [])
    assert (by_payee["Lab"]["tdsInr"], by_payee["Lab"]["form15caPart"]) == (850, "A")
    assert any("Tax Residency Certificate" in i["text"] for i in by_payee["Lab"]["issues"])
    assert {k: listed["totals"][k] for k in ("count", "withoutTds", "missing15cb", "relatedParty")} == {
        "count": 3, "withoutTds": 1, "missing15cb": 1, "relatedParty": 1}
    assert (await member.get("/api/foreign-payments")).status_code == 403

    # Audit checks
    second = (await owner.post("/api/invoices", json={"invoice": invoice()})).json()
    third = (await owner.post("/api/invoices", json={"invoice": invoice()})).json()
    assert (await owner.delete(f"/api/invoices/{second['id']}")).status_code == 204
    assert (await owner.patch(f"/api/invoices/{third['id']}/status", json={"status": "issued"})).status_code == 200
    assert (await ca.post("/api/tax/months/2026-10/close")).status_code == 200
    assert (await ca.post("/api/tax/months/2026-10/open")).status_code == 200
    assert (await tax.put(f"/api/invoices/{third['id']}/tax",
                          json={"exportScheme": "lut", "shippingBillNo": "SB-77", "shippingBillDate": "2026-10-16"})).status_code == 200
    checks = (await ca.get("/api/tax/audit-checks?from=2026-04&to=2027-03")).json()
    kinds = {f["check"] for f in checks["findings"]}
    assert {"numbering_gap", "edited_while_reopened", "foreign_no_tds", "foreign_no_15ca"} <= kinds
    gap = next(f for f in checks["findings"] if f["check"] == "numbering_gap")
    assert second["invoiceNumber"] in gap["detail"]
    assert checks["findings"][0]["severity"] == "high"
    assert (await member.get("/api/tax/audit-checks")).status_code == 403
    assert "Gap in invoice numbers" in (await ca.get("/api/tax/audit-checks/csv?from=2026-04&to=2027-03")).text

    # Form 3CD audit pack
    pack = (await ca.get("/api/tax/audit-pack?year=2026-27")).json()
    assert pack["turnover"]["lut"]["invoices"] == 2
    assert pack["stock"]["yieldPercent"] == 40
    assert (pack["purchases"]["imports"]["count"], pack["purchases"]["imports"]["taxableInr"]) == (1, 500000)
    assert (pack["tds"]["withoutTds"], pack["tds"]["withoutTdsInr"]) == (1, 595000)
    assert pack["relatedParty"]["purchases"]["count"] == 1 and pack["relatedParty"]["foreignPayments"]["count"] == 1
    assert pack["checks"]["high"] > 0
    assert len(pack["summary"]) > 10 and "_detail" not in pack
    archive = zipfile.ZipFile(io.BytesIO((await ca.get("/api/tax/audit-pack/zip?year=2026-27")).content))
    for name in ("summary.csv", "stock-register-clause-35.csv", "purchase-register.csv", "foreign-payments-tds.csv",
                 "receivables-at-year-end.csv", "audit-checks.csv"):
        assert name in archive.namelist()
    assert "Clause 35" in archive.read("summary.csv").decode("utf-8-sig")

    # Tally: a sales voucher as the frontend writes it, plus vouchers with nothing matching.
    sales_xml = f"""<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>
      <VOUCHER VCHTYPE="Sales - Export LUT" ACTION="Create" OBJVIEW="Invoice Voucher View"><DATE>20261015</DATE>
        <VOUCHERTYPENAME>Sales - Export LUT</VOUCHERTYPENAME><VOUCHERNUMBER>{first_invoice['invoiceNumber']}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Rosenfeld &amp; Sons BVBA</PARTYLEDGERNAME>
        <LEDGERENTRIES.LIST><LEDGERNAME>Rosenfeld &amp; Sons BVBA</LEDGERNAME><AMOUNT>$ 1000.00</AMOUNT><BASEAMOUNT>86650.00</BASEAMOUNT></LEDGERENTRIES.LIST>
      </VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>"""
    extra_xml = """<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>
      <VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20261018</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>EXP/OLD/9</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Unknown Buyer</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Unknown Buyer</LEDGERNAME><AMOUNT>-50000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
      <VOUCHER VCHTYPE="Purchase" ACTION="Create"><DATE>20261005</DATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>P-1</VOUCHERNUMBER>
        <REFERENCE>INV-077</REFERENCE><PARTYLEDGERNAME>Gem Traders</PARTYLEDGERNAME>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Gem Traders</LEDGERNAME><AMOUNT>100250.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
    </TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>"""
    parsed = parse_tally_xml(sales_xml)
    assert [(v["kind"], v["number"], v["amountUsd"], v["party"]) for v in parsed] == [
        ("sales", first_invoice["invoiceNumber"], 1000, "Rosenfeld & Sons BVBA")]
    first = await tax.post("/api/tally/import", json={"content": sales_xml})
    assert first.status_code == 201 and first.json()["imported"] == 1
    assert (await tax.post("/api/tally/import", json={"content": sales_xml})).json()["duplicates"] == 1
    assert (await tax.post("/api/tally/import", json={"content": extra_xml})).json()["imported"] == 2
    report = (await ca.get("/api/tally/reconcile?from=2026-10&to=2026-10")).json()

    def find(reference: str, area: str) -> dict:
        return next(r for r in report["rows"] if r["reference"] == reference and r["area"] == area)

    assert find(first_invoice["invoiceNumber"], "sales")["status"] == "matched"
    assert find("EXP/OLD/9", "sales")["status"] == "missing_in_app"
    assert find("INV-77", "purchases")["status"] == "matched"
    assert find("LF-80", "purchases")["status"] == "missing_in_tally"
    assert report["totals"]["missingInTally"] > 0
    assert (await member.post("/api/tally/import", json={"content": "nothing"})).status_code == 400

    # Notices, with replies drafted only from figures in the records
    assert (await tax.post("/api/notices", json={"authority": "gst", "formType": "ASMT-10", "invoiceNumbers": ["NOPE-1"]})).status_code == 400
    notice = await ca.post("/api/notices", json={
        "authority": "gst", "formType": "ASMT-10", "referenceNo": "ZA2410260001", "period": "2026-10", "issuedOn": "2026-10-25",
        "replyDue": "2026-11-05", "amountInr": 25000, "summary": "Difference between GSTR-1 and the e-way bill data.",
        "invoiceNumbers": [first_invoice["invoiceNumber"]]})
    assert notice.status_code == 201, notice.text
    notice_id = notice.json()["id"]
    drafter_notice.reply = lambda facts: {"paragraphs": [f"Invoice {facts['invoices'][0]['invoiceNumber']} for USD 1000.00 was exported under LUT."]}
    grounded = (await ca.post(f"/api/notices/{notice_id}/draft-reply")).json()
    assert grounded["source"] == "model" and "USD 1000.00" in grounded["reply"]
    drafter_notice.reply = lambda facts: {"paragraphs": ["We paid USD 77777.00 in tax already."]}
    invented = (await ca.post(f"/api/notices/{notice_id}/draft-reply")).json()
    assert invented["source"] == "template" and "not in your records" in invented["note"]
    assert first_invoice["invoiceNumber"] in invented["reply"] and "77777" not in invented["reply"]
    drafter_notice.reply = RuntimeError("model offline")
    assert (await ca.post(f"/api/notices/{notice_id}/draft-reply")).json()["source"] == "template"
    notices = (await tax.get("/api/notices")).json()["notices"]
    assert {k: notices[0][k] for k in ("formType", "status", "invoiceNumbers", "replySource")} == {
        "formType": "ASMT-10", "status": "open", "invoiceNumbers": [first_invoice["invoiceNumber"]], "replySource": "template"}
    assert (await ca.delete(f"/api/notices/{notice_id}")).status_code == 403
    assert (await member.get("/api/notices")).status_code == 403

    # Buyer credit limit (recorded in the activity history)
    buyer = (await owner.post("/api/buyers", json={"consignee": {"companyName": "Rosenfeld & Sons BVBA", "country": "Belgium"}})).json()
    assert (await owner.put(f"/api/buyers/{buyer['id']}/credit-limit", json={"creditLimitUsd": 1500})).status_code == 200

    # Activity history
    events = (await owner.get("/api/audit?limit=500")).json()["events"]
    actions = {e["action"] for e in events}
    for action in ("purchase.create", "gstr2b.import", "foreign_payment.create", "tally.import", "notice.create", "notice.draft", "buyer.credit_limit"):
        assert action in actions, action
