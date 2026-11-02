"""Reads credits from a bank statement (PDF, image, or text) with AI (port of server/modules/banking/statementReader.ts).

The model's output is never trusted as-is: only lines that look like real credits are kept, and the user
checks them before they are imported.
"""

from __future__ import annotations

import json
import logging
import math
import re

from fastapi import Depends, Request

from ...ai.call import ModelCallContext, call_model
from ...ai.client import AiUnavailableError, TokenUsage, active_model_name, ai_provider, gemini_generate, gemini_text, usage_from
from ...ai.huggingface import hf_json
from ...core.context import api_router
from ...core.form_input import parse_loose_date
from ...core.http import ApiError, CurrentUser, body
from ...core.numbers import js_number, round_to
from ..tax.shared import tax_writer

log = logging.getLogger("diamondx.statements")

STATEMENT_PROMPT_VERSION = "bank-statement-v1"
MAX_LINES = 500
FILE_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/webp"}

SYSTEM_PROMPT = """You read bank statements for an Indian diamond exporter's USD (EEFC or export) account.
Return only CREDIT entries (money received). Ignore debits, charges, opening and closing balances, and totals.
For each credit give:
- date: the value date, or the transaction date, as YYYY-MM-DD
- amountUsd: the credited amount in US dollars, as a number with no commas
- reference: the UTR, SWIFT, or bank reference number, if shown
- narration: the description, including the remitter name and any invoice numbers
- bankRateInr: the rupee conversion rate if the statement shows one, otherwise leave it out
Copy numbers and references exactly as printed. Never invent a line."""

SHAPE = '{"lines": [{"date": "YYYY-MM-DD", "amountUsd": number, "reference": string, "narration": string, "bankRateInr": number}]}'

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "lines": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "date": {"type": "STRING", "description": "Value date as YYYY-MM-DD"},
                    "amountUsd": {"type": "NUMBER", "description": "Credited amount in USD"},
                    "reference": {"type": "STRING", "description": "UTR, SWIFT, or bank reference"},
                    "narration": {"type": "STRING", "description": "Description including remitter and invoice numbers"},
                    "bankRateInr": {"type": "NUMBER", "description": "Rupee conversion rate, if printed"},
                },
                "required": ["date", "amountUsd"],
            },
        },
    },
    "required": ["lines"],
}


def clean_statement_lines(raw) -> list[dict]:
    """Keeps only lines that look like real credits."""
    entries = raw.get("lines") if isinstance(raw, dict) and isinstance(raw.get("lines"), list) else []
    lines = []
    for entry in entries[:MAX_LINES]:
        line = entry if isinstance(entry, dict) else {}
        day = parse_loose_date(line["date"] if isinstance(line.get("date"), str) else None)
        raw_amount = line.get("amountUsd")
        amount_text = "" if raw_amount is None else (raw_amount if isinstance(raw_amount, str) else repr(raw_amount))
        amount = js_number(re.sub(r"[,\s$]", "", amount_text)) if amount_text.strip() else 0.0
        rate = js_number(line["bankRateInr"]) if "bankRateInr" in line else math.nan
        if not day or not math.isfinite(amount) or amount <= 0:
            continue
        lines.append({
            "date": day,
            "amountUsd": round_to(amount, 2),
            "reference": line["reference"].strip()[:200] if isinstance(line.get("reference"), str) else "",
            "narration": line["narration"].strip()[:500] if isinstance(line.get("narration"), str) else "",
            "bankRateInr": rate if math.isfinite(rate) and 0 < rate < 1000 else None,
        })
    return lines


def build_router():
    router = api_router(prefix="/api/bank")

    @router.post("/parse-statement")
    async def parse_statement(request: Request, user: CurrentUser = Depends(tax_writer)):
        data = body(request)
        text = data["text"][:200_000] if isinstance(data.get("text"), str) else ""
        file_base64 = re.sub(r"^data:[^;]+;base64,", "", data["fileBase64"]) if isinstance(data.get("fileBase64"), str) else ""
        mime_type = data["mimeType"] if isinstance(data.get("mimeType"), str) else ""
        if not text and not file_base64:
            raise ApiError(400, "Upload a PDF, an image, or a CSV of the statement.")
        if file_base64 and mime_type not in FILE_TYPES:
            raise ApiError(400, "The AI reader takes PDF, PNG, JPEG, or WebP. Save Excel statements as CSV or PDF first.")

        async def run() -> tuple[object, TokenUsage | None]:
            if ai_provider() == "huggingface":
                if file_base64:
                    raise AiUnavailableError("not_configured", "Reading PDF or image statements needs AI_PROVIDER=gemini. Upload a CSV instead.")
                return await hf_json(SYSTEM_PROMPT, f"Bank statement:\n\n{text}", SHAPE)
            parts = (
                [{"inlineData": {"mimeType": mime_type, "data": file_base64}}, {"text": "Read the credits from this bank statement."}]
                if file_base64
                else [{"text": f"Read the credits from this bank statement:\n\n{text}"}]
            )
            response = await gemini_generate({
                "contents": [{"role": "user", "parts": parts}],
                "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "generationConfig": {"responseMimeType": "application/json", "responseSchema": RESPONSE_SCHEMA},
            })
            return json.loads(gemini_text(response) or "{}"), usage_from(response.get("usageMetadata"))

        context = ModelCallContext("bank_statement", STATEMENT_PROMPT_VERSION, active_model_name(), user.organization_id, user.id)
        try:
            parsed = await call_model(request.app.state.pool, context, run)
        except AiUnavailableError as error:
            raise ApiError(503, error.message) from None
        except Exception as error:
            log.error("Statement reader failed: %s", error)
            raise ApiError(502, "The AI could not read that statement. Try a clearer PDF, or upload it as CSV.") from None
        return {"lines": clean_statement_lines(parsed), "model": active_model_name()}

    return router
