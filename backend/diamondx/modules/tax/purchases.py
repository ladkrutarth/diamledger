"""Purchase register and input tax credit matched against GSTR-2B (port of server/modules/tax/purchases.ts)."""

from __future__ import annotations

import calendar
import re
from datetime import date

import asyncpg
from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import FormError, document_key, form_reader, parse_loose_date
from ...core.http import ApiError, CurrentUser, body, is_uuid, require_user
from ...core.numbers import money, round_to, to_fixed
from .closed_months import closed_month_message, parse_month
from .export_reports import month_range
from .shared import csv_file, csv_response, find_column, parse_amount, parse_csv, tax_manager, tax_reader, tax_writer

GSTIN = re.compile(r"^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$")
MAX_2B_ROWS = 5000

PURCHASE_COLUMNS = """id, kind, supplier_name, supplier_gstin, supplier_country, document_no,
  to_char(document_date, 'YYYY-MM-DD') AS document_date, port_code, description, carats, parcel_id, taxable_inr,
  igst_inr, cgst_inr, sgst_inr, related_party, notes"""


def to_purchase(row) -> dict:
    igst, cgst, sgst = money(row["igst_inr"]), money(row["cgst_inr"]), money(row["sgst_inr"])
    return {
        "id": row["id"],
        "kind": row["kind"],
        "supplierName": row["supplier_name"],
        "supplierGstin": row["supplier_gstin"],
        "supplierCountry": row["supplier_country"],
        "documentNo": row["document_no"],
        "documentDate": row["document_date"],
        "portCode": row["port_code"],
        "description": row["description"],
        "carats": float(row["carats"]),
        "parcelId": row["parcel_id"],
        "taxableInr": money(row["taxable_inr"]),
        "igstInr": igst,
        "cgstInr": cgst,
        "sgstInr": sgst,
        "taxInr": money(igst + cgst + sgst),
        "relatedParty": row["related_party"],
        "notes": row["notes"],
    }


async def purchases_between(pool: Pool, organization_id: str, start: date, end: date) -> list[dict]:
    rows = await pool.fetch(
        f"""SELECT {PURCHASE_COLUMNS} FROM purchases
            WHERE organization_id = $1 AND document_date BETWEEN $2 AND $3
            ORDER BY document_date, supplier_name, document_no""",
        organization_id, start, end,
    )
    return [to_purchase(row) for row in rows]


def read_purchase(data: dict) -> dict:
    form = form_reader(data)
    kind = form.choice("kind", ["import", "local"])
    supplier_name = form.required("supplierName", "Enter the supplier name.", 200)
    supplier_gstin = form.text("supplierGstin", 15).upper()
    if kind == "local" and supplier_gstin and not GSTIN.match(supplier_gstin):
        raise FormError("The supplier GSTIN should be 15 characters, like 24ABCDE1234F1Z5.")
    document_no = form.required("documentNo", "Enter the Bill of Entry number." if kind == "import" else "Enter the supplier invoice number.", 50)
    document_date = form.date("documentDate", "Enter the document date as YYYY-MM-DD.")
    taxable = form.number("taxableInr", "Enter the taxable (assessable) value in rupees.", min=0)

    def optional(key: str, message: str, places: int = 2) -> float:
        value = form.number(key, message, min=0, optional=True, places=places)
        return 0 if value is None else value

    igst = optional("igstInr", "IGST must be zero or more.")
    cgst = optional("cgstInr", "CGST must be zero or more.")
    sgst = optional("sgstInr", "SGST must be zero or more.")
    carats = optional("carats", "Carats must be zero or more.", 3)
    return {
        "kind": kind,
        "supplierName": supplier_name,
        "supplierGstin": "" if kind == "import" else supplier_gstin,
        "supplierCountry": form.text("supplierCountry", 100),
        "documentNo": document_no,
        "documentDate": document_date,
        "portCode": form.text("portCode", 20).upper(),
        "description": form.text("description", 300),
        "carats": carats,
        "parcelId": form.text("parcelId", 100),
        "taxableInr": taxable,
        "igstInr": igst,
        "cgstInr": 0 if kind == "import" else cgst,
        "sgstInr": 0 if kind == "import" else sgst,
        "relatedParty": form.flag("relatedParty"),
        "notes": form.text("notes", 500),
    }


def _purchase_values(purchase: dict) -> list:
    return [
        purchase["kind"], purchase["supplierName"], purchase["supplierGstin"], purchase["supplierCountry"], purchase["documentNo"],
        date.fromisoformat(purchase["documentDate"]), purchase["portCode"], purchase["description"], purchase["carats"],
        purchase["parcelId"], purchase["taxableInr"], purchase["igstInr"], purchase["cgstInr"], purchase["sgstInr"],
        purchase["relatedParty"], purchase["notes"],
    ]


