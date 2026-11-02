"""Settings production depends on: the Secure cookie, APP_URL for links, the trusted-proxy rule for client
addresses, the cron secret check, and the change-password limit."""

from __future__ import annotations

import httpx
import pytest
from starlette.requests import Request

from diamondx.app import AppOptions, create_app
from diamondx.core import settings
from diamondx.core.rate_limit import client_ip
from diamondx.modules.tax.rates import cron_authorized
from diamondx.serverless import ServerlessApp


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ("APP_ENV", "NODE_ENV", "APP_URL", "COOKIE_SECURE", "TRUST_PROXY", "VERCEL", "VERCEL_PROJECT_PRODUCTION_URL", "CRON_SECRET"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SESSION_SECRET", "test-secret")


def _request(headers: dict[str, str], client_host: str = "10.0.0.9") -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/", "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": (client_host, 5000),
    })


async def _register_cookie(pool) -> str:
    app = create_app(pool, AppOptions())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        response = await c.post("/api/auth/register", json={"email": "owner@example.com", "password": "password123"})
    assert response.status_code == 201, response.text
    return response.headers["set-cookie"]


# --- Session cookie -------------------------------------------------------------------------------------

async def test_session_cookie_is_secure_in_production(pool, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    assert "; Secure" in await _register_cookie(pool)


async def test_session_cookie_is_not_secure_in_development(pool):
    assert "Secure" not in await _register_cookie(pool)


async def test_cookie_secure_can_be_turned_off_for_a_local_production_build(pool, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("COOKIE_SECURE", "false")
    assert "Secure" not in await _register_cookie(pool)


# --- APP_URL --------------------------------------------------------------------------------------------

def test_production_needs_app_url(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    assert "APP_URL" in settings.production_settings_problem()
    monkeypatch.setenv("APP_URL", "MY_APP_URL")  # the old .env.example placeholder
    assert "APP_URL" in settings.production_settings_problem()
    monkeypatch.setenv("APP_URL", "https://app.example.com/")
    assert settings.production_settings_problem() is None
    assert settings.configured_app_url() == "https://app.example.com"


def test_development_does_not_need_app_url():
    assert settings.production_settings_problem() is None


def test_vercel_falls_back_to_the_production_domain(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_PROJECT_PRODUCTION_URL", "diamondx.example.com")
    assert settings.configured_app_url() == "https://diamondx.example.com"
    assert settings.production_settings_problem() is None


async def test_serverless_refuses_to_start_without_app_url(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused@127.0.0.1:1/none")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=ServerlessApp()), base_url="http://test") as c:
        response = await c.get("/api/index?__path=health")
    assert response.status_code == 503
    assert "APP_URL" in response.json()["error"]


async def test_reset_link_uses_app_url_not_the_host_header(client_factory, mailbox, monkeypatch):
    monkeypatch.setenv("APP_URL", "https://app.example.com")
    owner = client_factory()
    await owner.post("/api/auth/register", json={"email": "owner@example.com", "password": "password123"})
    response = await client_factory().post(
        "/api/auth/forgot-password", json={"email": "owner@example.com"},
        headers={"host": "evil.example", "x-forwarded-host": "evil.example"},
    )
    assert response.status_code == 200
    assert mailbox.sent and mailbox.sent[-1][1].startswith("https://app.example.com/?reset=")


# --- Client address -------------------------------------------------------------------------------------

def test_forwarded_for_is_ignored_without_a_trusted_proxy():
    assert client_ip(_request({"x-forwarded-for": "1.2.3.4"})) == "10.0.0.9"


def test_forwarded_for_is_read_behind_a_trusted_proxy(monkeypatch):
    monkeypatch.setenv("TRUST_PROXY", "true")
    assert client_ip(_request({"x-forwarded-for": "6.6.6.6, 1.2.3.4"})) == "1.2.3.4"
    monkeypatch.delenv("TRUST_PROXY")
    monkeypatch.setenv("VERCEL", "1")
    assert client_ip(_request({"x-forwarded-for": "1.2.3.4"})) == "1.2.3.4"


async def test_changing_forwarded_for_does_not_dodge_the_sign_in_limit(client_factory):
    owner = client_factory()
    await owner.post("/api/auth/register", json={"email": "owner@example.com", "password": "password123"})
    statuses = []
    for attempt in range(11):
        response = await client_factory().post(
            "/api/auth/login", json={"email": "owner@example.com", "password": "wrong-password"},
            headers={"x-forwarded-for": f"203.0.113.{attempt}"},
        )
        statuses.append(response.status_code)
    assert statuses[:10] == [401] * 10
    assert statuses[10] == 429


# --- Cron secret ----------------------------------------------------------------------------------------

def test_cron_needs_the_exact_bearer_secret(monkeypatch):
    assert not cron_authorized(_request({"authorization": "Bearer "}))
    monkeypatch.setenv("CRON_SECRET", "s3cret")
    assert cron_authorized(_request({"authorization": "Bearer s3cret"}))
    assert not cron_authorized(_request({"authorization": "Bearer s3cret2"}))
    assert not cron_authorized(_request({}))


# --- Change password ------------------------------------------------------------------------------------

async def test_change_password_is_rate_limited_on_wrong_passwords(client_factory):
    owner = client_factory()
    await owner.post("/api/auth/register", json={"email": "owner@example.com", "password": "password123"})
    for _ in range(10):
        wrong = await owner.post("/api/auth/change-password", json={"currentPassword": "nope", "newPassword": "new-password-1"})
        assert wrong.status_code == 400
    blocked = await owner.post("/api/auth/change-password", json={"currentPassword": "password123", "newPassword": "new-password-1"})
    assert blocked.status_code == 429


async def test_successful_password_changes_do_not_count(client_factory):
    owner = client_factory()
    await owner.post("/api/auth/register", json={"email": "owner@example.com", "password": "password123"})
    current = "password123"
    for n in range(11):
        new = f"new-password-{n}"
        changed = await owner.post("/api/auth/change-password", json={"currentPassword": current, "newPassword": new})
        assert changed.status_code == 200, changed.text
        current = new
