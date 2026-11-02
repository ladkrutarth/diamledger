"""Export register, GST and year packs, closing months, shipping-bill details, documents and CA review
(port of server/modules/tax/tax.ts)."""

from __future__ import annotations

import base64
import binascii
import math
import re
from datetime import date

from fastapi import Depends, Request, Response
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import financial_year_dates
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, require_user
from ...core.numbers import money, to_fixed
from ..invoices.invoices import financial_year
from .closed_months import closed_month_message, parse_month
from .shared import (
    chartered_accountant,
    csv_file,
    current_month,
    month_is_closed,
    tax_reader,
    tax_writer,
    zip_response,
)

DOCUMENT_KINDS = ("shipping_bill", "airway_bill", "lut")
DOCUMENT_TYPES = {"application/pdf", "image/jpeg", "image/png"}
MAX_DOCUMENT_BYTES = 1_500_000

REGISTER_SQL = """
  SELECT i.id, i.invoice_number,
         to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
         i.buyer_name, i.destination_country, i.status, i.total_usd, i.total_carats,
         COALESCE(t.export_scheme, 'lut') AS export_scheme,
         COALESCE(t.shipping_bill_no, '') AS shipping_bill_no,
         to_char(t.shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date,
         COALESCE(t.igst_usd, 0) AS igst_usd,
         COALESCE(i.data->'shipment'->>'awbNumber', '') AS awb_number,
         COALESCE(i.data->'shipment'->>'lutNumber', '') AS lut_number,
         r.status AS review_status,
         COALESCE(r.comment, '') AS review_comment,
         COALESCE((SELECT json_agg(d.kind ORDER BY d.kind) FROM invoice_documents d WHERE d.invoice_id = i.id), '[]'::json) AS documents
  FROM invoices i
  LEFT JOIN invoice_tax t ON t.invoice_id = i.id
  LEFT JOIN invoice_reviews r ON r.invoice_id = i.id
"""


def to_register(row) -> dict:
    return {
        "id": row["id"],
        "invoiceNumber": row["invoice_number"],
        "invoiceDate": row["invoice_date"],
        "buyerName": row["buyer_name"],
        "destinationCountry": row["destination_country"],
        "status": row["status"],
        "taxableUsd": money(row["total_usd"]),
        "totalCarats": float(row["total_carats"]),
        "exportScheme": row["export_scheme"],
        "shippingBillNo": row["shipping_bill_no"],
        "shippingBillDate": row["shipping_bill_date"],
        "igstUsd": money(row["igst_usd"]),
        "awbNumber": row["awb_number"],
        "lutNumber": row["lut_number"],
        "reviewStatus": row["review_status"],
        "reviewComment": row["review_comment"],
        "documents": row["documents"] if isinstance(row["documents"], list) else [],
    }


async def register_rows(pool: Pool, organization_id: str, where: str, *params) -> list[dict]:
    rows = await pool.fetch(
        f"""{REGISTER_SQL} WHERE i.organization_id = $1 AND i.status <> 'draft' AND {where}
            ORDER BY invoice_date, i.invoice_number""",
        organization_id,
        *params,
    )
    return [to_register(row) for row in rows]


MONTH_WHERE = "to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM') = $2"


def _sum(rows: list[dict], key: str) -> float:
    total = 0.0
    for row in rows:
        total += row[key]
    return money(total)


async def export_register(pool: Pool, organization_id: str, month: str) -> dict:
    rows = await register_rows(pool, organization_id, MONTH_WHERE, month)
    return {
        "month": month,
        "closed": await month_is_closed(pool, organization_id, month),
        "rows": rows,
        "totals": {"count": len(rows), "taxableUsd": _sum(rows, "taxableUsd"), "igstUsd": _sum(rows, "igstUsd")},
    }


def month_start(month: str) -> date:
    year, mon = (int(part) for part in month.split("-"))
    return date(year, mon, 1)


async def close_month(pool: Pool, organization_id: str, month: str, user_id: str) -> None:
    await pool.execute(
        """INSERT INTO closed_months (organization_id, month, closed_by) VALUES ($1, $2, $3)
           ON CONFLICT (organization_id, month) DO NOTHING""",
        organization_id, month_start(month), user_id,
    )


async def _invoice_date(pool: Pool, invoice_id: str, organization_id: str) -> str | None:
    if not is_uuid(invoice_id):
        raise ApiError(404, "Invoice not found.")
    row = await pool.fetchrow(
        """SELECT to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date
           FROM invoices WHERE id = $1 AND organization_id = $2""",
        invoice_id, organization_id,
    )
    if not row:
        raise ApiError(404, "Invoice not found.")
    return row["invoice_date"]


