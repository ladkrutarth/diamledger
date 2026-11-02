"""Password reset email over SMTP. Without SMTP settings the link is logged instead."""

from __future__ import annotations

import asyncio
import logging
import os
import smtplib
import ssl
from collections.abc import Awaitable, Callable
from email.message import EmailMessage

log = logging.getLogger("diamondx.mailer")

SendPasswordResetEmail = Callable[[str, str], Awaitable[None]]


def _send_sync(message: EmailMessage, host: str, port: int, user: str, password: str) -> None:
    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as server:
            server.login(user, password)
            server.send_message(message)
        return
    with smtplib.SMTP(host, port, timeout=30) as server:
        server.ehlo()
        if server.has_extn("starttls"):
            server.starttls(context=context)
            server.ehlo()
        server.login(user, password)
        server.send_message(message)


async def send_password_reset_email(to: str, link: str) -> None:
    host, user, password = os.environ.get("SMTP_HOST"), os.environ.get("SMTP_USER"), os.environ.get("SMTP_PASS")
    if not host or not user or not password:
        log.warning("Password reset requested for %s. SMTP is not configured, so the link was not emailed: %s", to, link)
        return
    try:
        port = int(os.environ.get("SMTP_PORT") or 587)
    except ValueError:
        port = 587
    message = EmailMessage()
    message["From"] = os.environ.get("SMTP_FROM") or user
    message["To"] = to
    message["Subject"] = "Reset your Meridian password"
    message.set_content(
        f"Use this link to choose a new password. It expires in 1 hour.\n\n{link}\n\nIf you did not ask for this, ignore this email."
    )
    await asyncio.to_thread(_send_sync, message, host, port, user, password)
