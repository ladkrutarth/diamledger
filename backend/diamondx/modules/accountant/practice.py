"""Practice tools for an accountant firm across its client companies: health, time, fees
(port of server/modules/accountant/practice.ts)."""

from __future__ import annotations

import asyncio
from datetime import date

import asyncpg
from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import current_financial_year, days_between, financial_year_dates, form_reader, iso_today
from ...core.http import ApiError, CurrentUser, body, is_uuid, require_user
from ...core.numbers import money
from ..tax.notices import open_notice_counts
from .client_requests import open_request_counts
from .workspace import compliance_items

BILLING = ("monthly", "quarterly", "yearly", "per_task")


async def clients_of(pool: Pool, user_id: str) -> list[dict]:
    """Clients are the companies that have given this user accountant access."""
    rows = await pool.fetch(
        """SELECT o.id, o.name, a.role FROM organization_access a JOIN organizations o ON o.id = a.organization_id
           WHERE a.user_id = $1 ORDER BY o.name""",
        user_id,
    )
    return [{"id": r["id"], "name": r["name"], "role": r["role"]} for r in rows]


async def practice_user(request: Request, user: CurrentUser = Depends(require_user)) -> tuple[CurrentUser, list[dict]]:
    """The practice tools are for accountants: anyone with access to at least one client company."""
    clients = await clients_of(request.app.state.pool, user.id)
    if not clients:
        raise ApiError(403, "The practice tools are for accountants with access to client companies.")
    return user, clients


def _client_id(clients: list[dict], value) -> str | None:
    return value if isinstance(value, str) and any(c["id"] == value for c in clients) else None


def health_score(*, overdue: int, dueSoon: int, actions: int, noticesOverdue: int, noticesDueSoon: int, requestsOverdue: int) -> dict:  # noqa: N803
    """100 is a client with nothing pending; overdue filings, notices, and requests pull it down."""
    score = max(0, 100 - overdue * 20 - noticesOverdue * 25 - noticesDueSoon * 10 - dueSoon * 5 - actions * 5 - requestsOverdue * 5)
    grade = "good" if score >= 80 else "watch" if score >= 50 else "at_risk"
    return {"score": score, "grade": grade}


