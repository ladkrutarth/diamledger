"""Subscription state, plan limits and the subscription guard (from server/modules/billing/billing.ts).

The billing routes (checkout, Razorpay webhook, PayPal, bank transfer) are still served by Node.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from ...core.db import Pool
from ...core.http import ApiError, CurrentUser
from .plans import FEATURE_LABELS, GRACE_DAYS, TRIAL_DAYS, TRIAL_PLAN, Plan, feature_for_path, feature_uses_home_company, plan_by_key

Access = Literal["trial", "active", "grace", "lapsed"]
LIVE_STATUSES = {"active", "authenticated", "pending", "halted"}
DAY = timedelta(days=1)


async def load_subscription(pool: Pool, organization_id: str):
    """The company's subscription, starting a free trial the first time a company is seen."""
    row = await pool.fetchrow("SELECT * FROM organization_subscriptions WHERE organization_id = $1", organization_id)
    if row:
        return row
    await pool.execute(
        """INSERT INTO organization_subscriptions (organization_id, trial_ends_at)
           VALUES ($1, now() + make_interval(days => $2)) ON CONFLICT (organization_id) DO NOTHING""",
        organization_id,
        TRIAL_DAYS,
    )
    return await pool.fetchrow("SELECT * FROM organization_subscriptions WHERE organization_id = $1", organization_id)


@dataclass(frozen=True)
class AccessInfo:
    access: Access
    plan: Plan
    days_left: int | None


def _days_until(moment: datetime, now: datetime) -> int:
    return math.ceil((moment - now) / DAY)


def access_of(row, now: datetime | None = None) -> AccessInfo:
    """A paid plan works until its period ends, then GRACE_DAYS while a charge is retried, then read-only."""
    now = now or datetime.now(timezone.utc)
    if row["plan_key"] == "trial":
        days_left = _days_until(row["trial_ends_at"], now)
        return AccessInfo("trial" if days_left > 0 else "lapsed", TRIAL_PLAN, max(days_left, 0))
    plan = plan_by_key(row["plan_key"]) or TRIAL_PLAN
    end = row["current_period_end"]
    if not end:
        return AccessInfo("active" if row["status"] in LIVE_STATUSES else "lapsed", plan, None)
    days_left = _days_until(end, now)
    if now <= end:
        return AccessInfo("active", plan, days_left)
    if row["status"] in LIVE_STATUSES and now <= end + GRACE_DAYS * DAY:
        return AccessInfo("grace", plan, days_left)
    return AccessInfo("lapsed", plan, days_left)


async def usage_of(pool: Pool, organization_id: str) -> dict[str, int]:
    row = await pool.fetchrow(
        """SELECT (SELECT COUNT(*) FROM users WHERE organization_id = $1) AS users,
                  (SELECT COUNT(*) FROM invoices WHERE organization_id = $1 AND issued_at >= date_trunc('month', now())) AS invoices,
                  (SELECT COUNT(DISTINCT a.organization_id) FROM organization_access a JOIN users u ON u.id = a.user_id
                    WHERE u.organization_id = $1) AS clients""",
        organization_id,
    )
    return {"users": row["users"], "invoicesThisMonth": row["invoices"], "clients": row["clients"]}


async def limit_message(pool: Pool, organization_id: str, kind: Literal["users", "invoices", "clients"]) -> str | None:
    """A message when adding one more would go over the plan, or None when it fits."""
    plan = access_of(await load_subscription(pool, organization_id)).plan
    usage = await usage_of(pool, organization_id)
    limits = plan.limits
    if kind == "users" and usage["users"] >= limits.users:
        return f"The {plan.name} plan allows {limits.users} users. Upgrade under Plan & billing to add more."
    if kind == "invoices" and limits.invoicesPerMonth is not None and usage["invoicesThisMonth"] >= limits.invoicesPerMonth:
        return (
            f"The {plan.name} plan allows {limits.invoicesPerMonth} issued invoices a month, and this month's are used. "
            "Upgrade under Plan & billing, or issue it next month."
        )
    if kind == "clients" and usage["clients"] >= (limits.clients or 0):
        if limits.clients:
            return f"That accountant's plan allows {limits.clients} client companies, and they are all in use."
        return "That accountant's firm is not on the CA Firm plan, so it cannot take client companies yet."
    return None


_ALWAYS_ALLOWED = re.compile(r"^/api/(auth|billing|health|workspace|platform)(/|$)")
READ_METHODS = {"GET", "HEAD", "OPTIONS"}


async def check_subscription(pool: Pool, method: str, path: str, user: CurrentUser | None) -> None:
    """Read-only once the plan lapses; locks features the plan does not include."""
    if not user or not path.startswith("/api/") or _ALWAYS_ALLOWED.match(path):
        return
    own = access_of(await load_subscription(pool, user.organization_id))
    if own.access == "lapsed" and method not in READ_METHODS:
        ended = "The free trial has ended" if own.plan is TRIAL_PLAN else "The subscription has ended"
        who = "Choose a plan under Plan & billing" if user.role == "admin" else "Ask a company admin to choose a plan"
        raise ApiError(
            402,
            f"{ended}, so this company is read-only. {who} to keep working. Your data is safe and can still be viewed and downloaded.",
            code="subscription_lapsed",
        )
    feature = feature_for_path(path)
    if feature:
        checked = (
            access_of(await load_subscription(pool, user.home_organization_id))
            if feature_uses_home_company(feature) and user.home_organization_id != user.organization_id
            else own
        )
        if feature not in checked.plan.features:
            label, plan_name = FEATURE_LABELS[feature]["label"], FEATURE_LABELS[feature]["plan"]
            verb = "are" if label.endswith("s") else "is"
            raise ApiError(402, f"{label} {verb} on the {plan_name} plan. Upgrade under Plan & billing.", code="plan_feature", feature=feature)
