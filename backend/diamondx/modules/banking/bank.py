"""Bank statement import and matching credits to invoices (port of server/modules/banking/bank.ts)."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import date

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import parse_loose_date
from ...core.http import ApiError, CurrentUser, body, is_uuid
from ...core.numbers import js_string, money, to_fixed
from ..invoices.payments import parse_bank_rate, record_payment
from ..tax.shared import find_column, parse_amount, parse_csv, tax_reader, tax_writer

MAX_IMPORT_ROWS = 2000
NAME_NOISE = {
    "LTD", "LIMITED", "INC", "LLC", "CO", "COMPANY", "CORP", "BVBA", "DMCC", "FZE", "FZCO", "GMBH", "SONS",
    "TRADING", "DIAMONDS", "DIAMOND", "GEMS", "JEWELS", "JEWELRY", "JEWELLERY", "INTERNATIONAL", "THE", "AND",
}


def _squash(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def suggest_matches(line: dict, invoices: list[dict]) -> list[dict]:
    """Up to three invoices this credit probably pays, best first, with the reasons."""
    text = f"{line['reference']} {line['narration']}".upper()
    squashed = _squash(text)
    words = {w for w in re.split(r"[^A-Z0-9]+", text) if w}
    suggestions = []
    for invoice in invoices:
        if invoice["dueUsd"] <= 0:
            continue
        score, reasons = 0, []
        number = _squash(invoice["invoiceNumber"])
        tail = re.split(r"[/-]", invoice["invoiceNumber"])[-1]
        if len(number) >= 4 and number in squashed:
            score += 60
            reasons.append("Invoice number is in the narration")
        elif len(tail) >= 4 and tail.upper() in words:
            score += 25
            reasons.append(f"Invoice serial {tail} is in the narration")
        tokens = [t for t in re.split(r"[^A-Z0-9]+", invoice["buyerName"].upper()) if len(t) >= 4 and t not in NAME_NOISE]
        if tokens and any(t in words for t in tokens):
            score += 25
            reasons.append("Buyer name matches the remitter")
        short_by = money(invoice["dueUsd"] - line["amountUsd"])
        if abs(short_by) <= 0.01:
            score += 30
            reasons.append("Amount equals the balance due")
        elif 0 < short_by <= max(75, invoice["dueUsd"] * 0.005):
            score += 20
            reasons.append(f"Short by ${to_fixed(short_by, 2)}, probably bank charges")
        elif short_by > 0:
            score += 5
            reasons.append("Part payment")
        else:
            continue
        if score >= 25:
            suggestions.append({
                "invoiceId": invoice["id"],
                "invoiceNumber": invoice["invoiceNumber"],
                "buyerName": invoice["buyerName"],
                "dueUsd": invoice["dueUsd"],
                "score": min(100, score),
                "reasons": reasons,
                "shortByUsd": max(0, short_by),
            })
    return sorted(suggestions, key=lambda s: -s["score"])[:3]


async def open_invoices(pool: Pool, organization_id: str) -> list[dict]:
    rows = await pool.fetch(
        """SELECT i.id, i.invoice_number, i.buyer_name, i.total_usd,
                  COALESCE((SELECT SUM(amount_usd) FROM payments WHERE invoice_id = i.id), 0) AS paid_usd
           FROM invoices i WHERE i.organization_id = $1 AND i.status = 'issued'""",
        organization_id,
    )
    return [{"id": r["id"], "invoiceNumber": r["invoice_number"], "buyerName": r["buyer_name"],
             "dueUsd": money(float(r["total_usd"]) - float(r["paid_usd"]))} for r in rows]


async def bank_lines(pool: Pool, organization_id: str, status: str, limit: int = 300) -> list[dict]:
    rows = await pool.fetch(
        """SELECT b.id, to_char(b.line_date, 'YYYY-MM-DD') AS line_date, b.amount_usd, b.bank_rate_inr, b.reference, b.narration,
                  b.status, b.invoice_id, i.invoice_number
           FROM bank_lines b LEFT JOIN invoices i ON i.id = b.invoice_id
           WHERE b.organization_id = $1 AND b.status = $2
           ORDER BY b.line_date DESC, b.created_at DESC
           LIMIT $3""",
        organization_id, status, max(1, int(limit)),
    )
    invoices = await open_invoices(pool, organization_id) if status == "unmatched" else []
    result = []
    for r in rows:
        amount_usd = money(r["amount_usd"])
        result.append({
            "id": r["id"],
            "lineDate": r["line_date"],
            "amountUsd": amount_usd,
            "bankRateInr": None if r["bank_rate_inr"] is None else float(r["bank_rate_inr"]),
            "reference": r["reference"],
            "narration": r["narration"],
            "status": r["status"],
            "invoiceId": r["invoice_id"],
            "invoiceNumber": r["invoice_number"],
            "suggestions": suggest_matches({"amountUsd": amount_usd, "reference": r["reference"], "narration": r["narration"]}, invoices)
            if status == "unmatched" else [],
        })
    return result


async def current_suggestion(pool: Pool, organization_id: str, line_id: str, invoice_id: str) -> dict | None:
    """The matcher's current suggestion linking this unmatched line to this invoice, if there is one."""
    found = await pool.fetchrow(
        "SELECT amount_usd, reference, narration FROM bank_lines WHERE id = $1 AND organization_id = $2 AND status = 'unmatched'",
        line_id, organization_id,
    )
    if not found:
        return None
    suggestions = suggest_matches(
        {"amountUsd": money(found["amount_usd"]), "reference": found["reference"], "narration": found["narration"]},
        await open_invoices(pool, organization_id),
    )
    return next((s for s in suggestions if s["invoiceId"] == invoice_id), None)


