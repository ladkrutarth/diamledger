"""Companies a user can work in, switching between them, the compliance calendar, and outside accountants
(port of server/modules/accountant/workspace.ts)."""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Request, Response
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import days_between
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, require_admin, require_user
from ..auth.users import normalize_email
from ..billing.subscription import limit_message
from ..tax.filing import filing_summary
from ..tax.realization import realization_rows
from ..tax.shared import tax_settings

MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
STATUS_ORDER = {"overdue": 0, "due_soon": 1, "action": 2, "upcoming": 3, "done": 4}


def _month_start(year: int, month_index: int) -> date:
    """new Date(year, monthIndex, 1) with month overflow, monthIndex counted from 0."""
    year += month_index // 12
    return date(year, month_index % 12 + 1, 1)


def _status_for(days_left: int, soon: int) -> str:
    if days_left < 0:
        return "overdue"
    return "due_soon" if days_left <= soon else "upcoming"


async def companies_for(pool: Pool, user_id: str) -> list[dict]:
    rows = await pool.fetch(
        """SELECT o.id, o.name, u.role, true AS home
           FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1
           UNION ALL
           SELECT o.id, o.name, a.role, false AS home
           FROM organization_access a JOIN organizations o ON o.id = a.organization_id WHERE a.user_id = $1
           ORDER BY home DESC, name""",
        user_id,
    )
    return [{"id": r["id"], "name": r["name"], "role": r["role"], "home": r["home"]} for r in rows]


async def compliance_items(pool: Pool, company: dict, today: date) -> list[dict]:
    items: list[dict] = []
    today_iso = today.isoformat()
    base = {"organizationId": company["id"], "organizationName": company["name"]}
    closed = {r["month"] for r in await pool.fetch(
        "SELECT to_char(month, 'YYYY-MM') AS month FROM closed_months WHERE organization_id = $1", company["id"])}

    for offset in (-1, 0):
        period = _month_start(today.year, today.month - 1 + offset)
        period_key = period.strftime("%Y-%m")
        period_name = f"{MONTH_NAMES[period.month - 1]} {period.year}"
        due_month = _month_start(period.year, period.month)
        for kind, day, title in (("gstr1", 11, "GSTR-1"), ("gstr3b", 20, "GSTR-3B")):
            due_date = date(due_month.year, due_month.month, day).isoformat()
            days_left = days_between(today_iso, due_date)
            books_closed = period_key in closed
            if books_closed:
                detail = "The chartered accountant has closed this month."
            elif kind == "gstr1":
                detail = "Report the export invoices in table 6A."
            else:
                detail = "Pay any IGST and file the summary return."
            items.append({**base, "kind": kind, "title": f"{title} for {period_name}", "dueDate": due_date, "daysLeft": days_left,
                          "status": "done" if books_closed else _status_for(days_left, 7), "detail": detail})

    settings = await tax_settings(pool, company["id"])
    if not settings["lutValidUntil"]:
        items.append({**base, "kind": "lut", "title": "Record the LUT validity", "dueDate": None, "daysLeft": None, "status": "action",
                      "detail": "Enter the date the current Letter of Undertaking runs out so the renewal can be tracked."})
    else:
        days_left = days_between(today_iso, settings["lutValidUntil"])
        items.append({**base, "kind": "lut", "title": "Renew the LUT (form GST RFD-11)", "dueDate": settings["lutValidUntil"],
                      "daysLeft": days_left, "status": _status_for(days_left, 45),
                      "detail": "Exports without IGST need a valid LUT for the new financial year, filed before 1 April."})

    realization = await realization_rows(pool, company["id"])
    urgent = [r for r in realization["rows"] if r["flag"] in ("overdue", "due_soon")]
    if urgent:
        earliest = urgent[0]
        for row in urgent[1:]:
            if row["deadline"] < earliest["deadline"]:
                earliest = row
        overdue = sum(1 for r in urgent if r["flag"] == "overdue")
        items.append({
            **base, "kind": "realization",
            "title": f"{len(urgent)} invoice{'' if len(urgent) == 1 else 's'} near the FEMA realization deadline",
            "dueDate": earliest["deadline"], "daysLeft": earliest["daysLeft"], "status": "overdue" if overdue else "due_soon",
            "detail": f"{overdue} already past the {settings['realizationMonths']}-month limit. Ask the bank to report realization or seek an extension.",
        })

    refunds = await pool.fetchrow(
        """SELECT COUNT(*) AS count, to_char(MIN(window_end), 'YYYY-MM-DD') AS earliest
           FROM (
             SELECT (COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date) + interval '2 years')::date AS window_end
             FROM invoices i LEFT JOIN invoice_tax t ON t.invoice_id = i.id
             WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND COALESCE(t.export_scheme, 'lut') = 'lut'
           ) w
           WHERE window_end BETWEEN $2::date AND ($2::date + 90)""",
        company["id"], today,
    )
    if refunds["count"] and refunds["earliest"]:
        count = refunds["count"]
        items.append({
            **base, "kind": "refund", "title": f"ITC refund window closing for {count} LUT export{'' if count == 1 else 's'}",
            "dueDate": refunds["earliest"], "daysLeft": days_between(today_iso, refunds["earliest"]), "status": "due_soon",
            "detail": "A refund of unused input tax on these exports has to be claimed within two years of the export date.",
        })

    last_month = _month_start(today.year, today.month - 2).strftime("%Y-%m")
    filing = await filing_summary(pool, company["id"], last_month)
    problems = sum(1 for r in filing["rows"] if not r["ready"]) + len(filing["companyIssues"])
    if problems:
        items.append({**base, "kind": "filing", "title": f"{problems} problem{'' if problems == 1 else 's'} to fix before filing {last_month}",
                      "dueDate": None, "daysLeft": None, "status": "action",
                      "detail": "Open the filing check to see shipping bill and e-invoice gaps."})
    return items


