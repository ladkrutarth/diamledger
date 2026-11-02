"""Requests between the accountant and the company: the accountant asks, the company answers, with files
(port of server/modules/accountant/clientRequests.ts)."""

from __future__ import annotations

import base64
import binascii
import re
from datetime import date, datetime, timezone

from fastapi import Depends, Request, Response
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import form_reader
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, require_user

ATTACHMENT_TYPES = {
    "application/pdf", "image/jpeg", "image/png", "text/csv", "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
MAX_ATTACHMENT_BYTES = 2_000_000


def is_accountant_side(user: CurrentUser) -> bool:
    return user.role in ("ca", "tax")


def to_request(row, today: str) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "detail": row["detail"],
        "dueDate": row["due_date"],
        "overdue": row["status"] != "closed" and row["due_date"] is not None and row["due_date"] < today,
        "status": row["status"],
        "invoiceId": row["invoice_id"],
        "invoiceNumber": row["invoice_number"],
        "createdByEmail": row["created_by_email"],
        "createdAt": iso(row["created_at"]),
        "updatedAt": iso(row["updated_at"]),
        "messages": row["messages"],
        "lastMessageAt": iso(row["last_message_at"]),
    }


async def open_request_counts(pool: Pool, organization_id: str) -> dict:
    row = await pool.fetchrow(
        """SELECT COUNT(*) FILTER (WHERE status <> 'closed') AS open,
                  COUNT(*) FILTER (WHERE status <> 'closed' AND due_date < current_date) AS overdue
           FROM client_requests WHERE organization_id = $1""",
        organization_id,
    )
    return {"open": row["open"], "overdue": row["overdue"]}


def read_attachment(value) -> dict | None:
    """The attached file, None when there is none. Raises ApiError(400) for a bad one."""
    if value is None:
        return None
    file = value if isinstance(value, dict) else {}
    name = file["name"].strip()[:200] if isinstance(file.get("name"), str) else ""
    content_type = file["type"] if isinstance(file.get("type"), str) else ""
    if not name or not isinstance(file.get("base64"), str):
        raise ApiError(400, "The attachment is missing its name or content.")
    if content_type not in ATTACHMENT_TYPES:
        raise ApiError(400, "Attach a PDF, JPG, PNG, CSV, or Excel file.")
    encoded = re.sub(r"[^A-Za-z0-9+/]", "", file["base64"])
    try:
        content = base64.b64decode(encoded + "=" * (-len(encoded) % 4))
    except (binascii.Error, ValueError):
        content = b""
    if not content:
        raise ApiError(400, "The attachment is empty.")
    if len(content) > MAX_ATTACHMENT_BYTES:
        raise ApiError(400, "Attachments can be at most 2 MB.")
    return {"fileName": name, "contentType": content_type, "content": content}


async def _load(pool: Pool, organization_id: str, request_id: str):
    if not is_uuid(request_id):
        return None
    return await pool.fetchrow(
        "SELECT id, status, created_by FROM client_requests WHERE id = $1 AND organization_id = $2", request_id, organization_id
    )


