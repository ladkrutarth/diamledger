"""Demo account owner@example.com / password123, its team, and its demo data (see demo_data.py).

`python -m diamondx.core.seed` creates them; add `--reset` to wipe and reload the demo company's data.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import sys

from ..modules.auth.users import check_password, hash_password
from .db import Pool
from .demo_data import fill_demo_invoices, reset_demo_data, seed_demo_data
from .settings import is_production

log = logging.getLogger("diamondx.seed")

DEMO_EMAIL = "owner@example.com"
DEMO_MEMBER_EMAIL = "priya.mehta@example.com"
DEMO_PASSWORD = "password123"

DEMO_TEAM: list[tuple[str, str]] = [
    (DEMO_EMAIL, "admin"),
    ("anil.desai@example.com", "admin"),
    ("neha.kapoor@example.com", "admin"),
    (DEMO_MEMBER_EMAIL, "member"),
    ("rahul.shah@example.com", "member"),
    ("kavita.joshi@example.com", "member"),
    ("arjun.patel@example.com", "member"),
    ("meera.nair@example.com", "member"),
    ("vikram.singh@example.com", "member"),
    ("ananya.iyer@example.com", "member"),
    ("rohan.gupta@example.com", "member"),
    ("sneha.reddy@example.com", "member"),
    ("karan.malhotra@example.com", "member"),
    ("divya.bose@example.com", "member"),
    ("amit.verma@example.com", "member"),
    ("pooja.kulkarni@example.com", "member"),
    ("nikhil.rao@example.com", "member"),
    ("isha.banerjee@example.com", "member"),
    ("dev.sharma@example.com", "member"),
    ("riya.choudhary@example.com", "member"),
    ("sameer.khan@example.com", "member"),
    ("lakshmi.pillai@example.com", "member"),
    ("harsh.agarwal@example.com", "member"),
    ("tax.desk@example.com", "tax"),
    ("ca.review@example.com", "ca"),
]


def demo_user_enabled() -> bool:
    return not is_production() or os.environ.get("SEED_DEMO_USER") == "true"


async def demo_organization_id(pool: Pool) -> str | None:
    return await pool.fetchval("SELECT organization_id FROM users WHERE email = $1", DEMO_EMAIL)


async def seed_demo_user(pool: Pool) -> None:
    if not demo_user_enabled():
        await disable_demo_password(pool)
        return
    organization_id = await demo_organization_id(pool)
    if not organization_id:
        password_hash = await hash_password(DEMO_PASSWORD)
        async with pool.acquire() as conn, conn.transaction():
            new_org = await conn.fetchval("INSERT INTO organizations (name) VALUES ($1) RETURNING id", "Meridian Diamond Exports")
            await conn.execute(
                """INSERT INTO users (email, password_hash, organization_id, role)
                   VALUES ($1, $2, $3, 'admin') ON CONFLICT (email) DO NOTHING""",
                DEMO_EMAIL,
                password_hash,
                new_org,
            )
        organization_id = await demo_organization_id(pool)
    if organization_id:
        await seed_demo_data(pool, organization_id)
        await fill_demo_invoices(pool, organization_id)
        await ensure_demo_team(pool, organization_id)


async def ensure_demo_team(pool: Pool, organization_id: str) -> None:
    # Runs on every cold start, so skip the hashing and inserts when the team is already there.
    emails = [email for email, _ in DEMO_TEAM]
    present = await pool.fetchval("SELECT COUNT(*) FROM users WHERE email = ANY($1::text[])", emails)
    if present >= len(DEMO_TEAM):
        return
    password_hash = await hash_password(DEMO_PASSWORD)
    for email, role in DEMO_TEAM:
        await pool.execute(
            """INSERT INTO users (email, password_hash, organization_id, role)
               VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING""",
            email,
            password_hash,
            organization_id,
            role,
        )


async def disable_demo_password(pool: Pool) -> None:
    row = await pool.fetchrow("SELECT id, password_hash FROM users WHERE email = $1", DEMO_EMAIL)
    if not row or not await check_password(DEMO_PASSWORD, row["password_hash"]):
        return
    unusable = await hash_password(secrets.token_hex(32))
    await pool.execute("UPDATE users SET password_hash = $2 WHERE id = $1", row["id"], unusable)
    log.warning('Disabled the public demo password for %s. Use "Forgot password?" to set a new one.', DEMO_EMAIL)


async def main() -> int:
    from .db import create_pool, run_migrations
    from .settings import load_env

    load_env()
    if not demo_user_enabled():
        print("Refusing to seed demo data in production. Set SEED_DEMO_USER=true to allow it.", file=sys.stderr)
        return 1
    pool = await create_pool()
    try:
        await run_migrations(pool)
        await seed_demo_user(pool)
        organization_id = await demo_organization_id(pool)
        if not organization_id:
            raise RuntimeError(f"No {DEMO_EMAIL} account to seed.")
        if "--reset" in sys.argv:
            print(f"Resetting demo data for {DEMO_EMAIL} only. Other companies are not touched.")
            result = await reset_demo_data(pool, organization_id)
            print(f"Reseeded {result['invoices']} demo invoices.")
        else:
            print(f"Demo account ready: {DEMO_EMAIL}. Use --reset to wipe and reseed its data.")
        return 0
    finally:
        await pool.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
