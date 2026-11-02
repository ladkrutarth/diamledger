"""Team members of a company (port of server/modules/auth/team.ts). Outside accountants are still on Node."""

from __future__ import annotations

import asyncpg
from fastapi import Depends, Request, Response
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.http import ApiError, CurrentUser, body, is_role, is_uuid, iso, require_admin
from ..billing.subscription import limit_message
from .users import MIN_PASSWORD_LENGTH, hash_password, is_valid_email, normalize_email


def to_member(row) -> dict:
    return {"id": row["id"], "email": row["email"], "role": row["role"], "createdAt": iso(row["created_at"])}


async def admin_count(pool, organization_id: str) -> int:
    return await pool.fetchval("SELECT COUNT(*) FROM users WHERE organization_id = $1 AND role = 'admin'", organization_id)


def build_router():
    router = api_router(prefix="/api/team/members")

    @router.get("")
    async def list_members(request: Request, user: CurrentUser = Depends(require_admin)):
        rows = await request.app.state.pool.fetch(
            "SELECT id, email, role, created_at FROM users WHERE organization_id = $1 ORDER BY created_at",
            user.organization_id,
        )
        return {"members": [to_member(row) for row in rows]}

    @router.post("")
    async def add_member(request: Request, user: CurrentUser = Depends(require_admin)):
        data = body(request)
        email = normalize_email(data.get("email"))
        password = data.get("password") if isinstance(data.get("password"), str) else ""
        role = data.get("role") if is_role(data.get("role")) else "member"

        if not is_valid_email(email):
            raise ApiError(400, "Enter a valid email address.")
        if len(password) < MIN_PASSWORD_LENGTH:
            raise ApiError(400, "Temporary password must be at least 8 characters.")
        pool = request.app.state.pool
        over_limit = await limit_message(pool, user.organization_id, "users")
        if over_limit:
            raise ApiError(402, over_limit, code="plan_limit")
        try:
            row = await pool.fetchrow(
                """INSERT INTO users (email, password_hash, organization_id, role)
                   VALUES ($1, $2, $3, $4)
                   RETURNING id, email, role, created_at""",
                email,
                await hash_password(password),
                user.organization_id,
                role,
            )
        except asyncpg.UniqueViolationError:
            raise ApiError(409, "An account with that email already exists.") from None
        return JSONResponse(to_member(row), status_code=201)

    @router.patch("/{member_id}")
    async def change_role(member_id: str, request: Request, user: CurrentUser = Depends(require_admin)):
        role = body(request).get("role")
        if not is_role(role):
            raise ApiError(400, "Choose admin, member, tax accountant, or chartered accountant.")
        if not is_uuid(member_id):
            raise ApiError(404, "Team member not found.")
        pool = request.app.state.pool
        target = await pool.fetchrow(
            "SELECT id, email, role, created_at FROM users WHERE id = $1 AND organization_id = $2",
            member_id,
            user.organization_id,
        )
        if not target:
            raise ApiError(404, "Team member not found.")
        if target["role"] == "admin" and role != "admin" and await admin_count(pool, user.organization_id) <= 1:
            raise ApiError(409, "A company needs at least one admin.")
        row = await pool.fetchrow(
            "UPDATE users SET role = $3 WHERE id = $1 AND organization_id = $2 RETURNING id, email, role, created_at",
            member_id,
            user.organization_id,
            role,
        )
        return to_member(row)

    @router.delete("/{member_id}")
    async def remove_member(member_id: str, request: Request, user: CurrentUser = Depends(require_admin)):
        if member_id == user.id:
            raise ApiError(409, "You cannot remove your own account.")
        if not is_uuid(member_id):
            raise ApiError(404, "Team member not found.")
        pool = request.app.state.pool
        result = await pool.execute("DELETE FROM users WHERE id = $1 AND organization_id = $2", member_id, user.organization_id)
        if result == "DELETE 0":
            raise ApiError(404, "Team member not found.")
        await pool.execute("DELETE FROM session WHERE sess->>'userId' = $1", member_id)
        return Response(status_code=204)

    return router
