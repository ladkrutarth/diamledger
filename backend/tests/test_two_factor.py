"""Two-step sign-in: authenticator app (TOTP), text message codes, recovery codes."""

from __future__ import annotations

import re
import time

import httpx
import pytest

from diamondx.app import AppOptions, create_app
from diamondx.modules.auth.two_factor import hotp, normalize_phone, totp_match, totp_now

PASSWORD = "password123"


class FakeSms:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []
        self.on = True

    def available(self) -> bool:
        return self.on

    async def send(self, to: str, text: str) -> None:
        self.sent.append((to, text))

    def last_code(self) -> str:
        return re.match(r"^(\d{6}) ", self.sent[-1][1]).group(1)


@pytest.fixture
def sms():
    return FakeSms()


@pytest.fixture
def make(pool, sms, monkeypatch):
    monkeypatch.setenv("ENCRYPTION_KEY", "a-test-encryption-key-of-at-least-32-chars")
    app = create_app(pool, AppOptions(sms=sms))

    def client() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 5000)), base_url="http://test")

    return client


async def register(make, email="owner@example.com"):
    agent = make()
    response = await agent.post("/api/auth/register", json={"email": email, "password": PASSWORD, "companyName": "Meridian"})
    assert response.status_code == 201, response.text
    return agent


async def turn_on_app(agent) -> tuple[str, list[str]]:
    setup = await agent.post("/api/auth/two-factor/app/setup", json={"password": PASSWORD})
    assert setup.status_code == 200, setup.text
    secret = setup.json()["secret"].replace(" ", "")
    assert setup.json()["otpauthUrl"].startswith("otpauth://totp/Meridian:owner@example.com?")
    assert setup.json()["qrCode"].startswith("data:image/svg+xml")
    # Use the previous step's code, so the sign-in below (current step) is a later, unused one.
    confirmed = await agent.post("/api/auth/two-factor/app/confirm", json={"code": totp_now(secret, time.time() - 30)})
    assert confirmed.status_code == 200, confirmed.text
    return secret, confirmed.json()["recoveryCodes"]


def test_totp_matches_rfc_6238_vectors():
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # "12345678901234567890"
    assert hotp(secret, 59 // 30, digits=8) == "94287082"
    assert hotp(secret, 1111111109 // 30, digits=8) == "07081804"
    assert totp_match(secret, totp_now(secret, 1000.0), at=1030.0) == 1000 // 30
    assert totp_match(secret, totp_now(secret, 1000.0), at=1100.0) is None


def test_phone_numbers_are_normalized():
    assert normalize_phone("98123 45678") == "+919812345678"
    assert normalize_phone("+32 470 12 34 56") == "+32470123456"
    assert normalize_phone("0032470123456") == "+32470123456"
    assert normalize_phone("12345") is None


async def test_authenticator_app_is_needed_to_sign_in(make, pool):
    owner = await register(make)
    assert (await owner.post("/api/auth/two-factor/app/setup", json={"password": "wrong"})).status_code == 400
    secret, recovery = await turn_on_app(owner)
    assert len(recovery) == 10 and all(re.fullmatch(r"[a-z0-9]{5}-[a-z0-9]{5}", c) for c in recovery)
    status = (await owner.get("/api/auth/two-factor")).json()
    assert (status["enabled"], status["app"], status["recoveryCodesLeft"]) == (True, True, 10)

    # The password alone does not sign in.
    browser = make()
    login = await browser.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
    assert login.status_code == 200
    assert login.json() == {"twoFactorRequired": True, "methods": ["app", "recovery"], "phoneHint": None}
    assert (await browser.get("/api/auth/me")).status_code == 401
    assert (await browser.get("/api/invoices")).status_code == 401

    assert (await browser.post("/api/auth/two-factor/verify", json={"code": "000000"})).status_code == 400
    code = totp_now(secret)
    verified = await browser.post("/api/auth/two-factor/verify", json={"code": code})
    assert verified.status_code == 200, verified.text
    assert verified.json()["method"] == "app"
    assert (await browser.get("/api/auth/me")).json()["user"]["email"] == "owner@example.com"

    # The same code cannot be used again, in another browser.
    replay = make()
    await replay.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
    assert (await replay.post("/api/auth/two-factor/verify", json={"code": code})).status_code == 400

    # Verify without having passed the password first does nothing.
    assert (await make().post("/api/auth/two-factor/verify", json={"code": totp_now(secret)})).status_code == 401


async def test_turning_on_signs_out_other_sessions(make, pool):
    owner = await register(make)
    laptop = make()
    assert (await laptop.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})).status_code == 200
    await turn_on_app(owner)
    assert (await laptop.get("/api/auth/me")).status_code == 401
    assert (await owner.get("/api/auth/me")).status_code == 200


