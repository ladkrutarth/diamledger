"""Request helpers and guards (port of server/core/http.ts). Guards are FastAPI dependencies."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import Request

Role = Literal["admin", "member", "tax", "ca"]
ROLES: tuple[Role, ...] = ("admin", "member", "tax", "ca")

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)


def is_role(value: Any) -> bool:
    return value in ROLES


def is_uuid(value: str) -> bool:
    return bool(UUID_PATTERN.match(value))


@dataclass(frozen=True)
class CurrentUser:
    id: str
    email: str
    organization_id: str
    organization_name: str
    role: Role
    home_organization_id: str


class ApiError(Exception):
    """Answered as {"error": message, **extra} with the given status."""

    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.headers = headers
        self.extra = extra


def current_user(request: Request) -> CurrentUser | None:
    return getattr(request.state, "user", None)


def require_user(request: Request) -> CurrentUser:
    user = current_user(request)
    if not user:
        raise ApiError(401, "Sign in required.")
    return user


def require_admin(request: Request) -> CurrentUser:
    user = require_user(request)
    if user.role != "admin":
        raise ApiError(403, "Only company admins can do this.")
    return user


def require_roles(*roles: Role):
    def guard(request: Request) -> CurrentUser:
        user = require_user(request)
        if user.role not in roles:
            raise ApiError(403, "You do not have access to this.")
        return user

    return guard


def body(request: Request) -> dict[str, Any]:
    """The JSON body as a dict, or {} when it is missing or not an object (like `req.body ?? {}`)."""
    value = getattr(request.state, "body", None)
    return value if isinstance(value, dict) else {}


def string_fields(value: Any, keys: tuple[str, ...] | list[str]) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    result: dict[str, str] = {}
    for key in keys:
        field = value.get(key)
        if field is None:
            result[key] = ""
        elif isinstance(field, str):
            result[key] = field[:500]
        else:
            return None
    return result


def iso(value: datetime | None) -> str | None:
    """A timestamp as JavaScript's toISOString() writes it: 2026-11-02T10:04:05.123Z."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"
