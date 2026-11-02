"""Sample invoices for tests, built from the presets in src/data/sampleInvoices.json (as in api.test.ts)."""

from __future__ import annotations

import copy

from diamondx.core.demo_data import presets
from diamondx.core.numbers import round_to

ANTWERP, NEW_YORK, DUBAI = (copy.deepcopy(p) for p in presets())


def invoice_with(base: dict, shipment: dict | None = None, consignee: dict | None = None, **overrides) -> dict:
    result = copy.deepcopy(base)
    result.update(copy.deepcopy(overrides))
    result["shipment"] = {**base["shipment"], **(shipment or {})}
    result["consignee"] = {**base["consignee"], **(consignee or {})}
    return result


def line(carats: float, rate: float) -> dict:
    return {**ANTWERP["items"][0], "carats": carats, "ratePerCarat": rate, "totalAmount": round_to(carats * rate, 2)}


SAMPLE = invoice_with(ANTWERP, consignee={"companyName": "Buyer BVBA"}, shipment={"invoiceNumber": "EXP-100"}, items=[])
PRICED = invoice_with(
    ANTWERP,
    consignee={"companyName": "Antwerp Gems BVBA", "country": "Belgium"},
    shipment={"invoiceNumber": "", "invoiceDate": "2026-10-15", "countryOfDestination": "Belgium"},
    items=[line(1.25, 480), line(1, 400)],
    freightUsd=30,
    insuranceUsd=20,
    otherChargesUsd=0,
)
