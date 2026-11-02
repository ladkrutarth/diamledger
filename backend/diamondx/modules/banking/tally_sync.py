"""Tally import (XML or Day Book CSV) and reconciliation with the app (port of server/modules/banking/tallySync.ts)."""

from __future__ import annotations

import asyncio
import hashlib
import re
from datetime import date

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import days_between, document_key, parse_loose_date
from ...core.http import ApiError, CurrentUser, body
from ...core.numbers import js_number, money, to_fixed
from ..tax.export_reports import month_range
from ..tax.shared import csv_file, csv_response, find_column, parse_csv, tax_manager, tax_reader, tax_writer

MAX_TALLY_VOUCHERS = 5000
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def voucher_kind(voucher_type: str) -> str:
    kind = voucher_type.lower()
    if "sales" in kind or "export" in kind:
        return "sales"
    if "receipt" in kind:
        return "receipt"
    if "purchase" in kind or "import" in kind:
        return "purchase"
    return "other"


def _decode_xml(value: str) -> str:
    value = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", r"\1", value)
    value = value.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'")
    value = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), value)
    return value.replace("&amp;", "&").strip()


def _tag(xml: str, name: str) -> str:
    match = re.search(rf"<{name}(?:\s[^>]*)?>([\s\S]*?)</{name}>", xml, re.IGNORECASE)
    return _decode_xml(match.group(1)) if match else ""


def parse_tally_amount(raw: str) -> dict | None:
    """A Tally amount: "-$ 1,250.00 @ ₹ 86.50/$ = -₹ 1,08,125.00" or "-108125.00". Both amounts are returned positive."""
    text = raw.replace(",", "").strip()
    if not text:
        return None

    def number(value: str) -> float | None:
        match = re.search(r"-?\d+(?:\.\d+)?", value)
        return abs(float(match.group(0))) if match else None

    if "=" in text:
        foreign, base = text.split("=")[:2]
        inr = number(base)
        if inr is None:
            return None
        return {"inr": money(inr), "usd": money(number(foreign.split("@")[0]) or 0) if "$" in foreign else None}
    if "$" in text:
        usd = number(text)
        return None if usd is None else {"inr": 0, "usd": money(usd)}
    inr = number(text)
    return None if inr is None else {"inr": money(inr), "usd": None}


def parse_tally_date(raw: str) -> str | None:
    value = raw.strip()
    if re.match(r"^\d{8}$", value):
        return parse_loose_date(f"{value[:4]}-{value[4:6]}-{value[6:8]}")
    named = re.match(r"^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$", value)
    if named:
        month = MONTHS.index(named.group(2).lower()) + 1 if named.group(2).lower() in MONTHS else 0
        year = 2000 + int(named.group(3)) if len(named.group(3)) == 2 else int(named.group(3))
        if month > 0:
            return parse_loose_date(f"{year}-{month}-{named.group(1)}")
    return parse_loose_date(value)


