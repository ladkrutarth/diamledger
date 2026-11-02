"""GST refund statement, Kimberley Process register and certificate check (port of server/modules/tax/exportReports.ts)."""

from __future__ import annotations

import calendar
import re
from datetime import date
from urllib.parse import quote

from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import CurrentUser
from ...core.numbers import js_number, money, round_to, to_fixed
from .closed_months import parse_month
from .shared import csv_file, csv_response, is_rough_hs_code, tax_reader

INVOICE_DATE = "COALESCE(i.invoice_date, i.created_at::date)"


def month_range(request: Request) -> dict:
    """From and to months (YYYY-MM). Defaults to the current Indian financial year up to this month."""
    today = date.today()
    this_month = today.strftime("%Y-%m")
    fy_start = today.year if today.month >= 4 else today.year - 1
    start_month = parse_month(request.query_params.get("from")) or f"{fy_start}-04"
    end_month = parse_month(request.query_params.get("to")) or this_month
    if start_month > end_month:
        start_month, end_month = end_month, start_month
    year, month = (int(part) for part in end_month.split("-"))
    last_day = calendar.monthrange(year, month)[1]
    return {
        "from": start_month,
        "to": end_month,
        "start": date.fromisoformat(f"{start_month}-01"),
        "end": date(year, month, last_day),
    }


def _number_or_zero(value) -> float:
    number = js_number(value)
    return number if number == number else 0.0


def _total(rows: list, key) -> float:
    total = 0.0
    for row in rows:
        total += key(row)
    return total


# --- GST refund (zero-rated exports under LUT) ------------------------------------------------------


async def refund_summary(pool: Pool, organization_id: str, start: date, end: date) -> dict:
    records = await pool.fetch(
        f"""SELECT i.id, i.invoice_number, to_char({INVOICE_DATE}, 'YYYY-MM-DD') AS invoice_date, i.buyer_name, i.destination_country,
                   i.total_usd, i.data->>'exchangeRateInr' AS rate_inr,
                   COALESCE(t.shipping_bill_no, '') AS shipping_bill_no, to_char(t.shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date,
                   COALESCE(t.port_code, '') AS port_code, t.sb_value_usd,
                   b.brc_number, to_char(b.realised_on, 'YYYY-MM-DD') AS realised_on, b.amount_usd AS brc_usd
            FROM invoices i
            LEFT JOIN invoice_tax t ON t.invoice_id = i.id
            LEFT JOIN invoice_brcs b ON b.invoice_id = i.id
            WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid')
              AND COALESCE(t.export_scheme, 'lut') = 'lut'
              AND {INVOICE_DATE} BETWEEN $2 AND $3
            ORDER BY {INVOICE_DATE}, i.invoice_number""",
        organization_id, start, end,
    )
    rows = []
    for r in records:
        raw_rate = js_number(r["rate_inr"]) if r["rate_inr"] is not None else 0
        rate = raw_rate if raw_rate > 0 else None
        total_usd = money(r["total_usd"])
        fob_usd = None if r["sb_value_usd"] is None else money(r["sb_value_usd"])
        issues = []
        if not r["shipping_bill_no"] or not r["shipping_bill_date"]:
            issues.append("Shipping bill number or date missing")
        if not r["port_code"]:
            issues.append("Port code missing")
        if not rate:
            issues.append("Exchange rate missing on the invoice")
        if not r["brc_number"]:
            issues.append("No BRC / e-BRC recorded yet")
        rows.append({
            "invoiceId": r["id"],
            "invoiceNumber": r["invoice_number"],
            "invoiceDate": r["invoice_date"],
            "buyerName": r["buyer_name"],
            "destinationCountry": r["destination_country"],
            "totalUsd": total_usd,
            "exchangeRateInr": rate,
            "valueInr": money(total_usd * rate) if rate else None,
            "shippingBillNo": r["shipping_bill_no"],
            "shippingBillDate": r["shipping_bill_date"],
            "portCode": r["port_code"],
            "fobUsd": fob_usd,
            "fobInr": money(fob_usd * rate) if rate and fob_usd is not None else None,
            "brcNumber": r["brc_number"] or "",
            "brcDate": r["realised_on"] or "",
            "brcUsd": None if r["brc_usd"] is None else money(r["brc_usd"]),
            "issues": issues,
            "ready": not issues,
        })
    ready = [row for row in rows if row["ready"]]

    def fob_or_value(row: dict) -> float:
        if row["fobInr"] is not None:
            return row["fobInr"]
        return row["valueInr"] if row["valueInr"] is not None else 0

    return {
        "rows": rows,
        "totals": {
            "invoices": len(rows),
            "ready": len(ready),
            "valueUsd": money(_total(rows, lambda row: row["totalUsd"])),
            "readyValueInr": money(_total(ready, lambda row: row["valueInr"] or 0)),
            "readyFobInr": money(_total(ready, fob_or_value)),
        },
    }


# --- Line items (certificates and Kimberley Process) ------------------------------------------------


