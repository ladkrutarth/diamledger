"""Any /api path no route took answers 404 with JSON, whatever the method (as the Express app did)."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def build_router() -> APIRouter:
    router = APIRouter()

    @router.api_route("/api/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], include_in_schema=False)
    async def not_found(path: str, request: Request):
        return JSONResponse({"error": f"No API route for {request.method} {request.url.path}"}, status_code=404)

    return router