async def test_recovery_code_works_once(make, pool):
    owner = await register(make)
    _, recovery = await turn_on_app(owner)
    browser = make()
    await browser.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
    used = await browser.post("/api/auth/two-factor/verify", json={"code": recovery[0].upper()})
    assert used.status_code == 200 and used.json()["method"] == "recovery" and used.json()["recoveryCodesLeft"] == 9

    again = make()
    await again.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
    assert (await again.post("/api/auth/two-factor/verify", json={"code": recovery[0]})).status_code == 400


async def test_wrong_codes_end_the_attempt_and_lock_the_account(make, pool):
    owner = await register(make)
    secret, _ = await turn_on_app(owner)
    browser = make()
    await browser.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
    for _ in range(4):
        assert (await browser.post("/api/auth/two-factor/verify", json={"code": "111111"})).status_code == 400
    fifth = await browser.post("/api/auth/two-factor/verify", json={"code": "111111"})
    assert fifth.status_code == 401 and fifth.json()["code"] == "two_factor_expired"
    # The pending session is gone: even the right code needs the password again.
    assert (await browser.post("/api/auth/two-factor/verify", json={"code": totp_now(secret)})).status_code == 401

    # Across sessions, 10 wrong codes lock the account for a while, right code or not.
    await pool.execute("DELETE FROM rate_limits WHERE key NOT LIKE 'two-factor:%'")
    other = make()
    await other.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
    for _ in range(4):
        await other.post("/api/auth/two-factor/verify", json={"code": "222222"})
    other = make()
    await other.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
    await other.post("/api/auth/two-factor/verify", json={"code": "333333"})
    locked = await other.post("/api/auth/two-factor/verify", json={"code": totp_now(secret)})
    assert locked.status_code == 429


async def test_text_message_codes(make, pool, sms):
    owner = await register(make)
    assert (await owner.post("/api/auth/two-factor/phone/setup", json={"password": PASSWORD, "phone": "12"})).status_code == 400
    started = await owner.post("/api/auth/two-factor/phone/setup", json={"password": PASSWORD, "phone": "98123 45678"})
    assert started.status_code == 200, started.text
    assert started.json()["phoneHint"].endswith("5678")
    assert sms.sent[-1][0] == "+919812345678"
    assert (await owner.post("/api/auth/two-factor/phone/confirm", json={"code": "000000"})).status_code == 400
    confirmed = await owner.post("/api/auth/two-factor/phone/confirm", json={"code": sms.last_code()})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["phone"].endswith("5678") and len(confirmed.json()["recoveryCodes"]) == 10
    # The code is stored hashed, never as typed.
    assert await pool.fetchval("SELECT COUNT(*) FROM two_factor_codes WHERE code_hash = $1", sms.last_code()) == 0

    browser = make()
    login = (await browser.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})).json()
    assert login["methods"] == ["sms", "recovery"] and login["phoneHint"].endswith("5678")
    await pool.execute("UPDATE two_factor_codes SET created_at = created_at - interval '1 minute'")  # past the 30-second gap
    assert (await browser.post("/api/auth/two-factor/sms")).status_code == 200
    assert (await browser.post("/api/auth/two-factor/sms")).status_code == 429  # too soon
    verified = await browser.post("/api/auth/two-factor/verify", json={"code": sms.last_code()})
    assert verified.status_code == 200 and verified.json()["method"] == "sms"