async def invoice_items(pool: Pool, organization_id: str, start: date, end: date):
    return await pool.fetch(
        f"""SELECT i.id, i.invoice_number, to_char({INVOICE_DATE}, 'YYYY-MM-DD') AS invoice_date, i.buyer_name, i.destination_country,
                   i.status, i.total_usd, i.total_carats, COALESCE(i.data->'shipment'->>'kpcsNumber', '') AS kpcs_number,
                   i.data->'items' AS items
            FROM invoices i
            WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND {INVOICE_DATE} BETWEEN $2 AND $3
            ORDER BY {INVOICE_DATE}, i.invoice_number""",
        organization_id, start, end,
    )


def _text(value) -> str:
    return "" if value is None else (value if isinstance(value, str) else str(value))


async def kp_register(pool: Pool, organization_id: str, start: date, end: date) -> dict:
    invoices = await invoice_items(pool, organization_id, start, end)
    seen: dict[str, list[str]] = {}
    for invoice in invoices:
        kpc = invoice["kpcs_number"].strip().upper()
        if kpc:
            seen.setdefault(kpc, []).append(invoice["invoice_number"])
    rows = []
    for invoice in invoices:
        items = invoice["items"] if isinstance(invoice["items"], list) else []
        hs_codes = list(dict.fromkeys(code for code in (_text(item.get("hsCode")).strip() for item in items) if code))
        rough_carats = _total([i for i in items if is_rough_hs_code(_text(i.get("hsCode")))], lambda item: _number_or_zero(item.get("carats")))
        kpc = invoice["kpcs_number"].strip()
        issues = []
        if rough_carats > 0 and not kpc:
            issues.append("Rough diamonds without a KP certificate number")
        shared = [n for n in seen.get(kpc.upper(), []) if n != invoice["invoice_number"]] if kpc else []
        if shared:
            issues.append(f"Same KP certificate as {', '.join(shared)}")
        rows.append({
            "invoiceId": invoice["id"],
            "invoiceNumber": invoice["invoice_number"],
            "invoiceDate": invoice["invoice_date"],
            "buyerName": invoice["buyer_name"],
            "destinationCountry": invoice["destination_country"],
            "kpcNumber": kpc,
            "hsCodes": hs_codes,
            "carats": round_to(float(invoice["total_carats"]), 3),
            "roughCarats": round_to(rough_carats, 3),
            "valueUsd": money(invoice["total_usd"]),
            "issues": issues,
        })
    return {
        "rows": rows,
        "totals": {
            "shipments": len(rows),
            "withKpc": sum(1 for row in rows if row["kpcNumber"]),
            "roughCarats": round_to(_total(rows, lambda row: row["roughCarats"]), 3),
            "carats": round_to(_total(rows, lambda row: row["carats"]), 3),
            "issues": sum(1 for row in rows if row["issues"]),
        },
    }


def guess_lab(certificate_no: str, description: str) -> str:
    text = f"{certificate_no} {description}".upper()
    if re.search(r"\bGIA\b", text):
        return "GIA"
    if re.search(r"\bIGI\b", text) or re.match(r"^LG\d+", certificate_no.upper()):
        return "IGI"
    if re.search(r"\bHRD\b", text):
        return "HRD"
    if re.match(r"^\d{10}$", re.sub(r"\D", "", certificate_no)) and re.match(r"^\d+$", certificate_no.strip()):
        return "GIA"
    return ""


def verify_url(lab: str, certificate_no: str) -> str:
    number = quote(re.sub(r"^(GIA|IGI|HRD)[\s:#-]*", "", certificate_no, flags=re.IGNORECASE).strip(), safe="-_.!~*'()")
    if not number:
        return ""
    if lab == "GIA":
        return f"https://www.gia.edu/report-check?reportno={number}"
    if lab == "IGI":
        return f"https://www.igi.org/verify-your-report/?r={number}"
    return ""


