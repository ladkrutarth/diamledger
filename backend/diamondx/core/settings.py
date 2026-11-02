"""Environment helpers. The Python API reads the same .env as the Node server."""

from __future__ import annotations

import os
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