@dataclass
class BankMatchResult:
    ok: bool
    status: int | str = 200
    error: str | None = None
    due_usd: float = 0
    payment_id: str | None = None


_MISSING = object()


async def match_bank_line(pool: Pool, user: CurrentUser, line_id: str, invoice_id: str, bank_rate_inr=_MISSING) -> BankMatchResult:
    found = await pool.fetchrow(
        """SELECT to_char(line_date, 'YYYY-MM-DD') AS line_date, amount_usd, bank_rate_inr, reference, narration, status
           FROM bank_lines WHERE id = $1 AND organization_id = $2""",
        line_id, user.organization_id,
    )
    if not found:
        return BankMatchResult(False, 404, "Bank line not found.")
    if found["status"] != "unmatched":
        return BankMatchResult(False, 409, "This bank line is already dealt with.")
    claimed = await pool.execute(
        "UPDATE bank_lines SET status = 'matched' WHERE id = $1 AND organization_id = $2 AND status = 'unmatched'", line_id, user.organization_id
    )
    if claimed == "UPDATE 0":
        return BankMatchResult(False, 409, "This bank line is already dealt with.")

    async def release() -> None:
        await pool.execute("UPDATE bank_lines SET status = 'unmatched' WHERE id = $1 AND payment_id IS NULL", line_id)

    rate = found["bank_rate_inr"] if bank_rate_inr is _MISSING or bank_rate_inr == "" else bank_rate_inr
    try:
        result = await record_payment(
            pool, user, invoice_id,
            {
                "amountUsd": found["amount_usd"],
                "paidOn": found["line_date"],
                "reference": found["reference"] or found["narration"][:200],
                "bankRateInr": rate,
            },
            within_balance=True,
        )
    except Exception:
        await release()
        raise
    if not result.ok:
        await release()
        return BankMatchResult(False, result.status, result.error)
    await pool.execute("UPDATE bank_lines SET invoice_id = $2, payment_id = $3 WHERE id = $1", line_id, invoice_id, result.payment_id)
    return BankMatchResult(True, result.state["status"], due_usd=result.state["dueUsd"], payment_id=result.payment_id)


async def insert_bank_line(pool: Pool, organization_id: str, line_date: str, amount: float, rate: float | None, reference: str, narration: str) -> bool:
    reference, narration = reference.strip()[:200], narration.strip()[:500]
    fingerprint = hashlib.sha256("|".join([line_date, to_fixed(amount, 2), reference, narration]).encode()).hexdigest()
    result = await pool.execute(
        """INSERT INTO bank_lines (organization_id, line_date, amount_usd, bank_rate_inr, reference, narration, fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (organization_id, fingerprint) DO NOTHING""",
        organization_id, date.fromisoformat(line_date), amount, rate, reference, narration, fingerprint,
    )
    return result != "INSERT 0 0"


