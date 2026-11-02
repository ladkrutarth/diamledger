"""GET /api/health: answers before the session is loaded, so it never touches the session table."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("diamondx.health")

DB_TIMEOUT_S = 3.0


def build_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/health")
    async def health(request: Request):
        headers = {"Cache-Control": "no-store"}
        try:
            await asyncio.wait_for(request.app.state.pool.fetchval("SELECT 1"), DB_TIMEOUT_S)
            return JSONResponse({"status": "ok", "database": "ok"}, headers=headers)
        except Exception as error:
            log.error("Health check failed: %s", error)
            return JSONResponse({"status": "error", "database": "unreachable"}, status_code=503, headers=headers)

    return router
