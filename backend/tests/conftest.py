"""Test database: TEST_DATABASE_URL if set (its tables are wiped), else a throwaway Postgres started from
the embedded-postgres binaries in node_modules, or PG_BIN (a folder with initdb, pg_ctl, postgres)."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import asyncpg
import httpx
import pytest

from diamondx.app import AppOptions, create_app
from diamondx.core.db import create_pool, run_migrations
from diamondx.core.settings import REPO_ROOT

PORT = 54330


def _pg_bin() -> Path | None:
    if os.environ.get("PG_BIN"):
        return Path(os.environ["PG_BIN"])
    for found in sorted((REPO_ROOT / "node_modules" / "@embedded-postgres").glob("*/native/bin")):
        if (found / "initdb").exists():
            return found
    initdb = shutil.which("initdb")
    return Path(initdb).parent if initdb else None


@pytest.fixture(scope="session")
def database_url():
    if os.environ.get("TEST_DATABASE_URL"):
        yield os.environ["TEST_DATABASE_URL"]
        return
    bin_dir = _pg_bin()
    if not bin_dir:
        pytest.skip("No Postgres for tests: set TEST_DATABASE_URL or PG_BIN, or run `npm ci` for embedded-postgres.")
    data = Path(tempfile.mkdtemp(prefix="diamondx-pytest-"))
    password_file = data.parent / f"{data.name}.pw"
    password_file.write_text("postgres\n")
    subprocess.run(
        [bin_dir / "initdb", "-D", data, "-U", "postgres", "--auth=password", f"--pwfile={password_file}", "-E", "UTF8"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [bin_dir / "pg_ctl", "-D", data, "-o", f"-p {PORT} -k {data}", "-w", "-l", data / "log.txt", "start"],
        check=True,
        capture_output=True,
    )
    try:
        yield f"postgresql://postgres:postgres@localhost:{PORT}/postgres"
    finally:
        subprocess.run([bin_dir / "pg_ctl", "-D", data, "-m", "immediate", "stop"], capture_output=True)
        shutil.rmtree(data, ignore_errors=True)
        password_file.unlink(missing_ok=True)


@pytest.fixture
async def pool(database_url):
    pool = await create_pool(database_url)
    await run_migrations(pool)
    tables = await pool.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
    )
    if tables:
        await pool.execute("TRUNCATE " + ", ".join(f'"{row["tablename"]}"' for row in tables) + " CASCADE")
    yield pool
    await pool.close()


class Mailbox:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def send(self, to: str, link: str) -> None:
        self.sent.append((to, link))


@pytest.fixture
def mailbox() -> Mailbox:
    return Mailbox()


class FakeSmtp:
    """Records what would be sent, like the createMailTransport fake in the Node tests."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, settings):
        fake = self

        class Transport:
            async def verify(self) -> None:
                fake.calls.append({"settings": settings})

            async def send_mail(self, message):
                fake.calls.append({"settings": settings, "message": message})
                return {"messageId": "<test@mail>", "accepted": []}

        return Transport()


class FakeDrafter:
    """The reminder drafter; tests set `reply` (a dict, or an exception to raise)."""

    def __init__(self) -> None:
        self.prompts: list[dict] = []
        self.reply: object = RuntimeError("No drafter configured for this test.")

    async def __call__(self, facts: dict) -> dict:
        self.prompts.append(dict(facts))
        if isinstance(self.reply, Exception):
            raise self.reply
        return dict(self.reply)  # type: ignore[arg-type]


class FakeNoticeDrafter:
    """The notice reply drafter; tests set `reply` (a function of the facts, or an exception to raise)."""

    def __init__(self) -> None:
        self.reply: object = lambda facts: {"paragraphs": ["Placeholder."]}

    async def __call__(self, facts: dict) -> dict:
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply(facts)  # type: ignore[operator]


@pytest.fixture
def drafter_notice() -> FakeNoticeDrafter:
    return FakeNoticeDrafter()


@pytest.fixture
def smtp() -> FakeSmtp:
    return FakeSmtp()


@pytest.fixture
def drafter() -> FakeDrafter:
    return FakeDrafter()


@pytest.fixture
def app(pool, mailbox, smtp, drafter, drafter_notice):
    return create_app(
        pool,
        AppOptions(
            send_password_reset_email=mailbox.send,
            create_mail_transport=smtp,
            draft_reminder_text=drafter,
            draft_notice_reply=drafter_notice,
            ),
    )


@pytest.fixture
def client_factory(app):
    """New clients with their own cookie jar, like supertest's request.agent(app)."""
    clients: list[httpx.AsyncClient] = []

    def make() -> httpx.AsyncClient:
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 5000)), base_url="http://test")
        clients.append(client)
        return client

    yield make


@pytest.fixture
async def client(client_factory):
    async with client_factory() as c:
        yield c


async def sign_up(make, email: str, company_name: str | None = None) -> httpx.AsyncClient:
    agent = make()
    response = await agent.post("/api/auth/register", json={"email": email, "password": "password123", "companyName": company_name})
    assert response.status_code == 201, response.text
    return agent


__all__ = ["sign_up", "asyncpg"]
