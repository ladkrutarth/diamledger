"""Text messages (sign-in codes) through Twilio. Without Twilio settings, development logs the message instead
and production offers no text-message option."""

from __future__ import annotations

import logging
import os
from typing import Protocol

import httpx

from .settings import is_production

log = logging.getLogger("diamondx.sms")


class SmsError(Exception):
    """The message could not be sent."""


class SmsSender(Protocol):
    def available(self) -> bool: ...

    async def send(self, to: str, text: str) -> None: ...


def twilio_configured() -> bool:
    return bool(
        os.environ.get("TWILIO_ACCOUNT_SID")
        and os.environ.get("TWILIO_AUTH_TOKEN")
        and (os.environ.get("TWILIO_FROM_NUMBER") or os.environ.get("TWILIO_MESSAGING_SERVICE_SID"))
    )


def mask_phone(phone: str) -> str:
    return f"{'•' * 4} {phone[-4:]}" if len(phone) > 4 else "••••"


class TwilioSms:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport

    def available(self) -> bool:
        return twilio_configured() or not is_production()

    async def send(self, to: str, text: str) -> None:
        if not twilio_configured():
            if is_production():
                raise SmsError("Text messages are not set up on this server.")
            log.warning("Twilio is not configured, so this text to %s was not sent: %s", mask_phone(to), text)
            return
        sid = os.environ["TWILIO_ACCOUNT_SID"]
        form = {"To": to, "Body": text}
        if os.environ.get("TWILIO_MESSAGING_SERVICE_SID"):
            form["MessagingServiceSid"] = os.environ["TWILIO_MESSAGING_SERVICE_SID"]
        else:
            form["From"] = os.environ["TWILIO_FROM_NUMBER"]
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=15.0) as client:
                response = await client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data=form, auth=(sid, os.environ["TWILIO_AUTH_TOKEN"])
                )
        except httpx.HTTPError as error:
            log.error("Twilio unreachable: %s", error)
            raise SmsError("The text message could not be sent. Try again in a minute.") from None
        if response.status_code >= 400:
            log.error("Twilio refused a message to %s (%s): %s", mask_phone(to), response.status_code, response.text[:300])
            raise SmsError("The text message could not be sent. Check the phone number, or try again in a minute.")
