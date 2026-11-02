"""Rough and polished parcels, and the carats invoiced against each (port of server/modules/stock/parcels.ts)."""

from __future__ import annotations

import math
from datetime import date
from typing import Any

import asyncpg
from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import parse_loose_date
from ...core.http import ApiError, CurrentUser, body, is_uuid, require_roles, require_user
from ...core.numbers import js_number, round_to, to_fixed
from ..tax.shared import csv_file, csv_response

parcel_writer = require_roles("admin", "member", "tax")

CARATS = r"'^[0-9]+(\.[0-9]+)?$'"


def _number(data: dict, key: str) -> float:
    """Number(body[key]): a missing key is NaN, null is 0."""
    return js_number(data[key]) if key in data else math.nan


def read_parcel(data: dict) -> dict[str, Any]:
    """The parcel from the request body. Raises ApiError(400) with what to fix."""

    def text(key: str, max_length: int) -> str:
        return data[key].strip()[:max_length] if isinstance(data.get(key), str) else ""

    parcel_id = text("parcelId", 100)
    if not parcel_id:
        raise ApiError(400, "Enter the parcel or lot number.")
    carats_in = round_to(_number(data, "caratsIn"), 3)
    if not math.isfinite(carats_in) or carats_in <= 0:
        raise ApiError(400, "Enter the carats received.")
    pieces_in = 0.0 if "piecesIn" not in data or data["piecesIn"] == "" else _number(data, "piecesIn")
    if not math.isfinite(pieces_in) or not pieces_in.is_integer() or pieces_in < 0:
        raise ApiError(400, "Pieces must be a whole number.")
    received_raw = text("receivedOn", 20)
    received_on = parse_loose_date(received_raw) if received_raw else None
    if received_raw and not received_on:
        raise ApiError(400, "Enter the received date as YYYY-MM-DD.")
    stock_kind = "rough" if data.get("stockKind") == "rough" else "polished"
    cost_raw = data.get("costInr")
    cost_inr = None if cost_raw is None or cost_raw == "" else round_to(js_number(cost_raw), 2)
    if cost_inr is not None and (not math.isfinite(cost_inr) or cost_inr < 0):
        raise ApiError(400, "Cost must be zero or more rupees.")
    made_from = text("madeFrom", 100) if stock_kind == "polished" else ""
    rough_carats_used = None
    if made_from:
        rough_carats_used = round_to(_number(data, "roughCaratsUsed"), 3)
        if not math.isfinite(rough_carats_used) or rough_carats_used <= 0:
            raise ApiError(400, "Enter the rough carats used to make this parcel.")
        if rough_carats_used < carats_in:
            raise ApiError(400, "Polished carats cannot be more than the rough carats used.")
    return {
        "stockKind": stock_kind,
        "costInr": cost_inr,
        "madeFrom": made_from,
        "roughCaratsUsed": rough_carats_used,
        "parcelId": parcel_id,
        "description": text("description", 300),
        "receivedOn": received_on,
        "source": text("source", 200),
        "piecesIn": int(pieces_in),
        "caratsIn": carats_in,
        "notes": text("notes", 500),
    }


async def check_rough_source(pool: Pool, organization_id: str, parcel: dict) -> None:
    """A polished parcel can only be cut from a rough parcel that is already in the register."""
    made_from = parcel["madeFrom"]
    if not made_from:
        return
    if made_from.strip().upper() == parcel["parcelId"].strip().upper():
        raise ApiError(400, "A parcel cannot be made from itself.")
    kind = await pool.fetchval(
        "SELECT stock_kind FROM parcels WHERE organization_id = $1 AND UPPER(TRIM(parcel_id)) = UPPER(TRIM($2))", organization_id, made_from
    )
    if not kind:
        raise ApiError(400, f"Rough parcel {made_from} is not in the register. Receive it first.")
    if kind != "rough":
        raise ApiError(400, f"{made_from} is a polished parcel. Choose the rough parcel it was cut from.")


def _round3(value: float) -> float:
    return round_to(value, 3)