def build_router():
    router = api_router()

    @router.get("/api/workspace/companies")
    async def companies(request: Request, user: CurrentUser = Depends(require_user)):
        return {"activeOrganizationId": user.organization_id, "companies": await companies_for(request.app.state.pool, user.id)}

    @router.post("/api/workspace/switch")
    async def switch(request: Request, user: CurrentUser = Depends(require_user)):
        target = body(request).get("organizationId")
        company = next((c for c in await companies_for(request.app.state.pool, user.id) if c["id"] == target), None)
        if not company:
            raise ApiError(404, "You do not have access to that company.")
        session = request.state.session
        if company["home"]:
            session.data.pop("organizationId", None)
        else:
            session.data["organizationId"] = company["id"]
        await request.app.state.sessions.save(session)
        return {"user": {"id": user.id, "email": user.email, "role": company["role"], "organizationId": company["id"], "organizationName": company["name"]}}

    @router.get("/api/workspace/calendar")
    async def calendar(request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        companies = [c for c in await companies_for(pool, user.id) if c["role"] != "member"]
        today = date.today()
        items: list[dict] = []
        for company in companies:
            items.extend(await compliance_items(pool, company, today))
        items.sort(key=lambda item: (STATUS_ORDER[item["status"]], item["dueDate"] or "9999"))
        return {"today": today.isoformat(), "companies": [{"id": c["id"], "name": c["name"]} for c in companies], "items": items}

    @router.get("/api/team/accountants")
    async def accountants(request: Request, user: CurrentUser = Depends(require_admin)):
        rows = await request.app.state.pool.fetch(
            """SELECT a.user_id, u.email, a.role, a.created_at, o.name AS firm
               FROM organization_access a JOIN users u ON u.id = a.user_id JOIN organizations o ON o.id = u.organization_id
               WHERE a.organization_id = $1 ORDER BY a.created_at""",
            user.organization_id,
        )
        return {"accountants": [{"userId": r["user_id"], "email": r["email"], "role": r["role"], "firm": r["firm"], "createdAt": iso(r["created_at"])}
                                for r in rows]}

    @router.post("/api/team/accountants")
    async def grant(request: Request, user: CurrentUser = Depends(require_admin)):
        data = body(request)
        email = normalize_email(data.get("email"))
        role = "tax" if data.get("role") == "tax" else "ca"
        pool: Pool = request.app.state.pool
        accountant = await pool.fetchrow("SELECT id, organization_id FROM users WHERE email = $1", email)
        if not accountant:
            raise ApiError(404, "No account uses that email. Ask the accountant to create their own firm account first.")
        if accountant["organization_id"] == user.organization_id:
            raise ApiError(409, "That person is already on your team. Change their role on the team list instead.")
        existing = await pool.fetchval(
            """SELECT 1 FROM organization_access a JOIN users u ON u.id = a.user_id
               WHERE a.organization_id = $1 AND u.organization_id = $2 LIMIT 1""",
            user.organization_id, accountant["organization_id"],
        )
        # A new client for the firm counts against the firm's plan; another person from a firm already here does not.
        if not existing:
            over_limit = await limit_message(pool, accountant["organization_id"], "clients")
            if over_limit:
                raise ApiError(402, over_limit, code="plan_limit")
        await pool.execute(
            """INSERT INTO organization_access (user_id, organization_id, role, granted_by) VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by""",
            accountant["id"], user.organization_id, role, user.id,
        )
        return JSONResponse({"userId": accountant["id"], "email": email, "role": role}, status_code=201)

    @router.delete("/api/team/accountants/{user_id}")
    async def revoke(user_id: str, request: Request, user: CurrentUser = Depends(require_admin)):
        if not is_uuid(user_id):
            raise ApiError(404, "Accountant not found.")
        result = await request.app.state.pool.execute(
            "DELETE FROM organization_access WHERE user_id = $1 AND organization_id = $2", user_id, user.organization_id
        )
        if result == "DELETE 0":
            raise ApiError(404, "Accountant not found.")
        return Response(status_code=204)

    return router