def _as_date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def build_router():
    router = api_router(prefix="/api/practice")

    @router.get("/clients")
    async def clients(request: Request, practice=Depends(practice_user)):
        user, client_list = practice
        pool: Pool = request.app.state.pool
        firm_id = user.home_organization_id
        year = financial_year_dates(current_financial_year())
        start, end = date.fromisoformat(year["start"]), date.fromisoformat(year["end"])
        month = iso_today()[:7]
        today = date.today()
        rows = []
        for client in client_list:
            items, requests, notices, engagement, time, bills = await asyncio.gather(
                compliance_items(pool, client, today),
                open_request_counts(pool, client["id"]),
                open_notice_counts(pool, client["id"]),
                pool.fetchrow("SELECT fee_inr, billing, notes FROM ca_engagements WHERE firm_id = $1 AND client_id = $2", firm_id, client["id"]),
                pool.fetchrow(
                    """SELECT COALESCE(SUM(minutes) FILTER (WHERE to_char(work_date, 'YYYY-MM') = $3), 0) AS month_minutes,
                              COALESCE(SUM(minutes) FILTER (WHERE work_date BETWEEN $4 AND $5), 0) AS year_minutes,
                              COALESCE(SUM(minutes) FILTER (WHERE billable AND work_date BETWEEN $4 AND $5), 0) AS unbilled_minutes
                       FROM ca_time_entries WHERE firm_id = $1 AND client_id = $2""",
                    firm_id, client["id"], month, start, end,
                ),
                pool.fetchrow(
                    """SELECT COALESCE(SUM(amount_inr) FILTER (WHERE bill_date BETWEEN $3 AND $4), 0) AS billed,
                              COALESCE(SUM(amount_inr) FILTER (WHERE paid_on IS NULL), 0) AS unpaid,
                              COUNT(*) FILTER (WHERE paid_on IS NULL) AS unpaid_count
                       FROM ca_fee_bills WHERE firm_id = $1 AND client_id = $2""",
                    firm_id, client["id"], start, end,
                ),
            )
            overdue = sum(1 for i in items if i["status"] == "overdue")
            due_soon = sum(1 for i in items if i["status"] == "due_soon")
            actions = sum(1 for i in items if i["status"] == "action")
            health = health_score(overdue=overdue, dueSoon=due_soon, actions=actions, noticesOverdue=notices["overdue"],
                                  noticesDueSoon=notices["dueSoon"], requestsOverdue=requests["overdue"])
            rows.append({
                "id": client["id"],
                "name": client["name"],
                "role": client["role"],
                "health": {
                    **health, "overdue": overdue, "dueSoon": due_soon, "actions": actions,
                    "openRequests": requests["open"], "overdueRequests": requests["overdue"],
                    "openNotices": notices["open"], "noticesDueSoon": notices["dueSoon"], "noticesOverdue": notices["overdue"],
                    "nextItems": [{"title": i["title"], "dueDate": i["dueDate"], "status": i["status"]} for i in items if i["status"] != "done"][:3],
                },
                "engagement": {"feeInr": money(engagement["fee_inr"]), "billing": engagement["billing"], "notes": engagement["notes"]}
                if engagement else None,
                "time": {"monthMinutes": int(time["month_minutes"]), "yearMinutes": int(time["year_minutes"]),
                         "billableYearMinutes": int(time["unbilled_minutes"])},
                "fees": {"billedYearInr": money(bills["billed"]), "unpaidInr": money(bills["unpaid"]), "unpaidBills": bills["unpaid_count"]},
            })
        rows.sort(key=lambda r: (r["health"]["score"], r["name"].casefold()))
        unpaid = billed = 0.0
        for r in rows:
            unpaid += r["fees"]["unpaidInr"]
        for r in rows:
            billed += r["fees"]["billedYearInr"]
        return {
            "year": year["label"],
            "clients": rows,
            "totals": {
                "clients": len(rows),
                "atRisk": sum(1 for r in rows if r["health"]["grade"] == "at_risk"),
                "unpaidInr": money(unpaid),
                "billedYearInr": money(billed),
                "monthMinutes": sum(r["time"]["monthMinutes"] for r in rows),
            },
        }

    @router.put("/clients/{client_id}/engagement")
    async def engagement(client_id: str, request: Request, practice=Depends(practice_user)):
        user, client_list = practice
        if not _client_id(client_list, client_id):
            raise ApiError(404, "Client not found.")
        form = form_reader(body(request))
        fee = form.number("feeInr", "The fee must be zero or more rupees.", min=0, optional=True)
        fee = 0 if fee is None else fee
        billing = form.choice("billing", BILLING, "monthly")
        notes = form.text("notes", 1000)
        await request.app.state.pool.execute(
            """INSERT INTO ca_engagements (firm_id, client_id, fee_inr, billing, notes) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (firm_id, client_id) DO UPDATE SET fee_inr = EXCLUDED.fee_inr, billing = EXCLUDED.billing,
                 notes = EXCLUDED.notes, updated_at = now()""",
            user.home_organization_id, client_id, fee, billing, notes,
        )
        return {"feeInr": fee, "billing": billing, "notes": notes}

    @router.get("/time")
    async def time_entries(request: Request, practice=Depends(practice_user)):
        user, client_list = practice
        requested = request.query_params.get("clientId")
        client_id = _client_id(client_list, requested) if requested else None
        if requested and not client_id:
            raise ApiError(404, "Client not found.")
        rows = await request.app.state.pool.fetch(
            """SELECT t.id, t.client_id, o.name AS client_name, t.user_email, to_char(t.work_date, 'YYYY-MM-DD') AS work_date, t.minutes,
                      t.task, t.billable
               FROM ca_time_entries t JOIN organizations o ON o.id = t.client_id
               WHERE t.firm_id = $1 AND ($2::uuid IS NULL OR t.client_id = $2) AND t.client_id = ANY($3::uuid[])
               ORDER BY t.work_date DESC, t.created_at DESC LIMIT 500""",
            user.home_organization_id, client_id, [c["id"] for c in client_list],
        )
        return {"entries": [{"id": r["id"], "clientId": r["client_id"], "clientName": r["client_name"], "userEmail": r["user_email"],
                             "workDate": r["work_date"], "minutes": r["minutes"], "task": r["task"], "billable": r["billable"]} for r in rows]}

    @router.post("/time")
    async def add_time(request: Request, practice=Depends(practice_user)):
        user, client_list = practice
        form = form_reader(body(request))
        client_id = _client_id(client_list, form.text("clientId", 40))
        if not client_id:
            raise ApiError(400, "Choose the client.")
        minutes = form.number("minutes", "Enter the time spent, from 1 minute to 24 hours.", min=1, max=1440, places=0)
        work_date = form.date("workDate", "Enter the date as YYYY-MM-DD.", True) or iso_today()
        task = form.required("task", "Say what the time was spent on.", 300)
        billable = True if "billable" not in form.raw else form.flag("billable")
        new_id = await request.app.state.pool.fetchval(
            """INSERT INTO ca_time_entries (firm_id, client_id, user_id, user_email, work_date, minutes, task, billable)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id""",
            user.home_organization_id, client_id, user.id, user.email, date.fromisoformat(work_date), int(minutes), task, billable,
        )
        return JSONResponse({"id": new_id}, status_code=201)

    @router.delete("/time/{entry_id}")
    async def delete_time(entry_id: str, request: Request, practice=Depends(practice_user)):
        user, _ = practice
        if not is_uuid(entry_id):
            raise ApiError(404, "Entry not found.")
        result = await request.app.state.pool.execute("DELETE FROM ca_time_entries WHERE id = $1 AND firm_id = $2", entry_id, user.home_organization_id)
        if result == "DELETE 0":
            raise ApiError(404, "Entry not found.")
        return {"deleted": True}

    @router.get("/bills")
    async def bills(request: Request, practice=Depends(practice_user)):
        user, client_list = practice
        rows = await request.app.state.pool.fetch(
            """SELECT b.id, b.client_id, o.name AS client_name, b.bill_no, to_char(b.bill_date, 'YYYY-MM-DD') AS bill_date, b.amount_inr,
                      to_char(b.paid_on, 'YYYY-MM-DD') AS paid_on, b.notes
               FROM ca_fee_bills b JOIN organizations o ON o.id = b.client_id
               WHERE b.firm_id = $1 AND b.client_id = ANY($2::uuid[])
               ORDER BY (b.paid_on IS NOT NULL), b.bill_date DESC LIMIT 500""",
            user.home_organization_id, [c["id"] for c in client_list],
        )
        today = iso_today()
        return {"bills": [{"id": r["id"], "clientId": r["client_id"], "clientName": r["client_name"], "billNo": r["bill_no"],
                           "billDate": r["bill_date"], "amountInr": money(r["amount_inr"]), "paidOn": r["paid_on"],
                           "daysUnpaid": None if r["paid_on"] else days_between(r["bill_date"], today), "notes": r["notes"]} for r in rows]}

    @router.post("/bills")
    async def add_bill(request: Request, practice=Depends(practice_user)):
        user, client_list = practice
        form = form_reader(body(request))
        client_id = _client_id(client_list, form.text("clientId", 40))
        if not client_id:
            raise ApiError(400, "Choose the client.")
        bill_no = form.required("billNo", "Enter the bill number.", 50)
        bill_date = form.date("billDate", "Enter the bill date as YYYY-MM-DD.", True) or iso_today()
        amount = form.number("amountInr", "Enter the bill amount in rupees.", min=0.01)
        notes = form.text("notes", 500)
        try:
            new_id = await request.app.state.pool.fetchval(
                """INSERT INTO ca_fee_bills (firm_id, client_id, bill_no, bill_date, amount_inr, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id""",
                user.home_organization_id, client_id, bill_no, date.fromisoformat(bill_date), amount, notes,
            )
        except asyncpg.UniqueViolationError:
            raise ApiError(409, f"Bill {bill_no} already exists.") from None
        return JSONResponse({"id": new_id}, status_code=201)

    @router.post("/bills/{bill_id}/paid")
    async def mark_paid(bill_id: str, request: Request, practice=Depends(practice_user)):
        user, _ = practice
        if not is_uuid(bill_id):
            raise ApiError(404, "Bill not found.")
        data = body(request)
        paid_on = None if data.get("paid") is False else (form_reader(data).date("paidOn", "Enter the date paid as YYYY-MM-DD.", True) or iso_today())
        result = await request.app.state.pool.execute(
            "UPDATE ca_fee_bills SET paid_on = $3 WHERE id = $1 AND firm_id = $2", bill_id, user.home_organization_id, _as_date(paid_on)
        )
        if result == "UPDATE 0":
            raise ApiError(404, "Bill not found.")
        return {"paidOn": paid_on}

    @router.delete("/bills/{bill_id}")
    async def delete_bill(bill_id: str, request: Request, practice=Depends(practice_user)):
        user, _ = practice
        if not is_uuid(bill_id):
            raise ApiError(404, "Bill not found.")
        result = await request.app.state.pool.execute("DELETE FROM ca_fee_bills WHERE id = $1 AND firm_id = $2", bill_id, user.home_organization_id)
        if result == "DELETE 0":
            raise ApiError(404, "Bill not found.")
        return {"deleted": True}

    return router