def build_router():
    router = api_router(prefix="/api/bank")

    @router.post("/import")
    async def import_csv(request: Request, user: CurrentUser = Depends(tax_writer)):
        data = body(request)
        rows = parse_csv(data["csv"] if isinstance(data.get("csv"), str) else "")
        if len(rows) < 2:
            raise ApiError(400, "Upload a CSV with a header row and at least one transaction.")
        if len(rows) > MAX_IMPORT_ROWS + 1:
            raise ApiError(400, f"Import at most {MAX_IMPORT_ROWS} lines at a time.")
        header, lines = rows[0], rows[1:]
        date_col = find_column(header, ["value date", "date", "txn date", "transaction date", "posting date"])
        amount_col = find_column(header, ["credit", "credit amount", "amount", "amount usd", "usd", "deposit"])
        ref_col = find_column(header, ["reference", "ref", "ref no", "utr", "swift reference", "cheque no"])
        narration_col = find_column(header, ["narration", "description", "details", "remitter", "particulars", "remarks"])
        rate_col = find_column(header, ["rate", "exchange rate", "inr rate", "conversion rate"])
        if date_col < 0 or amount_col < 0:
            raise ApiError(400, "The CSV needs a date column and a credit or amount column.")

        def cell(cells: list[str], index: int) -> str | None:
            return cells[index] if 0 <= index < len(cells) else None

        pool: Pool = request.app.state.pool
        imported = duplicates = skipped = 0
        for cells in lines:
            line_date = parse_loose_date(cell(cells, date_col))
            amount = parse_amount(cell(cells, amount_col))
            raw_rate = cell(cells, rate_col) if rate_col >= 0 else None
            rate = parse_bank_rate(raw_rate.strip() if raw_rate is not None else None) if rate_col >= 0 else None
            if not line_date or amount is None or amount <= 0 or rate is False:
                skipped += 1
                continue
            reference = (cell(cells, ref_col) or "") if ref_col >= 0 else ""
            narration = (cell(cells, narration_col) or "") if narration_col >= 0 else ""
            if await insert_bank_line(pool, user.organization_id, line_date, amount, rate, reference, narration):
                imported += 1
            else:
                duplicates += 1
        return JSONResponse({"imported": imported, "duplicates": duplicates, "skipped": skipped}, status_code=201)

    # Lines read from a statement by the AI reader, after the user has checked them.
    @router.post("/import-lines")
    async def import_lines(request: Request, user: CurrentUser = Depends(tax_writer)):
        data = body(request)
        lines = data["lines"] if isinstance(data.get("lines"), list) else []
        if not lines:
            raise ApiError(400, "There are no lines to import.")
        if len(lines) > MAX_IMPORT_ROWS:
            raise ApiError(400, f"Import at most {MAX_IMPORT_ROWS} lines at a time.")
        pool: Pool = request.app.state.pool
        imported = duplicates = skipped = 0
        for raw in lines:
            line = raw if isinstance(raw, dict) else {}
            line_date = parse_loose_date(line["date"] if isinstance(line.get("date"), str) else None)
            amount = parse_amount(None if line.get("amountUsd") is None else js_string(line["amountUsd"]))
            raw_rate = line.get("bankRateInr")
            rate = None if raw_rate is None or raw_rate == "" else parse_bank_rate(js_string(raw_rate))
            if not line_date or amount is None or amount <= 0 or rate is False:
                skipped += 1
                continue
            reference = line["reference"] if isinstance(line.get("reference"), str) else ""
            narration = line["narration"] if isinstance(line.get("narration"), str) else ""
            if await insert_bank_line(pool, user.organization_id, line_date, amount, rate, reference, narration):
                imported += 1
            else:
                duplicates += 1
        return JSONResponse({"imported": imported, "duplicates": duplicates, "skipped": skipped}, status_code=201)

    @router.get("/lines")
    async def list_lines(request: Request, user: CurrentUser = Depends(tax_reader)):
        requested = request.query_params.get("status")
        status = requested if requested in ("matched", "ignored") else "unmatched"
        pool: Pool = request.app.state.pool
        lines = await bank_lines(pool, user.organization_id, status)
        counts = await pool.fetch("SELECT status, COUNT(*) AS count FROM bank_lines WHERE organization_id = $1 GROUP BY status", user.organization_id)
        return {"status": status, "counts": {r["status"]: r["count"] for r in counts}, "lines": lines}

    @router.post("/lines/{line_id}/match")
    async def match(line_id: str, request: Request, user: CurrentUser = Depends(tax_writer)):
        data = body(request)
        invoice_id = data.get("invoiceId")
        if not is_uuid(line_id) or not isinstance(invoice_id, str) or not is_uuid(invoice_id):
            raise ApiError(404, "Bank line not found.")
        result = await match_bank_line(
            request.app.state.pool, user, line_id, invoice_id, data["bankRateInr"] if "bankRateInr" in data else _MISSING
        )
        if not result.ok:
            raise ApiError(int(result.status), result.error or "")
        return {"matched": True, "dueUsd": result.due_usd, "status": result.status}

    @router.post("/lines/{line_id}/ignore")
    async def ignore(line_id: str, request: Request, user: CurrentUser = Depends(tax_writer)):
        if not is_uuid(line_id):
            raise ApiError(404, "Bank line not found.")
        result = await request.app.state.pool.execute(
            "UPDATE bank_lines SET status = 'ignored' WHERE id = $1 AND organization_id = $2 AND status = 'unmatched'", line_id, user.organization_id
        )
        if result == "UPDATE 0":
            raise ApiError(404, "Bank line not found.")
        return {"ignored": True}

    return router

