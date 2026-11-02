"""Dashboard figures and the cash-flow forecast (port of server/modules/invoices/dashboard.ts)."""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone

from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import CurrentUser, require_user
from ...core.numbers import js_round, round_to

EFFECTIVE_DATE = "COALESCE(i.invoice_date, i.created_at::date)"
DUE_DATE = f"({EFFECTIVE_DATE} + i.credit_days)"
PAID = "COALESCE(p.paid, 0)"
BALANCE = f"(i.total_usd - {PAID})"
OPEN_FROM = f"""
  FROM invoices i
  LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid FROM payments WHERE invoice_id = i.id) p ON true
  WHERE i.organization_id = $1 AND i.status = 'issued' AND {BALANCE} > 0"""

AGING_ORDER = [
    ("current", "Not yet due"),
    ("1-30", "1–30 days"),
    ("31-60", "31–60 days"),
    ("61-90", "61–90 days"),
    ("90+", "Over 90 days"),
]


def _money(value) -> float:
    return round_to(float(value), 2)


async def dashboard(pool: Pool, organization_id: str) -> dict:
    queries = [
        (
            f"""SELECT COUNT(*) AS count, COALESCE(SUM(total_usd), 0) AS total_usd, COALESCE(SUM(total_carats), 0) AS total_carats
                FROM invoices i
                WHERE organization_id = $1 AND status IN ('issued', 'paid')
                  AND {EFFECTIVE_DATE} >= date_trunc('month', current_date)""",
            True,
        ),
        (
            """SELECT COUNT(*) AS count, COALESCE(SUM(amount_usd), 0) AS total_usd
               FROM payments WHERE organization_id = $1 AND paid_on >= date_trunc('month', current_date)""",
            True,
        ),
        (
            """SELECT COALESCE(NULLIF(destination_country, ''), 'Not set') AS country, COUNT(*) AS count, SUM(total_usd) AS total_usd
               FROM invoices i WHERE organization_id = $1 AND status IN ('issued', 'paid')
               GROUP BY 1 ORDER BY SUM(total_usd) DESC LIMIT 8""",
            False,
        ),
        (
            f"""SELECT to_char(span.month, 'YYYY-MM') AS month, to_char(span.month, 'Mon') AS label,
                       COUNT(i.id) AS count, COALESCE(SUM(i.total_usd), 0) AS total_usd
                FROM generate_series(date_trunc('month', current_date) - interval '5 months',
                                     date_trunc('month', current_date), interval '1 month') AS span(month)
                LEFT JOIN invoices i
                  ON i.organization_id = $1 AND i.status IN ('issued', 'paid')
                 AND date_trunc('month', {EFFECTIVE_DATE}) = span.month
                GROUP BY span.month ORDER BY span.month""",
            False,
        ),
        (
            f"""SELECT CASE
                         WHEN {DUE_DATE} >= current_date THEN 'current'
                         WHEN current_date - {DUE_DATE} <= 30 THEN '1-30'
                         WHEN current_date - {DUE_DATE} <= 60 THEN '31-60'
                         WHEN current_date - {DUE_DATE} <= 90 THEN '61-90'
                         ELSE '90+'
                       END AS bucket, COUNT(*) AS count, SUM({BALANCE}) AS due_usd
                {OPEN_FROM}
                GROUP BY 1""",
            False,
        ),
        (
            f"""SELECT i.buyer_name, COUNT(*) AS invoices, SUM({BALANCE}) AS due_usd,
                       SUM(CASE WHEN {DUE_DATE} < current_date THEN {BALANCE} ELSE 0 END) AS overdue_usd
                {OPEN_FROM}
                GROUP BY i.buyer_name ORDER BY due_usd DESC LIMIT 6""",
            False,
        ),
        (
            f"""SELECT i.id, i.invoice_number, i.buyer_name, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
                       to_char({DUE_DATE}, 'YYYY-MM-DD') AS due_date,
                       GREATEST(current_date - {DUE_DATE}, 0) AS days_overdue,
                       {DUE_DATE} < current_date AS overdue,
                       i.total_usd, {PAID} AS paid_usd
                {OPEN_FROM}
                ORDER BY overdue DESC, days_overdue DESC, {BALANCE} DESC LIMIT 8""",
            False,
        ),
        (f"SELECT COUNT(*) AS count, COALESCE(SUM({BALANCE}), 0) AS due_usd {OPEN_FROM}", True),
        ("SELECT status, COUNT(*) AS count FROM invoices WHERE organization_id = $1 GROUP BY status", False),
    ]

    async def run(sql: str, single: bool):
        return await (pool.fetchrow(sql, organization_id) if single else pool.fetch(sql, organization_id))

    month, collected, countries, months, aging, buyers, attention, open_totals, statuses = await asyncio.gather(
        *(run(sql, single) for sql, single in queries)
    )

    aging_by_key = {row["bucket"]: row for row in aging}
    status_counts = {"draft": 0, "issued": 0, "paid": 0, "cancelled": 0}
    for row in statuses:
        status_counts[row["status"]] = row["count"]

    def unpaid_row(row) -> dict:
        total_usd, paid_usd = float(row["total_usd"]), float(row["paid_usd"])
        return {
            "id": row["id"],
            "invoiceNumber": row["invoice_number"],
            "buyerName": row["buyer_name"],
            "invoiceDate": row["invoice_date"],
            "dueDate": row["due_date"],
            "daysOverdue": row["days_overdue"],
            "overdue": row["overdue"],
            "totalUsd": total_usd,
            "paidUsd": paid_usd,
            "dueUsd": max(0.0, round_to(total_usd - paid_usd, 2)),
        }

    return {
        "thisMonth": {"count": month["count"], "totalUsd": float(month["total_usd"]), "totalCarats": float(month["total_carats"])},
        "collectedThisMonth": {"count": collected["count"], "totalUsd": float(collected["total_usd"])},
        "months": [
            {"month": r["month"], "label": r["label"].strip(), "count": r["count"], "totalUsd": float(r["total_usd"])} for r in months
        ],
        "byCountry": [{"country": r["country"], "count": r["count"], "totalUsd": float(r["total_usd"])} for r in countries],
        "aging": [
            {
                "key": key,
                "label": label,
                "count": aging_by_key[key]["count"] if key in aging_by_key else 0,
                "dueUsd": _money(aging_by_key[key]["due_usd"]) if key in aging_by_key else 0,
            }
            for key, label in AGING_ORDER
        ],
        "topBuyers": [
            {
                "buyer": r["buyer_name"] or "No buyer",
                "invoices": r["invoices"],
                "dueUsd": _money(r["due_usd"]),
                "overdueUsd": _money(r["overdue_usd"]),
            }
            for r in buyers
        ],
        "unpaid": {
            "count": open_totals["count"],
            "dueUsd": _money(open_totals["due_usd"]),
            "invoices": [unpaid_row(r) for r in attention],
        },
        "statusCounts": status_counts,
    }


