"""Buyer payment grades, credit limits and warnings before issuing (port of server/modules/company/buyerRisk.ts)."""

from __future__ import annotations

import math

from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import ApiError, CurrentUser, body, is_uuid, require_admin, require_user
from ...core.numbers import js_number, js_round, money, round_to, to_fixed

GRADE_LABELS = {
    "A": "Pays on time",
    "B": "Sometimes late",
    "C": "Often late",
    "D": "High risk",
    "new": "No payment history",
}


def risk_grade(history: dict) -> str:
    """Grades a buyer from how they have paid so far."""
    avg_late = history["avgDaysLate"] or 0
    if history["invoices"] == 0:
        return "new"
    if history["maxDaysOverdue"] > 90 or (
        history["overdueUsd"] > 0 and history["overdueUsd"] >= history["outstandingUsd"] * 0.5 and history["maxDaysOverdue"] > 60
    ):
        return "D"
    if history["maxDaysOverdue"] > 30 or avg_late > 30:
        return "C"
    if history["overdueUsd"] > 0 or avg_late > 7 or (history["onTimePercent"] is not None and history["onTimePercent"] < 80):
        return "B"
    if history["paidInvoices"] == 0:
        return "new"
    return "A"


RISK_SQL = """
WITH inv AS (
  SELECT i.id, LOWER(TRIM(i.buyer_name)) AS buyer_key, i.buyer_name, i.status, i.total_usd,
         COALESCE(i.invoice_date, i.created_at::date) AS invoice_date,
         COALESCE(i.invoice_date, i.created_at::date) + i.credit_days AS due_date,
         COALESCE(p.paid, 0) AS paid, p.last_paid
  FROM invoices i
  LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid, MAX(paid_on) AS last_paid FROM payments WHERE invoice_id = i.id) p ON true
  WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND TRIM(i.buyer_name) <> ''
    AND ($2::text IS NULL OR LOWER(TRIM(i.buyer_name)) = LOWER(TRIM($2)))
)
SELECT inv.buyer_key, MIN(inv.buyer_name) AS buyer_name, COUNT(*) AS invoices,
       COUNT(*) FILTER (WHERE inv.status = 'paid') AS paid_invoices,
       SUM(inv.total_usd) AS total_usd,
       SUM(GREATEST(inv.total_usd - inv.paid, 0)) FILTER (WHERE inv.status = 'issued') AS outstanding_usd,
       COALESCE(SUM(GREATEST(inv.total_usd - inv.paid, 0)) FILTER (WHERE inv.status = 'issued' AND inv.due_date < current_date), 0) AS overdue_usd,
       MAX(current_date - inv.due_date) FILTER (WHERE inv.status = 'issued' AND inv.due_date < current_date AND inv.total_usd > inv.paid) AS max_days_overdue,
       SUM(GREATEST(inv.last_paid - inv.due_date, 0) * inv.total_usd) FILTER (WHERE inv.status = 'paid') AS late_weighted,
       COALESCE(SUM(inv.total_usd) FILTER (WHERE inv.status = 'paid'), 0) AS paid_value,
       COUNT(*) FILTER (WHERE inv.status = 'paid' AND inv.last_paid <= inv.due_date) AS on_time,
       MAX(to_char(inv.invoice_date, 'YYYY-MM-DD')) AS last_invoice,
       (SELECT b.credit_limit_usd FROM buyers b WHERE b.organization_id = $1 AND LOWER(TRIM(b.name)) = inv.buyer_key LIMIT 1) AS credit_limit_usd,
       (SELECT b.id FROM buyers b WHERE b.organization_id = $1 AND LOWER(TRIM(b.name)) = inv.buyer_key LIMIT 1) AS buyer_id
FROM inv GROUP BY inv.buyer_key
ORDER BY overdue_usd DESC, outstanding_usd DESC NULLS LAST, buyer_name"""


