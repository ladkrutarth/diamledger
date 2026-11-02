"""Stock register for a financial year: opening, received, sent to manufacture, sold, closing, yield and
closing value at cost (port of server/modules/stock/stock.ts; Form 3CD clause 35)."""

from __future__ import annotations

import asyncio
from datetime import date

from fastapi import Depends, Request

from ...core.context import api_router
from ...core.db import Pool
from ...core.form_input import current_financial_year, financial_year_dates
from ...core.http import ApiError, CurrentUser, require_user
from ...core.numbers import js_round, money, round_to, to_fixed
from ..tax.shared import csv_file, csv_response, is_rough_hs_code

CARATS = r"'^[0-9]+(\.[0-9]+)?$'"


def _round3(value: float) -> float:
    return round_to(value, 3)


def _key(value: str) -> str:
    return value.strip().upper()


def _empty_totals() -> dict:
    return {"opening": 0.0, "purchased": 0.0, "produced": 0.0, "consumed": 0.0, "sold": 0.0, "closing": 0.0,
            "closingValueInr": 0.0, "parcelsWithoutCost": 0}


async def stock_register(pool: Pool, organization_id: str, year: str) -> dict:
    period = financial_year_dates(year)
    if not period:
        raise ApiError(400, "Financial year should look like 2026-27.")
    start, end = period["start"], period["end"]
    start_date, end_date = date.fromisoformat(start), date.fromisoformat(end)

    parcel_rows, sale_rows = await asyncio.gather(
        pool.fetch(
            """SELECT parcel_id, description, stock_kind, to_char(received_on, 'YYYY-MM-DD') AS received_on, carats_in, cost_inr, made_from,
                      rough_carats_used
               FROM parcels WHERE organization_id = $1 AND (received_on IS NULL OR received_on <= $2)
               ORDER BY stock_kind, parcel_id""",
            organization_id, end_date,
        ),
        pool.fetch(
            f"""SELECT UPPER(TRIM(COALESCE(item->>'parcelId', ''))) AS parcel_key, COALESCE(item->>'hsCode', '') AS hs_code,
                       SUM(CASE WHEN COALESCE(i.invoice_date, i.created_at::date) < $2 AND item->>'carats' ~ {CARATS}
                                THEN (item->>'carats')::numeric ELSE 0 END) AS before,
                       SUM(CASE WHEN COALESCE(i.invoice_date, i.created_at::date) BETWEEN $2 AND $3 AND item->>'carats' ~ {CARATS}
                                THEN (item->>'carats')::numeric ELSE 0 END) AS during
                FROM invoices i, jsonb_array_elements(COALESCE(i.data->'items', '[]'::jsonb)) AS item
                WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND COALESCE(i.invoice_date, i.created_at::date) <= $3
                GROUP BY 1, 2""",
            organization_id, start_date, end_date,
        ),
    )

    sales: dict[str, dict[str, float]] = {}
    unassigned = {"rough": 0.0, "polished": 0.0}
    for row in sale_rows:
        if not row["parcel_key"]:
            unassigned["rough" if is_rough_hs_code(row["hs_code"]) else "polished"] += float(row["during"])
            continue
        found = sales.setdefault(row["parcel_key"], {"before": 0.0, "during": 0.0})
        found["before"] += float(row["before"])
        found["during"] += float(row["during"])

    # Rough carats used by polished parcels, split by whether the cutting finished before or during the year.
    consumption: dict[str, dict[str, float]] = {}
    rough_cost_per_carat: dict[str, float] = {}
    for parcel in parcel_rows:
        if parcel["stock_kind"] == "rough" and parcel["cost_inr"] is not None and float(parcel["carats_in"]) > 0:
            rough_cost_per_carat[_key(parcel["parcel_id"])] = float(parcel["cost_inr"]) / float(parcel["carats_in"])
        if not parcel["made_from"] or parcel["rough_carats_used"] is None:
            continue
        used = consumption.setdefault(_key(parcel["made_from"]), {"before": 0.0, "during": 0.0})
        if parcel["received_on"] is not None and parcel["received_on"] >= start:
            used["during"] += float(parcel["rough_carats_used"])
        else:
            used["before"] += float(parcel["rough_carats_used"])

    totals = {"rough": _empty_totals(), "polished": _empty_totals()}
    parcels = []
    for parcel in parcel_rows:
        carats_in = float(parcel["carats_in"])
        in_year = parcel["received_on"] is not None and parcel["received_on"] >= start
        sold = sales.get(_key(parcel["parcel_id"]), {"before": 0.0, "during": 0.0})
        used = consumption.get(_key(parcel["parcel_id"]), {"before": 0.0, "during": 0.0})
        opening = _round3((0 if in_year else carats_in) - sold["before"] - used["before"])
        received = carats_in if in_year else 0.0
        closing = _round3(opening + received - sold["during"] - used["during"])

        # Cost: what was paid for the parcel, or for a polished parcel without its own cost, the cost of the rough used.
        cost_inr = None if parcel["cost_inr"] is None else float(parcel["cost_inr"])
        if cost_inr is None and parcel["made_from"] and parcel["rough_carats_used"] is not None:
            per_carat = rough_cost_per_carat.get(_key(parcel["made_from"]))
            if per_carat is not None:
                cost_inr = money(per_carat * float(parcel["rough_carats_used"]))
        cost_per_carat = cost_inr / carats_in if cost_inr is not None and carats_in > 0 else None
        closing_value = None if cost_per_carat is None else money(max(closing, 0) * cost_per_carat)

        bucket = totals[parcel["stock_kind"]]
        bucket["opening"] += opening
        bucket["produced" if parcel["made_from"] else "purchased"] += received
        bucket["consumed"] += used["during"]
        bucket["sold"] += sold["during"]
        bucket["closing"] += closing
        bucket["closingValueInr"] += closing_value or 0
        if closing > 0.0005 and closing_value is None:
            bucket["parcelsWithoutCost"] += 1

        parcels.append(
            {
                "parcelId": parcel["parcel_id"],
                "description": parcel["description"],
                "stockKind": parcel["stock_kind"],
                "receivedOn": parcel["received_on"],
                "madeFrom": parcel["made_from"],
                "opening": opening,
                "received": received,
                "consumed": _round3(used["during"]),
                "sold": _round3(sold["during"]),
                "closing": closing,
                "costPerCaratInr": None if cost_per_carat is None else money(cost_per_carat),
                "closingValueInr": closing_value,
                "negative": closing < -0.0005,
            }
        )

    def finish(bucket: dict) -> dict:
        result = {k: _round3(bucket[k]) for k in ("opening", "purchased", "produced", "consumed", "sold", "closing")}
        result["closingValueInr"] = money(bucket["closingValueInr"])
        result["parcelsWithoutCost"] = bucket["parcelsWithoutCost"]
        return result

    rough, polished = finish(totals["rough"]), finish(totals["polished"])
    yield_percent = js_round(polished["produced"] / rough["consumed"] * 10000) / 100 if rough["consumed"] > 0 else None
    purchased = await pool.fetchval(
        "SELECT COALESCE(SUM(carats), 0) FROM purchases WHERE organization_id = $1 AND document_date BETWEEN $2 AND $3",
        organization_id, start_date, end_date,
    )
    return {
        "year": year,
        "start": start,
        "end": end,
        "parcels": [p for p in parcels if p["opening"] or p["received"] or p["sold"] or p["consumed"] or p["closing"]],
        "rough": rough,
        "polished": polished,
        "yieldPercent": yield_percent,
        "processLossCarats": _round3(rough["consumed"] - polished["produced"]),
        "soldWithoutParcel": {"rough": _round3(unassigned["rough"]), "polished": _round3(unassigned["polished"])},
        "purchaseRegisterCarats": _round3(float(purchased)),
        "negativeParcels": [p["parcelId"] for p in parcels if p["negative"]],
    }


