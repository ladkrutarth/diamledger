"""GSTR-1 table 6A and e-invoice preparation: checks per invoice, and the JSON the portals take
(port of server/modules/tax/filing.ts)."""

from __future__ import annotations

import re
from datetime import date

from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import ApiError, CurrentUser, body, is_uuid
from ...core.numbers import UNDEFINED, js_json, js_number, money, to_fixed
from .closed_months import closed_month_message, parse_month
from .shared import DIAMOND_GST_RATE, current_month, download_response, invoice_date_of, tax_reader, tax_settings, tax_writer

GSTIN_PATTERN = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
DOCUMENT_NUMBER_PATTERN = re.compile(r"^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$")

COUNTRY_CODES = {
    "BELGIUM": "BE", "UNITED STATES": "US", "USA": "US", "UNITED STATES OF AMERICA": "US", "HONG KONG": "HK",
    "UNITED ARAB EMIRATES": "AE", "UAE": "AE", "ISRAEL": "IL", "SWITZERLAND": "CH", "UNITED KINGDOM": "GB", "UK": "GB",
    "SINGAPORE": "SG", "JAPAN": "JP", "THAILAND": "TH", "CHINA": "CN", "ITALY": "IT", "FRANCE": "FR", "GERMANY": "DE",
    "CANADA": "CA", "AUSTRALIA": "AU", "NETHERLANDS": "NL", "SOUTH AFRICA": "ZA",
}

FILING_SQL = """
  SELECT i.id, i.invoice_number,
         to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
         i.status, i.total_usd, i.data,
         COALESCE(t.export_scheme, 'lut') AS export_scheme,
         COALESCE(t.shipping_bill_no, '') AS shipping_bill_no,
         to_char(t.shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date,
         COALESCE(t.port_code, '') AS port_code,
         COALESCE(t.sb_invoice_number, '') AS sb_invoice_number,
         t.sb_value_usd,
         COALESCE(t.igst_usd, 0) AS igst_usd,
         e.irn
  FROM invoices i
  LEFT JOIN invoice_tax t ON t.invoice_id = i.id
  LEFT JOIN invoice_einvoices e ON e.invoice_id = i.id
"""


async def filing_sources(pool: Pool, organization_id: str, month: str) -> list[dict]:
    rows = await pool.fetch(
        f"""{FILING_SQL}
            WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid')
              AND to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM') = $2
            ORDER BY invoice_date, i.invoice_number""",
        organization_id, month,
    )
    return [dict(row) for row in rows]


def fob_usd(source: dict) -> float:
    data = source["data"]
    return money(float(source["total_usd"]) - (data.get("freightUsd") or 0) - (data.get("insuranceUsd") or 0))


def exchange_rate(source: dict) -> float:
    rate = js_number(source["data"].get("exchangeRateInr")) if "exchangeRateInr" in source["data"] else float("nan")
    return rate if rate == rate and rate > 0 else 0