async def parcel_register(pool: Pool, organization_id: str) -> dict:
    """Each parcel with the carats and pieces invoiced against it (issued and paid invoices only)."""
    rows = await pool.fetch(
        f"""WITH lines AS (
              SELECT i.invoice_number, i.status, UPPER(TRIM(item->>'parcelId')) AS parcel_key,
                     CASE WHEN item->>'carats' ~ {CARATS} THEN (item->>'carats')::numeric ELSE 0 END AS carats,
                     CASE WHEN item->>'pieces' ~ {CARATS} THEN (item->>'pieces')::numeric ELSE 0 END AS pieces
              FROM invoices i, jsonb_array_elements(COALESCE(i.data->'items', '[]'::jsonb)) AS item
              WHERE i.organization_id = $1 AND i.status <> 'cancelled' AND COALESCE(TRIM(item->>'parcelId'), '') <> ''
            )
            SELECT p.id, p.parcel_id, p.description, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.source, p.pieces_in,
                   p.carats_in, p.notes, p.stock_kind, p.cost_inr, p.made_from, p.rough_carats_used,
                   (SELECT COALESCE(SUM(c.rough_carats_used), 0) FROM parcels c
                     WHERE c.organization_id = p.organization_id AND UPPER(TRIM(c.made_from)) = UPPER(TRIM(p.parcel_id))) AS consumed,
                   COALESCE(SUM(l.carats) FILTER (WHERE l.status IN ('issued', 'paid')), 0) AS carats_out,
                   COALESCE(SUM(l.pieces) FILTER (WHERE l.status IN ('issued', 'paid')), 0) AS pieces_out,
                   COALESCE(SUM(l.carats) FILTER (WHERE l.status = 'draft'), 0) AS draft_carats,
                   ARRAY_REMOVE(ARRAY_AGG(DISTINCT l.invoice_number) FILTER (WHERE l.status IN ('issued', 'paid')), NULL) AS invoices
            FROM parcels p
            LEFT JOIN lines l ON l.parcel_key = UPPER(TRIM(p.parcel_id))
            WHERE p.organization_id = $1
            GROUP BY p.id
            ORDER BY p.received_on DESC NULLS LAST, p.parcel_id""",
        organization_id,
    )
    parcels = []
    for row in rows:
        carats_in = float(row["carats_in"])
        consumed = _round3(float(row["consumed"]))
        carats_out = _round3(float(row["carats_out"]))
        balance = _round3(carats_in - carats_out - consumed)
        if balance < -0.0005:
            status = "over"
        elif balance <= 0.0005:
            status = "sold"
        else:
            status = "partial" if carats_out + consumed > 0 else "in_stock"
        parcels.append(
            {
                "id": row["id"],
                "parcelId": row["parcel_id"],
                "description": row["description"],
                "receivedOn": row["received_on"],
                "source": row["source"],
                "piecesIn": row["pieces_in"],
                "caratsIn": carats_in,
                "notes": row["notes"],
                "stockKind": row["stock_kind"],
                "costInr": None if row["cost_inr"] is None else float(row["cost_inr"]),
                "madeFrom": row["made_from"],
                "roughCaratsUsed": None if row["rough_carats_used"] is None else float(row["rough_carats_used"]),
                "consumedCarats": consumed,
                "caratsOut": carats_out,
                "piecesOut": float(row["pieces_out"]),
                "draftCarats": _round3(float(row["draft_carats"])),
                "balanceCarats": balance,
                "invoices": list(row["invoices"] or []),
                "status": status,
            }
        )

    # Invoiced parcel numbers that were never received into stock.
    unknown = await pool.fetch(
        f"""SELECT MIN(TRIM(item->>'parcelId')) AS parcel_id,
                   SUM(CASE WHEN item->>'carats' ~ {CARATS} THEN (item->>'carats')::numeric ELSE 0 END) AS carats,
                   ARRAY_AGG(DISTINCT i.invoice_number) AS invoices
            FROM invoices i, jsonb_array_elements(COALESCE(i.data->'items', '[]'::jsonb)) AS item
            WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND COALESCE(TRIM(item->>'parcelId'), '') <> ''
              AND NOT EXISTS (SELECT 1 FROM parcels p WHERE p.organization_id = $1 AND UPPER(TRIM(p.parcel_id)) = UPPER(TRIM(item->>'parcelId')))
            GROUP BY UPPER(TRIM(item->>'parcelId'))
            ORDER BY 1""",
        organization_id,
    )

    def total(key: str) -> float:
        acc = 0.0
        for parcel in parcels:
            acc += parcel[key]
        return _round3(acc)

    return {
        "parcels": parcels,
        "unregistered": [{"parcelId": r["parcel_id"], "carats": _round3(float(r["carats"])), "invoices": list(r["invoices"])} for r in unknown],
        "totals": {
            "caratsIn": total("caratsIn"),
            "caratsOut": total("caratsOut"),
            "balanceCarats": total("balanceCarats"),
            "overInvoiced": sum(1 for p in parcels if p["status"] == "over"),
        },
    }


