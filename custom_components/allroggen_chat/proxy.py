"""HTTP proxy view: forwards panel calls to the ticket-system backend.

The panel only talks to Home Assistant's own API (inheriting HA auth for
free). This view forwards each request to the backend with the per-customer
X-Customer-Token header — the token never reaches the browser, and the
backend needs no CORS rule for the HA origin.
"""
from __future__ import annotations

import asyncio
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
    TIMEOUT_STREAM_CONNECT,
    TIMEOUT_STREAM_READ,
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

        if method == "GET" and tail == "stream":
            return await self._forward_stream(request, entry)

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

    async def _forward_stream(
        self, request: web.Request, entry: ConfigEntry
    ) -> web.StreamResponse:
        """Stream the backend's SSE endpoint through to the panel.

        Unlike the regular forward path the body is NOT read up front —
        chunks are relayed as they arrive so assistant deltas reach the
        browser in real time. No total timeout: the backend heartbeats every
        15 s, the read timeout only guards against silently dead peers.
        """
        target = f"{entry.data[CONF_BACKEND_URL]}/api/customer-chat/stream"
        session = async_get_clientsession(self._hass)
        resp = None
        try:
            resp = await session.get(
                target,
                headers={"X-Customer-Token": entry.data[CONF_API_TOKEN]},
                timeout=aiohttp.ClientTimeout(
                    total=None,
                    sock_connect=TIMEOUT_STREAM_CONNECT,
                    sock_read=TIMEOUT_STREAM_READ,
                ),
            )
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.warning("Proxy stream %s failed: %s", target, err)
            return web.json_response({"error": "backend_unreachable"}, status=502)

        try:
            if resp.status != 200:
                # Errors (e.g. 404 on old backends, 401 on revoked tokens)
                # pass through like a regular call so the panel can fall back
                # to polling / trigger reauth.
                if resp.status == 401:
                    self._start_reauth_once(entry)
                return web.Response(
                    status=resp.status,
                    body=await resp.read(),
                    content_type=resp.content_type or "application/json",
                )

            out = web.StreamResponse(
                status=200,
                headers={
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                },
            )
            await out.prepare(request)
            try:
                async for chunk in resp.content.iter_any():
                    await out.write(chunk)
            except (ConnectionError, aiohttp.ClientError) as err:
                _LOGGER.debug("SSE relay to panel ended: %s", err)
            # asyncio.CancelledError (client disconnect) propagates on
            # purpose — the finally below still cleans up.
            try:
                await out.write_eof()
            except (ConnectionError, RuntimeError):
                pass
            return out
        finally:
            # Fully read bodies can be released back to the pool; an aborted
            # stream must not poison it, so close() is the safe default.
            if resp is not None:
                resp.close()