async def test_turning_off_needs_the_password_and_clears_recovery_codes(make, pool):
    owner = await register(make)
    await turn_on_app(owner)
    assert (await owner.request("DELETE", "/api/auth/two-factor/app", json={"password": "wrong"})).status_code == 400
    off = await owner.request("DELETE", "/api/auth/two-factor/app", json={"password": PASSWORD})
    assert off.status_code == 200
    assert (off.json()["enabled"], off.json()["recoveryCodesLeft"]) == (False, 0)
    login = await make().post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
    assert "user" in login.json()


async def test_app_needs_the_encryption_key(make, pool, monkeypatch):
    owner = await register(make)
    monkeypatch.delenv("ENCRYPTION_KEY")
    assert (await owner.post("/api/auth/two-factor/app/setup", json={"password": PASSWORD})).status_code == 503
    assert (await owner.get("/api/auth/two-factor")).json()["appAvailable"] is False


async def test_admin_can_reset_a_members_two_step(make, pool):
    admin = await register(make)
    assert (await admin.post("/api/team/members", json={"email": "clerk@example.com", "password": PASSWORD, "role": "member"})).status_code == 201
    clerk = make()
    assert (await clerk.post("/api/auth/login", json={"email": "clerk@example.com", "password": PASSWORD})).status_code == 200
    setup = (await clerk.post("/api/auth/two-factor/app/setup", json={"password": PASSWORD})).json()
    assert (await clerk.post("/api/auth/two-factor/app/confirm", json={"code": totp_now(setup["secret"].replace(" ", ""))})).status_code == 200

    members = {m["email"]: m for m in (await admin.get("/api/team/members")).json()["members"]}
    assert members["clerk@example.com"]["twoFactor"] is True and members["owner@example.com"]["twoFactor"] is False
    clerk_id, admin_id = members["clerk@example.com"]["id"], members["owner@example.com"]["id"]

    # Half-way through signing in when the reset happens.
    stuck = make()
    assert "twoFactorRequired" in (await stuck.post("/api/auth/login", json={"email": "clerk@example.com", "password": PASSWORD})).json()

    # Only an admin, with their own password, for someone else in the same company.
    assert (await clerk.post(f"/api/team/members/{clerk_id}/two-factor/reset", json={"password": PASSWORD})).status_code == 403
    assert (await admin.post(f"/api/team/members/{clerk_id}/two-factor/reset", json={"password": "wrong"})).status_code == 400
    assert (await admin.post(f"/api/team/members/{admin_id}/two-factor/reset", json={"password": PASSWORD})).status_code == 409
    rival = await register(make, "rival@example.com")
    assert (await rival.post(f"/api/team/members/{clerk_id}/two-factor/reset", json={"password": PASSWORD})).status_code == 404

    reset = await admin.post(f"/api/team/members/{clerk_id}/two-factor/reset", json={"password": PASSWORD})
    assert reset.status_code == 200, reset.text
    assert (await clerk.get("/api/auth/me")).status_code == 401  # signed out everywhere
    assert (await stuck.post("/api/auth/two-factor/verify", json={"code": "123456"})).status_code == 401
    login = await make().post("/api/auth/login", json={"email": "clerk@example.com", "password": PASSWORD})
    assert "user" in login.json()  # the password alone works again
    assert (await admin.post(f"/api/team/members/{clerk_id}/two-factor/reset", json={"password": PASSWORD})).status_code == 409

    history = await pool.fetch("SELECT action FROM audit_events WHERE action = 'team.two_factor_reset'")
    assert len(history) == 1