async def buyer_risk(pool: Pool, organization_id: str, buyer_name: str | None = None) -> list[dict]:
    rows = await pool.fetch(RISK_SQL, organization_id, buyer_name)
    result = []
    for row in rows:
        paid_invoices = row["paid_invoices"]
        paid_value = float(row["paid_value"])
        history = {
            "invoices": row["invoices"],
            "paidInvoices": paid_invoices,
            "outstandingUsd": money(row["outstanding_usd"] if row["outstanding_usd"] is not None else 0),
            "overdueUsd": money(row["overdue_usd"]),
            "maxDaysOverdue": row["max_days_overdue"] or 0,
            "avgDaysLate": js_round(js_number(row["late_weighted"]) / paid_value) if paid_value > 0 else None,
            "onTimePercent": js_round(row["on_time"] / paid_invoices * 100) if paid_invoices > 0 else None,
        }
        for key in ("avgDaysLate", "onTimePercent"):
            if history[key] is not None:
                history[key] = int(history[key])
        grade = risk_grade(history)
        credit_limit = None if row["credit_limit_usd"] is None else money(row["credit_limit_usd"])
        result.append(
            {
                "buyerName": row["buyer_name"],
                "buyerId": row["buyer_id"],
                **history,
                "totalUsd": money(row["total_usd"]),
                "lastInvoice": row["last_invoice"],
                "creditLimitUsd": credit_limit,
                "headroomUsd": None if credit_limit is None else money(credit_limit - history["outstandingUsd"]),
                "grade": grade,
                "gradeLabel": GRADE_LABELS[grade],
            }
        )
    return result


async def shipment_warnings(pool: Pool, organization_id: str, buyer_name: str, amount_usd: float) -> dict:
    """Warnings to show before a new invoice for this buyer is issued. Nothing is blocked."""
    rows = await buyer_risk(pool, organization_id, buyer_name)
    row = rows[0] if rows else None
    limit_value = await pool.fetchval(
        "SELECT credit_limit_usd FROM buyers WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2)) LIMIT 1",
        organization_id,
        buyer_name,
    )
    if row and row["creditLimitUsd"] is not None:
        credit_limit = row["creditLimitUsd"]
    else:
        credit_limit = None if limit_value is None else money(limit_value)
    warnings: list[str] = []
    if row and row["overdueUsd"] > 0:
        warnings.append(
            f"{row['buyerName']} already owes USD {to_fixed(row['overdueUsd'], 2)} past the due date (oldest {row['maxDaysOverdue']} days late)."
        )
    if row and row["grade"] in ("C", "D"):
        late = f", paying on average {row['avgDaysLate']} days after the due date" if row["avgDaysLate"] else ""
        warnings.append(f"Payment record: {row['gradeLabel'].lower()}{late}.")
    outstanding = row["outstandingUsd"] if row else 0
    if credit_limit is not None and outstanding + amount_usd > credit_limit + 0.005:
        warnings.append(
            f"This invoice takes the balance to USD {to_fixed(money(outstanding + amount_usd), 2)}, over the credit limit of USD {to_fixed(credit_limit, 2)}."
        )
    grade = row["grade"] if row else "new"
    return {"grade": grade, "gradeLabel": GRADE_LABELS[grade], "outstandingUsd": outstanding, "creditLimitUsd": credit_limit, "warnings": warnings}


def build_router():
    router = api_router(prefix="/api/buyers")

    @router.get("/risk")
    async def risk(request: Request, user: CurrentUser = Depends(require_user)):
        return {"buyers": await buyer_risk(request.app.state.pool, user.organization_id), "labels": GRADE_LABELS}

    @router.get("/risk/check")
    async def check(request: Request, user: CurrentUser = Depends(require_user)):
        buyer = request.query_params.get("buyer", "").strip()[:200]
        if not buyer:
            raise ApiError(400, "Name the buyer.")
        raw = js_number(request.query_params.get("amountUsd")) if "amountUsd" in request.query_params else math.nan
        amount_usd = max(0.0, raw if math.isfinite(raw) else 0.0)
        return await shipment_warnings(request.app.state.pool, user.organization_id, buyer, amount_usd)

    @router.put("/{buyer_id}/credit-limit")
    async def credit_limit(buyer_id: str, request: Request, user: CurrentUser = Depends(require_admin)):
        if not is_uuid(buyer_id):
            raise ApiError(404, "Buyer not found.")
        raw = body(request).get("creditLimitUsd")
        limit = None if raw is None or raw == "" else round_to(js_number(raw), 2)
        if limit is not None and (not math.isfinite(limit) or limit < 0):
            raise ApiError(400, "The credit limit must be zero or more dollars.")
        result = await request.app.state.pool.execute(
            "UPDATE buyers SET credit_limit_usd = $3, updated_at = now() WHERE id = $1 AND organization_id = $2",
            buyer_id, user.organization_id, limit,
        )
        if result == "UPDATE 0":
            raise ApiError(404, "Buyer not found.")
        return {"creditLimitUsd": limit}

    return router