def parse_tally_xml(xml: str) -> list[dict]:
    """Vouchers from a Tally XML export (Day Book or Vouchers)."""
    vouchers = []
    for match in re.finditer(r"<VOUCHER\b([^>]*)>([\s\S]*?)</VOUCHER>", xml, re.IGNORECASE):
        attributes, content = match.group(1), match.group(2)
        day = parse_tally_date(_tag(content, "DATE"))
        if not day:
            continue
        type_attr = re.search(r'VCHTYPE="([^"]*)"', attributes, re.IGNORECASE)
        voucher_type = _tag(content, "VOUCHERTYPENAME") or (type_attr.group(1) if type_attr else "")
        party = _tag(content, "PARTYLEDGERNAME") or _tag(content, "PARTYNAME")
        entries = []
        for entry in re.finditer(r"<(ALLLEDGERENTRIES|LEDGERENTRIES)\.LIST>([\s\S]*?)</\1\.LIST>", content, re.IGNORECASE):
            amount = parse_tally_amount(_tag(entry.group(2), "AMOUNT"))
            base = parse_tally_amount(_tag(entry.group(2), "BASEAMOUNT"))
            # Foreign currency entries can carry the rupee value separately in BASEAMOUNT.
            if amount and amount["inr"] == 0 and base:
                amount["inr"] = base["inr"]
            entries.append({"ledger": _tag(entry.group(2), "LEDGERNAME"), "amount": amount or base})
        party_entry = next((e for e in entries if party and e["ledger"].lower() == party.lower()), None)
        largest = None
        for entry in entries:
            if entry["amount"] and (largest is None or entry["amount"]["inr"] > largest["inr"]):
                largest = entry["amount"]
        amount = (party_entry["amount"] if party_entry else None) or largest
        vouchers.append({
            "date": day,
            "voucherType": voucher_type,
            "kind": voucher_kind(voucher_type),
            "number": _tag(content, "VOUCHERNUMBER"),
            "party": party,
            "reference": _tag(content, "REFERENCE"),
            "amountInr": amount["inr"] if amount else 0,
            "amountUsd": amount["usd"] if amount else None,
            "narration": _tag(content, "NARRATION")[:1000],
        })
    return vouchers


def parse_tally_csv(text: str) -> list[dict] | str:
    """Vouchers from a Day Book exported to Excel and saved as CSV."""
    rows = parse_csv(text)
    header_index = next(
        (i for i, row in enumerate(rows) if find_column(row, ["date"]) >= 0 and find_column(row, ["vch type", "voucher type"]) >= 0), -1
    )
    if header_index < 0:
        return "The CSV needs Date and Vch Type columns, as in the Tally Day Book export."
    header = rows[header_index]

    def col(names: list[str]) -> int:
        return find_column(header, names)

    date_col, type_col = col(["date"]), col(["vch type", "voucher type"])
    number_col = col(["vch no", "voucher no", "voucher number", "vch no."])
    party_col = col(["particulars", "party", "party name", "ledger"])
    debit_col, credit_col = col(["debit", "debit amount", "debit amt"]), col(["credit", "credit amount", "credit amt"])
    amount_col = col(["amount", "value"])
    ref_col, narration_col = col(["reference", "ref", "reference no"]), col(["narration", "remarks"])
    vouchers = []
    for cells in rows[header_index + 1:]:
        def cell(index: int) -> str:
            return cells[index].strip() if 0 <= index < len(cells) else ""

        day = parse_tally_date(cell(date_col))
        if not day:
            continue
        amounts = []
        for value in (cell(debit_col), cell(credit_col), cell(amount_col)):
            parsed = parse_tally_amount(value)
            amounts.append(parsed["inr"] if parsed else 0)
        voucher_type = cell(type_col)
        vouchers.append({
            "date": day,
            "voucherType": voucher_type,
            "kind": voucher_kind(voucher_type),
            "number": cell(number_col),
            "party": cell(party_col),
            "reference": cell(ref_col),
            "amountInr": max(amounts),
            "amountUsd": None,
            "narration": cell(narration_col)[:1000],
        })
    return vouchers


def fingerprint(voucher: dict) -> str:
    parts = [voucher["date"], voucher["voucherType"].lower(), voucher["number"].upper(), voucher["party"].lower(), to_fixed(voucher["amountInr"], 2)]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def close_enough(a: float, b: float) -> bool:
    return abs(a - b) <= max(1, abs(b) * 0.005)


STATUS_ORDER = {"amount_differs": 0, "missing_in_tally": 1, "missing_in_app": 2, "date_differs": 3, "matched": 4}


def _inr(value: float) -> str:
    return f"₹{to_fixed(value, 2)}"


