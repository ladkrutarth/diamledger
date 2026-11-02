"""Environment helpers. The Python API reads the same .env as the Node server."""

from __future__ import annotations

import os
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def load_env() -> None:
    from dotenv import load_dotenv

    # The project root first, so it works wherever the server is started from; then the current folder.
    load_dotenv(REPO_ROOT / ".env")
    load_dotenv()


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def is_production() -> bool:
    """APP_ENV wins; NODE_ENV is still read so one .env works for both servers during the move."""
    return (os.environ.get("APP_ENV") or os.environ.get("NODE_ENV")) == "production"


def on_vercel() -> bool:
    return os.environ.get("VERCEL") == "1"


def session_secret() -> str:
    secret = os.environ.get("SESSION_SECRET")
    if secret:
        return secret
    if is_production():
        raise RuntimeError("SESSION_SECRET is required.")
    return "dev-only-session-secret"


def _flag(name: str) -> bool | None:
    """An on/off setting: true/1/yes or false/0/no; anything else means "not set"."""
    value = os.environ.get(name, "").strip().lower()
    if value in ("1", "true", "yes"):
        return True
    if value in ("0", "false", "no"):
        return False
    return None


def cookie_secure() -> bool:
    """Send the session cookie over HTTPS only. On in production and on Vercel; COOKIE_SECURE overrides."""
    flag = _flag("COOKIE_SECURE")
    return flag if flag is not None else (is_production() or on_vercel())


def trust_proxy() -> bool:
    """Read the client address from X-Forwarded-For. Only safe behind a proxy that sets that header itself,
    so it is on for Vercel and otherwise needs TRUST_PROXY=true (nginx, a load balancer, ...)."""
    flag = _flag("TRUST_PROXY")
    return flag if flag is not None else on_vercel()


def configured_app_url() -> str | None:
    """The site's public address from APP_URL, or Vercel's production domain. None if neither is set."""
    configured = os.environ.get("APP_URL", "").strip().rstrip("/")
    if re.match(r"^https?://[^/\s]+", configured):
        return configured
    vercel_domain = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL", "").strip().rstrip("/")
    if on_vercel() and vercel_domain:
        return f"https://{vercel_domain}"
    return None


def production_settings_problem() -> str | None:
    """A message if a setting that production depends on is missing, else None."""
    if is_production() and not configured_app_url():
        return (
            "Set APP_URL to the site's public address (like https://app.example.com). Password-reset, "
            "buyer-portal and payment links are built from it."
        )
    return None
