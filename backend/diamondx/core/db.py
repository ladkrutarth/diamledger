"""Connection pool and migrations. Same SQL files, lock id and schema_migrations table as server/core/db.ts,
so either server can migrate the database."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import re
import ssl
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg

from .settings import REPO_ROOT

log = logging.getLogger("diamondx.db")

Pool = asyncpg.Pool


def is_local_database(connection_string: str) -> bool:
    """Hosts on this machine or on a private Docker network, where TLS is not used."""
    try:
        host = (urlsplit(connection_string).hostname or "").strip("[]")
    except ValueError:
        return False
    # A single-label name such as "postgres" is a Docker Compose service, not a public host.
    return host in ("localhost", "127.0.0.1", "::1") or "." not in host


def _positive(value: str | None, fallback: float) -> float:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) and parsed > 0 else fallback


@dataclass(frozen=True)
class PoolSettings:
    max_size: int
    idle_timeout_s: float
    connect_timeout_s: float
    query_timeout_s: float


def pool_settings(environ: Mapping[str, str] = os.environ) -> PoolSettings:
    """Serverless instances each hold their own pool behind a transaction pooler, so they stay small."""
    serverless = environ.get("VERCEL") == "1"
    return PoolSettings(
        max_size=int(_positive(environ.get("DB_POOL_MAX"), 3 if serverless else 10)),
        idle_timeout_s=_positive(environ.get("DB_IDLE_TIMEOUT_MS"), 10_000 if serverless else 30_000) / 1000,
        connect_timeout_s=_positive(environ.get("DB_CONNECT_TIMEOUT_MS"), 10_000) / 1000,
        query_timeout_s=_positive(environ.get("DB_QUERY_TIMEOUT_MS"), 60_000) / 1000,
    )


def without_ssl_params(connection_string: str) -> str:
    """SSL is set by the ssl argument; an sslmode in the URL would override it."""
    try:
        parts = urlsplit(connection_string)
    except ValueError:
        return connection_string
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in ("sslmode", "ssl", "uselibpqcompat")]
    return urlunsplit(parts._replace(query=urlencode(query)))


async def _init_connection(conn: asyncpg.Connection) -> None:
    # JSON in and out as Python values, UUIDs as strings (as node-postgres returns them).
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("uuid", encoder=str, decoder=str, schema="pg_catalog", format="text")


async def create_pool(connection_string: str | None = None) -> Pool:
    connection_string = connection_string or os.environ.get("DATABASE_URL")
    if not connection_string:
        raise RuntimeError("DATABASE_URL is required.")
    local = is_local_database(connection_string)
    settings = pool_settings()
    extra: dict = {}
    if not local:
        # Managed hosts such as Neon present a certificate from a public authority, so it is checked.
        context = ssl.create_default_context()
        if os.environ.get("DATABASE_SSL_VERIFY") == "false":
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        extra["ssl"] = context
    return await asyncpg.create_pool(
        dsn=connection_string if local else without_ssl_params(connection_string),
        min_size=0,
        max_size=settings.max_size,
        max_inactive_connection_lifetime=settings.idle_timeout_s,
        timeout=settings.connect_timeout_s,
        command_timeout=settings.query_timeout_s,
        # Transaction poolers (pgbouncer, Neon "-pooler") cannot keep named prepared statements.
        statement_cache_size=0,
        server_settings={"application_name": "diamondx-api-py"},
        init=_init_connection,
        **extra,
    )


# --- Migrations ---------------------------------------------------------------------------------

MIGRATION_FILE = re.compile(r"^\d{3,}_[\w-]+\.sql$", re.ASCII)
MIGRATION_LOCK_ID = 74102391


@dataclass(frozen=True)
class Migration:
    version: str
    sql: str
    checksum: str


class MigrationError(RuntimeError):
    pass


def migrations_dir() -> Path:
    for candidate in (Path.cwd() / "db" / "migrations", REPO_ROOT / "db" / "migrations"):
        if candidate.is_dir():
            return candidate
    raise RuntimeError("db/migrations was not found.")


def load_migrations(directory: Path | None = None) -> list[Migration]:
    directory = directory or migrations_dir()
    migrations = []
    for path in sorted(p for p in directory.iterdir() if MIGRATION_FILE.match(p.name)):
        raw = path.read_bytes()
        migrations.append(Migration(version=path.stem, sql=raw.decode("utf-8"), checksum=hashlib.sha256(raw).hexdigest()))
    return migrations


async def run_migrations(pool: Pool, migrations: list[Migration] | None = None) -> list[str]:
    migrations = load_migrations() if migrations is None else migrations
    applied: list[str] = []
    async with pool.acquire() as conn:
        # One transaction with a transaction-scoped lock: a session-level advisory lock can be left
        # behind forever behind a transaction pooler.
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1)", MIGRATION_LOCK_ID)
            await conn.execute(
                """CREATE TABLE IF NOT EXISTS schema_migrations (
                     version TEXT PRIMARY KEY,
                     checksum TEXT NOT NULL,
                     applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                   )"""
            )
            recorded = {row["version"]: row["checksum"] for row in await conn.fetch("SELECT version, checksum FROM schema_migrations")}
            for migration in migrations:
                checksum = recorded.get(migration.version)
                if checksum:
                    if checksum != migration.checksum:
                        log.warning("Migration %s was edited after it ran. Add a new migration instead.", migration.version)
                    continue
                try:
                    async with conn.transaction():  # a savepoint
                        await conn.execute(migration.sql)
                        await conn.execute(
                            "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
                            migration.version,
                            migration.checksum,
                        )
                except Exception as error:
                    raise MigrationError(f"Migration {migration.version} failed: {error}") from error
                applied.append(migration.version)
    return applied


async def run_migrations_with_retry(pool: Pool, attempts: int = 20) -> list[str]:
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await run_migrations(pool)
        except MigrationError:
            raise
        except Exception as error:  # database not up yet
            last = error
            if attempt < attempts:
                await asyncio.sleep(1)
    assert last is not None
    raise last


def migrate_on_start() -> bool:
    return os.environ.get("MIGRATE_ON_START") != "false"
