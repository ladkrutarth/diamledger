"""Headers, body limits, the CSP/vercel.json match, and session compatibility with express-session."""

from __future__ import annotations

import json
import shutil
import subprocess

import httpx
import pytest

from diamondx.app import AppOptions, create_app
from diamondx.core.security import CSP_DIRECTIVES, content_security_policy
from diamondx.core.sessions import cookie_value, sid_from_cookie, sign, unsign
from diamondx.core.settings import REPO_ROOT


def _directives(policy: str) -> list[str]:
    return [part.strip() for part in policy.split(";") if part.strip()]


async def test_csp_and_hsts_in_production(pool, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("SESSION_SECRET", "test-secret")
    app = create_app(pool, AppOptions())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        response = await c.get("/api/health")
    assert _directives(response.headers["content-security-policy"]) == _directives(content_security_policy())
    assert response.headers["strict-transport-security"] == "max-age=63072000; includeSubDomains"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_vercel_json_matches_the_server_policy():
    vercel = json.loads((REPO_ROOT / "vercel.json").read_text())
    values = [h["value"] for block in vercel.get("headers", []) for h in block.get("headers", []) if h["key"].lower() == "content-security-policy"]
    assert values, "vercel.json has no Content-Security-Policy header"
    for value in values:
        assert sorted(_directives(value)) == sorted(_directives(content_security_policy()))
    assert set(CSP_DIRECTIVES) == {d.split(" ")[0] for d in _directives(values[0])}


async def test_rejects_bodies_over_one_megabyte_except_uploads(client):
    big = "x" * (1024 * 1024 + 10)
    too_large = await client.post("/api/auth/login", json={"email": "a@example.com", "password": big})
    assert too_large.status_code == 413
    assert too_large.json() == {"error": "The request is too large."}
    # The email route takes up to 25 MB, so the body gets through to the sign-in check.
    allowed = await client.post("/api/send-email", json={"attachment": big})
    assert allowed.status_code == 401


async def test_invalid_json_is_a_400(client):
    response = await client.post("/api/auth/login", content=b"{nope", headers={"content-type": "application/json"})
    assert response.status_code == 400
    assert response.json() == {"error": "The request body is not valid JSON."}


def test_cookie_round_trip():
    signed = sign("abc", "secret")
    assert unsign(signed, "secret") == "abc"
    assert unsign(signed, "other") is None
    assert sid_from_cookie(cookie_value("abc", "secret"), "secret") == "abc"
    assert sid_from_cookie("abc", "secret") is None  # unsigned cookies are ignored


@pytest.mark.skipif(not shutil.which("node") or not (REPO_ROOT / "node_modules" / "cookie-signature").exists(), reason="needs node_modules")
def test_cookie_matches_express_session():
    script = "const s=require('cookie-signature');process.stdout.write(encodeURIComponent('s:'+s.sign('Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEy','keyboard cat')))"
    node = subprocess.run(["node", "-e", script], cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    assert cookie_value("Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEy", "keyboard cat") == node.stdout
