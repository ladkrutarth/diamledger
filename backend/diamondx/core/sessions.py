"""Cookie sessions stored in the `session` table, compatible with express-session + connect-pg-simple.

The cookie (`connect.sid`, value `s:<sid>.<hmac>`) and the row format are the ones the Node server
writes, so a user signed in on one server is signed in on the other while routes move over.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from typing import Any
from urllib.parse import quote, unquote

from .db import Pool

COOKIE_NAME = "connect.sid"
MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
# encodeURIComponent leaves these unescaped.
_URI_SAFE = "-_.!~*'()"


def sign(value: str, secret: str) -> str:
    mac = hmac.new(secret.encode(), value.encode(), hashlib.sha256).digest()
    return f"{value}.{base64.b64encode(mac).decode().rstrip('=')}"


def unsign(signed: str, secret: str) -> str | None:
    if "." not in signed:
        return None
    value = signed.rsplit(".", 1)[0]
    return value if hmac.compare_digest(sign(value, secret).encode(), signed.encode()) else None


def cookie_value(sid: str, secret: str) -> str:
    return quote("s:" + sign(sid, secret), safe=_URI_SAFE)


def sid_from_cookie(raw: str | None, secret: str) -> str | None:
    if not raw:
        return None
    value = unquote(raw)
    if not value.startswith("s:"):
        return None
    return unsign(value[2:], secret)


def _js_iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


@dataclass
class Session:
    sid: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
    # Set-Cookie header values to send with the response.
    outgoing_cookies: list[str] = field(default_factory=list)

    @property
    def user_id(self) -> str | None:
        value = self.data.get("userId")
        return value if isinstance(value, str) else None

    @property
    def organization_id(self) -> str | None:
        value = self.data.get("organizationId")
        return value if isinstance(value, str) else None


class SessionStore:
    def __init__(self, pool: Pool, secret: str, secure: bool) -> None:
        self.pool = pool
        self.secret = secret
        self.secure = secure

    def _cookie_meta(self, expires: datetime) -> dict[str, Any]:
        return {
            "originalMaxAge": MAX_AGE_MS,
            "expires": _js_iso(expires),
            "secure": self.secure,
            "httpOnly": True,
            "path": "/",
            "sameSite": "lax",
        }

    def _set_cookie_header(self, sid: str, expires: datetime) -> str:
        parts = [
            f"{COOKIE_NAME}={cookie_value(sid, self.secret)}",
            "Path=/",
            f"Expires={format_datetime(expires, usegmt=True)}",
            "HttpOnly",
        ]
        if self.secure:
            parts.append("Secure")
        parts.append("SameSite=Lax")
        return "; ".join(parts)

    @staticmethod
    def _clear_cookie_header() -> str:
        return f"{COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"

    async def load(self, raw_cookie: str | None) -> Session:
        """Reads the session and pushes its expiry forward, as connect-pg-simple's touch does."""
        sid = sid_from_cookie(raw_cookie, self.secret)
        if not sid:
            return Session()
        expire = time.time() + MAX_AGE_MS / 1000
        row = await self.pool.fetchrow(
            """UPDATE session SET expire = to_timestamp($2)
               WHERE sid = $1 AND expire >= to_timestamp($3)
               RETURNING sess""",
            sid,
            expire,
            time.time(),
        )
        if not row or not isinstance(row["sess"], dict):
            return Session()
        data = {k: v for k, v in row["sess"].items() if k != "cookie"}
        return Session(sid=sid, data=data)

    async def save(self, session: Session) -> None:
        if not session.sid:
            session.sid = secrets.token_urlsafe(24)
        expires = datetime.now(timezone.utc) + timedelta(milliseconds=MAX_AGE_MS)
        sess = {"cookie": self._cookie_meta(expires), **session.data}
        await self.pool.execute(
            """INSERT INTO session (sess, expire, sid) VALUES ($1, to_timestamp($2), $3)
               ON CONFLICT (sid) DO UPDATE SET sess = $1, expire = to_timestamp($2)""",
            sess,
            expires.timestamp(),
            session.sid,
        )
        session.outgoing_cookies.append(self._set_cookie_header(session.sid, expires))

    async def regenerate(self, session: Session, **data: Any) -> None:
        """A new session id on sign-in, so a session id fixed before sign-in is worthless."""
        if session.sid:
            await self.pool.execute("DELETE FROM session WHERE sid = $1", session.sid)
        session.sid = None
        session.data = dict(data)
        await self.save(session)

    async def destroy(self, session: Session) -> None:
        if session.sid:
            await self.pool.execute("DELETE FROM session WHERE sid = $1", session.sid)
        session.sid = None
        session.data = {}
        session.outgoing_cookies.append(self._clear_cookie_header())