# --- GSTR-2B ---------------------------------------------------------------------------------------


def parse_gstr2b_csv(text: str) -> dict | str:
    """The B2B and import (IMPG) tables of a GSTR-2B download saved as CSV, or what is wrong with it."""
    rows = parse_csv(text)
    if len(rows) < 2:
        return "Upload the GSTR-2B as CSV with a header row and at least one line."
    if len(rows) > MAX_2B_ROWS + 1:
        return f"Import at most {MAX_2B_ROWS} lines at a time."
    header, lines = rows[0], rows[1:]

    def col(names: list[str]) -> int:
        return find_column(header, names)

    gstin = col(["gstin of supplier", "supplier gstin", "gstin", "ctin"])
    name = col(["trade legal name", "trade name", "legal name", "supplier name", "name of supplier"])
    invoice = col(["invoice number", "invoice no", "document number", "inum"])
    boe = col(["bill of entry number", "bill of entry no", "boe number", "boe no"])
    date_col = col(["invoice date", "bill of entry date", "boe date", "document date", "date"])
    taxable = col(["taxable value", "taxable value rs", "taxable value inr", "assessable value", "txval"])
    igst = col(["integrated tax", "igst", "integrated tax rs", "iamt"])
    cgst = col(["central tax", "cgst", "central tax rs", "camt"])
    sgst = col(["state ut tax", "state tax", "sgst", "state ut tax rs", "samt"])
    available = col(["itc availability", "itc available", "eligibility"])
    section_col = col(["section", "table", "type"])
    if (invoice < 0 and boe < 0) or taxable < 0:
        return "The CSV needs an invoice number (or bill of entry number) column and a taxable value column."

    parsed, skipped = [], 0
    for cells in lines:
        def cell(index: int) -> str:
            return cells[index].strip() if 0 <= index < len(cells) else ""

        supplier_gstin = cell(gstin).upper()
        section_text = cell(section_col).lower()
        document_no = cell(invoice) or cell(boe)
        section = "impg" if "imp" in section_text or (not supplier_gstin and bool(cell(boe))) else "b2b"
        taxable_inr = parse_amount(cell(taxable).replace("₹", ""))
        if not document_no or taxable_inr is None:
            skipped += 1
            continue

        def amount(index: int) -> float:
            value = parse_amount(cell(index).replace("₹", ""))
            return 0 if value is None else value

        parsed.append({
            "section": section,
            "supplierGstin": "" if section == "impg" else supplier_gstin,
            "supplierName": cell(name)[:200],
            "documentNo": document_no[:50],
            "documentDate": parse_loose_date(cell(date_col)),
            "taxableInr": taxable_inr,
            "igstInr": amount(igst),
            "cgstInr": amount(cgst),
            "sgstInr": amount(sgst),
            "itcAvailable": not re.match(r"^\s*no", cell(available), re.IGNORECASE),
        })
    return {"lines": parsed, "skipped": skipped}


def purchase_match_key(kind: str, gstin: str, document_no: str) -> str:
    if kind in ("import", "impg"):
        return f"impg|{document_key(document_no)}"
    return f"b2b|{gstin.upper()}|{document_key(document_no)}"


def month_end(month: str) -> date:
    year, mon = (int(part) for part in month.split("-"))
    return date(year, mon, calendar.monthrange(year, mon)[1])


STATUS_ORDER = {"not_in_books": 0, "missing_in_2b": 1, "mismatch": 2, "itc_blocked": 3, "matched": 4}


