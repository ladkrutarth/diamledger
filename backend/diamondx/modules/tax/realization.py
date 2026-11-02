"""FEMA realization: export proceeds due within the realization period, e-BRC import, and tax settings
(port of server/modules/tax/realization.ts)."""

from __future__ import annotations

import math
from datetime import date

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import parse_loose_date
from ...core.http import ApiError, CurrentUser, body
from ...core.numbers import js_number, money
from .shared import find_column, parse_amount, parse_csv, tax_manager, tax_reader, tax_settings

DUE_SOON_DAYS = 30


async def realization_rows(pool: Pool, organization_id: str) -> dict:
    settings = await tax_settings(pool, organization_id)
    rows = await pool.fetch(
        """SELECT i.id, i.invoice_number,
                  to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
                  to_char(COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS shipped_on,
                  i.buyer_name, i.destination_country, i.total_usd,
                  COALESCE(p.paid_usd, 0) AS paid_usd,
                  p.bank_references,
                  (current_date - COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date))::int AS days_since_shipment,
                  to_char((COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date) + make_interval(months => $2))::date, 'YYYY-MM-DD') AS deadline,
                  ((COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date) + make_interval(months => $2))::date - current_date)::int AS days_left,
                  b.brc_number, to_char(b.realised_on, 'YYYY-MM-DD') AS brc_date, b.amount_usd AS brc_amount_usd
           FROM invoices i
           LEFT JOIN invoice_tax t ON t.invoice_id = i.id
           LEFT JOIN invoice_brcs b ON b.invoice_id = i.id
           LEFT JOIN LATERAL (
             SELECT SUM(amount_usd) AS paid_usd,
                    string_agg(NULLIF(btrim(reference), ''), ', ' ORDER BY paid_on) AS bank_references
             FROM payments WHERE invoice_id = i.id
           ) p ON true
           WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid')
           ORDER BY days_left, i.invoice_number
           LIMIT 1000""",
        organization_id, settings["realizationMonths"],
    )
    result = []
    for row in rows:
        total_usd, paid_usd = money(row["total_usd"]), money(row["paid_usd"])
        due_usd = max(0.0, money(total_usd - paid_usd))
        references = row["bank_references"] or ""
        is_open = due_usd > 0 and not row["brc_number"]
        days_left = row["days_left"]
        if is_open and days_left < 0:
            flag = "overdue"
        elif is_open and days_left <= DUE_SOON_DAYS:
            flag = "due_soon"
        elif is_open:
            flag = "open"
        elif not row["brc_number"]:
            flag = "needs_brc"
        else:
            flag = "done"
        result.append({
            "id": row["id"],
            "invoiceNumber": row["invoice_number"],
            "invoiceDate": row["invoice_date"],
            "shippedOn": row["shipped_on"],
            "buyerName": row["buyer_name"],
            "destinationCountry": row["destination_country"],
            "totalUsd": total_usd,
            "paidUsd": paid_usd,
            "dueUsd": due_usd,
            "bankReferences": references,
            "daysSinceShipment": row["days_since_shipment"],
            "deadline": row["deadline"],
            "daysLeft": days_left,
            "open": is_open,
            "flag": flag,
            "missingReference": paid_usd > 0 and references == "",
            "brcNumber": row["brc_number"] or "",
            "brcDate": row["brc_date"] or "",
            "brcAmountUsd": None if row["brc_amount_usd"] is None else money(row["brc_amount_usd"]),
        })
    return {"settings": settings, "rows": result}


async def realization_summary(pool: Pool, organization_id: str) -> dict:
    data = await realization_rows(pool, organization_id)
    rows = data["rows"]
    open_rows = [r for r in rows if r["open"]]
    open_usd = 0.0
    for row in open_rows:
        open_usd += row["dueUsd"]
    return {
        "realizationMonths": data["settings"]["realizationMonths"],
        "rows": rows,
        "openCount": len(open_rows),
        "openUsd": money(open_usd),
        "overdueCount": sum(1 for r in rows if r["flag"] == "overdue"),
        "dueSoonCount": sum(1 for r in rows if r["flag"] == "due_soon"),
        "needsBrcCount": sum(1 for r in rows if r["flag"] == "needs_brc"),
    }