async def _check_open(pool: Pool, organization_id: str, invoice_date: str | None) -> None:
    closed = await closed_month_message(pool, organization_id, invoice_date)
    if closed:
        raise ApiError(409, closed)


def _money_field(data: dict, key: str) -> float:
    """money(body[key]): a missing key is NaN, as Number(undefined) is."""
    return money(data[key]) if key in data else math.nan


def build_router():
    router = api_router()

    @router.get("/api/tax/register")
    async def register(request: Request, user: CurrentUser = Depends(tax_reader)):
        month = parse_month(request.query_params.get("month")) or current_month()
        return await export_register(request.app.state.pool, user.organization_id, month)

    @router.get("/api/tax/gst-pack")
    async def gst_pack(request: Request, user: CurrentUser = Depends(tax_reader)):
        pool: Pool = request.app.state.pool
        month = parse_month(request.query_params.get("month")) or current_month()
        rows = await register_rows(pool, user.organization_id, MONTH_WHERE, month)
        payments = await pool.fetch(
            """SELECT i.invoice_number, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd, p.reference
               FROM payments p JOIN invoices i ON i.id = p.invoice_id
               WHERE p.organization_id = $1 AND to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM') = $2
               ORDER BY p.paid_on, i.invoice_number""",
            user.organization_id, month,
        )
        register_csv = csv_file(
            ["Invoice number", "Invoice date", "Buyer", "Country", "Status", "Scheme", "Shipping bill", "Shipping bill date",
             "Taxable USD", "IGST USD", "Carats", "AWB", "LUT", "Review"],
            [
                [r["invoiceNumber"], r["invoiceDate"], r["buyerName"], r["destinationCountry"], r["status"], r["exportScheme"],
                 r["shippingBillNo"], r["shippingBillDate"], to_fixed(r["taxableUsd"], 2), to_fixed(r["igstUsd"], 2),
                 to_fixed(r["totalCarats"], 3), r["awbNumber"], r["lutNumber"], r["reviewStatus"] or ""]
                for r in rows
            ],
        )
        payment_csv = csv_file(
            ["Invoice number", "Date received", "Amount USD", "Bank reference"],
            [[p["invoice_number"], p["paid_on"], to_fixed(money(p["amount_usd"]), 2), p["reference"]] for p in payments],
        )
        return zip_response(f"gst-pack-{month}.zip", [("export-register.csv", register_csv), ("payments.csv", payment_csv)])

    @router.get("/api/tax/year-pack")
    async def year_pack(request: Request, user: CurrentUser = Depends(tax_reader)):
        pool: Pool = request.app.state.pool
        requested = request.query_params.get("year", financial_year(date.today()))
        period = financial_year_dates(requested)
        if not period:
            raise ApiError(400, "Use a financial year like 2026-27.")
        start, end = date.fromisoformat(period["start"]), date.fromisoformat(period["end"])
        sales = await register_rows(pool, user.organization_id, "COALESCE(i.invoice_date, i.created_at::date) BETWEEN $2 AND $3", start, end)
        receipts = await pool.fetch(
            """SELECT i.invoice_number, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd, p.reference, i.buyer_name
               FROM payments p JOIN invoices i ON i.id = p.invoice_id
               WHERE p.organization_id = $1 AND p.paid_on BETWEEN $2 AND $3
               ORDER BY p.paid_on, i.invoice_number""",
            user.organization_id, start, end,
        )
        outstanding = await pool.fetch(
            """SELECT i.invoice_number, to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
                      i.buyer_name, i.total_usd,
                      COALESCE((SELECT SUM(amount_usd) FROM payments WHERE invoice_id = i.id), 0) AS paid_usd
               FROM invoices i
               WHERE i.organization_id = $1 AND i.status = 'issued' AND COALESCE(i.invoice_date, i.created_at::date) <= $2
               ORDER BY invoice_date, i.invoice_number""",
            user.organization_id, end,
        )
        open_rows = [
            (row, money(money(row["total_usd"]) - money(row["paid_usd"])))
            for row in outstanding
        ]
        open_rows = [(row, due) for row, due in open_rows if due > 0]
        return zip_response(
            f"year-pack-{period['label']}.zip",
            [
                ("sales-register.csv", csv_file(
                    ["Invoice number", "Invoice date", "Buyer", "Country", "Status", "Scheme", "Taxable USD", "IGST USD"],
                    [[r["invoiceNumber"], r["invoiceDate"], r["buyerName"], r["destinationCountry"], r["status"], r["exportScheme"],
                      to_fixed(r["taxableUsd"], 2), to_fixed(r["igstUsd"], 2)] for r in sales],
                )),
                ("receipts.csv", csv_file(
                    ["Invoice number", "Buyer", "Date received", "Amount USD", "Bank reference"],
                    [[r["invoice_number"], r["buyer_name"], r["paid_on"], to_fixed(money(r["amount_usd"]), 2), r["reference"]] for r in receipts],
                )),
                ("outstanding.csv", csv_file(
                    ["Invoice number", "Invoice date", "Buyer", "Total USD", "Received USD", "Balance USD"],
                    [[r["invoice_number"], r["invoice_date"], r["buyer_name"], to_fixed(money(r["total_usd"]), 2),
                      to_fixed(money(r["paid_usd"]), 2), to_fixed(due, 2)] for r, due in open_rows],
                )),
                ("cancelled.csv", csv_file(
                    ["Invoice number", "Invoice date", "Buyer", "Country", "Taxable USD"],
                    [[r["invoiceNumber"], r["invoiceDate"], r["buyerName"], r["destinationCountry"], to_fixed(r["taxableUsd"], 2)]
                     for r in sales if r["status"] == "cancelled"],
                )),
            ],
        )

    @router.get("/api/tax/months")
    async def months(request: Request, user: CurrentUser = Depends(tax_reader)):
        rows = await request.app.state.pool.fetch(
            """SELECT to_char(c.month, 'YYYY-MM') AS month, c.closed_at, u.email
               FROM closed_months c LEFT JOIN users u ON u.id = c.closed_by
               WHERE c.organization_id = $1 ORDER BY c.month DESC""",
            user.organization_id,
        )
        return {
            "financialYear": financial_year(date.today()),
            "months": [{"month": r["month"], "closedAt": iso(r["closed_at"]), "closedBy": r["email"]} for r in rows],
        }

    @router.post("/api/tax/months/{month}/close")
    async def close(month: str, request: Request, user: CurrentUser = Depends(chartered_accountant)):
        if not parse_month(month):
            raise ApiError(400, "Choose a month like 2026-10.")
        await close_month(request.app.state.pool, user.organization_id, month, user.id)
        return {"month": month, "closed": True}

    @router.post("/api/tax/months/{month}/open")
    async def reopen(month: str, request: Request, user: CurrentUser = Depends(chartered_accountant)):
        if not parse_month(month):
            raise ApiError(400, "Choose a month like 2026-10.")
        await request.app.state.pool.execute(
            "DELETE FROM closed_months WHERE organization_id = $1 AND month = $2", user.organization_id, month_start(month)
        )
        return {"month": month, "closed": False}

    @router.get("/api/invoices/{invoice_id}/tax")
    async def invoice_tax(invoice_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        invoice_date = await _invoice_date(pool, invoice_id, user.organization_id)
        saved = await pool.fetchrow(
            """SELECT export_scheme, shipping_bill_no, to_char(shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date, igst_usd,
                      port_code, sb_invoice_number, sb_value_usd
               FROM invoice_tax WHERE invoice_id = $1""",
            invoice_id,
        )
        einvoice = await pool.fetchrow(
            "SELECT irn, ack_no, to_char(ack_date, 'YYYY-MM-DD') AS ack_date FROM invoice_einvoices WHERE invoice_id = $1", invoice_id
        )
        documents = await pool.fetch(
            "SELECT id, kind, file_name, content_type, byte_size, created_at FROM invoice_documents WHERE invoice_id = $1 ORDER BY kind",
            invoice_id,
        )
        review = await pool.fetchrow("SELECT status, comment, updated_at FROM invoice_reviews WHERE invoice_id = $1", invoice_id)
        month = parse_month(invoice_date[:7]) if invoice_date else None
        return {
            "exportScheme": saved["export_scheme"] if saved else "lut",
            "shippingBillNo": saved["shipping_bill_no"] if saved else "",
            "shippingBillDate": (saved["shipping_bill_date"] if saved else None) or "",
            "igstUsd": money(saved["igst_usd"]) if saved else 0,
            "portCode": saved["port_code"] if saved else "",
            "sbInvoiceNumber": saved["sb_invoice_number"] if saved else "",
            "sbValueUsd": money(saved["sb_value_usd"]) if saved and saved["sb_value_usd"] is not None else None,
            "einvoice": {"irn": einvoice["irn"], "ackNo": einvoice["ack_no"], "ackDate": einvoice["ack_date"] or ""} if einvoice else None,
            "month": month,
            "monthClosed": await month_is_closed(pool, user.organization_id, month) if month else False,
            "documents": [
                {"id": d["id"], "kind": d["kind"], "fileName": d["file_name"], "contentType": d["content_type"],
                 "byteSize": d["byte_size"], "createdAt": iso(d["created_at"])}
                for d in documents
            ],
            "review": {"status": review["status"], "comment": review["comment"], "updatedAt": iso(review["updated_at"])} if review else None,
        }

    @router.put("/api/invoices/{invoice_id}/tax")
    async def save_invoice_tax(invoice_id: str, request: Request, user: CurrentUser = Depends(tax_writer)):
        pool: Pool = request.app.state.pool
        await _check_open(pool, user.organization_id, await _invoice_date(pool, invoice_id, user.organization_id))
        data = body(request)
        scheme = "igst" if data.get("exportScheme") == "igst" else "lut"
        shipping_bill_no = data["shippingBillNo"].strip()[:80] if isinstance(data.get("shippingBillNo"), str) else ""
        shipping_bill_date = data["shippingBillDate"] if isinstance(data.get("shippingBillDate"), str) else ""
        bill_date = None
        if shipping_bill_date:
            try:
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", shipping_bill_date):
                    raise ValueError
                bill_date = date.fromisoformat(shipping_bill_date)
            except ValueError:
                raise ApiError(400, "Enter the shipping bill date as YYYY-MM-DD.") from None
        igst_usd = _money_field(data, "igstUsd") if scheme == "igst" else 0
        if not math.isfinite(igst_usd) or igst_usd < 0 or igst_usd > 1e11:
            raise ApiError(400, "Enter the IGST amount in USD.")
        port_code = data["portCode"].strip().upper()[:6] if isinstance(data.get("portCode"), str) else ""
        if port_code and not re.match(r"^[A-Z0-9]{6}$", port_code):
            raise ApiError(400, "Enter the six-character port code from the shipping bill, like INBOM4.")
        sb_invoice_number = data["sbInvoiceNumber"].strip()[:40] if isinstance(data.get("sbInvoiceNumber"), str) else ""
        raw_value = data.get("sbValueUsd")
        sb_value_usd = None if raw_value is None or raw_value == "" else money(raw_value)
        if sb_value_usd is not None and (not math.isfinite(sb_value_usd) or sb_value_usd < 0 or sb_value_usd > 1e11):
            raise ApiError(400, "Enter the shipping bill value in USD.")
        await pool.execute(
            """INSERT INTO invoice_tax (invoice_id, organization_id, export_scheme, shipping_bill_no, shipping_bill_date, igst_usd,
                                        port_code, sb_invoice_number, sb_value_usd)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (invoice_id) DO UPDATE SET
                 export_scheme = EXCLUDED.export_scheme, shipping_bill_no = EXCLUDED.shipping_bill_no,
                 shipping_bill_date = EXCLUDED.shipping_bill_date, igst_usd = EXCLUDED.igst_usd, port_code = EXCLUDED.port_code,
                 sb_invoice_number = EXCLUDED.sb_invoice_number, sb_value_usd = EXCLUDED.sb_value_usd""",
            invoice_id, user.organization_id, scheme, shipping_bill_no, bill_date, igst_usd, port_code, sb_invoice_number, sb_value_usd,
        )
        return {"exportScheme": scheme, "shippingBillNo": shipping_bill_no, "shippingBillDate": shipping_bill_date, "igstUsd": igst_usd,
                "portCode": port_code, "sbInvoiceNumber": sb_invoice_number, "sbValueUsd": sb_value_usd}

    @router.post("/api/invoices/{invoice_id}/documents")
    async def upload_document(invoice_id: str, request: Request, user: CurrentUser = Depends(tax_writer)):
        pool: Pool = request.app.state.pool
        await _check_open(pool, user.organization_id, await _invoice_date(pool, invoice_id, user.organization_id))
        data = body(request)
        kind = data.get("kind")
        if kind not in DOCUMENT_KINDS:
            raise ApiError(400, "Choose a shipping bill, airway bill, or LUT.")
        content_type = data.get("contentType") if isinstance(data.get("contentType"), str) else ""
        if content_type not in DOCUMENT_TYPES:
            raise ApiError(400, "Upload a PDF, JPEG, or PNG.")
        content = decode_base64(data.get("dataBase64"))
        if not content or len(content) > MAX_DOCUMENT_BYTES:
            raise ApiError(400, "The file must be a PDF or image under 1.5 MB.")
        file_name = safe_file_name(data.get("fileName"))
        saved_id = await pool.fetchval(
            """INSERT INTO invoice_documents (invoice_id, organization_id, kind, file_name, content_type, byte_size, content, uploaded_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (invoice_id, kind) DO UPDATE SET
                 file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type, byte_size = EXCLUDED.byte_size,
                 content = EXCLUDED.content, uploaded_by = EXCLUDED.uploaded_by, created_at = now()
               RETURNING id""",
            invoice_id, user.organization_id, kind, file_name, content_type, len(content), content, user.id,
        )
        return JSONResponse({"id": saved_id, "kind": kind, "fileName": file_name, "byteSize": len(content)}, status_code=201)

    @router.get("/api/invoices/{invoice_id}/documents/{document_id}")
    async def download_document(invoice_id: str, document_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        if not is_uuid(invoice_id) or not is_uuid(document_id):
            raise ApiError(404, "Document not found.")
        file = await request.app.state.pool.fetchrow(
            "SELECT file_name, content_type, content FROM invoice_documents WHERE id = $1 AND invoice_id = $2 AND organization_id = $3",
            document_id, invoice_id, user.organization_id,
        )
        if not file:
            raise ApiError(404, "Document not found.")
        name = file["file_name"].replace('"', "")
        return Response(bytes(file["content"]), media_type=file["content_type"], headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @router.delete("/api/invoices/{invoice_id}/documents/{document_id}")
    async def delete_document(invoice_id: str, document_id: str, request: Request, user: CurrentUser = Depends(tax_writer)):
        if not is_uuid(invoice_id) or not is_uuid(document_id):
            raise ApiError(404, "Document not found.")
        pool: Pool = request.app.state.pool
        await _check_open(pool, user.organization_id, await _invoice_date(pool, invoice_id, user.organization_id))
        result = await pool.execute(
            "DELETE FROM invoice_documents WHERE id = $1 AND invoice_id = $2 AND organization_id = $3", document_id, invoice_id, user.organization_id
        )
        if result == "DELETE 0":
            raise ApiError(404, "Document not found.")
        return Response(status_code=204)

    @router.put("/api/invoices/{invoice_id}/review")
    async def review(invoice_id: str, request: Request, user: CurrentUser = Depends(chartered_accountant)):
        if not is_uuid(invoice_id):
            raise ApiError(404, "Invoice not found.")
        data = body(request)
        status = data.get("status")
        if status not in ("query", "accepted"):
            raise ApiError(400, "Mark the invoice as a query or accepted.")
        comment = data["comment"].strip()[:2000] if isinstance(data.get("comment"), str) else ""
        if status == "query" and not comment:
            raise ApiError(400, "Write what the team needs to fix.")
        pool: Pool = request.app.state.pool
        if not await pool.fetchval("SELECT 1 FROM invoices WHERE id = $1 AND organization_id = $2", invoice_id, user.organization_id):
            raise ApiError(404, "Invoice not found.")
        await pool.execute(
            """INSERT INTO invoice_reviews (invoice_id, organization_id, status, comment, reviewed_by)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (invoice_id) DO UPDATE SET status = EXCLUDED.status, comment = EXCLUDED.comment,
                 reviewed_by = EXCLUDED.reviewed_by, updated_at = now()""",
            invoice_id, user.organization_id, status, comment, user.id,
        )
        return {"status": status, "comment": comment}

    return router


def decode_base64(value) -> bytes:
    """Buffer.from(text, 'base64'): a data: prefix is dropped, and bad input gives no bytes."""
    if not isinstance(value, str):
        return b""
    encoded = re.sub(r"^data:[^,]+,", "", value)
    encoded = re.sub(r"[^A-Za-z0-9+/_-]", "", encoded).replace("-", "+").replace("_", "/")
    try:
        return base64.b64decode(encoded + "=" * (-len(encoded) % 4))
    except (binascii.Error, ValueError):
        return b""


def safe_file_name(value, fallback: str = "document") -> str:
    raw = value if isinstance(value, str) else fallback
    last = re.split(r"[/\\]", raw)[-1]
    return re.sub(r"[^\w.\- ()]+", "", last, flags=re.ASCII)[:180] or fallback