async def itc_match(pool: Pool, organization_id: str, month: str) -> dict:
    """Purchases in the books against GSTR-2B. A purchase matches 2B lines from its own month or any later
    month up to the one asked for, because suppliers sometimes file late."""
    first = date.fromisoformat(f"{month}-01")
    purchase_rows = await pool.fetch(
        f"""SELECT {PURCHASE_COLUMNS} FROM purchases
            WHERE organization_id = $1 AND document_date <= $2 AND document_date >= ($3::date - interval '12 months')""",
        organization_id, month_end(month), first,
    )
    line_rows = await pool.fetch(
        """SELECT id, to_char(month, 'YYYY-MM') AS month, section, supplier_gstin, supplier_name, document_no,
                  to_char(document_date, 'YYYY-MM-DD') AS document_date, taxable_inr, igst_inr, cgst_inr, sgst_inr, itc_available
           FROM gstr2b_lines WHERE organization_id = $1 AND month <= $2::date AND month >= ($2::date - interval '12 months')""",
        organization_id, first,
    )
    imported_months = await pool.fetch(
        "SELECT DISTINCT to_char(month, 'YYYY-MM') AS month FROM gstr2b_lines WHERE organization_id = $1 ORDER BY 1 DESC LIMIT 24",
        organization_id,
    )
    purchases = [to_purchase(row) for row in purchase_rows]
    lines = [
        {
            "id": r["id"], "month": r["month"], "section": r["section"], "supplierGstin": r["supplier_gstin"],
            "supplierName": r["supplier_name"], "documentNo": r["document_no"], "documentDate": r["document_date"],
            "taxableInr": money(r["taxable_inr"]),
            "taxInr": money(float(r["igst_inr"]) + float(r["cgst_inr"]) + float(r["sgst_inr"])),
            "itcAvailable": r["itc_available"],
        }
        for r in line_rows
    ]
    lines_by_key: dict[str, list[dict]] = {}
    for line in lines:
        lines_by_key.setdefault(purchase_match_key(line["section"], line["supplierGstin"], line["documentNo"]), []).append(line)
    purchase_keys = {purchase_match_key(p["kind"], p["supplierGstin"], p["documentNo"]) for p in purchases}

    rows: list[dict] = []
    for purchase in (p for p in purchases if p["documentDate"][:7] == month):
        found = lines_by_key.get(purchase_match_key(purchase["kind"], purchase["supplierGstin"], purchase["documentNo"]), [])
        base = {
            "purchaseId": purchase["id"], "supplierName": purchase["supplierName"], "supplierGstin": purchase["supplierGstin"],
            "documentNo": purchase["documentNo"], "documentDate": purchase["documentDate"], "kind": purchase["kind"],
            "booksTaxInr": purchase["taxInr"],
        }
        if not found:
            detail = (
                "Bill of Entry not in GSTR-2B (IMPG) yet. Check the port code and BoE number with the customs broker."
                if purchase["kind"] == "import"
                else "Supplier has not reported this invoice in GSTR-1 yet. Ask them to file it, or the credit cannot be claimed."
            )
            rows.append({**base, "status": "missing_in_2b", "detail": detail, "gstr2bTaxInr": None, "gstr2bMonth": None})
            continue
        tax_in_2b = 0.0
        for line in found:
            tax_in_2b += line["taxInr"]
        tax_in_2b = money(tax_in_2b)
        blocked = all(not line["itcAvailable"] for line in found)
        differs = abs(tax_in_2b - purchase["taxInr"]) > 1
        if blocked:
            status, detail = "itc_blocked", "GSTR-2B marks this credit as not available."
        elif differs:
            status = "mismatch"
            detail = f"Tax in the books is ₹{to_fixed(purchase['taxInr'], 2)} but GSTR-2B shows ₹{to_fixed(tax_in_2b, 2)}."
        else:
            status, detail = "matched", ""
        rows.append({**base, "status": status, "detail": detail, "gstr2bTaxInr": tax_in_2b, "gstr2bMonth": found[0]["month"]})

    for line in (entry for entry in lines if entry["month"] == month):
        if purchase_match_key(line["section"], line["supplierGstin"], line["documentNo"]) in purchase_keys:
            continue
        rows.append({
            "status": "not_in_books",
            "detail": (
                "In GSTR-2B but not recorded as a purchase. Record it to claim the credit, or tell the supplier it is not yours."
                if line["itcAvailable"]
                else "In GSTR-2B (credit not available) but not recorded as a purchase."
            ),
            "purchaseId": None,
            "supplierName": line["supplierName"],
            "supplierGstin": line["supplierGstin"],
            "documentNo": line["documentNo"],
            "documentDate": line["documentDate"],
            "kind": "import" if line["section"] == "impg" else "local",
            "booksTaxInr": None,
            "gstr2bTaxInr": line["taxInr"],
            "gstr2bMonth": line["month"],
        })

    rows.sort(key=lambda row: (STATUS_ORDER[row["status"]], row["supplierName"].casefold()))

    def total(selected, pick) -> float:
        acc = 0.0
        for row in selected:
            acc += pick(row) or 0
        return money(acc)

    return {
        "month": month,
        "gstr2bImported": any(line["month"] == month for line in lines),
        "importedMonths": [r["month"] for r in imported_months],
        "rows": rows,
        "totals": {
            "booksItcInr": total([r for r in rows if r["purchaseId"] is not None], lambda r: r["booksTaxInr"]),
            "gstr2bItcInr": total([l for l in lines if l["month"] == month and l["itcAvailable"]], lambda l: l["taxInr"]),
            "matchedItcInr": total([r for r in rows if r["status"] == "matched"], lambda r: r["booksTaxInr"]),
            "atRiskItcInr": total([r for r in rows if r["status"] in ("missing_in_2b", "itc_blocked")], lambda r: r["booksTaxInr"]),
            "unclaimedItcInr": total([r for r in rows if r["status"] == "not_in_books"], lambda r: r["gstr2bTaxInr"]),
            "mismatches": sum(1 for r in rows if r["status"] == "mismatch"),
        },
    }


