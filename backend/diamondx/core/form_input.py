"""Readers for JSON request bodies (port of server/core/formInput.ts) and date helpers."""

from __future__ import annotations

import math
import re
from datetime import date, datetime, timezone
from typing import Any, Sequence

from .http import ApiError


class FormError(ApiError):
    """A message the user can act on, answered with status 400."""

    def __init__(self, message: str) -> None:
        super().__init__(400, message)


_ISO_DATE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")
_DMY_DATE = re.compile(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$")


def parse_loose_date(value: str | None) -> str | None:
    """2026-04-01, 1-4-2026, 01/04/2026 or 1.4.2026 as 2026-04-01; None when it is not a real date."""
    raw = (value or "").strip()
    match = _ISO_DATE.match(raw)
    if match:
        year, month, day = (int(g) for g in match.groups())
    else:
        match = _DMY_DATE.match(raw)
        if not match:
            return None
        day, month, year = (int(g) for g in match.groups())
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def _js_round(value: float) -> float:
    """Math.round: halves go up, also for negative numbers."""
    return math.floor(value + 0.5)


class FormReader:
    def __init__(self, value: Any) -> None:
        self.raw: dict[str, Any] = value if isinstance(value, dict) else {}

    def text(self, key: str, max_length: int = 500) -> str:
        raw = self.raw.get(key)
        if isinstance(raw, bool):
            return ""
        if isinstance(raw, (int, float)):
            return _js_number_string(raw)[:max_length]
        return raw.strip()[:max_length] if isinstance(raw, str) else ""

    def required(self, key: str, message: str, max_length: int = 500) -> str:
        found = self.text(key, max_length)
        if not found:
            raise FormError(message)
        return found

    def number(
        self,
        key: str,
        message: str,
        *,
        min: float | None = None,
        max: float | None = None,
        optional: bool = False,
        places: int = 2,
    ) -> float | None:
        raw = self.raw.get(key)
        if raw is None or raw == "":
            if optional:
                return None
            raise FormError(message)
        if isinstance(raw, bool):
            parsed = float(raw)
        else:
            try:
                parsed = float(raw.replace(",", "").strip() or "0") if isinstance(raw, str) else float(raw)
            except (TypeError, ValueError):
                raise FormError(message) from None
        if not math.isfinite(parsed):
            raise FormError(message)
        if min is not None and parsed < min:
            raise FormError(message)
        if max is not None and parsed > max:
            raise FormError(message)
        factor = 10**places
        return _js_round(parsed * factor) / factor

    def date(self, key: str, message: str, optional: bool = False) -> str | None:
        raw = self.text(key, 20)
        if not raw:
            if optional:
                return None
            raise FormError(message)
        parsed = parse_loose_date(raw)
        if not parsed:
            raise FormError(message)
        return parsed

    def flag(self, key: str) -> bool:
        return self.raw.get(key) is True or self.raw.get(key) == "true"

    def choice(self, key: str, options: Sequence[str], fallback: str | None = None) -> str:
        raw = self.text(key, 50)
        if raw in options:
            return raw
        if fallback is not None:
            return fallback
        raise FormError(f"Choose one of: {', '.join(options)}.")


def form_reader(value: Any) -> FormReader:
    return FormReader(value)


def _js_number_string(value: float) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def document_key(value: str) -> str:
    """Upper case letters and digits only, without leading zeros in a number, so "INV/007" matches "inv-7"."""
    cleaned = re.sub(r"[^A-Z0-9]", "", value.upper())
    return re.sub(r"(^|[A-Z])0+(?=[0-9])", r"\1", cleaned)


def iso_today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def financial_year_dates(token: str) -> dict[str, str] | None:
    """Start and end dates of an Indian financial year written as 2026-27."""
    match = re.match(r"^(\d{4})-(\d{2})$", token)
    if not match:
        return None
    start_year = int(match.group(1))
    if int(match.group(2)) != (start_year + 1) % 100:
        return None
    return {"start": f"{start_year}-04-01", "end": f"{start_year + 1}-03-31", "label": token}


def current_financial_year(today: date | None = None) -> str:
    today = today or date.today()
    start_year = today.year if today.month >= 4 else today.year - 1
    return f"{start_year}-{(start_year + 1) % 100:02d}"


def days_between(start: str, end: str) -> int:
    return (date.fromisoformat(end) - date.fromisoformat(start)).days
