"""Ported from server/tests/api.test.ts (auth, team, health, demo seed)."""

from __future__ import annotations

import re

import pytest

from diamondx.app import AppOptions, create_app
from diamondx.core import settings
from diamondx.core.seed import DEMO_EMAIL, DEMO_PASSWORD, DEMO_TEAM, seed_demo_user

from .conftest import sign_up


async def test_health_reports_the_database(client, pool):
    healthy = await client.get("/api/health")
    assert healthy.status_code == 200
    assert healthy.json() == {"status": "ok", "database": "ok"}
    assert healthy.headers["cache-control"] == "no-store"


async def test_health_is_503_when_the_database_is_gone(pool, client_factory):
    import httpx

    from diamondx.core.db import create_pool

    dead = await create_pool("postgresql://x:y@127.0.0.1:1/none")
    try:
        app = create_app(dead, AppOptions())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            response = await c.get("/api/health")
        assert response.status_code == 503
        assert response.json()["status"] == "error"
    finally:
        await dead.close()


async def test_register_reads_the_session_and_logs_out(client):
    registered = await client.post("/api/auth/register", json={"email": "owner@example.com", "password": "password123"})
    assert registered.status_code == 201
    assert registered.json()["user"]["email"] == "owner@example.com"
    assert "password_hash" not in registered.json()["user"]

    me = await client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "owner@example.com"

    assert (await client.post("/api/auth/logout")).status_code == 200
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_rejects_bad_sign_up_and_duplicates(client_factory):
    c = client_factory()
    bad_email = await c.post("/api/auth/register", json={"email": "nope", "password": "password123"})
    assert bad_email.status_code == 400
    assert bad_email.json() == {"error": "Enter a valid email address."}
    short = await c.post("/api/auth/register", json={"email": "a@example.com", "password": "short"})
    assert short.status_code == 400
    await sign_up(client_factory, "dup@example.com")
    duplicate = await client_factory().post("/api/auth/register", json={"email": "DUP@example.com", "password": "password123"})
    assert duplicate.status_code == 409


async def test_rejects_a_wrong_password(client_factory):
    await sign_up(client_factory, "owner@example.com")
    login = await client_factory().post("/api/auth/login", json={"email": "owner@example.com", "password": "not-the-password"})
    assert login.status_code == 401
    assert login.json()["error"] == "Invalid email or password."


async def test_blocks_repeated_failed_sign_ins_and_sign_ups(client_factory):
    await sign_up(client_factory, "owner@example.com")

    async def attempt(password: str):
        return await client_factory().post("/api/auth/login", json={"email": "owner@example.com", "password": password})

    assert (await attempt("password123")).status_code == 200
    for _ in range(10):
        assert (await attempt("wrong-password")).status_code == 401
    blocked = await attempt("password123")
    assert blocked.status_code == 429
    assert "Too many failed sign-in attempts" in blocked.json()["error"]
    assert "ratelimit-policy" in blocked.headers

    other = await client_factory().post("/api/auth/login", json={"email": "else@example.com", "password": "x"})
    assert other.status_code == 401

    for i in range(4):
        await client_factory().post("/api/auth/register", json={"email": f"user{i}@example.com", "password": "password123"})
    too_many = await client_factory().post("/api/auth/register", json={"email": "late@example.com", "password": "password123"})
    assert too_many.status_code == 429


async def test_team_roles_and_removal(client_factory):
    admin = await sign_up(client_factory, "owner@example.com")
    added = await admin.post("/api/team/members", json={"email": "clerk@example.com", "password": "temporary1", "role": "member"})
    assert added.status_code == 201
    assert added.json()["role"] == "member"
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", added.json()["createdAt"])

    clerk = client_factory()
    assert (await clerk.post("/api/auth/login", json={"email": "clerk@example.com", "password": "temporary1"})).status_code == 200
    assert (await clerk.get("/api/team/members")).status_code == 403

    me = (await admin.get("/api/auth/me")).json()["user"]
    assert (await admin.patch(f"/api/team/members/{me['id']}", json={"role": "member"})).status_code == 409
    assert (await admin.delete(f"/api/team/members/{me['id']}")).status_code == 409

    members = (await admin.get("/api/team/members")).json()["members"]
    assert [m["email"] for m in members] == ["owner@example.com", "clerk@example.com"]

    assert (await admin.delete(f"/api/team/members/{added.json()['id']}")).status_code == 204
    assert (await clerk.get("/api/auth/me")).status_code == 401


