"""Users and passwords shared by auth, team and the request context."""

from __future__ import annotations

import asyncio
import re
from typing import Any

import bcrypt

from ...core.db import Pool
from ...core.http import CurrentUser

EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
MIN_PASSWORD_LENGTH = 8
BCRYPT_ROUNDS = 10


def normalize_email(value: Any) -> str:
    return value.strip().lower() if isinstance(value, str) else ""


def is_valid_email(email: str) -> bool:
    return bool(EMAIL_PATTERN.match(email))


def read_password(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _password_bytes(password: str) -> bytes:
    # bcryptjs (the Node server) uses only the first 72 bytes; newer Python bcrypt refuses longer input.
    return password.encode("utf-8")[:72]


async def hash_password(password: str) -> str:
    salt = bcrypt.gensalt(rounds=BCRYPT_ROUNDS)
    hashed = await asyncio.to_thread(bcrypt.hashpw, _password_bytes(password), salt)
    return hashed.decode()


async def check_password(password: str, password_hash: str) -> bool:
    try:
        return await asyncio.to_thread(bcrypt.checkpw, _password_bytes(password), password_hash.encode())
    except ValueError:
        return False


async def find_user(pool: Pool, where: str, value: str):
    if where not in ("id", "email"):
        raise ValueError(where)
    return await pool.fetchrow(
        f"""SELECT u.id, u.email, u.password_hash, u.organization_id, u.role, o.name AS organization_name
            FROM users u
            JOIN organizations o ON o.id = u.organization_id
            WHERE u.{where} = $1""",
        value,
    )


def to_current_user(row) -> CurrentUser:
    role = row["role"] if row["role"] in ("member", "tax", "ca") else "admin"
    return CurrentUser(
        id=row["id"],
        email=row["email"],
        organization_id=row["organization_id"],
        organization_name=row["organization_name"],
        role=role,
        home_organization_id=row["organization_id"],
    )


async def apply_active_organization(pool: Pool, user: CurrentUser, organization_id: str | None) -> CurrentUser:
    """Swaps in a client company the user was given access to, if the session has one selected."""
    if not organization_id or organization_id == user.home_organization_id:
        return user
    row = await pool.fetchrow(
        """SELECT a.role, o.name FROM organization_access a
           JOIN organizations o ON o.id = a.organization_id
           WHERE a.user_id = $1 AND a.organization_id::text = $2""",
        user.id,
        organization_id,
    )
    if not row:
        return user
    return CurrentUser(
        id=user.id,
        email=user.email,
        organization_id=organization_id,
        organization_name=row["name"],
        role=row["role"],
        home_organization_id=user.home_organization_id,
    )


async def load_user(pool: Pool, user_id: str | None, organization_id: str | None) -> CurrentUser | None:
    if not user_id:
        return None
    row = await pool.fetchrow(
        """SELECT u.id, u.email, u.organization_id, u.role, o.name AS organization_name
           FROM users u JOIN organizations o ON o.id = u.organization_id
           WHERE u.id::text = $1""",
        user_id,
    )
    if not row:
        return None
    return await apply_active_organization(pool, to_current_user(row), organization_id)


def public_user(user: CurrentUser) -> dict[str, str]:
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "organizationId": user.organization_id,
        "organizationName": user.organization_name,
    }
