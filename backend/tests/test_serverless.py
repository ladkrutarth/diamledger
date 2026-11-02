"""Ported from server/tests/vercelHandler.test.ts: the Vercel rewrite turns back into the original API path."""

from __future__ import annotations

import httpx

from diamondx.serverless import ServerlessApp, api_url


def test_restores_the_api_path_from_the_rewrite():
    assert api_url("/api/index", "__path=invoices/abc&q=1") == ("/api/invoices/abc", "q=1")
    assert api_url("/api/index", "__path=%2Fauth%2Fme") == ("/api/auth/me", "")
    assert api_url("/api/health", "") == ("/api/health", "")
    # The cases from the Node test
    assert api_url("/api/index", "__path=auth/login") == ("/api/auth/login", "")
    assert api_url("/api/index", "__path=invoices%2Fabc%2Fpayments&status=paid") == ("/api/invoices/abc/payments", "status=paid")
    assert api_url("/api/invoices/export", "q=dubai") == ("/api/invoices/export", "q=dubai")


async def test_answers_503_until_the_database_is_configured(monkeypatch):
    monkeypatch.setattr("diamondx.serverless.load_env", lambda: None)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=ServerlessApp()), base_url="http://test") as client:
        response = await client.get("/api/index?__path=health")
    assert response.status_code == 503
    assert "DATABASE_URL" in response.json()["error"]


async def test_serves_the_api_through_the_rewrite(database_url, monkeypatch):
    monkeypatch.setattr("diamondx.serverless.load_env", lambda: None)
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("SESSION_SECRET", "test-secret")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=ServerlessApp()), base_url="http://test") as client:
        response = await client.get("/api/index?__path=health")
    assert response.status_code == 200 and response.json() == {"status": "ok", "database": "ok"}
