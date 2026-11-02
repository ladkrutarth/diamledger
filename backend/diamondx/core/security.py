"""Security headers (what helmet sends) and request body limits. Pure ASGI middleware.

The Content Security Policy must match vercel.json; tests/test_security.py checks it.
"""

from __future__ import annotations

import json
import re

from .settings import is_production

CSP_DIRECTIVES: dict[str, list[str]] = {
    "default-src": ["'self'"],
    # Razorpay Checkout: its script, the payment frame, and its logging endpoint.
    "script-src": ["'self'", "https://checkout.razorpay.com"],
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    "img-src": ["'self'", "data:", "blob:", "https://cdn.razorpay.com"],
    "connect-src": [
        "'self'",
        "https://*.ingest.sentry.io",
        "https://*.ingest.us.sentry.io",
        "https://*.ingest.de.sentry.io",
        "https://api.razorpay.com",
        "https://lumberjack.razorpay.com",
    ],
    "frame-src": ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
}


def content_security_policy() -> str:
    return "; ".join(f"{name} {' '.join(values)}" for name, values in CSP_DIRECTIVES.items())


def security_headers(production: bool) -> list[tuple[bytes, bytes]]:
    headers = {
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
        "origin-agent-cluster": "?1",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-content-type-options": "nosniff",
        "x-dns-prefetch-control": "off",
        "x-download-options": "noopen",
        "x-frame-options": "DENY",
        "x-permitted-cross-domain-policies": "none",
        "x-xss-protection": "0",
    }
    if production:
        headers["content-security-policy"] = content_security_policy()
        headers["strict-transport-security"] = "max-age=63072000; includeSubDomains"
    return [(k.encode(), v.encode()) for k, v in headers.items()]


class SecurityHeadersMiddleware:
    def __init__(self, app) -> None:
        self.app = app
        self.headers = security_headers(is_production())
        self.names = {name for name, _ in self.headers} | {b"server", b"x-powered-by"}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                kept = [(k, v) for k, v in message.get("headers", []) if k.lower() not in self.names]
                message["headers"] = kept + self.headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


# --- Body limits --------------------------------------------------------------------------------

MB = 1024 * 1024
DEFAULT_BODY_LIMIT = 1 * MB

LARGE_BODY_ROUTES: dict[str, int] = {
    "/api/parse-manifest": 15 * MB,
    "/api/bank/parse-statement": 15 * MB,
    "/api/bank/import-lines": 3 * MB,
    "/api/send-email": 25 * MB,
    "/api/purchases/gstr2b": 3 * MB,
    "/api/tally/import": 4 * MB,
}

_DOCUMENT_UPLOAD = re.compile(r"^/api/(invoices/[^/]+/documents|requests/[^/]+/messages|bank/import|tax/ebrc/import)$")


def body_limit_for(path: str) -> int:
    if path in LARGE_BODY_ROUTES:
        return LARGE_BODY_ROUTES[path]
    return 3 * MB if _DOCUMENT_UPLOAD.match(path) else DEFAULT_BODY_LIMIT


class BodyTooLarge(Exception):
    pass


TOO_LARGE_BODY = json.dumps({"error": "The request is too large."}).encode()


class BodyLimitMiddleware:
    """413 for a body over the route's limit, by Content-Length up front or by counting a chunked body."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        limit = body_limit_for(scope["path"])
        length = dict(scope.get("headers", [])).get(b"content-length")
        if length and length.isdigit() and int(length) > limit:
            await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": TOO_LARGE_BODY})
            return

        received = 0

        async def counted_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise BodyTooLarge()
            return message

        await self.app(scope, counted_receive, send)
