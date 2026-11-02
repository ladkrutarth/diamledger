"""Invoices: list, CSV, create, read, edit drafts, status, delete (port of server/modules/invoices/invoices.ts).

Line items live in invoices.data (JSON); status, totals, buyer and dates are copied into columns for
lists and the dashboard, always from `invoice_facts` so the two never disagree. Issued invoices are
immutable. Numbers run per Indian financial year: EXP/2026-27/0001.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone

import asyncpg
from fastapi import Depends, Request, Response
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, require_admin, require_user
from ...core.numbers import js_round, js_string, to_fixed
from ..billing.subscription import limit_message
from ..tax.closed_months import closed_month_message
from .schema import invoice_facts, validate_invoice

INVOICE_STATUSES = ("draft", "issued", "paid", "cancelled")
NUMBER_TAKEN = "Another invoice already uses that invoice number."

SUMMARY_COLUMNS = """
  i.id, i.invoice_number, i.status, i.buyer_name, i.destination_country,
  to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
  i.total_usd, i.total_carats, i.updated_at,
  COALESCE((SELECT SUM(p.amount_usd) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_usd"""

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def as_date(value: str | None) -> date | None:
    """A YYYY-MM-DD string as a date parameter (asyncpg does not convert strings for date columns)."""
    return date.fromisoformat(value) if value else None


def financial_year(today: date) -> str:
    start = today.year if today.month >= 4 else today.year - 1
    return f"{start}-{(start + 1) % 100:02d}"


def to_summary(row) -> dict:
    total_usd = float(row["total_usd"])
    paid_usd = float(row["paid_usd"])
    return {
        "id": row["id"],
        "invoiceNumber": row["invoice_number"],
        "status": row["status"],
        "buyerName": row["buyer_name"],
        "destinationCountry": row["destination_country"],
        "invoiceDate": row["invoice_date"],
        "totalUsd": total_usd,
        "totalCarats": float(row["total_carats"]),
        "paidUsd": paid_usd,
        "dueUsd": max(0.0, js_round((total_usd - paid_usd) * 100) / 100),
        "updatedAt": iso(row["updated_at"]),
    }


def to_record(row) -> dict:
    return {**to_summary(row), "invoice": row["data"]}


def _filters(request: Request) -> dict[str, str]:
    return {key: request.query_params.get(key, "").strip() for key in ("q", "status", "from", "to")}


def filter_sql(organization_id: str, filters: dict[str, str]) -> tuple[str, list]:
    clauses = ["i.organization_id = $1"]
    params: list = [organization_id]
    if filters["q"]:
        params.append(f"%{filters['q']}%")
        clauses.append(f"(i.invoice_number ILIKE ${len(params)} OR i.buyer_name ILIKE ${len(params)})")
    if filters["status"] in INVOICE_STATUSES:
        params.append(filters["status"])
        clauses.append(f"i.status = ${len(params)}")
    for key, op in (("from", ">="), ("to", "<=")):
        value = filters[key]
        if _ISO_DATE.match(value):
            try:
                params.append(date.fromisoformat(value))
            except ValueError:
                continue
            clauses.append(f"COALESCE(i.invoice_date, i.created_at::date) {op} ${len(params)}")
    return " AND ".join(clauses), params


async def load_invoice(conn, invoice_id: str, organization_id: str):
    return await conn.fetchrow(
        f"SELECT {SUMMARY_COLUMNS}, i.data FROM invoices i WHERE i.id = $1 AND i.organization_id = $2",
        invoice_id,
        organization_id,
    )


async def number_taken(conn, organization_id: str, invoice_number: str, except_id: str | None = None) -> bool:
    found = await conn.fetchval(
        """SELECT 1 FROM invoices
           WHERE organization_id = $1 AND lower(invoice_number) = lower($2) AND ($3::uuid IS NULL OR id <> $3::uuid)""",
        organization_id,
        invoice_number,
        except_id,
    )
    return bool(found)


async def next_invoice_number(conn, organization_id: str) -> str:
    profile = await conn.fetchval("SELECT profile FROM organizations WHERE id = $1", organization_id)
    prefix = ""
    if isinstance(profile, dict) and isinstance(profile.get("invoicePrefix"), str):
        prefix = profile["invoicePrefix"].strip()
    prefix = prefix or "EXP"
    year = financial_year(date.today())
    for _ in range(50):
        last = await conn.fetchval(
            """INSERT INTO invoice_counters (organization_id, financial_year, last_number)
               VALUES ($1, $2, 1)
               ON CONFLICT (organization_id, financial_year)
               DO UPDATE SET last_number = invoice_counters.last_number + 1
               RETURNING last_number""",
            organization_id,
            year,
        )
        candidate = f"{prefix}/{year}/{last:04d}"
        if not await number_taken(conn, organization_id, candidate):
            return candidate
    raise RuntimeError("Could not assign an invoice number.")


async def with_number(conn, organization_id: str, invoice: dict, except_id: str | None = None) -> dict | None:
    invoice_number = invoice["shipment"]["invoiceNumber"].strip()
    if not invoice_number:
        invoice_number = await next_invoice_number(conn, organization_id)
    elif await number_taken(conn, organization_id, invoice_number, except_id):
        return None
    return {**invoice, "shipment": {**invoice["shipment"], "invoiceNumber": invoice_number}}


async def refresh_paid_status(conn, invoice_id: str) -> None:
    await conn.execute(
        """UPDATE invoices i
           SET status = CASE WHEN paid.total >= i.total_usd AND i.total_usd > 0 THEN 'paid' ELSE 'issued' END,
               updated_at = now()
           FROM (SELECT COALESCE(SUM(amount_usd), 0) AS total FROM payments WHERE invoice_id = $1) paid
           WHERE i.id = $1 AND i.status IN ('issued', 'paid')""",
        invoice_id,
    )


def csv_cell(value) -> str:
    raw = "" if value is None else str(value)
    safe = f"'{raw}" if re.match(r"^[=+\-@]", raw) else raw
    return '"' + safe.replace('"', '""') + '"' if re.search(r'[",\n]', safe) else safe


def _fact_params(facts: dict) -> list:
    return [
        facts["buyerName"],
        facts["destinationCountry"],
        as_date(facts["invoiceDate"]),
        facts["totalUsd"],
        facts["totalCarats"],
        facts["creditDays"],
    ]


def build_router():
    router = api_router(prefix="/api/invoices")

    @router.get("")
    async def list_invoices(request: Request, user: CurrentUser = Depends(require_user)):
        where, params = filter_sql(user.organization_id, _filters(request))
        rows = await request.app.state.pool.fetch(
            f"SELECT {SUMMARY_COLUMNS} FROM invoices i WHERE {where} ORDER BY i.updated_at DESC LIMIT 500", *params
        )
        return {"invoices": [to_summary(row) for row in rows]}

    @router.get("/export")
    async def export_csv(request: Request, user: CurrentUser = Depends(require_user)):
        where, params = filter_sql(user.organization_id, _filters(request))
        rows = await request.app.state.pool.fetch(
            f"""SELECT {SUMMARY_COLUMNS} FROM invoices i WHERE {where}
                ORDER BY COALESCE(i.invoice_date, i.created_at::date) DESC, i.invoice_number""",
            *params,
        )
        header = ["Invoice number", "Invoice date", "Status", "Buyer", "Destination", "Carats", "Total USD", "Paid USD", "Due USD"]
        lines = []
        for row in map(to_summary, rows):
            cells = [
                row["invoiceNumber"], row["invoiceDate"], row["status"], row["buyerName"], row["destinationCountry"],
                to_fixed(row["totalCarats"], 3), to_fixed(row["totalUsd"], 2), to_fixed(row["paidUsd"], 2), to_fixed(row["dueUsd"], 2),
            ]
            lines.append(",".join(csv_cell(cell) for cell in cells))
        csv = "﻿" + "\r\n".join([",".join(header), *lines]) + "\r\n"
        today = datetime.now(timezone.utc).date().isoformat()
        return Response(
            csv,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="invoices-{today}.csv"'},
        )

    @router.post("")
    async def create_invoice(request: Request, user: CurrentUser = Depends(require_user)):
        validation = validate_invoice(body(request).get("invoice"))
        if not validation.ok:
            raise ApiError(400, validation.error)
        pool: Pool = request.app.state.pool
        closed = await closed_month_message(pool, user.organization_id, invoice_facts(validation.invoice)["invoiceDate"])
        if closed:
            raise ApiError(409, closed)
        try:
            async with pool.acquire() as conn, conn.transaction():
                invoice = await with_number(conn, user.organization_id, validation.invoice)
                if invoice is None:
                    raise ApiError(409, NUMBER_TAKEN)
                facts = invoice_facts(invoice)
                invoice_id = await conn.fetchval(
                    """INSERT INTO invoices (user_id, organization_id, invoice_number, data, status, buyer_name,
                                             destination_country, invoice_date, total_usd, total_carats, credit_days)
                       VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10)
                       RETURNING id""",
                    user.id, user.organization_id, facts["invoiceNumber"], invoice, *_fact_params(facts),
                )
        except asyncpg.UniqueViolationError:
            # Two requests can pass the number check together; the unique index lets only one win.
            raise ApiError(409, NUMBER_TAKEN) from None
        row = await load_invoice(pool, invoice_id, user.organization_id)
        return JSONResponse(to_record(row), status_code=201)

    async def existing_or_404(request: Request, invoice_id: str, user: CurrentUser):
        row = await load_invoice(request.app.state.pool, invoice_id, user.organization_id) if is_uuid(invoice_id) else None
        if not row:
            raise ApiError(404, "Invoice not found.")
        return row

    @router.get("/{invoice_id}")
    async def get_invoice(invoice_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        return to_record(await existing_or_404(request, invoice_id, user))

    @router.put("/{invoice_id}")
    async def update_invoice(invoice_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        existing = await existing_or_404(request, invoice_id, user)
        if existing["status"] != "draft":
            raise ApiError(409, f"This invoice is {existing['status']} and locked. Duplicate it to make changes.")
        validation = validate_invoice(body(request).get("invoice"))
        if not validation.ok:
            raise ApiError(400, validation.error)
        pool: Pool = request.app.state.pool
        try:
            async with pool.acquire() as conn, conn.transaction():
                invoice = await with_number(conn, user.organization_id, validation.invoice, existing["id"])
                if invoice is None:
                    raise ApiError(409, NUMBER_TAKEN)
                facts = invoice_facts(invoice)
                closed = await closed_month_message(pool, user.organization_id, existing["invoice_date"]) or await closed_month_message(
                    pool, user.organization_id, facts["invoiceDate"]
                )
                if closed:
                    raise ApiError(409, closed)
                await conn.execute(
                    """UPDATE invoices
                       SET invoice_number = $3, data = $4, buyer_name = $5, destination_country = $6,
                           invoice_date = $7, total_usd = $8, total_carats = $9, credit_days = $10, updated_at = now()
                       WHERE id = $1 AND organization_id = $2 AND status = 'draft'""",
                    existing["id"], user.organization_id, facts["invoiceNumber"], invoice, *_fact_params(facts),
                )
        except asyncpg.UniqueViolationError:
            raise ApiError(409, NUMBER_TAKEN) from None
        return to_record(await load_invoice(pool, existing["id"], user.organization_id))

    @router.patch("/{invoice_id}/status")
    async def change_status(invoice_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        existing = await existing_or_404(request, invoice_id, user)
        next_status = body(request).get("status")
        current = existing["status"]
        allowed = (current == "draft" and next_status in ("issued", "cancelled")) or (
            current in ("issued", "paid") and next_status == "cancelled"
        )
        if not allowed:
            shown = "undefined" if next_status is None and "status" not in body(request) else js_string(next_status)
            raise ApiError(400, f"A {current} invoice cannot be marked {shown}.")
        if next_status == "cancelled" and current != "draft" and user.role != "admin":
            raise ApiError(403, "Only company admins can cancel an issued invoice.")
        pool: Pool = request.app.state.pool
        closed = await closed_month_message(pool, user.organization_id, existing["invoice_date"])
        if closed:
            raise ApiError(409, closed)
        if next_status == "issued":
            over_limit = await limit_message(pool, user.organization_id, "invoices")
            if over_limit:
                raise ApiError(402, over_limit, code="plan_limit")
        await pool.execute(
            """UPDATE invoices SET status = $3, updated_at = now(),
                   issued_at = CASE WHEN $3 = 'issued' THEN now() ELSE issued_at END
               WHERE id = $1 AND organization_id = $2""",
            existing["id"], user.organization_id, next_status,
        )
        if next_status == "issued":
            await refresh_paid_status(pool, existing["id"])
        return to_record(await load_invoice(pool, existing["id"], user.organization_id))

    @router.delete("/{invoice_id}")
    async def delete_invoice(invoice_id: str, request: Request, user: CurrentUser = Depends(require_admin)):
        existing = await existing_or_404(request, invoice_id, user)
        pool: Pool = request.app.state.pool
        closed = await closed_month_message(pool, user.organization_id, existing["invoice_date"])
        if closed:
            raise ApiError(409, closed)
        result = await pool.execute("DELETE FROM invoices WHERE id = $1 AND organization_id = $2", invoice_id, user.organization_id)
        if result == "DELETE 0":
            raise ApiError(404, "Invoice not found.")
        return Response(status_code=204)

    return router