async def tally_reconcile(pool: Pool, organization_id: str, start: date, end: date) -> dict:
    """Compares the app with the vouchers imported from Tally, for sales, receipts, and purchases."""
    voucher_rows, invoice_rows, payment_rows, purchase_rows = await asyncio.gather(
        pool.fetch(
            """SELECT id, to_char(voucher_date, 'YYYY-MM-DD') AS voucher_date, voucher_type, voucher_kind, voucher_number, party, reference,
                      amount_inr, amount_usd, narration
               FROM tally_vouchers WHERE organization_id = $1 AND voucher_date BETWEEN ($2::date - 31) AND ($3::date + 31)""",
            organization_id, start, end,
        ),
        pool.fetch(
            """SELECT id, invoice_number, to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date, buyer_name, total_usd,
                      data->>'exchangeRateInr' AS rate
               FROM invoices WHERE organization_id = $1 AND status IN ('issued', 'paid') AND COALESCE(invoice_date, created_at::date) BETWEEN $2 AND $3""",
            organization_id, start, end,
        ),
        pool.fetch(
            """SELECT p.id, p.invoice_id, i.invoice_number, i.buyer_name, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd, p.bank_rate_inr
               FROM payments p JOIN invoices i ON i.id = p.invoice_id
               WHERE p.organization_id = $1 AND p.paid_on BETWEEN $2 AND $3""",
            organization_id, start, end,
        ),
        pool.fetch(
            """SELECT id, document_no, supplier_name, to_char(document_date, 'YYYY-MM-DD') AS document_date,
                      taxable_inr + igst_inr + cgst_inr + sgst_inr AS total_inr, taxable_inr
               FROM purchases WHERE organization_id = $1 AND document_date BETWEEN $2 AND $3""",
            organization_id, start, end,
        ),
    )
    start_iso, end_iso = start.isoformat(), end.isoformat()
    vouchers = [
        {"id": r["id"], "date": r["voucher_date"], "kind": r["voucher_kind"], "voucherType": r["voucher_type"], "number": r["voucher_number"],
         "party": r["party"], "reference": r["reference"], "amountInr": money(r["amount_inr"]),
         "amountUsd": None if r["amount_usd"] is None else money(r["amount_usd"]), "narration": r["narration"]}
        for r in voucher_rows
    ]
    used: set[str] = set()
    rows: list[dict] = []

    def tally_text(voucher: dict) -> str:
        return f"USD {to_fixed(voucher['amountUsd'], 2)}" if voucher["amountUsd"] is not None else _inr(voucher["amountInr"])

    # Sales: voucher number is the invoice number.
    sales = [v for v in vouchers if v["kind"] == "sales"]
    for invoice in invoice_rows:
        key = document_key(invoice["invoice_number"])
        voucher = next((v for v in sales if v["id"] not in used and document_key(v["number"]) == key), None)
        total_usd = money(invoice["total_usd"])
        raw_rate = js_number(invoice["rate"]) if invoice["rate"] is not None else 0
        rate = raw_rate if raw_rate > 0 else None
        app_inr = money(total_usd * rate) if rate else None
        base = {"area": "sales", "reference": invoice["invoice_number"], "party": invoice["buyer_name"], "appDate": invoice["invoice_date"],
                "invoiceId": invoice["id"], "appAmount": f"USD {to_fixed(total_usd, 2)}" + (f" ({_inr(app_inr)})" if app_inr else "")}
        if not voucher:
            rows.append({**base, "status": "missing_in_tally", "tallyDate": None, "tallyAmount": "",
                         "detail": "Issued in the app but no sales voucher with this number in Tally."})
            continue
        used.add(voucher["id"])
        tally_amount = (f"USD {to_fixed(voucher['amountUsd'], 2)} ({_inr(voucher['amountInr'])})" if voucher["amountUsd"] is not None
                        else _inr(voucher["amountInr"]))
        if voucher["amountUsd"] is not None and voucher["amountUsd"] > 0:
            amount_ok = close_enough(voucher["amountUsd"], total_usd)
        else:
            amount_ok = app_inr is not None and close_enough(voucher["amountInr"], app_inr)
        status = "amount_differs" if not amount_ok else "date_differs" if voucher["date"] != invoice["invoice_date"] else "matched"
        if status == "amount_differs":
            detail = ("The invoice has no exchange rate, so the rupee value cannot be compared."
                      if app_inr is None and voucher["amountUsd"] is None else "Amounts differ.")
        elif status == "date_differs":
            detail = "Dates differ; this can move the sale into another month or return."
        else:
            detail = ""
        rows.append({**base, "status": status, "tallyDate": voucher["date"], "tallyAmount": tally_amount, "detail": detail})

    # Receipts: same date (within 3 days), and the dollar or rupee amount agrees.
    receipts = [v for v in vouchers if v["kind"] == "receipt"]
    for payment in payment_rows:
        amount_usd = money(payment["amount_usd"])
        bank_inr = money(amount_usd * float(payment["bank_rate_inr"])) if payment["bank_rate_inr"] else None
        key = document_key(payment["invoice_number"])
        candidates = [v for v in receipts if v["id"] not in used and abs(days_between(payment["paid_on"], v["date"])) <= 3]

        def amount_matches(v: dict) -> bool:
            return (v["amountUsd"] is not None and close_enough(v["amountUsd"], amount_usd)) or (
                bank_inr is not None and close_enough(v["amountInr"], bank_inr))

        voucher = (
            next((v for v in candidates if amount_matches(v) and (document_key(v["reference"]) == key or key in document_key(v["narration"]))), None)
            or next((v for v in candidates if amount_matches(v) and v["party"].lower() == payment["buyer_name"].lower()), None)
            or next((v for v in candidates if amount_matches(v)), None)
        )
        base = {"area": "receipts", "reference": payment["invoice_number"], "party": payment["buyer_name"], "appDate": payment["paid_on"],
                "invoiceId": payment["invoice_id"], "appAmount": f"USD {to_fixed(amount_usd, 2)}" + (f" ({_inr(bank_inr)})" if bank_inr else "")}
        if not voucher:
            rows.append({**base, "status": "missing_in_tally", "tallyDate": None, "tallyAmount": "",
                         "detail": "Payment recorded in the app but no matching receipt voucher in Tally."})
            continue
        used.add(voucher["id"])
        rows.append({**base, "status": "matched" if voucher["date"] == payment["paid_on"] else "date_differs", "tallyDate": voucher["date"],
                     "tallyAmount": tally_text(voucher), "detail": ""})

    # Purchases: voucher number or reference is the supplier invoice / Bill of Entry number.
    purchase_vouchers = [v for v in vouchers if v["kind"] == "purchase"]
    for purchase in purchase_rows:
        key = document_key(purchase["document_no"])
        voucher = next((v for v in purchase_vouchers if v["id"] not in used and (document_key(v["reference"]) == key or document_key(v["number"]) == key)), None)
        total, taxable = money(purchase["total_inr"]), money(purchase["taxable_inr"])
        base = {"area": "purchases", "reference": purchase["document_no"], "party": purchase["supplier_name"], "appDate": purchase["document_date"],
                "invoiceId": None, "appAmount": _inr(total)}
        if not voucher:
            rows.append({**base, "status": "missing_in_tally", "tallyDate": None, "tallyAmount": "", "detail": "Purchase recorded in the app but not in Tally."})
            continue
        used.add(voucher["id"])
        amount_ok = close_enough(voucher["amountInr"], total) or close_enough(voucher["amountInr"], taxable)
        status = ("matched" if voucher["date"] == purchase["document_date"] else "date_differs") if amount_ok else "amount_differs"
        rows.append({**base, "status": status, "tallyDate": voucher["date"], "tallyAmount": _inr(voucher["amountInr"]),
                     "detail": "" if amount_ok else "Amounts differ."})

    def in_range(day: str) -> bool:
        return start_iso <= day <= end_iso

    for voucher in vouchers:
        if voucher["id"] in used or voucher["kind"] == "other" or not in_range(voucher["date"]):
            continue
        rows.append({
            "area": "sales" if voucher["kind"] == "sales" else "receipts" if voucher["kind"] == "receipt" else "purchases",
            "status": "missing_in_app",
            "reference": voucher["number"] or voucher["reference"],
            "party": voucher["party"],
            "appDate": None,
            "tallyDate": voucher["date"],
            "appAmount": "",
            "tallyAmount": tally_text(voucher),
            "invoiceId": None,
            "detail": f"{voucher['voucherType']} voucher in Tally with nothing matching in the app.",
        })

    rows.sort(key=lambda r: (r["area"], STATUS_ORDER[r["status"]], r["appDate"] or r["tallyDate"] or ""))

    def count(status: str) -> int:
        return sum(1 for r in rows if r["status"] == status)

    return {
        "rows": rows,
        "vouchersImported": sum(1 for v in vouchers if in_range(v["date"])),
        "totals": {"matched": count("matched"), "amountDiffers": count("amount_differs"), "dateDiffers": count("date_differs"),
                   "missingInTally": count("missing_in_tally"), "missingInApp": count("missing_in_app")},
    }


