"""The invoice body (port of server/modules/invoices/invoiceSchema.ts, zod → Pydantic).

The same rules as before: text lengths, numbers that may arrive as strings (blank or null means 0),
line total = carats × rate per carat to the cent, at most 500 lines, USD only. Unknown keys are
dropped. The shape must match `InvoiceState` in src/types/invoice.ts.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, StrictStr, ValidationError, model_validator

from ...core.numbers import plain, round_to


def _to_number(value: Any) -> Any:
    """zod's preprocess: null or '' → 0; a non-blank string → Number(string); anything else as given."""
    if value is None or value == "":
        return 0
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            raise ValueError("Expected a number") from None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Expected a number")
    return value


def _finite(value: float) -> float:
    if not math.isfinite(value):
        raise ValueError("Expected a finite number")
    return value


def _whole(value: Any) -> Any:
    value = _to_number(value)
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError("Expected a whole number")
        return int(value)
    return value


def Text(max_length: int = 500):
    return Annotated[StrictStr, Field(max_length=max_length)]


def Amount(maximum: float = 1e12):
    return Annotated[float, BeforeValidator(_to_number), AfterValidator(_finite), Field(ge=0, le=maximum)]


def Count(maximum: int = 1_000_000):
    return Annotated[int, BeforeValidator(_whole), Field(ge=0, le=maximum)]


_HS_CODE = re.compile(r"^[0-9.]{0,12}$")


def _hs_code(value: str) -> str:
    value = value.strip()
    if not _HS_CODE.match(value):
        raise ValueError("HS code may only contain digits and dots")
    return value


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Exporter(_Model):
    companyName: Text(200)
    addressLine1: Text()
    addressLine2: Text()
    city: Text(100)
    state: Text(100)
    stateCode: Text(10)
    pincode: Text(20)
    country: Text(100)
    iec: Text(20)
    gstin: Text(20)
    pan: Text(20)
    rcmcNo: Text(100)
    email: Text(320)
    phone: Text(50)


class Consignee(_Model):
    companyName: Text(200)
    addressLine1: Text()
    addressLine2: Text()
    city: Text(100)
    state: Text(100)
    country: Text(100)
    postalCode: Text(20)
    taxIdVat: Text(100)
    contactPerson: Text(200)
    email: Text(320)
    phone: Text(50)
    buyerOtherThanConsignee: StrictBool
    buyerName: Text(200) = None  # type: ignore[assignment]  # optional: absent, never null
    buyerAddress: Text(1000) = None  # type: ignore[assignment]
    buyerCountry: Text(100) = None  # type: ignore[assignment]
    buyerTaxId: Text(100) = None  # type: ignore[assignment]


class Shipment(_Model):
    invoiceNumber: Text(200)
    invoiceDate: Text(20)
    exporterRef: Text(200)
    buyerOrderRef: Text(200)
    kpcsNumber: Text(200)
    lutNumber: Text(200)
    incoterms: Literal["CIF", "FOB", "C&F", "DAP", "EXW"]
    incotermLocation: Text(200)
    paymentTerms: Text()
    creditDays: Count(365) = 30
    portOfLoading: Text(200)
    portOfDischarge: Text(200)
    countryOfOrigin: Text(100)
    countryOfDestination: Text(100)
    carrierName: Text(200)
    flightNumber: Text(100)
    awbNumber: Text(100)
    insurancePolicyNo: Text(200) = None  # type: ignore[assignment]

    @model_validator(mode="before")
    @classmethod
    def _credit_days_default(cls, data: Any) -> Any:
        # Set explicitly so it is kept when unset fields are dropped.
        if isinstance(data, dict) and data.get("creditDays", ...) is ...:
            data = {**data, "creditDays": 30}
        return data


class Bank(_Model):
    bankName: Text(200)
    branch: Text(200)
    accountNumber: Text(50)
    adCode: Text(50)
    swiftCode: Text(20)
    ifscCode: Text(20)
    iban: Text(50) = None  # type: ignore[assignment]
    correspondentBank: Text(200) = None  # type: ignore[assignment]
    correspondentSwift: Text(20) = None  # type: ignore[assignment]


class Packing(_Model):
    vaultBoxNo: Text(100)
    tamperSealNo: Text(100)
    packageDimensions: Text(100)
    numberOfPackages: Count(10_000)
    tareWeightGrams: Amount(1e7)
    grossWeightGrams: Amount(1e7)
    securityBagNo: Text(100)