def _values(parcel: dict) -> list:
    received = date.fromisoformat(parcel["receivedOn"]) if parcel["receivedOn"] else None
    return [
        parcel["parcelId"], parcel["description"], received, parcel["source"], parcel["piecesIn"], parcel["caratsIn"], parcel["notes"],
    ]


def build_router():
    router = api_router(prefix="/api/parcels")

    @router.get("")
    async def register(request: Request, user: CurrentUser = Depends(require_user)):
        return await parcel_register(request.app.state.pool, user.organization_id)

    @router.get("/csv")
    async def register_csv(request: Request, user: CurrentUser = Depends(require_user)):
        parcels = (await parcel_register(request.app.state.pool, user.organization_id))["parcels"]
        header = ["Parcel / lot", "Type", "Description", "Received on", "Source", "Made from", "Pieces in", "Carats in", "Cost INR",
                  "Pieces invoiced", "Carats invoiced", "Carats sent to manufacture", "Balance carats", "Invoices", "Notes"]
        rows = [
            [
                p["parcelId"], p["stockKind"], p["description"], p["receivedOn"] or "", p["source"], p["madeFrom"], p["piecesIn"],
                to_fixed(p["caratsIn"], 3), "" if p["costInr"] is None else to_fixed(p["costInr"], 2), p["piecesOut"],
                to_fixed(p["caratsOut"], 3), to_fixed(p["consumedCarats"], 3), to_fixed(p["balanceCarats"], 3), " ".join(p["invoices"]), p["notes"],
            ]
            for p in parcels
        ]
        return csv_response("parcel-register.csv", csv_file(header, rows))

    @router.post("")
    async def receive(request: Request, user: CurrentUser = Depends(parcel_writer)):
        parcel = read_parcel(body(request))
        pool: Pool = request.app.state.pool
        await check_rough_source(pool, user.organization_id, parcel)
        new_id = await pool.fetchval(
            """INSERT INTO parcels (organization_id, parcel_id, description, received_on, source, pieces_in, carats_in, notes, created_by,
                 stock_kind, cost_inr, made_from, rough_carats_used)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
               ON CONFLICT (organization_id, parcel_id) DO NOTHING RETURNING id""",
            user.organization_id, *_values(parcel), user.id,
            parcel["stockKind"], parcel["costInr"], parcel["madeFrom"], parcel["roughCaratsUsed"],
        )
        if not new_id:
            raise ApiError(409, f"Parcel {parcel['parcelId']} is already in the register.")
        return JSONResponse({"id": new_id}, status_code=201)

    @router.put("/{parcel_id}")
    async def edit(parcel_id: str, request: Request, user: CurrentUser = Depends(parcel_writer)):
        if not is_uuid(parcel_id):
            raise ApiError(404, "Parcel not found.")
        parcel = read_parcel(body(request))
        pool: Pool = request.app.state.pool
        await check_rough_source(pool, user.organization_id, parcel)
        try:
            result = await pool.execute(
                """UPDATE parcels SET parcel_id = $3, description = $4, received_on = $5, source = $6, pieces_in = $7, carats_in = $8,
                     notes = $9, stock_kind = $10, cost_inr = $11, made_from = $12, rough_carats_used = $13
                   WHERE id = $1 AND organization_id = $2""",
                parcel_id, user.organization_id, *_values(parcel),
                parcel["stockKind"], parcel["costInr"], parcel["madeFrom"], parcel["roughCaratsUsed"],
            )
        except asyncpg.UniqueViolationError:
            raise ApiError(409, f"Parcel {parcel['parcelId']} is already in the register.") from None
        if result == "UPDATE 0":
            raise ApiError(404, "Parcel not found.")
        return {"id": parcel_id}

    @router.delete("/{parcel_id}")
    async def delete(parcel_id: str, request: Request, user: CurrentUser = Depends(require_roles("admin"))):
        if not is_uuid(parcel_id):
            raise ApiError(404, "Parcel not found.")
        result = await request.app.state.pool.execute("DELETE FROM parcels WHERE id = $1 AND organization_id = $2", parcel_id, user.organization_id)
        if result == "DELETE 0":
            raise ApiError(404, "Parcel not found.")
        return {"deleted": True}

    return router
