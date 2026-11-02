"""Two-step sign-in: after the password, a code from an authenticator app (TOTP, RFC 6238) or a code texted to
the user's phone. One-time recovery codes cover a lost phone.

Sign-in with two-step on: the password check leaves the session *pending* (`twoFactorUserId`, no `userId`), so
nothing but this module's `/verify` and `/sms` can use it. A right code regenerates the session with `userId`.
Wrong codes are limited per pending session (then the password is asked again) and per account across all
sessions and addresses, so guessing a 6-digit code is not practical even with the password.

Secrets: the app's shared secret is encrypted with ENCRYPTION_KEY; texted codes are stored as an HMAC with the
session secret; recovery codes as SHA-256. A TOTP code is accepted once (the last used 30-second step is kept).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import struct
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode
from uuid import uuid4

import segno
from fastapi import Depends, Request

from ...core.context import api_router
from ...core.crypto import SecretUnavailableError, decrypt_secret, encrypt_secret, encryption_ready
from ...core.db import Pool
from ...core.http import ApiError, CurrentUser, body, require_user
from ...core.rate_limit import increment
from ...core.settings import session_secret
from ...core.sms import SmsError, mask_phone
from .users import check_password, find_user, public_user, read_password, to_current_user

ISSUER = "Meridian"
STEP_SECONDS = 30
PENDING_SECONDS = 10 * 60  # time to enter the code after the password
SESSION_FAILS = 5  # wrong codes per pending session before the password is asked again
ACCOUNT_FAILS = 10  # wrong codes per account per window, across every session and address
ACCOUNT_WINDOW_SECONDS = 15 * 60
SMS_TTL = timedelta(minutes=10)
SMS_ATTEMPTS = 5
SMS_PER_HOUR = 5
SMS_GAP_SECONDS = 30
RECOVERY_COUNT = 10
RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/l/i


# --- TOTP --------------------------------------------------------------------------------------------------

def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def hotp(secret: str, counter: int, digits: int = 6) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    number = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(number % 10**digits).zfill(digits)


def totp_now(secret: str, at: float | None = None) -> str:
    return hotp(secret, int((time.time() if at is None else at) // STEP_SECONDS))


def totp_match(secret: str, code: str, at: float | None = None) -> int | None:
    """The time step `code` belongs to, allowing one step of clock drift either way; None if it matches none."""
    current = int((time.time() if at is None else at) // STEP_SECONDS)
    for step in (current - 1, current, current + 1):
        if hmac.compare_digest(hotp(secret, step), code):
            return step
    return None


def otpauth_url(secret: str, email: str) -> str:
    label = quote(f"{ISSUER}:{email}", safe="@:")
    return f"otpauth://totp/{label}?" + urlencode({"secret": secret, "issuer": ISSUER, "algorithm": "SHA1", "digits": 6, "period": STEP_SECONDS})


def qr_code(url: str) -> str:
    """An SVG data URI of the QR code (the CSP allows data: images)."""
    return segno.make(url, error="m").svg_data_uri(scale=5, border=2)


# --- Recovery and texted codes ----------------------------------------------------------------------------

def normalize_code(value) -> str:
    return re.sub(r"[\s-]", "", value).lower() if isinstance(value, str) else ""


def new_recovery_codes() -> list[str]:
    codes = []
    for _ in range(RECOVERY_COUNT):
        raw = "".join(secrets.choice(RECOVERY_ALPHABET) for _ in range(10))
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


def hash_recovery(code: str) -> str:
    return hashlib.sha256(normalize_code(code).encode()).hexdigest()


def hash_texted(code_id: str, code: str) -> str:
    return hmac.new(session_secret().encode(), f"{code_id}:{code}".encode(), hashlib.sha256).hexdigest()


def normalize_phone(value) -> str | None:
    """E.164 (+919812345678). A bare 10-digit Indian mobile number gets +91."""
    if not isinstance(value, str):
        return None
    phone = re.sub(r"[\s().-]", "", value)
    if phone.startswith("00"):
        phone = "+" + phone[2:]
    if re.fullmatch(r"0?[6-9]\d{9}", phone):
        phone = "+91" + phone[-10:]
    return phone if re.fullmatch(r"\+[1-9]\d{7,14}", phone) else None


# --- State ---------------------------------------------------------------------------------------------------

async def load_two_factor(pool: Pool, user_id: str):
    return await pool.fetchrow("SELECT * FROM user_two_factor WHERE user_id = $1", user_id)


def two_factor_on(row) -> bool:
    return bool(row and (row["totp_secret_encrypted"] or row["phone"]))


def sign_in_methods(row) -> list[str]:
    methods = []
    if row and row["totp_secret_encrypted"]:
        methods.append("app")
    if row and row["phone"]:
        methods.append("sms")
    if methods and row["recovery_codes"]:
        methods.append("recovery")
    return methods


def status_json(request: Request, row) -> dict:
    return {
        "enabled": two_factor_on(row),
        "app": bool(row and row["totp_secret_encrypted"]),
        "phone": mask_phone(row["phone"]) if row and row["phone"] else None,
        "recoveryCodesLeft": len(row["recovery_codes"]) if row else 0,
        "appAvailable": encryption_ready(),
        "smsAvailable": request.app.state.options.sms.available(),
    }


async def start_pending_sign_in(request: Request, user_id: str, row) -> dict:
    """Called by /login after a right password when two-step is on. The session stays signed out."""
    await request.app.state.sessions.regenerate(request.state.session, twoFactorUserId=user_id, twoFactorAt=time.time(), twoFactorFails=0)
    return {"twoFactorRequired": True, "methods": sign_in_methods(row), "phoneHint": mask_phone(row["phone"]) if row["phone"] else None}


def _pending_user_id(request: Request) -> str:
    data = request.state.session.data
    user_id, started = data.get("twoFactorUserId"), data.get("twoFactorAt")
    if not isinstance(user_id, str) or not isinstance(started, (int, float)) or time.time() - started > PENDING_SECONDS:
        raise ApiError(401, "Your sign-in timed out. Enter your email and password again.", code="two_factor_expired")
    return user_id


async def send_texted_code(request: Request, user_id: str, purpose: str, phone: str) -> None:
    pool: Pool = request.app.state.pool
    recent = await pool.fetchrow(
        """SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour') AS last_hour,
                  COALESCE(MAX(created_at) > now() - make_interval(secs => $2), false) AS too_soon
           FROM two_factor_codes WHERE user_id = $1""",
        user_id, float(SMS_GAP_SECONDS),
    )
    if recent["too_soon"]:
        raise ApiError(429, f"A code was just sent. Wait {SMS_GAP_SECONDS} seconds before asking for another.")
    if recent["last_hour"] >= SMS_PER_HOUR:
        raise ApiError(429, "Too many codes sent in the last hour. Use your authenticator app or a recovery code, or try again later.")
    code, code_id = f"{secrets.randbelow(10**6):06d}", str(uuid4())
    # Only the newest code works.
    await pool.execute("UPDATE two_factor_codes SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL", user_id, purpose)
    await pool.execute(
        "INSERT INTO two_factor_codes (id, user_id, purpose, phone, code_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
        code_id, user_id, purpose, phone, hash_texted(code_id, code), datetime.now(timezone.utc) + SMS_TTL,
    )
    try:
        await request.app.state.options.sms.send(phone, f"{code} is your {ISSUER} verification code. It expires in 10 minutes. Never share it with anyone.")
    except SmsError as error:
        await pool.execute("DELETE FROM two_factor_codes WHERE id = $1", code_id)
        raise ApiError(502, str(error)) from None


async def accept_texted_code(pool: Pool, user_id: str, purpose: str, code: str, phone: str) -> bool:
    row = await pool.fetchrow(
        """UPDATE two_factor_codes SET attempts = attempts + 1
           WHERE id = (SELECT id FROM two_factor_codes WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
                       ORDER BY created_at DESC LIMIT 1)
             AND attempts < $3
           RETURNING id, phone, code_hash""",
        user_id, purpose, SMS_ATTEMPTS,
    )
    if not row or row["phone"] != phone or not hmac.compare_digest(hash_texted(row["id"], code), row["code_hash"]):
        return False
    return await pool.fetchval("UPDATE two_factor_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING true", row["id"]) is True


async def accept_app_code(pool: Pool, user_id: str, secret: str, code: str) -> bool:
    step = totp_match(secret, code)
    if step is None:
        return False
    # Each code works once: the step must be later than the last one used.
    return await pool.fetchval(
        "UPDATE user_two_factor SET totp_last_step = $2 WHERE user_id = $1 AND totp_last_step < $2 RETURNING true", user_id, step
    ) is True


async def check_sign_in_code(pool: Pool, user_id: str, row, value) -> str | None:
    """The method a sign-in code was right for ("app", "sms", "recovery"), or None."""
    code = normalize_code(value)
    if re.fullmatch(r"\d{6}", code):
        if row["totp_secret_encrypted"]:
            try:
                if await accept_app_code(pool, user_id, decrypt_secret(row["totp_secret_encrypted"]), code):
                    return "app"
            except SecretUnavailableError:
                pass  # The key changed; the phone or a recovery code still works.
        if row["phone"] and await accept_texted_code(pool, user_id, "sign_in", code, row["phone"]):
            return "sms"
        return None
    if re.fullmatch(r"[a-z0-9]{10}", code):
        used = await pool.fetchval(
            """UPDATE user_two_factor SET recovery_codes = array_remove(recovery_codes, $2), updated_at = now()
               WHERE user_id = $1 AND $2 = ANY(recovery_codes) RETURNING true""",
            user_id, hash_recovery(code),
        )
        return "recovery" if used else None
    return None


async def _account_locked(pool: Pool, user_id: str) -> bool:
    hits = await pool.fetchval("SELECT hits FROM rate_limits WHERE key = $1 AND reset_at > now()", f"two-factor:{user_id}")
    return (hits or 0) >= ACCOUNT_FAILS


async def _confirm_password(pool: Pool, user: CurrentUser, data: dict) -> None:
    row = await find_user(pool, "id", user.id)
    if not row or not await check_password(read_password(data.get("password")), row["password_hash"]):
        raise ApiError(400, "Your password is not right.")


async def _ensure_row(pool: Pool, user_id: str) -> None:
    await pool.execute("INSERT INTO user_two_factor (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", user_id)


async def _turned_on(request: Request, user: CurrentUser, was_on: bool) -> list[str] | None:
    """After a method is confirmed: the first time two-step comes on, recovery codes are made and every other
    session of the user is signed out. Returns the new codes (shown once) or None."""
    if was_on:
        return None
    pool: Pool = request.app.state.pool
    codes = new_recovery_codes()
    await pool.execute(
        "UPDATE user_two_factor SET recovery_codes = $2, updated_at = now() WHERE user_id = $1", user.id, [hash_recovery(c) for c in codes]
    )
    await pool.execute("DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2", user.id, request.state.session.sid or "")
    return codes


async def _after_removal(pool: Pool, user_id: str) -> None:
    """With no method left, two-step is off and the recovery codes go too."""
    await pool.execute(
        """UPDATE user_two_factor SET recovery_codes = '{}'
           WHERE user_id = $1 AND totp_secret_encrypted IS NULL AND phone IS NULL""",
        user_id,
    )


def build_router():
    router = api_router(prefix="/api/auth/two-factor")

    # --- Signing in (pending session, no user yet) --------------------------------------------------------

    @router.post("/sms")
    async def send_sign_in_text(request: Request):
        user_id = _pending_user_id(request)
        row = await load_two_factor(request.app.state.pool, user_id)
        if not row or not row["phone"]:
            raise ApiError(400, "There is no phone on this account. Use your authenticator app or a recovery code.")
        if not request.app.state.options.sms.available():
            raise ApiError(503, "Text messages are not available right now. Use your authenticator app or a recovery code.")
        await send_texted_code(request, user_id, "sign_in", row["phone"])
        return {"sent": True, "phoneHint": mask_phone(row["phone"])}

    @router.post("/verify")
    async def verify(request: Request):
        pool: Pool = request.app.state.pool
        store, session = request.app.state.sessions, request.state.session
        user_id = _pending_user_id(request)
        row = await load_two_factor(pool, user_id)
        user = await find_user(pool, "id", user_id)
        if not user or not two_factor_on(row):
            await store.destroy(session)
            raise ApiError(401, "Enter your email and password again.", code="two_factor_expired")
        if await _account_locked(pool, user_id):
            raise ApiError(429, "Too many wrong codes for this account. Wait 15 minutes, then try again.")

        method = await check_sign_in_code(pool, user_id, row, body(request).get("code"))
        if not method:
            await increment(pool, f"two-factor:{user_id}", ACCOUNT_WINDOW_SECONDS)
            fails = int(session.data.get("twoFactorFails") or 0) + 1
            if fails >= SESSION_FAILS:
                await store.destroy(session)
                raise ApiError(401, "Too many wrong codes. Enter your email and password again.", code="two_factor_expired")
            session.data["twoFactorFails"] = fails
            await store.save(session)
            raise ApiError(400, "That code is not right. Check it and try again.")

        await store.regenerate(session, userId=user_id)
        left = len((await load_two_factor(pool, user_id))["recovery_codes"])
        return {"user": public_user(to_current_user(user)), "method": method, "recoveryCodesLeft": left}

    # --- Settings (signed in) -----------------------------------------------------------------------------

    @router.get("")
    async def get_status(request: Request, user: CurrentUser = Depends(require_user)):
        return status_json(request, await load_two_factor(request.app.state.pool, user.id))

    @router.post("/app/setup")
    async def start_app(request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        if not encryption_ready():
            raise ApiError(503, "Authenticator apps need ENCRYPTION_KEY set on the server. Ask whoever runs this site.")
        await _confirm_password(pool, user, body(request))
        secret = new_totp_secret()
        await _ensure_row(pool, user.id)
        await pool.execute(
            "UPDATE user_two_factor SET totp_pending_encrypted = $2, updated_at = now() WHERE user_id = $1", user.id, encrypt_secret(secret)
        )
        url = otpauth_url(secret, user.email)
        return {"secret": " ".join(secret[i:i + 4] for i in range(0, len(secret), 4)), "otpauthUrl": url, "qrCode": qr_code(url)}

    @router.post("/app/confirm")
    async def confirm_app(request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        row = await load_two_factor(pool, user.id)
        if not row or not row["totp_pending_encrypted"]:
            raise ApiError(400, "Start again: scan a new QR code.")
        try:
            secret = decrypt_secret(row["totp_pending_encrypted"])
        except SecretUnavailableError:
            raise ApiError(400, "Start again: scan a new QR code.") from None
        step = totp_match(secret, normalize_code(body(request).get("code")))
        if step is None:
            raise ApiError(400, "That code is not right. Enter the 6-digit code the app shows now.")
        was_on = two_factor_on(row)
        await pool.execute(
            """UPDATE user_two_factor SET totp_secret_encrypted = totp_pending_encrypted, totp_pending_encrypted = NULL,
                 totp_last_step = $2, updated_at = now() WHERE user_id = $1""",
            user.id, step,
        )
        codes = await _turned_on(request, user, was_on)
        return {**status_json(request, await load_two_factor(pool, user.id)), "recoveryCodes": codes}

    @router.delete("/app")
    async def remove_app(request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        await _confirm_password(pool, user, body(request))
        await pool.execute(
            "UPDATE user_two_factor SET totp_secret_encrypted = NULL, totp_pending_encrypted = NULL, updated_at = now() WHERE user_id = $1", user.id
        )
        await _after_removal(pool, user.id)
        return status_json(request, await load_two_factor(pool, user.id))

    @router.post("/phone/setup")
    async def start_phone(request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        if not request.app.state.options.sms.available():
            raise ApiError(503, "Text messages are not set up on this server. Use an authenticator app instead.")
        data = body(request)
        phone = normalize_phone(data.get("phone"))
        if not phone:
            raise ApiError(400, "Enter the mobile number with its country code, like +91 98123 45678.")
        await _confirm_password(pool, user, data)
        await _ensure_row(pool, user.id)
        await pool.execute("UPDATE user_two_factor SET phone_pending = $2, updated_at = now() WHERE user_id = $1", user.id, phone)
        await send_texted_code(request, user.id, "phone_setup", phone)
        return {"sent": True, "phoneHint": mask_phone(phone)}

    @router.post("/phone/confirm")
    async def confirm_phone(request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        row = await load_two_factor(pool, user.id)
        if not row or not row["phone_pending"]:
            raise ApiError(400, "Start again: enter your mobile number.")
        code = normalize_code(body(request).get("code"))
        if not re.fullmatch(r"\d{6}", code) or not await accept_texted_code(pool, user.id, "phone_setup", code, row["phone_pending"]):
            raise ApiError(400, "That code is not right, or it has expired. Check the text message, or send a new code.")
        was_on = two_factor_on(row)
        await pool.execute(
            "UPDATE user_two_factor SET phone = phone_pending, phone_pending = NULL, updated_at = now() WHERE user_id = $1", user.id
        )
        codes = await _turned_on(request, user, was_on)
        return {**status_json(request, await load_two_factor(pool, user.id)), "recoveryCodes": codes}

    @router.delete("/phone")
    async def remove_phone(request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        await _confirm_password(pool, user, body(request))
        await pool.execute("UPDATE user_two_factor SET phone = NULL, phone_pending = NULL, updated_at = now() WHERE user_id = $1", user.id)
        await _after_removal(pool, user.id)
        return status_json(request, await load_two_factor(pool, user.id))

    @router.post("/recovery-codes")
    async def new_codes(request: Request, user: CurrentUser = Depends(require_user)):
        pool: Pool = request.app.state.pool
        await _confirm_password(pool, user, body(request))
        if not two_factor_on(await load_two_factor(pool, user.id)):
            raise ApiError(400, "Turn on two-step sign-in first.")
        codes = new_recovery_codes()
        await pool.execute(
            "UPDATE user_two_factor SET recovery_codes = $2, updated_at = now() WHERE user_id = $1", user.id, [hash_recovery(c) for c in codes]
        )
        return {**status_json(request, await load_two_factor(pool, user.id)), "recoveryCodes": codes}

    return router
