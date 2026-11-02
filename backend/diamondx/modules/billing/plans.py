"""Subscription plans, priced in Indian rupees (port of server/modules/billing/plans.ts).

Prices are per company and exclude GST; 18% GST is added at checkout. Annual billing is 10x monthly.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Literal

GST_RATE = 0.18
TRIAL_DAYS = 14
# Days after a paid period ends before the company becomes read-only, while the bank retries the charge.
GRACE_DAYS = 3

Feature = Literal["advanced_tax", "audit", "ai", "outside_accountants", "practice"]


@dataclass(frozen=True)
class Limits:
    users: int
    invoicesPerMonth: int | None
    clients: int | None


@dataclass(frozen=True)
class Plan:
    key: str
    name: str
    audience: str
    monthlyInr: int
    yearlyInr: int
    # For customers outside India paying by PayPal. Export of services, so no GST.
    monthlyUsd: int
    yearlyUsd: int
    limits: Limits
    features: tuple[str, ...] = ()
    highlights: tuple[str, ...] = field(default_factory=tuple)


PLANS: list[Plan] = [
    Plan(
        key="starter",
        name="Starter",
        audience="A small exporter starting out",
        monthlyInr=1499,
        yearlyInr=14990,
        monthlyUsd=19,
        yearlyUsd=190,
        limits=Limits(users=2, invoicesPerMonth=30, clients=None),
        features=(),
        highlights=(
            "2 users, 30 issued invoices a month",
            "Export invoices, PDF, Tally XML, SAP",
            "Payments, buyers, collections, dashboard",
            "Filing check, export register, realization, forex, bank match",
            "Parcels, stock register, KP register",
        ),
    ),
    Plan(
        key="growth",
        name="Growth",
        audience="An exporter with an accountant",
        monthlyInr=3999,
        yearlyInr=39990,
        monthlyUsd=49,
        yearlyUsd=490,
        limits=Limits(users=5, invoicesPerMonth=150, clients=None),
        features=("advanced_tax", "ai", "outside_accountants"),
        highlights=(
            "Everything in Starter",
            "5 users, 150 issued invoices a month",
            "Purchases & GSTR-2B credit match, TDS on payments abroad",
            "Tally match, notices with drafted replies",
            "AI assistant, month review, statement and manifest reading",
            "Give your CA firm access",
        ),
    ),
    Plan(
        key="business",
        name="Business",
        audience="A larger exporter preparing for tax audit",
        monthlyInr=7999,
        yearlyInr=79990,
        monthlyUsd=99,
        yearlyUsd=990,
        limits=Limits(users=15, invoicesPerMonth=None, clients=None),
        features=("advanced_tax", "audit", "ai", "outside_accountants"),
        highlights=(
            "Everything in Growth",
            "15 users, unlimited invoices",
            "Automatic audit checks",
            "Form 3CD tax audit pack",
        ),
    ),
    Plan(
        key="ca_firm",
        name="CA Firm",
        audience="A chartered accountant firm serving exporters",
        monthlyInr=2499,
        yearlyInr=24990,
        monthlyUsd=29,
        yearlyUsd=290,
        limits=Limits(users=5, invoicesPerMonth=30, clients=25),
        features=("practice", "ai"),
        highlights=(
            "5 staff, up to 25 client companies",
            "Practice view: client health, time, fee bills",
            "Work inside each client's company on the client's own plan",
            "Requests and notices with each client",
        ),
    ),
]

# What a trial gets: everything, with Business limits.
TRIAL_PLAN = Plan(
    key="business",
    name="Free trial",
    audience="Every feature for 14 days",
    monthlyInr=0,
    yearlyInr=0,
    monthlyUsd=0,
    yearlyUsd=0,
    limits=Limits(users=15, invoicesPerMonth=None, clients=25),
    features=("advanced_tax", "audit", "ai", "outside_accountants", "practice"),
)

FEATURE_LABELS: dict[str, dict[str, str]] = {
    "advanced_tax": {"label": "Purchases & ITC, TDS, Tally match, and notices", "plan": "Growth"},
    "audit": {"label": "Audit checks and the tax audit pack", "plan": "Business"},
    "ai": {"label": "AI features", "plan": "Growth"},
    "outside_accountants": {"label": "Outside accountant access", "plan": "Growth"},
    "practice": {"label": "The practice tools", "plan": "CA Firm"},
}


def plan_by_key(key: str | None) -> Plan | None:
    return next((plan for plan in PLANS if plan.key == key), None)


def is_cycle(value: object) -> bool:
    return value in ("monthly", "yearly")


def price_for(plan: Plan, cycle: str) -> dict[str, int]:
    """Price before GST, GST, and the total charged, in rupees. Totals are rounded to the rupee."""
    base = plan.monthlyInr if cycle == "monthly" else plan.yearlyInr
    gst = int(base * GST_RATE + 0.5)  # Math.round for positive amounts
    return {"baseInr": base, "gstInr": gst, "totalInr": base + gst, "totalPaise": (base + gst) * 100}


def usd_price_for(plan: Plan, cycle: str) -> int:
    return plan.monthlyUsd if cycle == "monthly" else plan.yearlyUsd


def plan_json(plan: Plan) -> dict:
    data = asdict(plan)
    data["features"] = list(plan.features)
    data["highlights"] = list(plan.highlights)
    return data


def public_plans() -> list[dict]:
    """Each plan with its prices, as shown on the pricing page."""
    return [
        {
            **plan_json(plan),
            "prices": {"monthly": price_for(plan, "monthly"), "yearly": price_for(plan, "yearly")},
            "pricesUsd": {"monthly": usd_price_for(plan, "monthly"), "yearly": usd_price_for(plan, "yearly")},
            "yearlySavingInr": plan.monthlyInr * 12 - plan.yearlyInr,
        }
        for plan in PLANS
    ]


_FEATURE_PATHS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^/api/(purchases|foreign-payments|tally|notices)(/|$)"), "advanced_tax"),
    (re.compile(r"^/api/tax/(audit-checks|audit-pack)(/|$)"), "audit"),
    (re.compile(r"^/api/(assistant|parse-manifest|bank/parse-statement)(/|$)"), "ai"),
    (re.compile(r"^/api/team/accountants(/|$)"), "outside_accountants"),
    (re.compile(r"^/api/practice(/|$)"), "practice"),
]


def feature_for_path(path: str) -> str | None:
    """Which feature a request path needs. Reads are gated too, so a locked desk explains itself."""
    for pattern, feature in _FEATURE_PATHS:
        if pattern.match(path):
            return feature
    return None


def feature_uses_home_company(feature: str) -> bool:
    """Practice tools belong to the accountant's own firm, so they follow the firm's plan."""
    return feature == "practice"
