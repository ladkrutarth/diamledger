"""Demo company data: buyers, 400 invoices, payments and a sent reminder (port of server/core/demoData.ts).

The invoice presets are read from src/data/sampleInvoices.json, which the frontend uses too.
"""

from __future__ import annotations

import copy
import json
from datetime import date, timedelta
from functools import lru_cache

from ..modules.invoices.invoices import next_invoice_number, refresh_paid_status
from ..modules.invoices.schema import invoice_facts, validate_invoice
from .db import Pool
from .numbers import js_round, round_to
from .settings import REPO_ROOT

DEMO_INVOICE_PREFIX = "XYZ"
DEMO_INVOICE_TARGET = 400

DEMO_BUYERS: list[dict[str, str]] = [
    {"companyName": "Rosenfeld & Sons BVBA", "addressLine1": "Hoveniersstraat 30", "city": "Antwerp", "country": "Belgium",
     "postalCode": "2018", "contactPerson": "Miriam Rosenfeld", "email": "accounts.rosenfeld@example.com", "phone": "+32 3 000 0101"},
    {"companyName": "Fifth Avenue Diamonds Inc", "addressLine1": "580 Fifth Avenue, Suite 1200", "city": "New York",
     "country": "United States", "postalCode": "10036", "contactPerson": "Daniel Brooks",
     "email": "payables.fifthavenue@example.com", "phone": "+1 212 000 0102"},
    {"companyName": "Gulf Gems DMCC", "addressLine1": "Almas Tower, Jumeirah Lakes Towers", "city": "Dubai",
     "country": "United Arab Emirates", "postalCode": "00000", "contactPerson": "Omar Haddad",
     "email": "finance.gulfgems@example.com", "phone": "+971 4 000 0103"},
    {"companyName": "Kowloon Jewellery Trading Ltd", "addressLine1": "18 Hankow Road, Tsim Sha Tsui", "city": "Hong Kong",
     "country": "Hong Kong", "postalCode": "000000", "contactPerson": "Grace Leung", "email": "ap.kowloon@example.com",
     "phone": "+852 0000 0104"},
    {"companyName": "Ramat Gan Polished Ltd", "addressLine1": "3 Jabotinsky Street, Diamond Exchange", "city": "Tel Aviv",
     "country": "Israel", "postalCode": "5252001", "contactPerson": "Avi Cohen", "email": "billing.ramatgan@example.com",
     "phone": "+972 3 000 0105"},
    {"companyName": "Siam Gem Traders Co Ltd", "addressLine1": "919 Silom Road, Bang Rak", "city": "Bangkok", "country": "Thailand",
     "postalCode": "10500", "contactPerson": "Niran Chaiyaporn", "email": "accounts.siamgem@example.com", "phone": "+66 2 000 0106"},
]


@lru_cache(maxsize=1)
def presets() -> list[dict]:
    data = json.loads((REPO_ROOT / "src" / "data" / "sampleInvoices.json").read_text(encoding="utf-8"))
    return [data["suratToAntwerp"], data["mumbaiToNewYork"], data["suratToDubai"]]


def _spec(buyer, preset, items, days_ago, credit_days, status, paid=None, reminded=False, scale=None, key=None) -> dict:
    return {"buyer": buyer, "preset": preset, "items": items, "daysAgo": days_ago, "creditDays": credit_days,
            "status": status, "paid": paid, "reminded": reminded, "scale": scale, "key": key}


DEMO_INVOICES: list[dict] = [
    _spec(0, 0, 3, 115, 60, "issued", "partial"),
    _spec(0, 0, 2, 20, 30, "issued"),
    _spec(1, 1, 3, 100, 30, "issued", reminded=True),
    _spec(1, 1, 2, 75, 60, "issued", "full"),
    _spec(2, 2, 2, 95, 0, "issued", "partial"),
    _spec(2, 2, 3, 45, 30, "issued"),
    _spec(3, 0, 4, 110, 60, "issued", "full"),
    _spec(3, 1, 1, 10, 30, "issued"),
    _spec(4, 2, 4, 80, 30, "issued", "partial"),
    _spec(4, 0, 1, 40, 60, "issued"),
    _spec(5, 1, 2, 50, 0, "issued", "full"),
    _spec(5, 2, 1, 35, 30, "issued"),
    _spec(1, 1, 1, 5, 30, "draft"),
    _spec(2, 2, 2, 3, 30, "draft"),
    _spec(3, 0, 2, 65, 30, "cancelled"),
]


