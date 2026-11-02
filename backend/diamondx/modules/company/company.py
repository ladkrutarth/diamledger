"""Company profile and the buyer address book (port of server/modules/company/company.ts)."""

from __future__ import annotations

import re

from fastapi import Depends, Request, Response
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.http import ApiError, CurrentUser, body, is_uuid, iso, require_admin, require_user, string_fields

EXPORTER_FIELDS = (
    "companyName", "addressLine1", "addressLine2", "city", "state", "stateCode", "pincode", "country",
    "iec", "gstin", "pan", "rcmcNo", "email", "phone",
)
BANK_FIELDS = (
    "bankName", "branch", "accountNumber", "adCode", "swiftCode", "ifscCode", "iban", "correspondentBank", "correspondentSwift",
)
BUYER_FIELDS = (
    "companyName", "addressLine1", "addressLine2", "city", "state", "country", "postalCode", "taxIdVat",
    "contactPerson", "email", "phone",
)


def to_buyer(row) -> dict:
    return {"id": row["id"], "name": row["name"], "consignee": row["data"], "updatedAt": iso(row["updated_at"])}


def parse_profile(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    exporter = string_fields(value.get("exporter") if value.get("exporter") is not None else {}, EXPORTER_FIELDS)
    bank = string_fields(value.get("bank") if value.get("bank") is not None else {}, BANK_FIELDS)
    extra = string_fields(value, ("invoicePrefix", "authorizedSignatoryName", "authorizedSignatoryDesignation"))
    if exporter is None or bank is None or extra is None:
        return None
    invoice_prefix = re.sub(r"[^A-Za-z0-9-]", "", extra["invoicePrefix"].strip())[:12]
    return {**extra, "invoicePrefix": invoice_prefix, "exporter": exporter, "bank": bank}


def _consignee(request: Request) -> dict[str, str]:
    consignee = string_fields(body(request).get("consignee"), BUYER_FIELDS)
    if not consignee or not consignee["companyName"].strip():
        raise ApiError(400, "Buyer company name is required.")
    return consignee


def build_router():
    router = api_router(prefix="/api")

    @router.get("/company")
    async def get_company(request: Request, user: CurrentUser = Depends(require_user)):
        row = await request.app.state.pool.fetchrow("SELECT name, profile FROM organizations WHERE id = $1", user.organization_id)
        return {"name": row["name"], "profile": row["profile"]}

    @router.put("/company")
    async def put_company(request: Request, user: CurrentUser = Depends(require_admin)):
        data = body(request)
        name = data["name"].strip()[:200] if isinstance(data.get("name"), str) else ""
        profile = parse_profile(data.get("profile"))
        if not name:
            raise ApiError(400, "Company name is required.")
        if not profile:
            raise ApiError(400, "Company profile is invalid.")
        await request.app.state.pool.execute(
            "UPDATE organizations SET name = $2, profile = $3 WHERE id = $1", user.organization_id, name, profile
        )
        return {"name": name, "profile": profile}

    @router.get("/buyers")
    async def list_buyers(request: Request, user: CurrentUser = Depends(require_user)):
        rows = await request.app.state.pool.fetch(
            "SELECT id, name, data, updated_at FROM buyers WHERE organization_id = $1 ORDER BY lower(name)", user.organization_id
        )
        return {"buyers": [to_buyer(row) for row in rows]}

    @router.post("/buyers")
    async def add_buyer(request: Request, user: CurrentUser = Depends(require_user)):
        consignee = _consignee(request)
        row = await request.app.state.pool.fetchrow(
            """INSERT INTO buyers (organization_id, name, data) VALUES ($1, $2, $3)
               RETURNING id, name, data, updated_at""",
            user.organization_id, consignee["companyName"].strip(), consignee,
        )
        return JSONResponse(to_buyer(row), status_code=201)

    @router.put("/buyers/{buyer_id}")
    async def edit_buyer(buyer_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        consignee = _consignee(request)
        if not is_uuid(buyer_id):
            raise ApiError(404, "Buyer not found.")
        row = await request.app.state.pool.fetchrow(
            """UPDATE buyers SET name = $3, data = $4, updated_at = now()
               WHERE id = $1 AND organization_id = $2
               RETURNING id, name, data, updated_at""",
            buyer_id, user.organization_id, consignee["companyName"].strip(), consignee,
        )
        if not row:
            raise ApiError(404, "Buyer not found.")
        return to_buyer(row)

    @router.delete("/buyers/{buyer_id}")
    async def delete_buyer(buyer_id: str, request: Request, user: CurrentUser = Depends(require_user)):
        if not is_uuid(buyer_id):
            raise ApiError(404, "Buyer not found.")
        result = await request.app.state.pool.execute("DELETE FROM buyers WHERE id = $1 AND organization_id = $2", buyer_id, user.organization_id)
        if result == "DELETE 0":
            raise ApiError(404, "Buyer not found.")
        return Response(status_code=204)

    return router