async def purchase_summary(pool: Pool, organization_id: str, start: date, end: date) -> dict:
    """Purchase totals for the tax audit pack."""
    purchases = await purchases_between(pool, organization_id, start, end)

    def group(selected: list[dict]) -> dict:
        taxable = tax = carats = 0.0
        for p in selected:
            taxable += p["taxableInr"]
        for p in selected:
            tax += p["taxInr"]
        for p in selected:
            carats += p["carats"]
        return {"count": len(selected), "taxableInr": money(taxable), "taxInr": money(tax), "carats": round_to(carats, 3)}

    return {
        "purchases": purchases,
        "imports": group([p for p in purchases if p["kind"] == "import"]),
        "registered": group([p for p in purchases if p["kind"] == "local" and p["supplierGstin"]]),
        "unregistered": group([p for p in purchases if p["kind"] == "local" and not p["supplierGstin"]]),
        "relatedParty": group([p for p in purchases if p["relatedParty"]]),
        "total": group(purchases),
    }


def purchase_csv(purchases: list[dict]) -> bytes:
    return csv_file(
        ["Type", "Supplier", "Supplier GSTIN", "Country", "Invoice / BoE no", "Date", "Port code", "Description", "Carats", "Parcel",
         "Taxable INR", "IGST INR", "CGST INR", "SGST INR", "Total tax INR", "Related party", "Notes"],
        [["Import" if p["kind"] == "import" else "Local", p["supplierName"], p["supplierGstin"], p["supplierCountry"], p["documentNo"],
          p["documentDate"], p["portCode"], p["description"], to_fixed(p["carats"], 3), p["parcelId"], to_fixed(p["taxableInr"], 2),
          to_fixed(p["igstInr"], 2), to_fixed(p["cgstInr"], 2), to_fixed(p["sgstInr"], 2), to_fixed(p["taxInr"], 2),
          "Yes" if p["relatedParty"] else "No", p["notes"]] for p in purchases],
    )


async def _closed(pool: Pool, organization_id: str, document_date: str | None) -> None:
    message = await closed_month_message(pool, organization_id, document_date)
    if message:
        raise ApiError(409, message.replace("this invoice", "this purchase", 1))


async def _existing_date(pool: Pool, purchase_id: str, organization_id: str) -> str:
    if not is_uuid(purchase_id):
        raise ApiError(404, "Purchase not found.")
    found = await pool.fetchval(
        "SELECT to_char(document_date, 'YYYY-MM-DD') FROM purchases WHERE id = $1 AND organization_id = $2", purchase_id, organization_id
    )
    if not found:
        raise ApiError(404, "Purchase not found.")
    return found


