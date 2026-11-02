"""Daily USD/INR rates (port of server/modules/tax/rates.ts).

Reference rates come from Frankfurter (ECB reference rates); RBI has no public API. A company can enter
its own rate for a date, such as the customs notified rate, and that rate wins over the reference rate.
"""

from __future__ import annotations

import hmac
import logging
import math
import os
import re
from datetime import date, datetime, timedelta, timezone

import httpx
from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import parse_loose_date
from ...core.housekeeping import purge_expired_rows
from ...core.http import ApiError, CurrentUser, body, require_user
from ...core.numbers import js_number
from .shared import tax_manager

log = logging.getLogger("diamondx.rates")

REFERENCE_SOURCE = "ECB reference (Frankfurter)"
REFERENCE_WINDOW_DAYS = 7
COMPANY_WINDOW_DAYS = 31
BACKFILL_DAYS = 400


def rate_source_url() -> str:
    return (os.environ.get("EXCHANGE_RATE_URL") or "https://api.frankfurter.dev/v1").rstrip("/")


def _today() -> date:
    return datetime.now(timezone.utc).date()


async def fetch_reference_rates(start: date, end: date, transport: httpx.AsyncBaseTransport | None = None) -> list[tuple[date, float]]:
    async with httpx.AsyncClient(transport=transport, timeout=8.0) as client:
        response = await client.get(f"{rate_source_url()}/{start.isoformat()}..{end.isoformat()}", params={"base": "USD", "symbols": "INR"})
    if response.status_code >= 400:
        raise RuntimeError(f"The rate source answered {response.status_code}.")
    rates = (response.json() or {}).get("rates") or {}
    points = []
    for day, rate in rates.items():
        value = rate.get("INR") if isinstance(rate, dict) else None
        if re.match(r"^\d{4}-\d{2}-\d{2}$", day) and isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            points.append((date.fromisoformat(day), float(value)))
    return points


async def refresh_reference_rates(pool: Pool, transport: httpx.AsyncBaseTransport | None = None) -> dict:
    """Fetches every day since the last stored rate (or the last ~13 months on first run)."""
    today = _today()
    last = await pool.fetchval("SELECT MAX(rate_date) FROM reference_rates WHERE currency = 'USD'")
    start = last + timedelta(days=1) if last else today - timedelta(days=BACKFILL_DAYS)
    if start > today:
        return {"added": 0, "latest": last.isoformat() if last else None}
    points = await fetch_reference_rates(start, today, transport)
    added = 0
    for day, rate in points:
        result = await pool.execute(
            """INSERT INTO reference_rates (currency, rate_date, rate_inr, source) VALUES ('USD', $1, $2, $3)
               ON CONFLICT (currency, rate_date) DO NOTHING""",
            day, rate, REFERENCE_SOURCE,
        )
        added += int(result.rsplit(" ", 1)[-1])
    latest = points[-1][0] if points else last
    return {"added": added, "latest": latest.isoformat() if latest else None}


def rate_lateral(organization_expr: str, date_expr: str) -> str:
    """A LATERAL subquery yielding rate_inr, rate_source and rate_date for the date: the company's own
    rate within a month before it, else the reference rate within a week."""
    return f"""(
    SELECT r.rate_inr, r.rate_source, r.rate_date FROM (
      SELECT o.rate_inr, 'Company rate' AS rate_source, o.rate_date, 0 AS preference
      FROM organization_rates o
      WHERE o.organization_id = {organization_expr} AND o.currency = 'USD'
        AND o.rate_date <= {date_expr} AND o.rate_date > {date_expr} - {COMPANY_WINDOW_DAYS}
      UNION ALL
      SELECT x.rate_inr, x.source AS rate_source, x.rate_date, 1 AS preference
      FROM reference_rates x
      WHERE x.currency = 'USD' AND x.rate_date <= {date_expr} AND x.rate_date > {date_expr} - {REFERENCE_WINDOW_DAYS}
    ) r ORDER BY r.preference, r.rate_date DESC LIMIT 1
  )"""


async def rate_on(pool: Pool, organization_id: str, day: str | date) -> dict | None:
    value = date.fromisoformat(day) if isinstance(day, str) else day
    row = await pool.fetchrow(
        f"SELECT rate_inr, rate_source, to_char(rate_date, 'YYYY-MM-DD') AS rate_date FROM {rate_lateral('$1::uuid', '$2::date')} AS found",
        organization_id, value,
    )
    return {"rateInr": float(row["rate_inr"]), "source": row["rate_source"], "date": row["rate_date"]} if row else None


