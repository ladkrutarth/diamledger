"""The activity history page and its CSV (from server/modules/activity/audit.ts)."""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import parse_loose_date
from ...core.http import CurrentUser, iso
from ...core.numbers import js_number
from ..tax.shared import csv_file, csv_response, tax_reader


async def events(pool: Pool, organization_id: str, request: Request, limit: int) -> list[dict]:
    start = parse_loose_date(request.query_params.get("from", ""))
    end = parse_loose_date(request.query_params.get("to", ""))
    search = request.query_params.get("q", "").strip()[:100]
    rows = await pool.fetch(
        """SELECT id, created_at, user_email, action, summary, entity_type, entity_id FROM audit_events
           WHERE organization_id = $1
             AND ($2::date IS NULL OR created_at >= $2::date)
             AND ($3::date IS NULL OR created_at < $3::date + 1)
             AND ($4 = '' OR summary ILIKE '%' || $4 || '%' OR user_email ILIKE '%' || $4 || '%')
           ORDER BY created_at DESC LIMIT $5""",
        organization_id,
        date.fromisoformat(start) if start else None,
        date.fromisoformat(end) if end else None,
        search,
        limit,
    )
    return [
        {"id": r["id"], "at": iso(r["created_at"]), "userEmail": r["user_email"], "action": r["action"], "summary": r["summary"],
         "entityType": r["entity_type"], "entityId": r["entity_id"]}
        for r in rows
    ]


def build_router():
    router = api_router(prefix="/api/audit")

    @router.get("")
    async def history(request: Request, user: CurrentUser = Depends(tax_reader)):
        requested = js_number(request.query_params.get("limit")) if "limit" in request.query_params else 0
        limit = int(min(max(requested if requested == requested and requested else 200, 1), 500))
        return {"events": await events(request.app.state.pool, user.organization_id, request, limit)}

    @router.get("/csv")
    async def history_csv(request: Request, user: CurrentUser = Depends(tax_reader)):
        found = await events(request.app.state.pool, user.organization_id, request, 10000)
        return csv_response(
            "activity-history.csv",
            csv_file(["When (UTC)", "Who", "What", "Action"], [[e["at"], e["userEmail"], e["summary"], e["action"]] for e in found]),
        )

    return router
