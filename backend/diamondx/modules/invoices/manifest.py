"""Reads a diamond parcel manifest (text or image) into invoice lines with AI (port of server/modules/invoices/legacyRoutes.ts).

The result fills the editor; nothing is saved until the user saves the invoice, which runs the usual checks.
"""

from __future__ import annotations

import json
import logging
import re

from fastapi import Depends, Request

from ...ai.call import ModelCallContext, call_model
from ...ai.client import AiUnavailableError, TokenUsage, active_model_name, ai_provider, gemini_generate, gemini_text, usage_from
from ...ai.huggingface import MANIFEST_SHAPE, hf_json
from ...core.context import api_router
from ...core.http import ApiError, CurrentUser, body, require_user

log = logging.getLogger("diamondx.manifest")

MANIFEST_PROMPT_VERSION = "manifest-v1"

SYSTEM_PROMPT = """You are a Senior Customs Compliance Officer and GJEPC Diamond Trade Specialist. 
Analyze diamond parcel manifests, grading reports (GIA, IGI, HRD), rough/polished lot lists, or commercial slips.
Extract structured diamond export line items and invoice metadata with extreme precision.
Standard HS codes:
- 7102.39.10: Cut & Polished Natural Earth-Mined Diamonds
- 7102.31.00: Unworked / Rough Diamonds
- 7102.10.00: Unsorted Diamonds
Default to HS Code "7102.39.10" if not specified.
Always extract exact carats (e.g. 1.25, 2.504), pieces, rate per carat in USD, total amount (carats * rate), lab certificate numbers, parcel IDs, and shape/color/clarity."""

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "consigneeName": {"type": "STRING", "description": "Consignee or buyer firm name if detected"},
        "portOfDestination": {"type": "STRING", "description": "Destination port or city (e.g. Antwerp, Dubai, New York, Hong Kong)"},
        "kpcsNumber": {"type": "STRING", "description": "Kimberley Process Certificate number if detected"},
        "items": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "description": {"type": "STRING", "description": "Full diamond description e.g. Cut & Polished Natural Diamonds - Round Brilliant VVS1/E"},
                    "hsCode": {"type": "STRING", "description": "HS / HSN Code (e.g. 7102.39.10)"},
                    "certificateNo": {"type": "STRING", "description": "GIA, IGI or HRD certificate number"},
                    "parcelId": {"type": "STRING", "description": "Lot number or parcel tag"},
                    "pieces": {"type": "INTEGER", "description": "Number of pieces (pcs)"},
                    "carats": {"type": "NUMBER", "description": "Weight in carats (cts)"},
                    "ratePerCarat": {"type": "NUMBER", "description": "Price per carat in USD"},
                },
                "required": ["description", "hsCode", "pieces", "carats", "ratePerCarat"],
            },
        },
        "notes": {"type": "STRING", "description": "Summary notes or grading remarks"},
    },
    "required": ["items"],
}


def build_router():
    router = api_router()

    @router.post("/api/parse-manifest")
    async def parse_manifest(request: Request, user: CurrentUser = Depends(require_user)):
        data = body(request)
        manifest_text, image, mime_type = data.get("manifestText"), data.get("imageBase64"), data.get("mimeType")
        if not manifest_text and not image:
            raise ApiError(400, "Please provide manifest text, CSV, or an image file.")
        prompt = (f"Parse this diamond parcel manifest data into invoice line items and shipment metadata:\n\n{manifest_text}" if manifest_text
                  else "Please analyze this diamond parcel manifest image/document and extract the diamond line items, carats, rates, "
                       "certificates, and lot numbers.")

        async def run() -> tuple[str, TokenUsage | None]:
            if ai_provider() == "huggingface":
                if image:
                    raise AiUnavailableError("not_configured", "Reading manifest images needs AI_PROVIDER=gemini. Paste the manifest text instead.")
                value, usage = await hf_json(SYSTEM_PROMPT, prompt, MANIFEST_SHAPE)
                return json.dumps(value), usage
            parts: list[dict] = []
            if image:
                parts.append({"inlineData": {"mimeType": mime_type or "image/jpeg",
                                             "data": re.sub(r"^data:[a-zA-Z0-9/+-]+;base64,", "", str(image))}})
            parts.append({"text": prompt})
            response = await gemini_generate({
                "contents": [{"role": "user", "parts": parts}],
                "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "generationConfig": {"responseMimeType": "application/json", "responseSchema": RESPONSE_SCHEMA},
            })
            return gemini_text(response), usage_from(response.get("usageMetadata"))

        context = ModelCallContext("manifest_parser", MANIFEST_PROMPT_VERSION, active_model_name(), user.organization_id, user.id)
        try:
            text = await call_model(request.app.state.pool, context, run)
            return {"success": True, "data": json.loads(text or "{}")}
        except AiUnavailableError as error:
            raise ApiError(503, error.message) from None
        except Exception as error:
            log.exception("Error in /api/parse-manifest")
            raise ApiError(500, str(error) or "Failed to parse diamond manifest via Gemini API.") from None

    return router