async def test_team_changes_are_in_the_activity_history(client_factory, pool):
    admin = await sign_up(client_factory, "owner@example.com")
    await admin.post("/api/team/members", json={"email": "clerk@example.com", "password": "temporary1"})
    await admin.post("/api/team/members", json={"email": "bad", "password": "temporary1"})  # 400: not recorded
    rows = await pool.fetch("SELECT action, summary, user_email FROM audit_events ORDER BY created_at")
    assert [(r["action"], r["summary"], r["user_email"]) for r in rows] == [
        ("team.add", "Added team member clerk@example.com", "owner@example.com")
    ]


async def test_change_password_signs_out_other_sessions(client_factory):
    owner = await sign_up(client_factory, "owner@example.com")
    other = client_factory()
    await other.post("/api/auth/login", json={"email": "owner@example.com", "password": "password123"})

    wrong = await owner.post("/api/auth/change-password", json={"currentPassword": "nope", "newPassword": "new-password-1"})
    assert wrong.status_code == 400
    changed = await owner.post("/api/auth/change-password", json={"currentPassword": "password123", "newPassword": "new-password-1"})
    assert changed.status_code == 200
    assert (await owner.get("/api/auth/me")).status_code == 200
    assert (await other.get("/api/auth/me")).status_code == 401
    relogin = await client_factory().post("/api/auth/login", json={"email": "owner@example.com", "password": "new-password-1"})
    assert relogin.status_code == 200


async def test_password_reset_by_email(client_factory, mailbox):
    owner = await sign_up(client_factory, "owner@example.com")
    unknown = await client_factory().post("/api/auth/forgot-password", json={"email": "nobody@example.com"})
    assert unknown.status_code == 200
    assert mailbox.sent == []

    forgot = await client_factory().post("/api/auth/forgot-password", json={"email": "Owner@Example.com"})
    assert forgot.status_code == 200
    assert len(mailbox.sent) == 1
    to, link = mailbox.sent[0]
    assert to == "owner@example.com"
    token = link.split("reset=")[1]

    reset = await client_factory().post("/api/auth/reset-password", json={"token": token, "password": "brand-new-pass"})
    assert reset.status_code == 200
    assert (await owner.get("/api/auth/me")).status_code == 401
    reused = await client_factory().post("/api/auth/reset-password", json={"token": token, "password": "another-pass-1"})
    assert reused.status_code == 400
    login = await client_factory().post("/api/auth/login", json={"email": "owner@example.com", "password": "brand-new-pass"})
    assert login.status_code == 200


async def test_demo_account_outside_production_only(pool, client_factory, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("SEED_DEMO_USER", raising=False)
    await seed_demo_user(pool)
    assert await pool.fetchval("SELECT COUNT(*) FROM users WHERE email = $1", DEMO_EMAIL) == 0

    monkeypatch.setenv("NODE_ENV", "development")
    await seed_demo_user(pool)
    await seed_demo_user(pool)

    async def demo_login():
        return await client_factory().post("/api/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})

    assert (await demo_login()).status_code == 200
    assert await pool.fetchval("SELECT COUNT(*) FROM users") == len(DEMO_TEAM)

    monkeypatch.setenv("NODE_ENV", "production")
    await seed_demo_user(pool)
    assert (await demo_login()).status_code == 401


async def test_chartered_accountant_cannot_change_the_team(client_factory):
    admin = await sign_up(client_factory, "owner@example.com")
    await admin.post("/api/team/members", json={"email": "ca@example.com", "password": "temporary1", "role": "ca"})
    ca = client_factory()
    await ca.post("/api/auth/login", json={"email": "ca@example.com", "password": "temporary1"})
    blocked = await ca.post("/api/team/members", json={"email": "x@example.com", "password": "temporary1"})
    assert blocked.status_code == 403
    assert "chartered accountant" in blocked.json()["error"]
    assert (await ca.post("/api/auth/logout")).status_code == 200


async def test_lapsed_trial_is_read_only(client_factory, pool):
    admin = await sign_up(client_factory, "owner@example.com")
    await admin.get("/api/team/members")  # starts the trial
    await pool.execute("UPDATE organization_subscriptions SET trial_ends_at = now() - interval '1 day'")
    assert (await admin.get("/api/team/members")).status_code == 200
    blocked = await admin.post("/api/team/members", json={"email": "x@example.com", "password": "temporary1"})
    assert blocked.status_code == 402
    assert blocked.json()["code"] == "subscription_lapsed"
    # Signing out and in still works.
    assert (await admin.post("/api/auth/logout")).status_code == 200


async def test_unknown_api_routes_answer_404(client):
    response = await client.get("/api/nothing-here")
    assert response.status_code == 404
    assert response.json() == {"error": "No API route for GET /api/nothing-here"}
    wrong_method = await client.delete("/api/auth/me")
    assert wrong_method.status_code == 404
    assert wrong_method.json() == {"error": "No API route for DELETE /api/auth/me"}


@pytest.fixture(autouse=True)
def _development(monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("NODE_ENV", "test")
    assert not settings.is_production()