def build_router():
    router = api_router(prefix="/api/purchases")

    @router.get("")
    async def list_purchases(request: Request, user: CurrentUser = Depends(require_user)):
        r = month_range(request)
        purchases = await purchases_between(request.app.state.pool, user.organization_id, r["start"], r["end"])
        taxable = tax = carats = 0.0
        for p in purchases:
            taxable += p["taxableInr"]
        for p in purchases:
            tax += p["taxInr"]
        for p in purchases:
            carats += p["carats"]
        return {"from": r["from"], "to": r["to"], "purchases": purchases,
                "totals": {"taxableInr": money(taxable), "taxInr": money(tax), "carats": round_to(carats, 3)}}

    @router.get("/csv")
    async def csv(request: Request, user: CurrentUser = Depends(require_user)):
        r = month_range(request)
        purchases = await purchases_between(request.app.state.pool, user.organization_id, r["start"], r["end"])
        return csv_response(f"purchase-register-{r['from']}-to-{r['to']}.csv", purchase_csv(purchases))

    @router.post("")
    async def create(request: Request, user: CurrentUser = Depends(tax_writer)):
        purchase = read_purchase(body(request))
        pool: Pool = request.app.state.pool
        await _closed(pool, user.organization_id, purchase["documentDate"])
        try:
            new_id = await pool.fetchval(
                """INSERT INTO purchases (organization_id, kind, supplier_name, supplier_gstin, supplier_country, document_no, document_date,
                     port_code, description, carats, parcel_id, taxable_inr, igst_inr, cgst_inr, sgst_inr, related_party, notes, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id""",
                user.organization_id, *_purchase_values(purchase), user.id,
            )
        except asyncpg.UniqueViolationError:
            raise ApiError(409, f"{purchase['documentNo']} from this supplier is already recorded.") from None
        return JSONResponse({"id": new_id}, status_code=201)

    @router.post("/gstr2b")
    async def import_gstr2b(request: Request, user: CurrentUser = Depends(tax_writer)):
        data = body(request)
        month = parse_month(data.get("month"))
        if not month:
            raise ApiError(400, "Choose the return month of this GSTR-2B.")
        parsed = parse_gstr2b_csv(data["csv"] if isinstance(data.get("csv"), str) else "")
        if isinstance(parsed, str):
            raise ApiError(400, parsed)
        first = date.fromisoformat(f"{month}-01")
        pool: Pool = request.app.state.pool
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("DELETE FROM gstr2b_lines WHERE organization_id = $1 AND month = $2", user.organization_id, first)
            for line in parsed["lines"]:
                await conn.execute(
                    """INSERT INTO gstr2b_lines (organization_id, month, section, supplier_gstin, supplier_name, document_no, document_date,
                         taxable_inr, igst_inr, cgst_inr, sgst_inr, itc_available)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)""",
                    user.organization_id, first, line["section"], line["supplierGstin"], line["supplierName"], line["documentNo"],
                    date.fromisoformat(line["documentDate"]) if line["documentDate"] else None,
                    line["taxableInr"], line["igstInr"], line["cgstInr"], line["sgstInr"], line["itcAvailable"],
                )
        return JSONResponse({"month": month, "imported": len(parsed["lines"]), "skipped": parsed["skipped"]}, status_code=201)

    @router.get("/itc-match")
    async def match(request: Request, user: CurrentUser = Depends(tax_reader)):
        month = parse_month(request.query_params.get("month"))
        if not month:
            raise ApiError(400, "Choose a month.")
        return await itc_match(request.app.state.pool, user.organization_id, month)

    @router.get("/itc-match/csv")
    async def match_csv(request: Request, user: CurrentUser = Depends(tax_reader)):
        month = parse_month(request.query_params.get("month"))
        if not month:
            raise ApiError(400, "Choose a month.")
        report = await itc_match(request.app.state.pool, user.organization_id, month)

        def fixed(value) -> str:
            return "" if value is None else to_fixed(value, 2)

        body_csv = csv_file(
            ["Status", "Type", "Supplier", "GSTIN", "Invoice / BoE no", "Date", "Tax in books INR", "Tax in GSTR-2B INR", "2B month", "Detail"],
            [[r["status"].replace("_", " "), r["kind"], r["supplierName"], r["supplierGstin"], r["documentNo"], r["documentDate"] or "",
              fixed(r["booksTaxInr"]), fixed(r["gstr2bTaxInr"]), r["gstr2bMonth"] or "", r["detail"]] for r in report["rows"]],
        )
        return csv_response(f"itc-match-{month}.csv", body_csv)

    @router.put("/{purchase_id}")
    async def update(purchase_id: str, request: Request, user: CurrentUser = Depends(tax_writer)):
        purchase = read_purchase(body(request))
        pool: Pool = request.app.state.pool
        existing = await _existing_date(pool, purchase_id, user.organization_id)
        await _closed(pool, user.organization_id, existing)
        await _closed(pool, user.organization_id, purchase["documentDate"])
        try:
            await pool.execute(
                """UPDATE purchases SET kind = $3, supplier_name = $4, supplier_gstin = $5, supplier_country = $6, document_no = $7,
                     document_date = $8, port_code = $9, description = $10, carats = $11, parcel_id = $12, taxable_inr = $13, igst_inr = $14,
                     cgst_inr = $15, sgst_inr = $16, related_party = $17, notes = $18, updated_at = now()
                   WHERE id = $1 AND organization_id = $2""",
                purchase_id, user.organization_id, *_purchase_values(purchase),
            )
        except asyncpg.UniqueViolationError:
            raise ApiError(409, f"{purchase['documentNo']} from this supplier is already recorded.") from None
        return {"id": purchase_id}

    @router.delete("/{purchase_id}")
    async def delete(purchase_id: str, request: Request, user: CurrentUser = Depends(tax_manager)):
        pool: Pool = request.app.state.pool
        await _closed(pool, user.organization_id, await _existing_date(pool, purchase_id, user.organization_id))
        await pool.execute("DELETE FROM purchases WHERE id = $1 AND organization_id = $2", purchase_id, user.organization_id)
        return {"deleted": True}

    return router