def filing_issues(source: dict, einvoice_required: bool) -> list[dict]:
    issues: list[dict] = []

    def add(code: str, message: str) -> None:
        issues.append({"code": code, "message": message})

    number = source["invoice_number"].strip()
    if not DOCUMENT_NUMBER_PATTERN.match(number):
        add("invoice_number_format", "GSTR-1 and the e-invoice portal need an invoice number of at most 16 letters, digits, / or -, not starting with 0, / or -.")
    if not exchange_rate(source):
        add("exchange_rate", "The invoice has no customs exchange rate, so the rupee value cannot be worked out.")
    if not source["shipping_bill_no"]:
        add("shipping_bill_missing", "No shipping bill number. Table 6A and the IGST refund need it.")
    else:
        if not source["shipping_bill_date"]:
            add("shipping_bill_date", "No shipping bill date.")
        elif source["shipping_bill_date"] < source["invoice_date"]:
            add("shipping_bill_before_invoice", "The shipping bill is dated before the invoice.")
        if not re.match(r"^[A-Z0-9]{6}$", source["port_code"]):
            add("port_code", "No six-character port code (for example INBOM4).")
        if not source["sb_invoice_number"]:
            add("sb_invoice_missing", "Enter the invoice number exactly as printed on the shipping bill.")
        elif source["sb_invoice_number"].strip().upper() != number.upper():
            add("sb_invoice_mismatch",
                f"The shipping bill shows invoice {source['sb_invoice_number']}, but GSTR-1 will report {number}. Customs will hold the refund.")
        if source["sb_value_usd"] is None:
            add("sb_value_missing", "Enter the FOB value from the shipping bill.")
        else:
            fob = fob_usd(source)
            if abs(float(source["sb_value_usd"]) - fob) > max(1, fob * 0.01):
                add("sb_value_mismatch",
                    f"The shipping bill FOB is ${to_fixed(float(source['sb_value_usd']), 2)} but the invoice FOB is ${to_fixed(fob, 2)}.")
    if source["export_scheme"] == "igst":
        expected = money(float(source["total_usd"]) * DIAMOND_GST_RATE / 100)
        if abs(float(source["igst_usd"]) - expected) > 1:
            add("igst_amount",
                f"IGST at {DIAMOND_GST_RATE}% should be about ${to_fixed(expected, 2)}, but ${to_fixed(float(source['igst_usd']), 2)} is recorded.")
    if einvoice_required and not source["irn"]:
        add("irn_missing", "No e-invoice IRN recorded. Generate it on the portal and enter it here.")
    return issues


def gst_date(value: str, separator: str) -> str:
    year, month, day = value.split("-")
    return separator.join([day, month, year])


def inr(usd: float, rate: float) -> float:
    return money(usd * rate)


def gstr1_invoice(source: dict) -> dict:
    rate = exchange_rate(source)
    total = float(source["total_usd"])
    return {
        "inum": source["invoice_number"],
        "idt": gst_date(source["invoice_date"], "-"),
        "val": inr(total, rate),
        "sbpcode": source["port_code"],
        "sbnum": source["shipping_bill_no"],
        "sbdt": gst_date(source["shipping_bill_date"], "-") if source["shipping_bill_date"] else "",
        "itms": [{
            "txval": inr(total, rate),
            "rt": DIAMOND_GST_RATE,
            "iamt": inr(float(source["igst_usd"]), rate) if source["export_scheme"] == "igst" else 0,
            "csamt": 0,
        }],
    }


def _pin(value: str) -> int | None:
    digits = re.sub(r"\D", "", value)
    return int(digits) if len(digits) == 6 else None


def _or_undefined(value):
    return value if value else UNDEFINED