def build_router():
    router = api_router(prefix="/api/tally")

    @router.post("/import")
    async def import_tally(request: Request, user: CurrentUser = Depends(tax_writer)):
        data = body(request)
        content = data["content"] if isinstance(data.get("content"), str) else ""
        if not content.strip():
            raise ApiError(400, "Choose a Tally export file (XML or CSV).")
        parsed = parse_tally_xml(content) if re.search(r"<ENVELOPE|<VOUCHER", content, re.IGNORECASE) else parse_tally_csv(content)
        if isinstance(parsed, str):
            raise ApiError(400, parsed)
        if not parsed:
            raise ApiError(400, "No vouchers were found in that file.")
        if len(parsed) > MAX_TALLY_VOUCHERS:
            raise ApiError(400, f"Import at most {MAX_TALLY_VOUCHERS} vouchers at a time.")
        pool: Pool = request.app.state.pool
        imported = 0
        for v in parsed:
            result = await pool.execute(
                """INSERT INTO tally_vouchers (organization_id, voucher_date, voucher_type, voucher_kind, voucher_number, party, reference,
                     amount_inr, amount_usd, narration, fingerprint)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (organization_id, fingerprint) DO NOTHING""",
                user.organization_id, date.fromisoformat(v["date"]), v["voucherType"][:100], v["kind"], v["number"][:100], v["party"][:200],
                v["reference"][:100], v["amountInr"], v["amountUsd"], v["narration"], fingerprint(v),
            )
            if result != "INSERT 0 0":
                imported += 1
        return JSONResponse({"read": len(parsed), "imported": imported, "duplicates": len(parsed) - imported}, status_code=201)

    @router.get("/reconcile")
    async def reconcile(request: Request, user: CurrentUser = Depends(tax_reader)):
        r = month_range(request)
        return {"from": r["from"], "to": r["to"], **(await tally_reconcile(request.app.state.pool, user.organization_id, r["start"], r["end"]))}

    @router.get("/reconcile/csv")
    async def reconcile_csv(request: Request, user: CurrentUser = Depends(tax_reader)):
        r = month_range(request)
        report = await tally_reconcile(request.app.state.pool, user.organization_id, r["start"], r["end"])
        body_csv = csv_file(
            ["Area", "Status", "Reference", "Party", "App date", "Tally date", "App amount", "Tally amount", "Detail"],
            [[row["area"], row["status"].replace("_", " "), row["reference"], row["party"], row["appDate"] or "", row["tallyDate"] or "",
              row["appAmount"], row["tallyAmount"], row["detail"]] for row in report["rows"]],
        )
        return csv_response(f"tally-reconciliation-{r['from']}-to-{r['to']}.csv", body_csv)

    @router.delete("/vouchers")
    async def delete_vouchers(request: Request, user: CurrentUser = Depends(tax_manager)):
        r = month_range(request)
        result = await request.app.state.pool.execute(
            "DELETE FROM tally_vouchers WHERE organization_id = $1 AND voucher_date BETWEEN $2 AND $3", user.organization_id, r["start"], r["end"]
        )
        return {"deleted": int(result.rsplit(" ", 1)[-1])}

    return router