class Item(_Model):
    id: Text(100)
    srNo: Count(10_000)
    description: Text(1000)
    shape: Text(100) = None  # type: ignore[assignment]
    colorClarity: Text(100) = None  # type: ignore[assignment]
    cutGrade: Text(100) = None  # type: ignore[assignment]
    hsCode: Annotated[StrictStr, AfterValidator(_hs_code)]
    certificateNo: Text(200)
    parcelId: Text(200)
    pieces: Count()
    carats: Amount(1e6)
    ratePerCarat: Amount(1e9)
    totalAmount: Amount()

    @model_validator(mode="after")
    def _total_matches(self) -> "Item":
        if abs(self.totalAmount - self.carats * self.ratePerCarat) > 0.01:
            raise _LineTotalError()
        return self


class _LineTotalError(ValueError):
    def __init__(self) -> None:
        super().__init__("Total amount must equal carats × rate per carat")


class Declarations(_Model):
    kimberleyClause: StrictBool
    naturalDiamondAffirmation: StrictBool
    gjepcOriginClause: StrictBool
    lutSupplyClause: StrictBool


class Invoice(_Model):
    exporter: Exporter
    consignee: Consignee
    shipment: Shipment
    bank: Bank
    packing: Packing
    items: Annotated[list[Item], Field(max_length=500)]
    currency: Literal["USD"]
    exchangeRateInr: Annotated[float, BeforeValidator(_to_number), AfterValidator(_finite), Field(gt=0, le=10_000)]
    freightUsd: Amount()
    insuranceUsd: Amount()
    otherChargesUsd: Amount()
    declarations: Declarations
    authorizedSignatoryName: Text(200)
    authorizedSignatoryDesignation: Text(200)


# --- Errors in the words the Node server used ------------------------------------------------------

_MESSAGES = {
    "missing": "Required",
    "string_type": "Expected text",
    "bool_type": "Expected true or false",
    "model_type": "Expected an object",
    "dict_type": "Expected an object",
    "list_type": "Expected a list",
    "literal_error": "Invalid option",
    "greater_than": "Must be more than {gt}",
    "greater_than_equal": "Must be {ge} or more",
    "less_than_equal": "Must be {le} or less",
    "string_too_long": "Too long: at most {max_length} characters",
    "too_long": "Too many",
    "int_from_float": "Expected a whole number",
}


def _describe(error: dict) -> str:
    location = " › ".join(
        f"line {part + 1}" if isinstance(part, int) else str(part) for part in error["loc"]
    )
    kind = error["type"]
    if kind == "value_error":
        message = str(error.get("ctx", {}).get("error") or error["msg"])
    elif kind == "too_long" and error["loc"] == ("items",):
        message = "An invoice can have at most 500 lines"
    elif kind in _MESSAGES:
        message = _MESSAGES[kind].format(**{k: plain(v) for k, v in (error.get("ctx") or {}).items()})
    else:
        message = error["msg"]
    if isinstance(error.get("ctx", {}).get("error"), _LineTotalError):
        location = f"{location} › totalAmount" if location else "totalAmount"
    return f"{location}: {message}" if location else message


@dataclass(frozen=True)
class InvoiceParseResult:
    ok: bool
    invoice: dict | None = None
    error: str | None = None


def validate_invoice(value: Any) -> InvoiceParseResult:
    """The checked invoice as a plain dict (unknown keys dropped, numbers converted), or the first 3 problems."""
    try:
        parsed = Invoice.model_validate(value)
    except ValidationError as error:
        issues = [_describe(e) for e in error.errors(include_url=False)[:3]]
        return InvoiceParseResult(ok=False, error=f"Invoice data is invalid. {'; '.join(issues)}.")
    return InvoiceParseResult(ok=True, invoice=plain(parsed.model_dump(exclude_unset=True)))


# --- Facts kept in columns for lists and the dashboard ---------------------------------------------

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def invoice_facts(invoice: dict) -> dict:
    items = invoice["items"]
    items_total = 0.0
    for item in items:
        items_total += item["totalAmount"]
    total_usd = items_total + invoice["freightUsd"] + invoice["insuranceUsd"] + invoice["otherChargesUsd"]
    total_carats = 0.0
    for item in items:
        total_carats += item["carats"]
    shipment, consignee = invoice["shipment"], invoice["consignee"]
    raw_date = shipment["invoiceDate"].strip()
    return {
        "invoiceNumber": shipment["invoiceNumber"].strip(),
        "buyerName": consignee["companyName"].strip(),
        "destinationCountry": shipment["countryOfDestination"].strip() or consignee["country"].strip(),
        "invoiceDate": raw_date if _ISO_DATE.match(raw_date) else None,
        "creditDays": shipment["creditDays"],
        "totalUsd": round_to(total_usd, 2),
        "totalCarats": round_to(total_carats, 3),
    }
