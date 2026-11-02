"""Migrations, pool settings and housekeeping (from server/tests/api.test.ts and database.test.ts)."""

from __future__ import annotations

import pytest

from diamondx.core.db import (
    Migration,
    MigrationError,
    is_local_database,
    load_migrations,
    pool_settings,
    run_migrations,
    without_ssl_params,
)
from diamondx.core.form_input import FormError, document_key, form_reader, parse_loose_date
from diamondx.core.housekeeping import purge_expired_rows


async def test_records_migrations_once_and_rolls_back_a_failed_one(pool):
    assert await run_migrations(pool) == []
    versions = [row["version"] for row in await pool.fetch("SELECT version FROM schema_migrations ORDER BY version")]
    assert versions == [m.version for m in load_migrations()]

    broken = Migration(version="999_broken", checksum="x", sql="CREATE TABLE migration_probe (id INT); SELECT nope;")
    with pytest.raises(MigrationError, match="Migration 999_broken failed"):
        await run_migrations(pool, [broken])
    assert await pool.fetchval("SELECT to_regclass('migration_probe')") is None
    assert await pool.fetchval("SELECT COUNT(*) FROM schema_migrations WHERE version = '999_broken'") == 0


def test_local_and_ssl_handling():
    assert is_local_database("postgresql://u:p@localhost:5432/db")
    assert is_local_database("postgresql://u:p@postgres:5432/db")
    assert not is_local_database("postgresql://u:p@ep-x.neon.tech/db")
    cleaned = without_ssl_params("postgresql://u:p@ep-x.neon.tech/db?sslmode=require&application_name=x")
    assert "sslmode" not in cleaned and "application_name=x" in cleaned


def test_pool_settings_are_small_on_serverless():
    assert pool_settings({"VERCEL": "1"}).max_size == 3
    assert pool_settings({}).max_size == 10
    assert pool_settings({"DB_POOL_MAX": "4"}).max_size == 4
    assert pool_settings({"DB_POOL_MAX": "nope"}).max_size == 10


async def test_purges_expired_rows(pool):
    await pool.execute("INSERT INTO rate_limits (key, hits, reset_at) VALUES ('old', 1, now() - interval '2 days'), ('new', 1, now())")
    await pool.execute("INSERT INTO session (sid, sess, expire) VALUES ('gone', '{}', now() - interval '1 hour')")
    result = await purge_expired_rows(pool)
    assert result == {"rateLimits": 1, "resetTokens": 0, "sessions": 1}
    assert await purge_expired_rows(pool) == {"rateLimits": 0, "resetTokens": 0, "sessions": 0}


def test_form_reader():
    form = form_reader({"a": " x ", "n": "1,234.567", "d": "1/4/2026", "f": "true", "c": "b", "z": 3})
    assert form.text("a") == "x"
    assert form.text("z") == "3"
    assert form.number("n", "bad") == 1234.57
    assert form.date("d", "bad") == "2026-04-01"
    assert form.flag("f") is True
    assert form.choice("c", ["a", "b"]) == "b"
    assert form.number("missing", "bad", optional=True) is None
    with pytest.raises(FormError):
        form.number("a", "Enter a number.")
    with pytest.raises(FormError):
        form.required("missing", "Required.")
    assert parse_loose_date("31/02/2026") is None
    assert document_key("INV/007") == document_key("inv-7") == "INV7"