def einvoice_payload(source: dict) -> dict:
    invoice = source["data"]
    rate = exchange_rate(source)
    with_igst = source["export_scheme"] == "igst"
    total = float(source["total_usd"])
    items = []
    for index, item in enumerate(invoice["items"]):
        amount = inr(item["totalAmount"], rate)
        share = item["totalAmount"] / total if total > 0 else 0
        igst = inr(float(source["igst_usd"]) * share, rate) if with_igst else 0
        items.append({
            "SlNo": str(index + 1),
            "PrdDesc": item["description"][:300],
            "IsServc": "N",
            "HsnCd": re.sub(r"\D", "", item["hsCode"])[:8],
            "Qty": float(to_fixed(item["carats"], 3)),
            "Unit": "OTH",
            "UnitPrice": inr(item["ratePerCarat"], rate),
            "TotAmt": amount,
            "AssAmt": amount,
            "GstRt": DIAMOND_GST_RATE,
            "IgstAmt": igst,
            "TotItemVal": money(amount + igst),
        })
    assessable = igst_total = 0.0
    for item in items:
        assessable += item["AssAmt"]
    for item in items:
        igst_total += item["IgstAmt"]
    assessable, igst_total = money(assessable), money(igst_total)
    other = inr((invoice.get("freightUsd") or 0) + (invoice.get("insuranceUsd") or 0) + (invoice.get("otherChargesUsd") or 0), rate)
    shipment, consignee, exporter = invoice["shipment"], invoice["consignee"], invoice["exporter"]
    country = (shipment.get("countryOfDestination") or consignee.get("country") or "").strip().upper()
    return {
        "Version": "1.1",
        "TranDtls": {"TaxSch": "GST", "SupTyp": "EXPWP" if with_igst else "EXPWOP", "RegRev": "N", "IgstOnIntra": "N"},
        "DocDtls": {"Typ": "INV", "No": source["invoice_number"], "Dt": gst_date(source["invoice_date"], "/")},
        "SellerDtls": {
            "Gstin": exporter["gstin"],
            "LglNm": exporter["companyName"],
            "Addr1": exporter["addressLine1"][:100],
            "Addr2": _or_undefined(exporter["addressLine2"][:100]),
            "Loc": exporter["city"],
            "Pin": _pin(exporter["pincode"]),
            "Stcd": exporter["stateCode"],
            "Em": _or_undefined(exporter["email"]),
        },
        "BuyerDtls": {
            "Gstin": "URP",
            "LglNm": consignee["companyName"],
            "Pos": "96",
            "Addr1": consignee["addressLine1"][:100],
            "Loc": consignee["city"] or country,
            "Pin": 999999,
            "Stcd": "96",
        },
        "ItemList": items,
        "ValDtls": {
            "AssVal": assessable,
            "IgstVal": igst_total,
            "OthChrg": other,
            "TotInvVal": money(assessable + igst_total + other),
            "TotInvValFc": money(total),
        },
        "ExpDtls": {
            "ShipBNo": _or_undefined(source["shipping_bill_no"]),
            "ShipBDt": gst_date(source["shipping_bill_date"], "/") if source["shipping_bill_date"] else UNDEFINED,
            "Port": _or_undefined(source["port_code"]),
            "RefClm": "Y" if with_igst else "N",
            "ForCur": "USD",
            "CntCode": COUNTRY_CODES.get(country, UNDEFINED),
        },
    }


def organization_issues(sources: list[dict]) -> list[dict]:
    if not sources:
        return []
    gstin = (sources[0]["data"].get("exporter", {}).get("gstin") or "").strip()
    if not GSTIN_PATTERN.match(gstin):
        return [{"code": "gstin", "message": f'The company GSTIN "{gstin}" is not a valid 15-character GSTIN.'}]
    return []


async def filing_summary(pool: Pool, organization_id: str, month: str) -> dict:
    settings = await tax_settings(pool, organization_id)
    sources = await filing_sources(pool, organization_id, month)
    rows = []
    for source in sources:
        issues = filing_issues(source, settings["einvoiceRequired"])
        rows.append({
            "id": source["id"],
            "invoiceNumber": source["invoice_number"],
            "invoiceDate": source["invoice_date"],
            "exportScheme": source["export_scheme"],
            "shippingBillNo": source["shipping_bill_no"],
            "irn": source["irn"] or "",
            "issues": issues,
            "ready": not issues,
        })
    return {"sources": sources, "rows": rows, "settings": settings, "companyIssues": organization_issues(sources)}


def _month(request: Request) -> str:
    return parse_month(request.query_params.get("month")) or current_month()


