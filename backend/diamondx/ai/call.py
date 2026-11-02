"""Every model call goes through call_model (port of server/ai/call.ts): the on/off switch, a daily
token budget per company, a timeout, one retry on 429/5xx, and a row in ai_calls for each call."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, TypeVar

from ..core.db import Pool
from ..core.monitoring import report_error
from .client import AiUnavailableError, TokenUsage

log = logging.getLogger("diamondx.ai")

T = TypeVar("T")

Feature = Literal["manifest_parser", "payment_reminder", "assistant", "month_review", "bank_statement", "notice_reply"]


@dataclass(frozen=True)
class ModelCallContext:
    feature: Feature
    prompt_version: str
    model: str
    organization_id: str
    user_id: str


# A model call: returns the value and the tokens it used. Cancelled when the timeout passes.
ModelRun = Callable[[], Awaitable[tuple[T, TokenUsage | None]]]


def ai_enabled() -> bool:
    return os.environ.get("AI_ENABLED") != "false"


def _positive_env(name: str, fallback: float) -> float:
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def daily_token_budget() -> float:
    return _positive_env("AI_DAILY_TOKEN_BUDGET", 2_000_000)


def timeout_seconds() -> float:
    return _positive_env("AI_TIMEOUT_MS", 20_000) / 1000


async def tokens_used_today(pool: Pool, organization_id: str) -> int:
    used = await pool.fetchval(
        """SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0)
           FROM ai_calls WHERE organization_id = $1 AND created_at >= date_trunc('day', now())""",
        organization_id,
    )
    return int(used)


async def _record(pool: Pool, context: ModelCallContext, outcome: str, latency_ms: float, usage: TokenUsage | None = None) -> None:
    usage = usage or TokenUsage()
    try:
        await pool.execute(
            """INSERT INTO ai_calls
                 (organization_id, user_id, feature, model, prompt_version, outcome, latency_ms, input_tokens, output_tokens)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)""",
            context.organization_id, context.user_id, context.feature, context.model, context.prompt_version, outcome,
            round(latency_ms), usage.input_tokens, usage.output_tokens,
        )
    except Exception as error:
        log.error("Could not record AI call: %s", error)


def _retryable(error: BaseException) -> bool:
    status = getattr(error, "status", None)
    return isinstance(status, int) and (status == 429 or status >= 500)


async def _attempt(run: ModelRun[T]) -> tuple[T, TokenUsage | None]:
    try:
        return await asyncio.wait_for(run(), timeout_seconds())
    except asyncio.TimeoutError:
        raise AiUnavailableError("timeout", "The AI service took too long to answer. Try again.") from None


async def call_model(pool: Pool, context: ModelCallContext, run: ModelRun[T]) -> T:
    if not ai_enabled():
        await _record(pool, context, "blocked", 0)
        raise AiUnavailableError("disabled", "AI features are turned off on this server.")
    if await tokens_used_today(pool, context.organization_id) >= daily_token_budget():
        await _record(pool, context, "blocked", 0)
        raise AiUnavailableError("budget", "Your company has used today's AI allowance. It resets at midnight.")

    started = time.monotonic()
    last_error: BaseException | None = None
    for tries in (1, 2):
        try:
            value, usage = await _attempt(run)
            await _record(pool, context, "ok", (time.monotonic() - started) * 1000, usage)
            return value
        except Exception as error:
            last_error = error
            if tries == 1 and _retryable(error):
                continue
            break

    assert last_error is not None
    if isinstance(last_error, AiUnavailableError):
        outcome = "timeout" if last_error.reason == "timeout" else "blocked"
    else:
        outcome = "error"
    await _record(pool, context, outcome, (time.monotonic() - started) * 1000)
    if outcome != "blocked":
        report_error(last_error, path=f"ai:{context.feature}", user_id=context.user_id, organization_id=context.organization_id)
    raise last_error
