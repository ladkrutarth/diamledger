"""Hugging Face Inference Providers through its OpenAI-compatible chat endpoint (from server/ai/huggingface.ts).

Set AI_PROVIDER=huggingface and HF_TOKEN. The assistant's tool-calling adapter moves with the assistant.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from .client import AiUnavailableError, ProviderError, TokenUsage, hf_model

HF_BASE_URL = "https://router.huggingface.co/v1"

REMINDER_SHAPE = '{"subject": string, "greeting": string, "paragraphs": string[]}'

MANIFEST_SHAPE = """{
  "consigneeName": string,
  "portOfDestination": string,
  "kpcsNumber": string,
  "items": [{"description": string, "hsCode": string, "certificateNo": string, "parcelId": string, "pieces": integer, "carats": number, "ratePerCarat": number}],
  "notes": string
}"""


def hf_configured() -> bool:
    return bool(os.environ.get("HF_TOKEN"))


async def chat(messages: list[dict[str, Any]], *, tools: list[dict] | None = None, temperature: float = 0.2) -> dict[str, Any]:
    if not hf_configured():
        raise AiUnavailableError("not_configured", "AI features need HF_TOKEN to be set on the server.")
    body: dict[str, Any] = {"model": hf_model(), "messages": messages, "temperature": temperature}
    if tools:
        body.update(tools=tools, tool_choice="auto")
    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.post(
            f"{HF_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {os.environ['HF_TOKEN']}"},
            json=body,
        )
    if response.status_code >= 400:
        raise ProviderError(f"Hugging Face request failed ({response.status_code}): {response.text[:300]}", response.status_code)
    return response.json()


def usage_of(response: dict[str, Any]) -> TokenUsage:
    usage = response.get("usage") or {}
    return TokenUsage(usage.get("prompt_tokens"), usage.get("completion_tokens"))


def extract_json(text: str) -> Any:
    """The first JSON object in a reply, which may be wrapped in prose or code fences."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("The model did not return JSON.")
    return json.loads(text[start : end + 1])


async def hf_json(system: str, user: str, shape: str) -> tuple[Any, TokenUsage]:
    response = await chat(
        [
            {"role": "system", "content": f"{system}\n\nReply with one JSON object only, no other text, shaped like:\n{shape}"},
            {"role": "user", "content": user},
        ]
    )
    choices = response.get("choices") or [{}]
    content = (choices[0].get("message") or {}).get("content") or ""
    return extract_json(content), usage_of(response)
