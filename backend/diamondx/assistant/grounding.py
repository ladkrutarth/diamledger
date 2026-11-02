"""Every money amount in a model's reply must appear in the facts it was given (from server/assistant/agent.ts)."""

from __future__ import annotations

import re
from typing import Any

from ..core.numbers import js_number, round_to

MONEY = re.compile(
    r"(?:\$|₹\s*|\b(?:USD|INR|Rs\.?)\s*)(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:USD|US dollars|dollars|INR|rupees)\b",
    re.IGNORECASE | re.ASCII,
)
NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?", re.ASCII)


def money_amounts(text: str) -> list[float]:
    amounts = []
    for match in MONEY.finditer(text):
        value = js_number((match.group(1) or match.group(2)).replace(",", ""))
        if value == value and value not in (float("inf"), float("-inf")):
            amounts.append(value)
    return amounts


def _numbers_in(value: Any, into: set[float]) -> set[float]:
    if isinstance(value, bool):
        return into
    if isinstance(value, (int, float)):
        into.add(round_to(abs(float(value)), 2))
    elif isinstance(value, str):
        for match in NUMBER.finditer(value):
            into.add(round_to(js_number(match.group(0).replace(",", "")), 2))
    elif isinstance(value, (list, tuple)):
        for item in value:
            _numbers_in(item, into)
    elif isinstance(value, dict):
        for item in value.values():
            _numbers_in(item, into)
    return into


def is_grounded(reply: str, tool_results: list[Any]) -> bool:
    amounts = money_amounts(reply)
    if not amounts:
        return True
    known = _numbers_in(tool_results, set())
    return all(round_to(amount, 2) in known for amount in amounts)
