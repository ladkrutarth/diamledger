"""Rounding exactly as the JavaScript server did, so totals and CSVs come out identical.

Python's round() rounds halves to even and format() does the same on exact ties; Math.round and
toFixed round halves up. Money must not change by a cent between the two servers.
"""

from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal
from typing import Any


def js_number(value: Any) -> float:
    """Number(value) for the values the API sees: numbers, numeric strings, Decimals, None."""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            return float(text)
        except ValueError:
            return math.nan
    return math.nan


def js_round(value: float) -> float:
    """Math.round: the nearest integer, halves toward +infinity."""
    if not math.isfinite(value):
        return value
    whole = math.floor(value)
    # value - whole is exact; floor(value + 0.5) is not (0.49999999999999994 + 0.5 rounds to 1.0).
    return float(whole + 1 if value - whole >= 0.5 else whole)


def round_to(value: float, places: int) -> float:
    """Math.round(value * 10^places) / 10^places."""
    factor = 10**places
    return js_round(value * factor) / factor


def money(value: Any) -> float:
    """Math.round(Number(value) * 100) / 100."""
    return round_to(js_number(value), 2)


def to_fixed(value: float, places: int) -> str:
    """Number.prototype.toFixed: the exact binary value, rounded half up."""
    if not math.isfinite(value):
        return "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
    if value == 0:
        value = 0.0  # (-0).toFixed(2) is "0.00", but (-0.001).toFixed(2) is "-0.00"
    quantum = Decimal(1).scaleb(-places)
    return str(Decimal(value).quantize(quantum, rounding=ROUND_HALF_UP))


def plain(value: Any) -> Any:
    """Whole floats as ints, recursively, so JSON reads 550 rather than 550.0 (as JSON.stringify writes it)."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [plain(v) for v in value]
    return value


def usd(value: float) -> str:
    """Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}): $1,000.00, -$5.00."""
    amount = Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    sign = "-" if amount < 0 else ""
    return f"{sign}${abs(amount):,.2f}"


def js_string(value: Any) -> str:
    """String(value) in JavaScript, for the plain values the API handles."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        return repr(value)
    if isinstance(value, Decimal):
        return js_string(float(value))
    if isinstance(value, list):
        return ",".join("" if v is None else js_string(v) for v in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


class _Undefined:
    """A value to leave out of JSON, as JSON.stringify leaves out undefined."""

    def __repr__(self) -> str:
        return "UNDEFINED"


UNDEFINED: Any = _Undefined()


def js_json(value: Any, indent: int | None = None) -> str:
    """JSON.stringify(value, null, indent): whole numbers without .0, UNDEFINED keys left out, Unicode kept."""
    import json

    def clean(item: Any) -> Any:
        if isinstance(item, dict):
            return {k: clean(v) for k, v in item.items() if v is not UNDEFINED}
        if isinstance(item, (list, tuple)):
            return [None if v is UNDEFINED else clean(v) for v in item]
        return plain(item)

    return json.dumps(clean(value), indent=indent, ensure_ascii=False)