async def certificate_check(pool: Pool, organization_id: str, start: date, end: date) -> dict:
    invoices = await invoice_items(pool, organization_id, start, end)
    lines = []
    for invoice in invoices:
        for index, item in enumerate(invoice["items"] if isinstance(invoice["items"], list) else []):
            sr_no = _number_or_zero(item.get("srNo"))
            lines.append({
                "invoiceId": invoice["id"],
                "invoiceNumber": invoice["invoice_number"],
                "invoiceDate": invoice["invoice_date"],
                "line": int(sr_no) if sr_no else index + 1,
                "description": _text(item.get("description")),
                "certificateNo": _text(item.get("certificateNo")).strip(),
                "hsCode": _text(item.get("hsCode")),
                "pieces": _number_or_zero(item.get("pieces")),
                "carats": _number_or_zero(item.get("carats")),
                "colorClarity": _text(item.get("colorClarity")),
                "shape": _text(item.get("shape")),
            })
    uses: dict[str, list[str]] = {}
    for line in lines:
        if line["certificateNo"]:
            uses.setdefault(line["certificateNo"].upper(), []).append(f"{line['invoiceNumber']} line {line['line']}")
    rows = []
    for line in lines:
        if is_rough_hs_code(line["hsCode"]):
            continue
        lab = guess_lab(line["certificateNo"], line["description"]) if line["certificateNo"] else ""
        issues = []
        if not line["certificateNo"]:
            if line["carats"] >= 0.3 and line["pieces"] == 1:
                issues.append({"tone": "amber", "text": "Single stone of 0.30 ct or more with no certificate"})
        else:
            here = f"{line['invoiceNumber']} line {line['line']}"
            others = [use for use in uses.get(line["certificateNo"].upper(), []) if use != here]
            if others:
                issues.append({"tone": "red", "text": f"Certificate also used on {', '.join(others)}"})
            if line["pieces"] > 1:
                pieces = int(line["pieces"]) if float(line["pieces"]).is_integer() else line["pieces"]
                issues.append({"tone": "amber", "text": f"One certificate for {pieces} pieces; a grading report covers one stone"})
            if not lab:
                issues.append({"tone": "amber", "text": "Lab not recognised; add GIA, IGI, or HRD to the description"})
        rows.append({**line, "lab": lab, "verifyUrl": verify_url(lab, line["certificateNo"]) if lab else "", "issues": issues})
    return {
        "rows": rows,
        "totals": {
            "lines": len(rows),
            "certified": sum(1 for row in rows if row["certificateNo"]),
            "duplicates": sum(1 for row in rows if any(i["tone"] == "red" for i in row["issues"])),
            "warnings": sum(1 for row in rows if any(i["tone"] == "amber" for i in row["issues"])),
        },
    }


def _fixed(value, places: int = 2) -> str:
    return "" if value is None else to_fixed(value, places)


def build_router():
    router = api_router(prefix="/api/tax")

    @router.get("/refund-summary")
    async def refund(request: Request, user: CurrentUser = Depends(tax_reader)):
        r = month_range(request)
        return {"from": r["from"], "to": r["to"], **(await refund_summary(request.app.state.pool, user.organization_id, r["start"], r["end"]))}

    @router.get("/refund-summary/csv")
    async def refund_csv(request: Request, user: CurrentUser = Depends(tax_reader)):
        r = month_range(request)
        rows = (await refund_summary(request.app.state.pool, user.organization_id, r["start"], r["end"]))["rows"]
        body = csv_file(
            ["Invoice no", "Invoice date", "Buyer", "Destination", "Invoice value USD", "Exchange rate", "Invoice value INR",
             "Shipping bill no", "Shipping bill date", "Port code", "FOB value USD", "FOB value INR", "BRC / e-BRC no", "BRC date",
             "BRC value USD", "Ready"],
            [[row["invoiceNumber"], row["invoiceDate"], row["buyerName"], row["destinationCountry"], to_fixed(row["totalUsd"], 2),
              "" if row["exchangeRateInr"] is None else row["exchangeRateInr"], _fixed(row["valueInr"]), row["shippingBillNo"],
              row["shippingBillDate"] or "", row["portCode"], _fixed(row["fobUsd"]), _fixed(row["fobInr"]), row["brcNumber"],
              row["brcDate"], _fixed(row["brcUsd"]), "Yes" if row["ready"] else "; ".join(row["issues"])] for row in rows],
        )
        return csv_response(f"gst-refund-statement-{r['from']}-to-{r['to']}.csv", body)

    @router.get("/kp-register")
    async def kp(request: Request, user: CurrentUser = Depends(tax_reader)):
        r = month_range(request)
        return {"from": r["from"], "to": r["to"], **(await kp_register(request.app.state.pool, user.organization_id, r["start"], r["end"]))}

    @router.get("/kp-register/csv")
    async def kp_csv(request: Request, user: CurrentUser = Depends(tax_reader)):
        r = month_range(request)
        rows = (await kp_register(request.app.state.pool, user.organization_id, r["start"], r["end"]))["rows"]
        body = csv_file(
            ["Invoice no", "Date", "Buyer", "Destination", "KP certificate no", "HS codes", "Total carats", "Rough carats", "Value USD", "Issues"],
            [[row["invoiceNumber"], row["invoiceDate"], row["buyerName"], row["destinationCountry"], row["kpcNumber"], " ".join(row["hsCodes"]),
              to_fixed(row["carats"], 3), to_fixed(row["roughCarats"], 3), to_fixed(row["valueUsd"], 2), "; ".join(row["issues"])] for row in rows],
        )
        return csv_response(f"kimberley-process-register-{r['from']}-to-{r['to']}.csv", body)

    @router.get("/certificates")
    async def certificates(request: Request, user: CurrentUser = Depends(tax_reader)):
        r = month_range(request)
        return {"from": r["from"], "to": r["to"], **(await certificate_check(request.app.state.pool, user.organization_id, r["start"], r["end"]))}

    return router
