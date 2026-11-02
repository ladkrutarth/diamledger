"""Helpers shared by the tax, stock and report modules (from server/modules/tax/taxShared.ts)."""

from __future__ import annotations

import re
from typing import Any, Iterable

from fastapi import Response

from ...core.http import require_roles
from ...core.numbers import js_string, money  # noqa: F401  (money is re-exported for the tax modules)

tax_reader = require_roles("admin", "tax", "ca")
tax_writer = require_roles("admin", "member", "tax")
tax_manager = require_roles("admin", "tax")
chartered_accountant = require_roles("ca")

DIAMOND_GST_RATE = 0.25


def csv_cell(value: Any) -> str:
    """One CSV cell. A leading = + - @ is quoted with ' so a spreadsheet does not run it as a formula."""
    raw = "" if value is None else (value if isinstance(value, str) else js_string(value))
    safe = f"'{raw}" if re.match(r"^[=+\-@]", raw) else raw
    return '"' + safe.replace('"', '""') + '"' if re.search(r'[",\n\r]', safe) else safe


def csv_file(header: list[str], rows: Iterable[Iterable[Any]]) -> bytes:
    lines = [",".join(csv_cell(cell) for cell in row) for row in [header, *rows]]
    return ("﻿" + "\r\n".join(lines) + "\r\n").encode("utf-8")


def csv_response(filename: str, body: bytes) -> Response:
    return Response(body, media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def is_rough_hs_code(hs_code: str) -> bool:
    digits = re.sub(r"\D", "", hs_code)
    return digits.startswith(("710210", "710221", "710231"))


# --- Downloads -------------------------------------------------------------------------------------


def zip_files(files: list[tuple[str, bytes]]) -> bytes:
    """An uncompressed zip, as core/zip.ts wrote it."""
    import io
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in files:
            archive.writestr(name, data)
    return buffer.getvalue()


def zip_response(filename: str, files: list[tuple[str, bytes]]) -> Response:
    return Response(zip_files(files), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def download_response(filename: str, content_type: str, body: str | bytes) -> Response:
    return Response(body, media_type=content_type, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# --- Months and settings ---------------------------------------------------------------------------


def current_month() -> str:
    from datetime import date

    return date.today().strftime("%Y-%m")


async def month_is_closed(pool, organization_id: str, month: str) -> bool:
    from datetime import date

    year, mon = (int(part) for part in month.split("-"))
    return bool(await pool.fetchval("SELECT 1 FROM closed_months WHERE organization_id = $1 AND month = $2", organization_id, date(year, mon, 1)))


async def invoice_date_of(pool, organization_id: str, invoice_id: str) -> str | None | bool:
    """The invoice's date (or created date); False when there is no such invoice."""
    row = await pool.fetchrow(
        """SELECT to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date
           FROM invoices WHERE id = $1 AND organization_id = $2""",
        invoice_id, organization_id,
    )
    return row["invoice_date"] if row else False


async def tax_settings(pool, organization_id: str) -> dict:
    row = await pool.fetchrow(
        """SELECT realization_months, to_char(lut_valid_until, 'YYYY-MM-DD') AS lut_valid_until, einvoice_required
           FROM organization_tax_settings WHERE organization_id = $1""",
        organization_id,
    )
    return {
        "realizationMonths": row["realization_months"] if row else 9,
        "lutValidUntil": row["lut_valid_until"] if row else None,
        "einvoiceRequired": row["einvoice_required"] if row else True,
    }


# --- Reading uploaded files ------------------------------------------------------------------------


def parse_csv(text: str) -> list[list[str]]:
    """CSV text as rows of cells, with quoted commas, quotes and line breaks. Blank rows are skipped."""
    rows: list[list[str]] = []
    row: list[str] = []
    cell: list[str] = []
    quoted = False
    source = text[1:] if text.startswith("﻿") else text
    i, n = 0, len(source)
    while i < n:
        char = source[i]
        if quoted:
            if char == '"' and i + 1 < n and source[i + 1] == '"':
                cell.append('"')
                i += 1
            elif char == '"':
                quoted = False
            else:
                cell.append(char)
        elif char == '"':
            quoted = True
        elif char == ",":
            row.append("".join(cell))
            cell = []
        elif char in "\r\n":
            if char == "\r" and i + 1 < n and source[i + 1] == "\n":
                i += 1
            row.append("".join(cell))
            if any(value.strip() for value in row):
                rows.append(row)
            row, cell = [], []
        else:
            cell.append(char)
        i += 1
    row.append("".join(cell))
    if any(value.strip() for value in row):
        rows.append(row)
    return rows


def find_column(header: list[str], names: list[str]) -> int:
    normalized = [re.sub(r"[^a-z0-9]+", " ", value.strip().lower()).strip() for value in header]
    for name in names:
        if name in normalized:
            return normalized.index(name)
    return -1


def parse_amount(value: str | None) -> float | None:
    import math

    from ...core.numbers import js_number

    raw = re.sub(r"^USD", "", re.sub(r"[,\s$]", "", value or ""), flags=re.IGNORECASE)
    if not raw:
        return None
    amount = js_number(raw)
    return money(amount) if math.isfinite(amount) else None
