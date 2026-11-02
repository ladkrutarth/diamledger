"""The request pipeline for routes served by Python, in the order server/app.ts runs it:

body → session → user → chartered-accountant guard → subscription guard → rate limit → (route) → audit trail.

It is a router dependency (see `api_router`) rather than global middleware, so requests that are
proxied to the Node server are not limited or audited twice. `ResponseFinisher` applies what the
pipeline asked for (cookies, rate-limit headers and refunds, the audit row) once the status is known.
"""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, Request

from ..modules.activity.audit import describe_change, record_change
from ..modules.auth.users import load_user
from ..modules.billing.subscription import check_subscription
from .http import ApiError, CurrentUser
from .rate_limit import apply_rate_limit, decrement
from .sessions import COOKIE_NAME

READ_METHODS = {"GET", "HEAD", "OPTIONS"}

_CA_ALLOWED = [
    re.compile(r"^/api/auth/logout$"),
    re.compile(r"^/api/auth/change-password$"),
    re.compile(r"^/api/auth/two-factor(/|$)"),
    re.compile(r"^/api/workspace/switch$"),
    re.compile(r"^/api/assistant/"),
    re.compile(r"^/api/practice/"),
    re.compile(r"^/api/requests$"),
    re.compile(r"^/api/requests/[0-9a-f-]{36}/(messages|status)$"),
    re.compile(r"^/api/invoices/[0-9a-f-]{36}/review$"),
    re.compile(r"^/api/tax/months/\d{4}-\d{2}/(close|open)$"),
]

CA_FORBIDDEN = (
    "A chartered accountant account can review invoices, close months, raise requests, track notices, and use the "
    "assistant. It cannot change invoices, payments, buyers, or the team."
)


def chartered_accountant_allowed(method: str, path: str, user: CurrentUser | None) -> bool:
    """A CA may read anything but write only through an explicit allowlist. New CA-writable endpoints go here."""
    if not user or user.role != "ca" or method in READ_METHODS:
        return True
    if path.startswith("/api/notices") and method != "DELETE":
        return True
    return any(pattern.match(path) for pattern in _CA_ALLOWED)


RAW_BODY_PATHS = {"/api/billing/webhook"}  # signed over the exact bytes; the route reads them itself
RAW_BODY_PREFIXES = ("/api/collections/webhook/",)  # each exporter's own Razorpay webhook


async def _read_body(request: Request):
    path = request.url.path
    if request.method in READ_METHODS or path in RAW_BODY_PATHS or path.startswith(RAW_BODY_PREFIXES):
        return None
    raw = await request.body()
    if not raw:
        return None
    content_type = request.headers.get("content-type", "")
    if "json" not in content_type:
        return None
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ApiError(400, "The request body is not valid JSON.") from None


async def request_context(request: Request) -> None:
    app_state = request.app.state
    pool, store = app_state.pool, app_state.sessions
    path = request.url.path

    request.state.body = await _read_body(request)
    session = await store.load(request.cookies.get(COOKIE_NAME))
    request.state.session = session
    user = await load_user(pool, session.user_id, session.organization_id)
    request.state.user = user

    if not chartered_accountant_allowed(request.method, path, user):
        raise ApiError(403, CA_FORBIDDEN)
    await check_subscription(pool, request.method, path, user)
    body = request.state.body if isinstance(request.state.body, dict) else {}
    request.state.rate_limit = await apply_rate_limit(pool, request, user, body)
    request.state.audit = describe_change(request.method, path, user, body)


def api_router(**kwargs) -> APIRouter:
    """A router whose routes run the full request pipeline. Use it for every feature module."""
    return APIRouter(dependencies=[Depends(request_context)], **kwargs)


class ResponseFinisher:
    """Pure ASGI middleware: runs when the response status is known, before any byte is sent."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        state: dict = scope.setdefault("state", {})
        pool = None

        async def finishing_send(message):
            nonlocal pool
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = list(message.get("headers", []))
                session = state.get("session")
                if session is not None:
                    headers += [(b"set-cookie", value.encode("latin-1")) for value in session.outgoing_cookies]
                limit = state.get("rate_limit")
                app = scope.get("app")
                pool = app.state.pool if app is not None else None
                if limit is not None:
                    names = {name.lower().encode() for name in limit.headers}
                    headers = [(k, v) for k, v in headers if k.lower() not in names]
                    headers += [(k.encode(), v.encode()) for k, v in limit.headers.items()]
                    if limit.refund_key and status < 400 and pool is not None:
                        await decrement(pool, limit.refund_key)
                pending = state.get("audit")
                if pending is not None and status < 400 and pool is not None:
                    await record_change(pool, pending)
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, finishing_send)