def generated_spec(n: int) -> dict:
    kind = n % 20
    status, paid = "issued", None
    days_ago = 40 + (n % 200)
    credit_days = [0, 30, 60][n % 3]
    if kind <= 1:
        status, days_ago, credit_days = "draft", 1 + (n % 12), 30
    elif kind == 2:
        status, days_ago = "cancelled", 15 + (n % 100)
    elif kind <= 10:
        paid, days_ago = "full", 20 + (n % 240)
    elif kind <= 12:
        paid, days_ago, credit_days = "partial", 70 + (n % 80), 30
    elif kind <= 16:
        days_ago, credit_days = 2 + (n % 10), 60
    else:
        days_ago, credit_days = 50 + (n % 90), (0 if n % 2 == 0 else 30)
    scale = js_round((0.35 + (n % 10) * 0.08) * 100) / 100
    return _spec(n % len(DEMO_BUYERS), n % 3, (n % 4) + 1, days_ago, credit_days, status, paid, scale=scale, key=n)


def demo_invoice(spec: dict, invoice_date: str) -> dict:
    buyer = DEMO_BUYERS[spec["buyer"]]
    preset = copy.deepcopy(presets()[spec["preset"]])
    scale = spec["scale"] if spec["scale"] is not None else 1
    items = []
    for index, item in enumerate(preset["items"][: min(spec["items"], len(preset["items"]))]):
        carats = round_to(item["carats"] * scale, 3)
        items.append(
            {
                **item,
                "id": f"demo-{spec['key'] if spec['key'] is not None else 'base'}-{index + 1}",
                "srNo": index + 1,
                "parcelId": item["parcelId"] if spec["key"] is None else f"{item['parcelId']}-{spec['key']}",
                "carats": carats,
                "totalAmount": round_to(carats * item["ratePerCarat"], 2),
            }
        )
    credit_days = spec["creditDays"]
    return {
        **preset,
        "exporter": {**preset["exporter"], "companyName": "Meridian Diamond Exports"},
        "items": items,
        "consignee": {**preset["consignee"], **buyer, "addressLine2": "", "state": "", "taxIdVat": "", "buyerOtherThanConsignee": False},
        "shipment": {
            **preset["shipment"],
            "invoiceNumber": "",
            "invoiceDate": invoice_date,
            "creditDays": credit_days,
            "paymentTerms": "Payment against documents" if credit_days == 0 else f"{credit_days} days from invoice date",
            "countryOfDestination": buyer["country"],
        },
    }


async def _ensure_demo_profile(conn, organization_id: str) -> None:
    preset = presets()[0]
    profile = {
        "invoicePrefix": DEMO_INVOICE_PREFIX,
        "authorizedSignatoryName": preset["authorizedSignatoryName"],
        "authorizedSignatoryDesignation": preset["authorizedSignatoryDesignation"],
        "exporter": {**preset["exporter"], "companyName": "Meridian Diamond Exports"},
        "bank": preset["bank"],
    }
    await conn.execute("UPDATE organizations SET profile = $2 WHERE id = $1 AND profile IS NULL", organization_id, profile)


async def _owner_and_today(conn, organization_id: str) -> tuple[str | None, date]:
    owner = await conn.fetchval(
        "SELECT id FROM users WHERE organization_id = $1 ORDER BY (role = 'admin') DESC, created_at LIMIT 1", organization_id
    )
    today = await conn.fetchval("SELECT current_date")
    return owner, today


