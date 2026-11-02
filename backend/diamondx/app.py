"""create_app: the one place middleware and routes are registered (port of server/app.ts).

Order: security headers → body limits → response finisher → /api/health → feature routers (each runs
the request pipeline in core/context.py) → /api 404 → error handlers.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .assistant import routes as assistant_routes
from .assistant.agent import AssistantModel, default_assistant_model
from .core import health, not_found
from .core.context import ResponseFinisher
from .core.db import Pool
from .core.http import ApiError, current_user
from .core.mailer import SendPasswordResetEmail, send_password_reset_email
from .core.monitoring import report_error
from .core.security import BodyLimitMiddleware, BodyTooLarge, SecurityHeadersMiddleware
from .core.sessions import SessionStore
from .core.settings import is_production, on_vercel, session_secret
from .modules.accountant import client_requests, practice, workspace
from .modules.activity import history
from .modules.auth import routes as auth_routes
from .modules.auth import team as team_routes
from .modules.banking import bank, statement_reader, tally_sync
from .modules.billing import payment_methods
from .modules.billing import routes as billing_routes
from .modules.collections import email_dispatch, reminders
from .modules.collections.email_dispatch import CreateMailTransport, create_smtp_transport
from .modules.collections.reminders import DraftReminderText, default_reminder_text
from .modules.company import buyer_risk, company
from .modules.invoices import dashboard, invoices, manifest, payments, portal
from .modules.stock import parcels, stock
from .modules.tax import audit_checks, audit_pack, export_reports, filing, foreign_payments, forex, notices, purchases, rates, realization
from .modules.tax import tax as tax_routes
from .modules.tax.notices import DraftNoticeReply, default_notice_reply

log = logging.getLogger("diamondx.api")


@dataclass
class AppOptions:
    """External side effects, injectable so tests pass fakes instead of mocking modules."""

    send_password_reset_email: SendPasswordResetEmail = send_password_reset_email
    create_mail_transport: CreateMailTransport = create_smtp_transport
    draft_reminder_text: DraftReminderText = default_reminder_text
    draft_notice_reply: DraftNoticeReply = default_notice_reply
    assistant_model: AssistantModel = default_assistant_model
    # Tests replace the exchange-rate source (Frankfurter) with an httpx.MockTransport.
    rates_transport: httpx.AsyncBaseTransport | None = None
    razorpay_transport: httpx.AsyncBaseTransport | None = None
    paypal_transport: httpx.AsyncBaseTransport | None = None
    # Serve the built frontend (dist/) with a single-page-app fallback.
    serve_frontend: Path | None = None


def create_app(pool: Pool, options: AppOptions | None = None) -> FastAPI:
    options = options or AppOptions()
    production = is_production()
    app = FastAPI(
        title="DiamondX API",
        docs_url=None if production else "/api/docs",
        redoc_url=None,
        openapi_url=None if production else "/api/openapi.json",
    )
    app.state.pool = pool
    app.state.options = options
    app.state.sessions = SessionStore(pool, session_secret(), secure=on_vercel())

    # Added innermost first: the last one added runs first.
    app.add_middleware(ResponseFinisher)
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)

    # Order matters where paths overlap: /api/invoices/export before /api/invoices/{id}, and so on within each module.
    feature_modules = (
        health,
        auth_routes, team_routes, workspace,
        company, buyer_risk,
        invoices, payments, dashboard, portal, manifest,
        email_dispatch, reminders,
        parcels, stock,
        tax_routes, filing, realization, forex, rates, export_reports, purchases, foreign_payments, audit_checks, audit_pack, notices,
        bank, statement_reader, tally_sync,
        client_requests, practice,
        billing_routes, payment_methods,
        history,
        assistant_routes,
    )
    for module in feature_modules:
        app.include_router(module.build_router())
    app.include_router(not_found.build_router())  # last: any other /api path is a 404

    if options.serve_frontend:
        _serve_frontend(app, options.serve_frontend)

    _register_error_handlers(app)
    return app


def _error_response(status: int, message: str, headers: dict[str, str] | None = None, **extra) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status, headers=headers)


def _register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(_request: Request, error: ApiError):
        return _error_response(error.status, error.message, error.headers, **error.extra)

    @app.exception_handler(BodyTooLarge)
    async def too_large(_request: Request, _error: BodyTooLarge):
        return _error_response(413, "The request is too large.")

    @app.exception_handler(RequestValidationError)
    async def invalid(_request: Request, error: RequestValidationError):
        first = error.errors()[0] if error.errors() else {}
        return _error_response(400, str(first.get("msg") or "The request is not valid."))

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException):
        if error.status_code == 404 and request.url.path.startswith("/api"):
            return _error_response(404, f"No API route for {request.method} {request.url.path}")
        return _error_response(error.status_code, str(error.detail))

    @app.exception_handler(Exception)
    async def unexpected(request: Request, error: Exception):
        log.exception("API error")
        user = current_user(request)
        report_error(
            error,
            method=request.method,
            path=request.url.path,
            user_id=user.id if user else "",
            organization_id=user.organization_id if user else "",
        )
        return _error_response(500, "Something went wrong. Please try again.")


def _serve_frontend(app: FastAPI, dist: Path) -> None:
    dist = dist.resolve()
    index = dist / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str):
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and dist in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(index)