FORECAST_WEEKS = 12


async def cash_flow_forecast(pool: Pool, organization_id: str, today: datetime | None = None) -> dict:
    """Expected receipts by week: each open invoice on its due date plus the buyer's average delay so far."""
    today = today or datetime.now(timezone.utc)
    history, open_rows = await asyncio.gather(
        pool.fetch(
            f"""WITH settled AS (
                  SELECT i.buyer_name, MAX(p.paid_on) - {DUE_DATE} AS days_late
                  FROM invoices i JOIN payments p ON p.invoice_id = i.id
                  WHERE i.organization_id = $1 AND i.status = 'paid'
                  GROUP BY i.id
                )
                SELECT buyer_name, AVG(days_late)::float AS avg_days_late, COUNT(*) AS paid_invoices FROM settled GROUP BY buyer_name""",
            organization_id,
        ),
        pool.fetch(
            f"""SELECT i.id, i.invoice_number, i.buyer_name, to_char({DUE_DATE}, 'YYYY-MM-DD') AS due_date, {BALANCE} AS balance
                {OPEN_FROM}
                ORDER BY {DUE_DATE}""",
            organization_id,
        ),
    )
    delays = {r["buyer_name"]: {"avg": max(0, int(js_round(r["avg_days_late"]))), "count": r["paid_invoices"]} for r in history}

    start = today.astimezone(timezone.utc).date()
    start -= timedelta(days=start.weekday())  # Monday of this week
    today_iso = today.astimezone(timezone.utc).date().isoformat()
    weeks = []
    for index in range(FORECAST_WEEKS):
        week_start = start + timedelta(days=index * 7)
        weeks.append({"start": week_start.isoformat(), "end": (week_start + timedelta(days=6)).isoformat(), "expectedUsd": 0, "invoices": []})
    overdue: dict = {"expectedUsd": 0, "invoices": []}
    later: dict = {"expectedUsd": 0, "invoices": []}

    for row in open_rows:
        delay = delays.get(row["buyer_name"])
        expected_on = (date.fromisoformat(row["due_date"]) + timedelta(days=delay["avg"] if delay else 0)).isoformat()
        balance = _money(row["balance"])
        basis = (
            f"{row['buyer_name']} paid {delay['count']} earlier invoice{'' if delay['count'] == 1 else 's'} {delay['avg']} days late on average"
            if delay
            else "No payment history; expected on the due date"
        )
        entry = {
            "id": row["id"],
            "invoiceNumber": row["invoice_number"],
            "buyerName": row["buyer_name"],
            "dueDate": row["due_date"],
            "expectedOn": expected_on,
            "balanceUsd": balance,
            "buyerAvgDaysLate": delay["avg"] if delay else None,
            "basis": basis,
        }
        if expected_on < today_iso:
            bucket = overdue
        else:
            bucket = next((w for w in weeks if w["start"] <= expected_on <= w["end"]), later)
        bucket["expectedUsd"] = round_to(bucket["expectedUsd"] + balance, 2)
        bucket["invoices"].append(entry)

    open_total = 0.0
    for row in open_rows:
        open_total += float(row["balance"])
    next4 = 0.0
    for week in weeks[:4]:
        next4 += week["expectedUsd"]
    return {
        "today": today_iso,
        "weeks": weeks,
        "overdue": overdue,
        "later": later,
        "totals": {"openUsd": round_to(open_total, 2), "next4WeeksUsd": round_to(next4, 2)},
    }


def build_router():
    router = api_router(prefix="/api/dashboard")

    @router.get("")
    async def get_dashboard(request: Request, user: CurrentUser = Depends(require_user)):
        return await dashboard(request.app.state.pool, user.organization_id)

    @router.get("/forecast")
    async def forecast(request: Request, user: CurrentUser = Depends(require_user)):
        return await cash_flow_forecast(request.app.state.pool, user.organization_id)

    return router