def _percent(value: float) -> str:
    return f"{int(value)}%" if float(value).is_integer() else f"{value}%"


def stock_csv(report: dict) -> bytes:
    def summary(label: str, t: dict) -> list:
        return [label, "", "", "", to_fixed(t["opening"], 3), to_fixed(t["purchased"] + t["produced"], 3), to_fixed(t["consumed"], 3),
                to_fixed(t["sold"], 3), to_fixed(t["closing"], 3), "", to_fixed(t["closingValueInr"], 2)]

    rows = [
        [
            p["parcelId"], p["stockKind"], p["description"], p["madeFrom"], to_fixed(p["opening"], 3), to_fixed(p["received"], 3),
            to_fixed(p["consumed"], 3), to_fixed(p["sold"], 3), to_fixed(p["closing"], 3),
            "" if p["costPerCaratInr"] is None else to_fixed(p["costPerCaratInr"], 2),
            "" if p["closingValueInr"] is None else to_fixed(p["closingValueInr"], 2),
        ]
        for p in report["parcels"]
    ]
    rows += [
        summary("Total rough", report["rough"]),
        summary("Total polished", report["polished"]),
        ["Yield (polished produced / rough used)", "", "", "", "", "", "", "",
         "" if report["yieldPercent"] is None else _percent(report["yieldPercent"]), "", ""],
    ]
    header = ["Parcel / lot", "Type", "Description", "Made from", "Opening ct", "Received / produced ct", "Sent to manufacture ct",
              "Sold ct", "Closing ct", "Cost per ct INR", "Closing value INR"]
    return csv_file(header, rows)


def build_router():
    router = api_router(prefix="/api/stock/register")

    def year_of(request: Request) -> str:
        return request.query_params.get("year") or current_financial_year()

    @router.get("")
    async def register(request: Request, user: CurrentUser = Depends(require_user)):
        return await stock_register(request.app.state.pool, user.organization_id, year_of(request))

    @router.get("/csv")
    async def register_csv(request: Request, user: CurrentUser = Depends(require_user)):
        year = year_of(request)
        report = await stock_register(request.app.state.pool, user.organization_id, year)
        return csv_response(f"stock-register-{year}.csv", stock_csv(report))

    return router
