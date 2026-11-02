"""Which ways to pay are switched on, from environment variables (port of server/modules/billing/providers.ts).

Card numbers, UPI PINs, and bank passwords never reach this server: cards, UPI and net banking are entered
on Razorpay's page, and PayPal on PayPal's.
"""

from __future__ import annotations

import os


def razorpay_configured() -> bool:
    return bool(os.environ.get("RAZORPAY_KEY_ID") and os.environ.get("RAZORPAY_KEY_SECRET"))


def seller_bank_account() -> dict | None:
    """The account customers pay into by NEFT, RTGS or IMPS. On when the account number and IFSC are set."""

    def env(key: str) -> str:
        return (os.environ.get(key) or "").strip()

    account = {
        "accountName": env("BILLING_BANK_ACCOUNT_NAME"),
        "bankName": env("BILLING_BANK_NAME"),
        "accountNumber": env("BILLING_BANK_ACCOUNT_NUMBER"),
        "ifsc": env("BILLING_BANK_IFSC").upper(),
        "branch": env("BILLING_BANK_BRANCH"),
        "accountType": env("BILLING_BANK_ACCOUNT_TYPE") or "Current",
        "gstin": env("BILLING_GSTIN"),
    }
    return account if account["accountNumber"] and account["ifsc"] else None


def paypal_configured() -> bool:
    return bool(os.environ.get("PAYPAL_CLIENT_ID") and os.environ.get("PAYPAL_CLIENT_SECRET"))


def is_platform_admin(email: str) -> bool:
    """Email addresses of the people who run this site and approve bank transfers."""
    admins = [v.strip().lower() for v in (os.environ.get("PLATFORM_ADMIN_EMAILS") or "").split(",") if v.strip()]
    return email.strip().lower() in admins


def payment_options() -> dict[str, bool]:
    razorpay = razorpay_configured()
    return {"upi": razorpay, "card": razorpay, "netbanking": razorpay, "bankTransfer": bool(seller_bank_account()), "paypal": paypal_configured()}
