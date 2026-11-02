"""AI provider selection and the Gemini REST client (port of server/ai/client.ts).

Gemini is called over its REST API with httpx: the request and response JSON are the same shape the
@google/genai SDK sends (contents, systemInstruction, generationConfig, tools), so prompts and
schemas carry over unchanged.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal

import httpx

GEMINI_MODEL = "gemini-3.8-flash"
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_HF_MODEL = "meta-llama/Llama-3.3-70B-Instruct"

UnavailableReason = Literal["disabled", "not_configured", "budget", "timeout"]


class AiUnavailableError(Exception):
    """The AI service cannot be used now; the message is shown to the user (status 503)."""

    def __init__(self, reason: UnavailableReason, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


class ProviderError(Exception):
    """An HTTP error from the AI provider. 429 and 5xx are retried once by call_model."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class TokenUsage:
    input_tokens: int | None = None
    output_tokens: int | None = None


def gemini_configured() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY"))


def ai_provider() -> Literal["gemini", "huggingface"]:
    """AI_PROVIDER=huggingface selects Hugging Face; anything else keeps Gemini."""
    return "huggingface" if os.environ.get("AI_PROVIDER", "").strip().lower() == "huggingface" else "gemini"


def hf_model() -> str:
    return os.environ.get("HF_MODEL", "").strip() or DEFAULT_HF_MODEL


def active_model_name() -> str:
    """The model name recorded against each AI call."""
    return hf_model() if ai_provider() == "huggingface" else GEMINI_MODEL


async def gemini_generate(body: dict[str, Any], model: str = GEMINI_MODEL) -> dict[str, Any]:
    """POST models/{model}:generateContent. call_model applies the timeout."""
    if not gemini_configured():
        raise AiUnavailableError("not_configured", "AI features need GEMINI_API_KEY to be set on the server.")
    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.post(
            f"{GEMINI_BASE_URL}/models/{model}:generateContent",
            headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"], "User-Agent": "aistudio-build"},
            json=body,
        )
    if response.status_code >= 400:
        raise ProviderError(f"Gemini request failed ({response.status_code}): {response.text[:300]}", response.status_code)
    return response.json()


def gemini_text(response: dict[str, Any]) -> str:
    """The reply text: the first candidate's text parts, without thinking parts (response.text in the SDK)."""
    candidates = response.get("candidates") or []
    parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
    return "".join(part["text"] for part in parts if part.get("text") and not part.get("thought"))


def usage_from(metadata: dict[str, Any] | None) -> TokenUsage:
    metadata = metadata or {}
    return TokenUsage(metadata.get("promptTokenCount"), metadata.get("candidatesTokenCount"))
