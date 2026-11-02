"""Sentry error reporting, on when SENTRY_DSN is set."""

from __future__ import annotations

import logging
import os

log = logging.getLogger("diamondx.monitoring")

_sentry = None


def init_monitoring() -> None:
    global _sentry
    dsn = os.environ.get("SENTRY_DSN")
    if not dsn or _sentry is not None:
        return
    try:
        import sentry_sdk
    except ImportError:
        log.warning("SENTRY_DSN is set but sentry-sdk is not installed.")
        return
    sentry_sdk.init(
        dsn=dsn,
        environment=os.environ.get("VERCEL_ENV") or os.environ.get("APP_ENV") or os.environ.get("NODE_ENV") or "development",
        release=os.environ.get("VERCEL_GIT_COMMIT_SHA"),
        # Request bodies carry passwords and SMTP credentials.
        send_default_pii=False,
        max_request_body_size="never",
        traces_sample_rate=0,
    )
    _sentry = sentry_sdk


def report_error(error: BaseException, *, method: str = "", path: str = "", user_id: str = "", organization_id: str = "") -> None:
    if _sentry is None:
        return
    with _sentry.new_scope() as scope:
        if user_id:
            scope.set_user({"id": user_id})
        if organization_id:
            scope.set_tag("organization_id", organization_id)
        if method:
            scope.set_tag("http.method", method)
        if path:
            scope.set_tag("http.path", path)
        _sentry.capture_exception(error)
    # Serverless functions can be frozen as soon as the response ends.
    if os.environ.get("VERCEL") == "1":
        _sentry.flush(2)
