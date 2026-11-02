"""Encryption for secrets kept in the database, such as a company's own Razorpay key secret.

The key comes from ENCRYPTION_KEY: any long random string (for example `openssl rand -base64 32`). It is
stretched with HKDF into a Fernet key (AES-128-CBC with an HMAC-SHA256 tag), so a tampered or wrong-key
value fails to decrypt instead of returning garbage. Changing ENCRYPTION_KEY makes stored secrets
unreadable: companies then have to enter their keys again.
"""

from __future__ import annotations

import base64
import os

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MIN_KEY_LENGTH = 32


class SecretUnavailableError(Exception):
    """ENCRYPTION_KEY is missing, or a stored secret was written with a different key."""


def encryption_ready() -> bool:
    return len(os.environ.get("ENCRYPTION_KEY", "").strip()) >= MIN_KEY_LENGTH


def _fernet() -> Fernet:
    secret = os.environ.get("ENCRYPTION_KEY", "").strip()
    if len(secret) < MIN_KEY_LENGTH:
        raise SecretUnavailableError(f"Set ENCRYPTION_KEY (at least {MIN_KEY_LENGTH} characters) to store payment keys.")
    derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"diamondx-secrets-v1").derive(secret.encode())
    return Fernet(base64.urlsafe_b64encode(derived))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        raise SecretUnavailableError("A stored payment key could not be read. Enter the Razorpay keys again.") from None
