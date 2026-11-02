"""python -m diamondx.main: the API on PORT (default 3000).

Loads .env, creates the pool, runs migrations, seeds the demo user, then serves the API. In production
it also serves the built frontend from dist/. In development run Vite separately (`npm run dev:web`),
which forwards /api here.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from .app import AppOptions, create_app
from .core.db import create_pool, migrate_on_start, run_migrations_with_retry
from .core.monitoring import init_monitoring
from .core.seed import seed_demo_user
from .core.settings import REPO_ROOT, is_production, load_env, production_settings_problem

log = logging.getLogger("diamondx")


def build() -> FastAPI:
    """An ASGI app that connects to the database on startup (for uvicorn --factory and serverless)."""
    load_env()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    init_monitoring()
    problem = production_settings_problem()
    if problem:
        raise SystemExit(problem)

    holder: dict[str, FastAPI] = {}

    @asynccontextmanager
    async def lifespan(_outer: FastAPI):
        pool = await create_pool()
        if migrate_on_start():
            applied = await run_migrations_with_retry(pool)
            if applied:
                log.info("Applied migrations: %s", ", ".join(applied))
        await seed_demo_user(pool)
        dist = REPO_ROOT / "dist"
        holder["app"] = create_app(pool, AppOptions(serve_frontend=dist if is_production() and dist.is_dir() else None))
        async with holder["app"].router.lifespan_context(holder["app"]):
            yield
        await pool.close()

    outer = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    async def asgi(scope, receive, send):
        if scope["type"] == "lifespan":
            return await outer(scope, receive, send)
        return await holder["app"](scope, receive, send)

    return asgi  # type: ignore[return-value]


def main() -> None:
    app = build()  # loads .env first, so PORT can come from it
    port = int(os.environ.get("PORT") or 3000)
    # X-Forwarded-For is read by the app itself (one trusted hop, as Express `trust proxy` 1).
    uvicorn.run(app, host="0.0.0.0", port=port, proxy_headers=False)


if __name__ == "__main__":
    main()
