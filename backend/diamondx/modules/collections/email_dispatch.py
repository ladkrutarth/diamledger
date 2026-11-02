"""Emailing invoices through the company's own SMTP server (port of server/modules/collections/emailDispatch.ts).

Without SMTP settings the send is simulated and logged. Only PDF attachments, at most 10 addresses,
single-line subjects, and verified TLS unless the sender opts out.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import re
import smtplib
import ssl
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any, Literal, Protocol

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ...core.context import api_router
from ...core.db import Pool
from ...core.http import CurrentUser, body, iso, require_user
from ...core.numbers import js_number
from ..auth.users import is_valid_email

log = logging.getLogger("diamondx.email")

MAX_RECIPIENTS = 10
MAX_ATTACHMENTS = 2
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_HTML_LENGTH = 200_000
ALLOWED_PORTS = {25, 465, 587, 2525}
_HOST = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")


class InputError(Exception):
    """A problem with the request, answered with status 400."""


@dataclass(frozen=True)
class SmtpSettings:
    host: str
    port: int
    secure: bool
    user: str
    password: str
    allow_invalid_certificates: bool


@dataclass(frozen=True)
class Attachment:
    filename: str
    content: bytes
    content_type: str = "application/pdf"


@dataclass
class MailMessage:
    from_name: str
    from_address: str
    to: list[str]
    cc: list[str]
    subject: str
    html: str
    attachments: list[Attachment] = field(default_factory=list)


class MailTransport(Protocol):
    async def verify(self) -> None: ...

    async def send_mail(self, message: MailMessage) -> dict[str, Any]:
        """Returns {"messageId": str | None, "accepted": [addresses]}."""
        ...


CreateMailTransport = Callable[[SmtpSettings], MailTransport]


class SmtpTransport:
    """smtplib in a worker thread. TLS is required except on port 25, and certificates are verified unless opted out."""

    def __init__(self, settings: SmtpSettings) -> None:
        self.settings = settings

    def tls_context(self) -> ssl.SSLContext:
        context = ssl.create_default_context()
        if self.settings.allow_invalid_certificates:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        return context

    def _connect(self) -> smtplib.SMTP:
        s = self.settings
        if s.secure:
            server: smtplib.SMTP = smtplib.SMTP_SSL(s.host, s.port, context=self.tls_context(), timeout=20)
        else:
            server = smtplib.SMTP(s.host, s.port, timeout=20)
            server.ehlo()
            if server.has_extn("starttls"):
                server.starttls(context=self.tls_context())
                server.ehlo()
            elif s.port != 25:
                server.close()
                raise smtplib.SMTPException("The mail server does not offer STARTTLS, so the password would be sent unencrypted.")
        server.login(s.user, s.password)
        return server

    async def verify(self) -> None:
        def run() -> None:
            with self._connect():
                pass

        await asyncio.to_thread(run)

    async def send_mail(self, message: MailMessage) -> dict[str, Any]:
        email = EmailMessage()
        email["From"] = formataddr((message.from_name, message.from_address))
        email["To"] = ", ".join(message.to)
        if message.cc:
            email["Cc"] = ", ".join(message.cc)
        email["Subject"] = message.subject
        message_id = make_msgid(domain=message.from_address.rsplit("@", 1)[-1] or None)
        email["Message-ID"] = message_id
        email.set_content(message.html, subtype="html")
        for attachment in message.attachments:
            email.add_attachment(attachment.content, maintype="application", subtype="pdf", filename=attachment.filename)

        def run() -> dict:
            with self._connect() as server:
                return server.send_message(email)

        refused = await asyncio.to_thread(run)
        return {"messageId": message_id, "accepted": [a for a in [*message.to, *message.cc] if a not in refused]}


def create_smtp_transport(settings: SmtpSettings) -> MailTransport:
    return SmtpTransport(settings)


def _text(value: Any, max_length: int, label: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise InputError(f"{label} must be text.")
    trimmed = value.strip()
    if len(trimmed) > max_length:
        raise InputError(f"{label} is too long.")
    return trimmed


def parse_smtp_settings(value: Any) -> SmtpSettings | None:
    if not isinstance(value, dict):
        return None
    host = _text(value.get("host"), 255, "SMTP host").lower()
    user = _text(value.get("user"), 320, "SMTP username")
    password = value["pass"].strip() if isinstance(value.get("pass"), str) else ""
    if not host or not user or not password:
        return None
    if not _HOST.match(host):
        raise InputError("Enter the SMTP host name, for example smtp.gmail.com.")
    # Number(port) || 587: missing, blank, zero, or not a number means the default.
    requested = js_number(value.get("port"))
    if requested != requested or requested == 0:
        requested = 587
    if requested not in ALLOWED_PORTS:
        raise InputError("SMTP port must be 25, 465, 587, or 2525.")
    port = int(requested)
    return SmtpSettings(
        host=host,
        port=port,
        secure=bool(value.get("secure")),
        user=user,
        password=password,
        allow_invalid_certificates=value.get("allowInvalidCertificates") is True,
    )


def _email_list(value: Any, label: str) -> list[str]:
    raw = value if isinstance(value, list) else value.split(",") if isinstance(value, str) else []
    addresses = [entry.strip().lower() for entry in raw if isinstance(entry, str) and entry.strip()]
    for address in addresses:
        if not is_valid_email(address) or len(address) > 320:
            raise InputError(f"{label} has an invalid address: {address}")
    return list(dict.fromkeys(addresses))


def _attachments(value: Any) -> list[Attachment]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise InputError("Attachments are invalid.")
    if len(value) > MAX_ATTACHMENTS:
        raise InputError(f"At most {MAX_ATTACHMENTS} attachments can be sent.")
    result = []
    for entry in value:
        if not isinstance(entry, dict) or not isinstance(entry.get("content"), str):
            raise InputError("Attachments are invalid.")
        content_type = entry.get("contentType") if entry.get("contentType") is not None else "application/pdf"
        if content_type != "application/pdf":
            raise InputError("Only PDF attachments can be sent.")
        filename = re.sub(r'[\\/\r\n"]', "_", _text(entry.get("filename"), 200, "Attachment name")) or "document.pdf"
        data = re.sub(r"^data:[^;]+;base64,", "", entry["content"])
        try:
            content = base64.b64decode(data + "=" * (-len(data) % 4))
        except (binascii.Error, ValueError):
            raise InputError("Attachments are invalid.") from None
        if len(content) > MAX_ATTACHMENT_BYTES:
            raise InputError("Each attachment must be under 10 MB.")
        result.append(Attachment(filename, content))
    return result


@dataclass
class EmailRequest:
    recipients: list[str]
    cc: list[str]
    subject: str
    html_body: str
    invoice_number: str
    from_name: str
    from_email: str
    attachments: list[Attachment]
    settings: SmtpSettings | None


def parse_email_request(data: Any) -> EmailRequest:
    if not isinstance(data, dict) or not isinstance(data.get("emailData"), dict):
        raise InputError("Email details are missing.")
    email_data = data["emailData"]
    recipients = _email_list(email_data.get("recipients"), "Recipients")
    cc = [address for address in _email_list(email_data.get("cc"), "CC") if address not in recipients]
    if not recipients:
        raise InputError("At least one recipient email is required.")
    if len(recipients) + len(cc) > MAX_RECIPIENTS:
        raise InputError(f"An email can go to at most {MAX_RECIPIENTS} addresses, including CC.")

    subject = _text(email_data.get("subject"), 300, "Subject")
    if not subject:
        raise InputError("Subject is required.")
    if re.search(r"[\r\n]", subject):
        raise InputError("Subject must be a single line.")
    html_body = email_data["htmlBody"] if isinstance(email_data.get("htmlBody"), str) else ""
    if len(html_body) > MAX_HTML_LENGTH:
        raise InputError("Email body is too long.")

    smtp = data["smtpConfig"] if isinstance(data.get("smtpConfig"), dict) else {}
    return EmailRequest(
        recipients=recipients,
        cc=cc,
        subject=subject,
        html_body=html_body,
        invoice_number=_text(email_data.get("invoiceNumber"), 200, "Invoice number"),
        from_name=re.sub(r'["<>\r\n]', "", _text(smtp.get("fromName"), 120, "Sender name")),
        from_email=_text(smtp.get("fromEmail"), 320, "Sender email"),
        attachments=_attachments(data.get("attachments")),
        settings=parse_smtp_settings(data.get("smtpConfig")),
    )


@dataclass
class DispatchResult:
    ok: bool
    mode: Literal["preview_simulated", "live_smtp"] = "preview_simulated"
    message_id: str | None = None
    accepted: list = field(default_factory=list)
    status: int = 200
    error: str | None = None


async def dispatch_email(pool: Pool, user: CurrentUser, request: EmailRequest, create_transport: CreateMailTransport) -> DispatchResult:
    settings = request.settings
    result = DispatchResult(ok=True)
    if settings:
        if request.from_email and not is_valid_email(request.from_email):
            return DispatchResult(ok=False, status=400, error="Sender email is invalid.")
        try:
            info = await create_transport(settings).send_mail(
                MailMessage(
                    from_name=request.from_name or user.organization_name,
                    from_address=request.from_email or settings.user,
                    to=request.recipients,
                    cc=request.cc,
                    subject=request.subject,
                    html=request.html_body,
                    attachments=request.attachments,
                )
            )
        except Exception as error:
            log.error("SMTP dispatch failed: %s", error)
            return DispatchResult(ok=False, status=502, error=f"The mail server rejected the email: {error or 'unknown error'}")
        result = DispatchResult(ok=True, mode="live_smtp", message_id=info.get("messageId"), accepted=list(info.get("accepted") or []))

    await pool.execute(
        """INSERT INTO email_dispatches
             (organization_id, user_id, mode, smtp_host, recipients, cc, subject, invoice_number, attachment_count, message_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)""",
        user.organization_id, user.id, result.mode, settings.host if settings else None, request.recipients, request.cc,
        request.subject, request.invoice_number, len(request.attachments), result.message_id,
    )
    log.info(json.dumps({
        "event": "email_dispatch",
        "mode": result.mode,
        "userId": user.id,
        "organizationId": user.organization_id,
        "recipients": len(request.recipients) + len(request.cc),
        "invoiceNumber": request.invoice_number,
    }))
    return result


def build_router():
    router = api_router(prefix="/api")

    @router.post("/send-email")
    async def send_email(request: Request, user: CurrentUser = Depends(require_user)):
        try:
            email = parse_email_request(request.state.body)
        except InputError as error:
            log.warning("Invalid send-email request: %s", error)
            return JSONResponse({"error": "Invalid email request payload."}, status_code=400)
        result = await dispatch_email(request.app.state.pool, user, email, request.app.state.options.create_mail_transport)
        if not result.ok:
            return JSONResponse({"error": result.error}, status_code=result.status)
        if result.mode == "preview_simulated":
            return {
                "success": True,
                "mode": result.mode,
                "log": {
                    "status": "simulated_success",
                    "message": "Email was not sent. Enter SMTP credentials to send real email.",
                    "timestamp": iso(datetime.now(timezone.utc)),
                    "recipients": email.recipients,
                    "cc": email.cc,
                    "subject": email.subject,
                    "attachmentsCount": len(email.attachments),
                    "invoiceNumber": email.invoice_number,
                },
            }
        return {"success": True, "mode": result.mode, "messageId": result.message_id, "accepted": result.accepted}

    @router.post("/verify-smtp")
    async def verify_smtp(request: Request, user: CurrentUser = Depends(require_user)):
        try:
            settings = parse_smtp_settings(body(request))
        except InputError as error:
            return JSONResponse({"success": False, "error": str(error)}, status_code=400)
        if not settings:
            return JSONResponse({"success": False, "error": "Host, Username, and Password are required."}, status_code=400)
        try:
            await request.app.state.options.create_mail_transport(settings).verify()
        except Exception as error:
            message = str(error) or "SMTP Connection failed. Verify host, port, and security credentials."
            return JSONResponse({"success": False, "error": message}, status_code=400)
        return {"success": True, "message": "SMTP connection verified successfully."}

    return router
