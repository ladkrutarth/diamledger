"""Sign up, sign in, sign out, password change and reset (port of server/modules/auth/auth.ts)."""

from __future__ import annotations

import hashlib
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone

import asyncpg
from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.http import ApiError, CurrentUser, body, require_user
from .users import (
    MIN_PASSWORD_LENGTH,
    check_password,
    find_user,
    hash_password,
    is_valid_email,
    normalize_email,
    public_user,
    read_password,
    to_current_user,
)

log = logging.getLogger("diamondx.auth")

RESET_TOKEN_TTL = timedelta(hours=1)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def app_base_url(request: Request) -> str:
    configured = os.environ.get("APP_URL", "")
    if re.match(r"^https?://", configured):
        return configured.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    return f"{proto}://{host}"


def build_router():
    router = api_router(prefix="/api/auth")

    @router.post("/register")
    async def register(request: Request):
        data = body(request)
        email = normalize_email(data.get("email"))
        password = read_password(data.get("password"))
        company = data.get("companyName")
        company_name = company.strip()[:200] if isinstance(company, str) and company.strip() else email.split("@")[0]

        if not is_valid_email(email):
            raise ApiError(400, "Enter a valid email address.")
        if len(password) < MIN_PASSWORD_LENGTH:
            raise ApiError(400, "Password must be at least 8 characters.")

        password_hash = await hash_password(password)
        pool = request.app.state.pool
        try:
            async with pool.acquire() as conn, conn.transaction():
                organization_id = await conn.fetchval("INSERT INTO organizations (name) VALUES ($1) RETURNING id", company_name)
                user_id = await conn.fetchval(
                    """INSERT INTO users (email, password_hash, organization_id, role)
                       VALUES ($1, $2, $3, 'admin') RETURNING id""",
                    email,
                    password_hash,
                    organization_id,
                )
        except asyncpg.UniqueViolationError:
            raise ApiError(409, "An account with that email already exists.") from None

        await request.app.state.sessions.regenerate(request.state.session, userId=user_id)
        user = await find_user(pool, "id", user_id)
        return JSONResponse({"user": public_user(to_current_user(user))}, status_code=201)

    @router.post("/login")
    async def login(request: Request):
        data = body(request)
        email = normalize_email(data.get("email"))
        password = read_password(data.get("password"))
        if not email or not password:
            raise ApiError(400, "Email and password are required.")

        user = await find_user(request.app.state.pool, "email", email)
        if not user or not await check_password(password, user["password_hash"]):
            raise ApiError(401, "Invalid email or password.")
        await request.app.state.sessions.regenerate(request.state.session, userId=user["id"])
        return {"user": public_user(to_current_user(user))}

    @router.post("/logout")
    async def logout(request: Request):
        await request.app.state.sessions.destroy(request.state.session)
        return {"success": True}

    @router.get("/me")
    async def me(user: CurrentUser = Depends(require_user)):
        return {"user": public_user(user)}

    @router.post("/change-password")
    async def change_password(request: Request, user: CurrentUser = Depends(require_user)):
        data = body(request)
        current_password = read_password(data.get("currentPassword"))
        new_password = read_password(data.get("newPassword"))
        if len(new_password) < MIN_PASSWORD_LENGTH:
            raise ApiError(400, "New password must be at least 8 characters.")
        pool = request.app.state.pool
        row = await find_user(pool, "id", user.id)
        if not row or not await check_password(current_password, row["password_hash"]):
            raise ApiError(400, "Current password is incorrect.")

        await pool.execute("UPDATE users SET password_hash = $2 WHERE id = $1", user.id, await hash_password(new_password))
        await pool.execute(
            "DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2",
            user.id,
            request.state.session.sid or "",
        )
        return {"success": True}

    @router.post("/forgot-password")
    async def forgot_password(request: Request):
        email = normalize_email(body(request).get("email"))
        message = "If that email has an account, a reset link has been sent."
        if not is_valid_email(email):
            return {"success": True, "message": message}

        pool = request.app.state.pool
        user = await find_user(pool, "email", email)
        if user:
            token = secrets.token_hex(32)
            await pool.execute(
                "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
                hash_token(token),
                user["id"],
                datetime.now(timezone.utc) + RESET_TOKEN_TTL,
            )
            link = f"{app_base_url(request)}/?reset={token}"
            try:
                await request.app.state.options.send_password_reset_email(user["email"], link)
            except Exception:
                log.exception("Password reset email failed")
        return {"success": True, "message": message}

    @router.post("/reset-password")
    async def reset_password(request: Request):
        data = body(request)
        token = data.get("token") if isinstance(data.get("token"), str) else ""
        password = read_password(data.get("password"))
        if len(password) < MIN_PASSWORD_LENGTH:
            raise ApiError(400, "Password must be at least 8 characters.")

        pool = request.app.state.pool
        user_id = await pool.fetchval(
            """UPDATE password_reset_tokens SET used_at = now()
               WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
               RETURNING user_id""",
            hash_token(token),
        )
        if not user_id:
            raise ApiError(400, "This reset link is invalid or has expired.")

        await pool.execute("UPDATE users SET password_hash = $2 WHERE id = $1", user_id, await hash_password(password))
        await pool.execute("DELETE FROM session WHERE sess->>'userId' = $1", user_id)
        return {"success": True}

    return router
