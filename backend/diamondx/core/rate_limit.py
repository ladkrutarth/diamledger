"""Rate limits stored in Postgres (`rate_limits`), so they hold across serverless instances.

Same rules, key prefixes and table as server/core/rateLimit.ts.
"""

from __future__ import annotations

import ipaddress
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import Request

from .db import Pool
from .http import ApiError, CurrentUser


def client_ip(request: Request) -> str:
    """The address one proxy hop back (Express `trust proxy` 1), with IPv6 cut to its /56 network."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        ip = forwarded.split(",")[-1].strip()
    else:
        ip = request.client.host if request.client else "unknown"
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped:
            return str(address.ipv4_mapped)
        return str(ipaddress.ip_network(f"{address}/56", strict=False))
    return ip


def _normalize_email(value: Any) -> str:
    return value.strip().lower() if isinstance(value, str) else ""


KeyFn = Callable[[Request, "CurrentUser | None", dict], str]


def _ip(request: Request, _user: CurrentUser | None, _body: dict) -> str:
    return client_ip(request)


def _user_or_ip(request: Request, user: CurrentUser | None, _body: dict) -> str:
    return f"user:{user.id}" if user else f"ip:{client_ip(request)}"


def _login_key(request: Request, _user: CurrentUser | None, body: dict) -> str:
    return f"{client_ip(request)}:{_normalize_email(body.get('email'))}"


@dataclass(frozen=True)
class LimitRule:
    path: str
    name: str
    window_minutes: int
    limit: int
    message: str
    key: KeyFn
    skip_successful: bool = False
    method: str = "POST"
    pattern: re.Pattern = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        regex = "^" + re.sub(r":[A-Za-z_]+", "[^/]+", self.path) + "/?$"
        object.__setattr__(self, "pattern", re.compile(regex, re.IGNORECASE))

    @property
    def window_seconds(self) -> int:
        return self.window_minutes * 60


RULES: list[LimitRule] = [
    LimitRule("/api/auth/login", "login", 15, 10, "Too many failed sign-in attempts. Wait 15 minutes, or reset your password.", _login_key, skip_successful=True),
    LimitRule("/api/auth/register", "register", 60, 5, "Too many accounts created from this network. Try again in an hour.", _ip),
    LimitRule("/api/auth/forgot-password", "forgot", 60, 5, "Too many reset requests. Try again in an hour.", _ip),
    LimitRule("/api/auth/reset-password", "reset", 60, 10, "Too many reset attempts. Try again in an hour.", _ip),
    LimitRule("/api/send-email", "send-email", 60, 30, "Email limit reached: 30 emails per hour. Try again later.", _user_or_ip),
    LimitRule("/api/verify-smtp", "verify-smtp", 60, 20, "Too many SMTP checks. Try again in an hour.", _user_or_ip),
    LimitRule("/api/parse-manifest", "parse-manifest", 60, 60, "AI parsing limit reached: 60 manifests per hour. Try again later.", _user_or_ip),
    LimitRule("/api/bank/parse-statement", "parse-statement", 60, 30, "AI statement reading limit reached: 30 statements per hour. Try again later.", _user_or_ip),
    LimitRule("/api/portal/:token", "buyer-portal", 15, 120, "Too many requests. Try again in a few minutes.", _ip, method="GET"),
    LimitRule("/api/reminders/draft", "reminder-draft", 60, 60, "Reminder drafting limit reached: 60 drafts per hour. Try again later.", _user_or_ip),
    LimitRule("/api/reminders/:id/send", "reminder-send", 60, 30, "Reminder limit reached: 30 reminders per hour. Try again later.", _user_or_ip),
    LimitRule("/api/assistant/sessions/:id/messages", "assistant-message", 60, 30, "Assistant limit reached: 30 questions per hour. Try again later.", _user_or_ip),
    LimitRule("/api/notices/:id/draft-reply", "notice-draft", 60, 30, "Notice drafting limit reached: 30 drafts per hour. Try again later.", _user_or_ip),
    LimitRule("/api/billing/checkout", "billing-checkout", 60, 20, "Too many checkout attempts. Try again in an hour.", _user_or_ip),
    LimitRule("/api/billing/paypal/order", "paypal-order", 60, 20, "Too many PayPal attempts. Try again in an hour.", _user_or_ip),
    LimitRule("/api/billing/bank-transfer", "bank-transfer", 60, 10, "Too many bank transfer requests. Try again in an hour.", _user_or_ip),
    LimitRule("/api/tally/import", "tally-import", 60, 30, "Too many Tally imports. Try again in an hour.", _user_or_ip),
    LimitRule("/api/assistant/reviews", "assistant-review", 60, 10, "Month review limit reached: 10 reviews per hour. Try again later.", _user_or_ip),
]


def rule_for(method: str, path: str) -> LimitRule | None:
    method = "GET" if method == "HEAD" else method
    for rule in RULES:
        if rule.method == method and rule.pattern.match(path):
            return rule
    return None


async def increment(pool: Pool, key: str, window_seconds: int) -> tuple[int, datetime]:
    row = await pool.fetchrow(
        """INSERT INTO rate_limits (key, hits, reset_at)
           VALUES ($1, 1, now() + make_interval(secs => $2))
           ON CONFLICT (key) DO UPDATE SET
             hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
             reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
           RETURNING hits, reset_at""",
        key,
        float(window_seconds),
    )
    return row["hits"], row["reset_at"]


async def decrement(pool: Pool, key: str) -> None:
    await pool.execute("UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1", key)


@dataclass
class LimitState:
    """What the response finisher needs: headers to add, and a key to give back on success."""

    headers: dict[str, str]
    refund_key: str | None


async def apply_rate_limit(pool: Pool, request: Request, user: CurrentUser | None, body: dict) -> LimitState | None:
    rule = rule_for(request.method, request.url.path)
    if not rule:
        return None
    key = f"{rule.name}:{rule.key(request, user, body)}"
    hits, reset_at = await increment(pool, key, rule.window_seconds)
    reset_in = max(0, math.ceil((reset_at - datetime.now(timezone.utc)).total_seconds()))
    remaining = max(0, rule.limit - hits)
    policy = f'"{rule.limit}-in-{rule.window_minutes}min"'
    headers = {
        "RateLimit-Policy": f"{policy}; q={rule.limit}; w={rule.window_seconds}",
        "RateLimit": f"{policy}; r={remaining}; t={reset_in}",
    }
    if hits > rule.limit:
        raise ApiError(429, rule.message, headers={**headers, "Retry-After": str(reset_in)})
    return LimitState(headers=headers, refund_key=key if rule.skip_successful else None)
