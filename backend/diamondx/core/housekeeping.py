"""Removes rows that can never matter again. Run from the daily cron; cheap and safe to repeat."""

from __future__ import annotations

from .db import Pool


def _count(status: str) -> int:
    # asyncpg returns the command tag, such as "DELETE 3".
    return int(status.rsplit(" ", 1)[-1]) if status else 0


async def purge_expired_rows(pool: Pool) -> dict[str, int]:
    rate_limits = await pool.execute("DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'")
    reset_tokens = await pool.execute(
        "DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '7 days' OR used_at < now() - interval '7 days'"
    )
    sessions = await pool.execute("DELETE FROM session WHERE expire < now()")
    return {"rateLimits": _count(rate_limits), "resetTokens": _count(reset_tokens), "sessions": _count(sessions)}
