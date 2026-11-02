"""The API as one serverless function (port of server/vercelHandler.ts).

vercel.json rewrites every /api/* request to /api/index?__path=<rest>; `api_url` turns that back into
the original path. The app (pool, migrations, demo seed) is built once per instance, on the first
request, and rebuilt if the platform runs a later request on a different event loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from urllib.parse import parse_qsl, urlencode

from .core.settings import load_env

log = logging.getLogger("diamondx.serverless")


def api_url(raw_path: str, query_string: str) -> tuple[str, str]:
    """(/api/index, "__path=invoices/1&q=x") -> (/api/invoices/1, "q=x")."""
    params = parse_qsl(query_string, keep_blank_values=True)
    rewritten = next((value for key, value in params if key == "__path"), None)
    rest = [(key, value) for key, value in params if key != "__path"]
    path = f"/api/{rewritten.lstrip('/')}" if rewritten is not None else (raw_path or "/")
    return path, urlencode(rest)


async def _error_app(message: str, scope, receive, send) -> None:
    body = json.dumps({"error": message}).encode()
    await send({"type": "http.response.start", "status": 503, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": body})


class ServerlessApp:
    def __init__(self) -> None:
        self._app = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._migrated = False
        self._lock: asyncio.Lock | None = None

    async def _build(self):
        load_env()
        if not os.environ.get("DATABASE_URL") or not os.environ.get("SESSION_SECRET"):
            return "Set DATABASE_URL and SESSION_SECRET in the Vercel project settings, then redeploy."
        from .core.settings import production_settings_problem

        problem = production_settings_problem()
        if problem:
            return problem
        from .app import create_app
        from .core.db import create_pool, migrate_on_start, run_migrations
        from .core.monitoring import init_monitoring
        from .core.seed import seed_demo_user

        init_monitoring()
        pool = await create_pool()
        if migrate_on_start() and not self._migrated:
            await run_migrations(pool)
            await seed_demo_user(pool)
            self._migrated = True
        return create_app(pool)

    async def app(self):
        loop = asyncio.get_running_loop()
        if self._app is not None and self._loop is loop:
            return self._app
        if self._lock is None or self._loop is not loop:
            self._lock, self._loop, self._app = asyncio.Lock(), loop, None
        async with self._lock:
            if self._app is None:
                try:
                    self._app = await self._build()
                except Exception as error:
                    log.exception("API failed to start")
                    from .core.monitoring import report_error

                    report_error(error, path="startup")
                    return str(error) or "Could not connect to the database."
            return self._app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "lifespan":
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            return
        if scope["type"] == "http":
            path, query = api_url(scope.get("path", "/"), scope.get("query_string", b"").decode("latin-1"))
            scope = {**scope, "path": path, "raw_path": path.encode(), "query_string": query.encode("latin-1")}
        app = await self.app()
        if isinstance(app, str):
            await _error_app(app, scope, receive, send)
            return
        await app(scope, receive, send)


app = ServerlessApp()