def build_router():
    router = api_router(prefix="/api/requests")

    @router.get("")
    async def list_requests(request: Request, user: CurrentUser = Depends(require_user)):
        requested = request.query_params.get("status")
        status = "closed" if requested == "closed" else "all" if requested == "all" else "active"
        rows = await request.app.state.pool.fetch(
            """SELECT r.id, r.title, r.detail, to_char(r.due_date, 'YYYY-MM-DD') AS due_date, r.status, r.invoice_id, i.invoice_number,
                      r.created_by_email, r.created_at, r.updated_at,
                      (SELECT COUNT(*) FROM client_request_messages m WHERE m.request_id = r.id) AS messages,
                      (SELECT MAX(created_at) FROM client_request_messages m WHERE m.request_id = r.id) AS last_message_at
               FROM client_requests r LEFT JOIN invoices i ON i.id = r.invoice_id
               WHERE r.organization_id = $1
                 AND ($2 = 'all' OR ($2 = 'closed' AND r.status = 'closed') OR ($2 = 'active' AND r.status <> 'closed'))
               ORDER BY (r.status = 'closed'), r.due_date NULLS LAST, r.updated_at DESC
               LIMIT 500""",
            user.organization_id, status,
        )
        today = datetime.now(timezone.utc).date().isoformat()
        return {"requests": [to_request(row, today) for row in rows]}

    @router.post("")
    async def create(request: Request, user: CurrentUser = Depends(require_user)):
        form = form_reader(body(request))
        title = form.required("title", 'Say what you need, for example "Bank statement for March".', 200)
        detail = form.text("detail", 4000)
        due = form.date("dueDate", "Enter the due date as YYYY-MM-DD.", True)
        invoice_id = form.text("invoiceId", 40)
        pool: Pool = request.app.state.pool
        if invoice_id:
            found = is_uuid(invoice_id) and await pool.fetchval(
                "SELECT 1 FROM invoices WHERE id = $1 AND organization_id = $2", invoice_id, user.organization_id
            )
            if not found:
                raise ApiError(400, "That invoice is not in this company.")
        new_id = await pool.fetchval(
            """INSERT INTO client_requests (organization_id, title, detail, due_date, invoice_id, created_by, created_by_email)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id""",
            user.organization_id, title, detail, date.fromisoformat(due) if due else None, invoice_id or None, user.id, user.email,
        )
        return JSONResponse({"id": new_id}, status_code=201)

    @router.get("/{request_id}/messages")
    async def messages(request_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        found = await _load(pool, user.organization_id, request_id)
        if not found:
            raise ApiError(404, "Request not found.")
        rows = await pool.fetch(
            """SELECT id, user_email, body, file_name, content_type, byte_size, created_at FROM client_request_messages
               WHERE request_id = $1 ORDER BY created_at""",
            found["id"],
        )
        return {"messages": [
            {"id": r["id"], "userEmail": r["user_email"], "body": r["body"],
             "file": {"name": r["file_name"], "type": r["content_type"], "size": r["byte_size"]} if r["file_name"] else None,
             "createdAt": iso(r["created_at"])}
            for r in rows
        ]}

    @router.post("/{request_id}/messages")
    async def reply(request_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        found = await _load(pool, user.organization_id, request_id)
        if not found:
            raise ApiError(404, "Request not found.")
        if found["status"] == "closed":
            raise ApiError(409, "This request is closed. Reopen it to reply.")
        data = body(request)
        text = data["body"].strip()[:4000] if isinstance(data.get("body"), str) else ""
        file = read_attachment(data.get("file"))
        if not text and not file:
            raise ApiError(400, "Write a reply or attach a file.")
        await pool.execute(
            """INSERT INTO client_request_messages (request_id, organization_id, user_id, user_email, body, file_name, content_type, byte_size, content)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)""",
            found["id"], user.organization_id, user.id, user.email, text,
            file["fileName"] if file else None, file["contentType"] if file else None,
            len(file["content"]) if file else None, file["content"] if file else None,
        )
        # A reply from the company marks the request answered; a follow-up from the accountant opens it again.
        await pool.execute("UPDATE client_requests SET status = $2, updated_at = now() WHERE id = $1",
                           found["id"], "open" if is_accountant_side(user) else "answered")
        return JSONResponse({"ok": True}, status_code=201)

    @router.post("/{request_id}/status")
    async def set_status(request_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        found = await _load(pool, user.organization_id, request_id)
        if not found:
            raise ApiError(404, "Request not found.")
        requested = body(request).get("status")
        status = requested if requested in ("closed", "open") else None
        if not status:
            raise ApiError(400, "Status must be open or closed.")
        if not (found["created_by"] == user.id or user.role == "admin" or is_accountant_side(user)):
            raise ApiError(403, "Only the person who asked, an admin, or the accountant can close this request.")
        await pool.execute("UPDATE client_requests SET status = $2, updated_at = now() WHERE id = $1", found["id"], status)
        return {"status": status}

    @router.get("/{request_id}/messages/{message_id}/file")
    async def download(request_id: str, message_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        if not is_uuid(request_id) or not is_uuid(message_id):
            raise ApiError(404, "File not found.")
        file = await request.app.state.pool.fetchrow(
            """SELECT file_name, content_type, content FROM client_request_messages
               WHERE id = $1 AND request_id = $2 AND organization_id = $3 AND content IS NOT NULL""",
            message_id, request_id, user.organization_id,
        )
        if not file:
            raise ApiError(404, "File not found.")
        name = re.sub(r'["\r\n\\]', "_", file["file_name"])
        return Response(bytes(file["content"]), media_type=file["content_type"],
                        headers={"Content-Disposition": f'attachment; filename="{name}"', "X-Content-Type-Options": "nosniff"})

    return router
