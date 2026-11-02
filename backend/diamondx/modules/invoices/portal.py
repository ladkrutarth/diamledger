"""Buyer portal links: a read-only page of one buyer's invoices (port of server/modules/invoices/portal.ts)."""

from __future__ import annotations

import hashlib
import os
import re
import secrets
from datetime import datetime, timezone

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, require_roles
from ...core.numbers import js_number, js_round, money

link_manager = require_roles("admin", "member", "tax")
MAX_DAYS = 365
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{20,64}$")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def site_url(request: Request) -> str:
    configured = os.environ.get("APP_URL", "").strip().rstrip("/")
    if configured:
        return configured
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    return f"{proto}://{request.headers.get('x-forwarded-host') or request.headers.get('host', '')}"


def build_router():
    router = api_router(prefix="/api")

    @router.get("/portal-links")
    async def list_links(request: Request, user: CurrentUser = Depends(link_manager)):
        rows = await request.app.state.pool.fetch(
            """SELECT l.id, l.buyer_name, l.created_at, l.expires_at, l.revoked_at, l.last_viewed_at, u.email AS created_by_email
               FROM buyer_portal_links l LEFT JOIN users u ON u.id = l.created_by
               WHERE l.organization_id = $1 ORDER BY l.created_at DESC""",
            user.organization_id,
        )
        now = datetime.now(timezone.utc)
        return {
            "links": [
                {
                    "id": r["id"],
                    "buyerName": r["buyer_name"],
                    "createdAt": iso(r["created_at"]),
                    "expiresAt": iso(r["expires_at"]),
                    "revokedAt": iso(r["revoked_at"]),
                    "lastViewedAt": iso(r["last_viewed_at"]),
                    "createdBy": r["created_by_email"] or "",
                    "active": not r["revoked_at"] and r["expires_at"] > now,
                }
                for r in rows
            ]
        }

    @router.post("/portal-links")
    async def create_link(request: Request, user: CurrentUser = Depends(link_manager)):
        data = body(request)
        buyer_name = data["buyerName"].strip()[:200] if isinstance(data.get("buyerName"), str) else ""
        if not buyer_name:
            raise ApiError(400, "Choose the buyer.")
        raw_days = js_number(data.get("days")) if data.get("days") is not None else 0
        days = int(min(max(js_round(raw_days if raw_days == raw_days and raw_days else 90), 1), MAX_DAYS))
        token = secrets.token_urlsafe(24)
        row = await request.app.state.pool.fetchrow(
            """INSERT INTO buyer_portal_links (organization_id, buyer_name, token_hash, created_by, expires_at)
               VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at""",
            user.organization_id, buyer_name, hash_token(token), user.id, days,
        )
        # The token is shown once. Only its hash is stored, so a lost link has to be replaced.
        return JSONResponse(
            {"id": row["id"], "url": f"{site_url(request)}/?portal={token}", "expiresAt": iso(row["expires_at"])}, status_code=201
        )

    @router.delete("/portal-links/{link_id}")
    async def revoke_link(link_id: str, request: Request, user: CurrentUser = Depends(link_manager)):
        if not is_uuid(link_id):
            raise ApiError(404, "Link not found.")
        result = await request.app.state.pool.execute(
            "UPDATE buyer_portal_links SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL",
            link_id, user.organization_id,
        )
        if result == "UPDATE 0":
            raise ApiError(404, "Link not found.")
        return {"revoked": True}

    # Public: no sign-in. The token decides which company and which buyer can be seen.
    @router.get("/portal/{token}")
    async def portal(token: str, request: Request):
        if not _TOKEN.match(token):
            raise ApiError(404, "This link is not valid.")
        pool = request.app.state.pool
        found = await pool.fetchrow(
            """UPDATE buyer_portal_links l SET last_viewed_at = now()
               FROM organizations o
               WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now() AND o.id = l.organization_id
               RETURNING l.id, l.organization_id, l.buyer_name, l.expires_at, o.name AS organization_name""",
            hash_token(token),
        )
        if not found:
            raise ApiError(404, "This link has expired or was withdrawn. Ask the exporter for a new one.")
        invoices = await pool.fetch(
            """SELECT i.id, i.invoice_number, to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
                      to_char(COALESCE(i.invoice_date, i.created_at::date) + i.credit_days, 'YYYY-MM-DD') AS due_date,
                      i.status, i.total_usd, COALESCE(p.paid, 0) AS paid_usd,
                      (i.status = 'issued' AND COALESCE(i.invoice_date, i.created_at::date) + i.credit_days < current_date
                        AND i.total_usd - COALESCE(p.paid, 0) > 0) AS overdue,
                      i.data
               FROM invoices i
               LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid FROM payments WHERE invoice_id = i.id) p ON true
               WHERE i.organization_id = $1 AND LOWER(TRIM(i.buyer_name)) = LOWER(TRIM($2)) AND i.status IN ('issued', 'paid')
               ORDER BY COALESCE(i.invoice_date, i.created_at::date) DESC
               LIMIT 500""",
            found["organization_id"], found["buyer_name"],
        )
        rows = []
        for r in invoices:
            total_usd, paid_usd = money(r["total_usd"]), money(r["paid_usd"])
            rows.append(
                {
                    "id": r["id"],
                    "invoiceNumber": r["invoice_number"],
                    "invoiceDate": r["invoice_date"],
                    "dueDate": r["due_date"],
                    "status": r["status"],
                    "totalUsd": total_usd,
                    "paidUsd": paid_usd,
                    "dueUsd": money(max(total_usd - paid_usd, 0)),
                    "overdue": r["overdue"],
                    "invoice": r["data"],
                }
            )
        due = overdue = 0.0
        for row in rows:
            due += row["dueUsd"]
        for row in rows:
            if row["overdue"]:
                overdue += row["dueUsd"]
        return JSONResponse(
            {
                "exporterName": found["organization_name"],
                "buyerName": found["buyer_name"],
                "expiresAt": iso(found["expires_at"]),
                "invoices": rows,
                "totals": {"invoices": len(rows), "dueUsd": money(due), "overdueUsd": money(overdue)},
            },
            headers={"Cache-Control": "no-store"},
        )

    return router