async def list_rates(pool: Pool, organization_id: str, start: date, end: date) -> dict:
    reference = await pool.fetch(
        """SELECT to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_inr, source FROM reference_rates
           WHERE currency = 'USD' AND rate_date BETWEEN $1 AND $2 ORDER BY rate_date DESC""",
        start, end,
    )
    company = await pool.fetch(
        """SELECT to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_inr, note FROM organization_rates
           WHERE organization_id = $1 AND currency = 'USD' AND rate_date BETWEEN $2 AND $3 ORDER BY rate_date DESC""",
        organization_id, start, end,
    )
    return {
        "reference": [{"date": r["rate_date"], "rateInr": float(r["rate_inr"]), "source": r["source"]} for r in reference],
        "company": [{"date": r["rate_date"], "rateInr": float(r["rate_inr"]), "note": r["note"]} for r in company],
    }


def cron_authorized(request: Request) -> bool:
    secret = os.environ.get("CRON_SECRET")
    if not secret:
        return False
    sent = request.headers.get("authorization", "")
    return hmac.compare_digest(sent.encode(), f"Bearer {secret}".encode())


def build_router():
    router = api_router(prefix="/api")

    def transport(request: Request):
        return request.app.state.options.rates_transport

    # Called once a day by Vercel Cron (see vercel.json). Vercel sends CRON_SECRET as a bearer token.
    @router.get("/cron/rates")
    async def cron(request: Request):
        if not cron_authorized(request):
            raise ApiError(401, "Not allowed.")
        pool: Pool = request.app.state.pool
        refreshed = await refresh_reference_rates(pool, transport(request))
        try:
            purged = await purge_expired_rows(pool)
        except Exception as error:
            log.error("Cleanup of expired rows failed: %s", error)
            purged = None
        return {**refreshed, "purged": purged}

    @router.get("/rates")
    async def rates(request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        today = _today()
        end = parse_loose_date(request.query_params.get("to", "")) or today.isoformat()
        start = parse_loose_date(request.query_params.get("from", "")) or (date.fromisoformat(end) - timedelta(days=45)).isoformat()
        # Keep the table fresh even without the cron: refresh when the newest rate is more than two days old.
        newest = await pool.fetchval("SELECT MAX(rate_date) FROM reference_rates WHERE currency = 'USD'")
        refresh_error = ""
        if not newest or newest < today - timedelta(days=2):
            try:
                await refresh_reference_rates(pool, transport(request))
            except Exception as error:
                refresh_error = f"Could not reach the rate source: {error}"
        latest = await rate_on(pool, user.organization_id, today)
        listed = await list_rates(pool, user.organization_id, date.fromisoformat(start), date.fromisoformat(end))
        return {"today": today.isoformat(), "latest": latest, **listed, "refreshError": refresh_error, "source": REFERENCE_SOURCE}

    @router.get("/rates/on")
    async def rates_on(request: Request, user: CurrentUser = Depends(require_user)):
        day = parse_loose_date(request.query_params.get("date", ""))
        if not day:
            raise ApiError(400, "Give a date as YYYY-MM-DD.")
        return {"date": day, "rate": await rate_on(request.app.state.pool, user.organization_id, day)}

    @router.post("/rates/refresh")
    async def refresh(request: Request, user: CurrentUser = Depends(tax_manager)):
        try:
            return await refresh_reference_rates(request.app.state.pool, transport(request))
        except Exception as error:
            raise ApiError(502, f"Could not reach the rate source: {error}") from None

    @router.put("/rates/company")
    async def set_company_rate(request: Request, user: CurrentUser = Depends(tax_manager)):
        data = body(request)
        raw_date = data.get("date")
        day = parse_loose_date("" if raw_date is None else str(raw_date))
        rate = js_number(data["rateInr"]) if "rateInr" in data else math.nan
        if not day:
            raise ApiError(400, "Enter the date as YYYY-MM-DD.")
        if not math.isfinite(rate) or rate <= 0 or rate > 10000:
            raise ApiError(400, "Enter the rate in rupees per US dollar.")
        note = data["note"].strip()[:200] if isinstance(data.get("note"), str) else ""
        await request.app.state.pool.execute(
            """INSERT INTO organization_rates (organization_id, currency, rate_date, rate_inr, note, entered_by)
               VALUES ($1, 'USD', $2, $3, $4, $5)
               ON CONFLICT (organization_id, currency, rate_date) DO UPDATE SET rate_inr = EXCLUDED.rate_inr, note = EXCLUDED.note,
                 entered_by = EXCLUDED.entered_by, created_at = now()""",
            user.organization_id, date.fromisoformat(day), rate, note, user.id,
        )
        return {"date": day, "rateInr": rate, "note": note}

    @router.delete("/rates/company/{day}")
    async def delete_company_rate(day: str, request: Request, user: CurrentUser = Depends(tax_manager)):
        parsed = parse_loose_date(day)
        if not parsed:
            raise ApiError(404, "Rate not found.")
        result = await request.app.state.pool.execute(
            "DELETE FROM organization_rates WHERE organization_id = $1 AND currency = 'USD' AND rate_date = $2",
            user.organization_id, date.fromisoformat(parsed),
        )
        if result == "DELETE 0":
            raise ApiError(404, "Rate not found.")
        return {"deleted": True}

    return router