def build_router():
    router = api_router(prefix="/api/tax")

    @router.get("/realization")
    async def realization(request: Request, user: CurrentUser = Depends(tax_reader)):
        return await realization_summary(request.app.state.pool, user.organization_id)

    @router.get("/settings")
    async def get_settings(request: Request, user: CurrentUser = Depends(tax_reader)):
        return await tax_settings(request.app.state.pool, user.organization_id)

    @router.put("/settings")
    async def put_settings(request: Request, user: CurrentUser = Depends(tax_manager)):
        data = body(request)
        months = js_number(data["realizationMonths"]) if "realizationMonths" in data else math.nan
        if not (math.isfinite(months) and months.is_integer() and 1 <= months <= 36):
            raise ApiError(400, "The realization period must be between 1 and 36 months.")
        lut_raw = data["lutValidUntil"] if isinstance(data.get("lutValidUntil"), str) and data["lutValidUntil"] else None
        lut = parse_loose_date(lut_raw) if lut_raw else None
        if lut_raw and not lut:
            raise ApiError(400, "Enter the LUT expiry as YYYY-MM-DD.")
        einvoice_required = data.get("einvoiceRequired") is not False
        pool: Pool = request.app.state.pool
        await pool.execute(
            """INSERT INTO organization_tax_settings (organization_id, realization_months, lut_valid_until, einvoice_required)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (organization_id) DO UPDATE SET realization_months = EXCLUDED.realization_months,
                 lut_valid_until = EXCLUDED.lut_valid_until, einvoice_required = EXCLUDED.einvoice_required, updated_at = now()""",
            user.organization_id, int(months), date.fromisoformat(lut) if lut else None, einvoice_required,
        )
        return await tax_settings(pool, user.organization_id)

    @router.post("/ebrc/import")
    async def import_ebrc(request: Request, user: CurrentUser = Depends(tax_manager)):
        data = body(request)
        rows = parse_csv(data["csv"] if isinstance(data.get("csv"), str) else "")
        if len(rows) < 2:
            raise ApiError(400, "Upload the e-BRC CSV with its header row.")
        header, lines = rows[0], rows[1:]
        brc_col = find_column(header, ["brc number", "ebrc number", "e brc number", "brc no", "e brc no", "ebrc no", "brc"])
        bill_col = find_column(header, ["shipping bill number", "shipping bill no", "sb number", "sb no", "shipping bill"])
        invoice_col = find_column(header, ["invoice number", "invoice no", "invoice"])
        date_col = find_column(header, ["realisation date", "realization date", "brc date", "date"])
        amount_col = find_column(header, ["realised value", "realized value", "realised amount", "realized amount", "amount usd", "amount"])
        if brc_col < 0 or date_col < 0 or (bill_col < 0 and invoice_col < 0):
            raise ApiError(400, "The CSV needs the e-BRC number, realisation date, and a shipping bill or invoice number.")

        def cell(cells: list[str], index: int) -> str:
            return cells[index] if 0 <= index < len(cells) else ""

        pool: Pool = request.app.state.pool
        matched, unmatched = 0, []
        for cells in lines:
            brc_number = cell(cells, brc_col).strip()[:60]
            realised_on = parse_loose_date(cell(cells, date_col))
            bill = cell(cells, bill_col).strip() if bill_col >= 0 else ""
            invoice_number = cell(cells, invoice_col).strip() if invoice_col >= 0 else ""
            label = bill or invoice_number or brc_number or "(blank row)"
            if not brc_number or not realised_on:
                unmatched.append(label)
                continue
            found = await pool.fetchrow(
                """SELECT i.id, i.total_usd FROM invoices i
                   LEFT JOIN invoice_tax t ON t.invoice_id = i.id
                   WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid')
                     AND (($2 <> '' AND t.shipping_bill_no = $2) OR ($3 <> '' AND upper(i.invoice_number) = upper($3)))
                   LIMIT 1""",
                user.organization_id, bill, invoice_number,
            )
            if not found:
                unmatched.append(label)
                continue
            amount = parse_amount(cell(cells, amount_col)) if amount_col >= 0 else None
            await pool.execute(
                """INSERT INTO invoice_brcs (invoice_id, organization_id, brc_number, realised_on, amount_usd)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (invoice_id) DO UPDATE SET brc_number = EXCLUDED.brc_number, realised_on = EXCLUDED.realised_on,
                     amount_usd = EXCLUDED.amount_usd""",
                found["id"], user.organization_id, brc_number, date.fromisoformat(realised_on),
                amount if amount is not None else money(found["total_usd"]),
            )
            matched += 1
        return JSONResponse({"matched": matched, "unmatched": unmatched}, status_code=201)

    return router