async def _insert_demo_invoice(conn, organization_id: str, user_id: str | None, today: date, spec: dict) -> None:
    invoice_date = today - timedelta(days=spec["daysAgo"])
    draft = demo_invoice(spec, invoice_date.isoformat())
    draft["shipment"]["invoiceNumber"] = await next_invoice_number(conn, organization_id)
    validation = validate_invoice(draft)
    if not validation.ok:
        raise RuntimeError(f"Demo invoice is invalid: {validation.error}")
    facts = invoice_facts(validation.invoice)
    invoice_id = await conn.fetchval(
        """INSERT INTO invoices (user_id, organization_id, invoice_number, data, status, buyer_name,
                                 destination_country, invoice_date, total_usd, total_carats, credit_days, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $8::date)
           RETURNING id""",
        user_id, organization_id, facts["invoiceNumber"], validation.invoice, spec["status"], facts["buyerName"],
        facts["destinationCountry"], invoice_date, facts["totalUsd"], facts["totalCarats"], facts["creditDays"],
    )

    if spec["paid"] and spec["status"] == "issued" and facts["totalUsd"] > 0:
        amount = facts["totalUsd"] if spec["paid"] == "full" else max(0.01, round_to(facts["totalUsd"] * 0.4, 2))
        paid_on = invoice_date + timedelta(days=min(spec["daysAgo"] - 1, max(spec["creditDays"], 1)))
        await conn.execute(
            """INSERT INTO payments (invoice_id, organization_id, amount_usd, paid_on, reference, created_by)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            invoice_id, organization_id, amount, paid_on, f"SWIFT-DEMO-{facts['invoiceNumber'][-4:]}", user_id,
        )
        await refresh_paid_status(conn, invoice_id)

    if spec["reminded"]:
        number = facts["invoiceNumber"]
        await conn.execute(
            """INSERT INTO payment_reminders (organization_id, invoice_id, created_by, model, prompt_version, subject,
                                              body_html, status, created_at, sent_at)
               VALUES ($1, $2, $3, 'template', 'demo', $4, $5, 'sent', now() - interval '3 days', now() - interval '3 days')""",
            organization_id, invoice_id, user_id, f"Payment reminder: invoice {number}",
            f"<p>Dear {DEMO_BUYERS[spec['buyer']]['contactPerson']},</p><p>This is a reminder that invoice {number} is past due.</p>",
        )


async def seed_demo_data(pool: Pool, organization_id: str) -> dict[str, int]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", organization_id)
        if await conn.fetchval("SELECT 1 FROM invoices WHERE organization_id = $1 LIMIT 1", organization_id):
            return {"invoices": 0}
        user_id, today = await _owner_and_today(conn, organization_id)
        await _ensure_demo_profile(conn, organization_id)
        for buyer in DEMO_BUYERS:
            await conn.execute(
                "INSERT INTO buyers (organization_id, name, data) VALUES ($1, $2, $3)",
                organization_id, buyer["companyName"], {**buyer, "addressLine2": "", "state": "", "taxIdVat": ""},
            )
        for spec in DEMO_INVOICES:
            await _insert_demo_invoice(conn, organization_id, user_id, today, spec)
    return {"invoices": len(DEMO_INVOICES)}


async def fill_demo_invoices(pool: Pool, organization_id: str, target: int = DEMO_INVOICE_TARGET) -> dict[str, int]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", organization_id)
        have = await conn.fetchval("SELECT COUNT(*) FROM invoices WHERE organization_id = $1", organization_id)
        need = target - have
        if need <= 0:
            return {"invoices": 0}
        user_id, today = await _owner_and_today(conn, organization_id)
        for offset in range(need):
            await _insert_demo_invoice(conn, organization_id, user_id, today, generated_spec(have + offset))
    return {"invoices": need}


async def reset_demo_data(pool: Pool, organization_id: str) -> dict[str, int]:
    for table in ("assistant_sessions", "ai_calls", "email_dispatches", "invoices", "buyers", "invoice_counters"):
        await pool.execute(f"DELETE FROM {table} WHERE organization_id = $1", organization_id)
    seeded = await seed_demo_data(pool, organization_id)
    filled = await fill_demo_invoices(pool, organization_id)
    return {"invoices": seeded["invoices"] + filled["invoices"]}
