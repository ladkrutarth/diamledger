"""Closed months lock data dated in them (from server/modules/tax/closedMonths.ts).

The close and reopen routes are still served by Node.
"""

from __future__ import annotations

import re
from datetime import date

from ...core.db import Pool

_MONTH = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


def parse_month(value: object) -> str | None:
    return value if isinstance(value, str) and _MONTH.match(value) else None


def month_of(invoice_date: str | None) -> str | None:
    return parse_month(invoice_date[:7]) if invoice_date else None


async def closed_month_message(pool: Pool, organization_id: str, invoice_date: str | None) -> str | None:
    month = month_of(invoice_date)
    if not month:
        return None
    year, mon = (int(part) for part in month.split("-"))
    found = await pool.fetchval(
        "SELECT 1 FROM closed_months WHERE organization_id = $1 AND month = $2",
        organization_id,
        date(year, mon, 1),
    )
    if not found:
        return None
    return f"The books for {month} are closed. A chartered accountant has to reopen that month before this invoice can change."
