"""python -m diamondx.core.migrate: apply pending migrations."""

from __future__ import annotations

import asyncio
import sys

from .db import create_pool, run_migrations_with_retry
from .settings import load_env


async def main() -> int:
    load_env()
    pool = await create_pool()
    try:
        applied = await run_migrations_with_retry(pool, 5)
        print(f"Applied migrations: {', '.join(applied)}" if applied else "Database is up to date.")
        return 0
    except Exception as error:
        print(error, file=sys.stderr)
        return 1
    finally:
        await pool.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