def build_router():
    router = api_router()

    @router.get("/api/tax/filing-check")
    async def filing_check(request: Request, user: CurrentUser = Depends(tax_reader)):
        month = _month(request)
        summary = await filing_summary(request.app.state.pool, user.organization_id, month)
        rows = summary["rows"]
        return {
            "month": month,
            "einvoiceRequired": summary["settings"]["einvoiceRequired"],
            "companyIssues": summary["companyIssues"],
            "rows": rows,
            "readyCount": sum(1 for r in rows if r["ready"]),
            "issueCount": sum(1 for r in rows if not r["ready"]),
        }

    @router.get("/api/tax/gstr1-6a")
    async def gstr1(request: Request, user: CurrentUser = Depends(tax_reader)):
        month = _month(request)
        summary = await filing_summary(request.app.state.pool, user.organization_id, month)
        sources = summary["sources"]
        ready = {r["id"] for r in summary["rows"] if r["ready"]}
        included = [s for s in sources if s["id"] in ready]
        year, month_number = month.split("-")
        groups = [
            {"exp_typ": "WPAY", "inv": [gstr1_invoice(s) for s in included if s["export_scheme"] == "igst"]},
            {"exp_typ": "WOPAY", "inv": [gstr1_invoice(s) for s in included if s["export_scheme"] == "lut"]},
        ]
        payload = {
            "gstin": sources[0]["data"].get("exporter", {}).get("gstin", "") if sources else "",
            "fp": f"{month_number}{year}",
            "exp": [g for g in groups if g["inv"]],
        }
        response = download_response(f"gstr1-6a-{month}.json", "application/json", js_json(payload, 2))
        response.headers["X-Left-Out"] = str(len(sources) - len(included))
        return response

    @router.get("/api/tax/einvoice-batch")
    async def einvoice_batch(request: Request, user: CurrentUser = Depends(tax_reader)):
        month = _month(request)
        sources = (await filing_summary(request.app.state.pool, user.organization_id, month))["sources"]
        pending = [s for s in sources if not s["irn"] and DOCUMENT_NUMBER_PATTERN.match(s["invoice_number"].strip())]
        return download_response(f"einvoice-{month}.json", "application/json", js_json([einvoice_payload(s) for s in pending], 2))

    @router.get("/api/invoices/{invoice_id}/einvoice.json")
    async def einvoice_json(invoice_id: str, request: Request, user: CurrentUser = Depends(tax_reader)):
        if not is_uuid(invoice_id):
            raise ApiError(404, "Invoice not found.")
        row = await request.app.state.pool.fetchrow(
            f"{FILING_SQL} WHERE i.id = $1 AND i.organization_id = $2 AND i.status <> 'draft'", invoice_id, user.organization_id
        )
        if not row:
            raise ApiError(404, "Issue the invoice before generating its e-invoice.")
        source = dict(row)
        safe_name = re.sub(r"[^\w-]+", "-", source["invoice_number"], flags=re.ASCII)
        return download_response(f"einvoice-{safe_name}.json", "application/json", js_json(einvoice_payload(source), 2))

    @router.put("/api/invoices/{invoice_id}/einvoice")
    async def record_einvoice(invoice_id: str, request: Request, user: CurrentUser = Depends(tax_writer)):
        if not is_uuid(invoice_id):
            raise ApiError(404, "Invoice not found.")
        pool: Pool = request.app.state.pool
        invoice_date = await invoice_date_of(pool, user.organization_id, invoice_id)
        if invoice_date is False:
            raise ApiError(404, "Invoice not found.")
        closed = await closed_month_message(pool, user.organization_id, invoice_date)
        if closed:
            raise ApiError(409, closed)
        data = body(request)
        irn = data["irn"].strip().lower() if isinstance(data.get("irn"), str) else ""
        if not re.match(r"^[0-9a-f]{64}$", irn):
            raise ApiError(400, "The IRN is the 64-character code the portal returns.")
        ack_no = data["ackNo"].strip()[:20] if isinstance(data.get("ackNo"), str) else ""
        if ack_no and not re.match(r"^\d{1,20}$", ack_no):
            raise ApiError(400, "The acknowledgement number is digits only.")
        ack_date = data["ackDate"] if isinstance(data.get("ackDate"), str) and data["ackDate"] else None
        ack_value = None
        if ack_date:
            try:
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", ack_date):
                    raise ValueError
                ack_value = date.fromisoformat(ack_date)
            except ValueError:
                raise ApiError(400, "Enter the acknowledgement date as YYYY-MM-DD.") from None
        await pool.execute(
            """INSERT INTO invoice_einvoices (invoice_id, organization_id, irn, ack_no, ack_date, recorded_by)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (invoice_id) DO UPDATE SET irn = EXCLUDED.irn, ack_no = EXCLUDED.ack_no, ack_date = EXCLUDED.ack_date,
                 recorded_by = EXCLUDED.recorded_by, recorded_at = now()""",
            invoice_id, user.organization_id, irn, ack_no, ack_value, user.id,
        )
        return {"irn": irn, "ackNo": ack_no, "ackDate": ack_date or ""}

    return router

