"""HTTP proxy view: forwards panel calls to the ticket-system backend.

The panel only talks to Home Assistant's own API (inheriting HA auth for
free). This view forwards each request to the backend with the per-customer
X-Customer-Token header — the token never reaches the browser, and the
backend needs no CORS rule for the HA origin.
"""
from __future__ import annotations

import logging

import aiohttp
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import SOURCE_REAUTH, ConfigEntry
from homeassistant.const import CONF_API_TOKEN
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_BACKEND_URL,
    DOMAIN,
    PROXY_URL_BASE,
    TIMEOUT_DEFAULT,
    TIMEOUT_SEND,
)

_LOGGER = logging.getLogger(__name__)


class AllroggenChatProxyView(HomeAssistantView):
    """Proxy /api/allroggen_chat/<path> -> <backend>/api/customer-chat/<path>."""

    url = PROXY_URL_BASE + "/{tail:.*}"
    name = "api:allroggen_chat"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    def _current_entry(self) -> ConfigEntry | None:
        """Resolve the active config entry (its data may change on reauth/reload)."""
        domain_data = self._hass.data.get(DOMAIN) or {}
        return domain_data.get("entry")

    def _start_reauth_once(self, entry: ConfigEntry) -> None:
        """Trigger a reauth flow unless one is already in progress."""
        in_progress = any(
            flow["context"].get("source") == SOURCE_REAUTH
            for flow in self._hass.config_entries.flow.async_progress_by_handler(DOMAIN)
        )
        if not in_progress:
            entry.async_start_reauth(self._hass)

    async def get(self, request: web.Request, tail: str = "") -> web.Response:
        return await self._forward(request, "GET", tail)

    async def delete(self, request: web.Request, tail: str = "") -> web.Response:
        return await self._forward(request, "DELETE", tail)

    async def post(self, request: web.Request, tail: str = "") -> web.Response:
        return await self._forward(request, "POST", tail)

    async def _forward(self, request: web.Request, method: str, tail: str) -> web.Response:
        entry = self._current_entry()
        if entry is None:
            return web.json_response({"error": "not_configured"}, status=503)

        target = f"{entry.data[CONF_BACKEND_URL]}/api/customer-chat/{tail}"
        if request.query_string:
            target += f"?{request.query_string}"

        body = await request.read() if request.can_read_body else None
        timeout = TIMEOUT_SEND if tail.startswith("messages") else TIMEOUT_DEFAULT

        session = async_get_clientsession(self._hass)
        try:
            async with session.request(
                method,
                target,
                headers={
                    "X-Customer-Token": entry.data[CONF_API_TOKEN],
                    "Content-Type": request.headers.get("Content-Type", "application/json"),
                },
                data=body,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                if resp.status == 401:
                    # Token revoked/expired — ask the user for a new one via the UI.
                    self._start_reauth_once(entry)
                resp_body = await resp.read()
                return web.Response(
                    status=resp.status,
                    body=resp_body,
                    content_type=resp.content_type or "application/json",
                )
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.warning("Proxy call %s %s failed: %s", method, target, err)
            return web.json_response(
                {"error": "backend_unreachable"}, status=502
            )
