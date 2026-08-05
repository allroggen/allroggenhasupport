"""Tests for the backend proxy view."""
from __future__ import annotations

import aiohttp
from aioresponses import aioresponses
from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from yarl import URL

from custom_components.allroggen_chat.const import DOMAIN, PROXY_URL_BASE

from .conftest import API_TOKEN, BACKEND_URL

CONFIG_BACKEND_URL = URL(f"{BACKEND_URL}/api/customer-chat/config")
STREAM_BACKEND_URL = URL(f"{BACKEND_URL}/api/customer-chat/stream")

# aioresponses patches every aiohttp session — let the test client's calls to
# the local HA test server pass through untouched.
_LOOPBACK = ["http://127.0.0.1", "https://127.0.0.1", "http://localhost"]


def _mock_backend() -> aioresponses:
    return aioresponses(passthrough=_LOOPBACK)


async def _setup(hass: HomeAssistant, mock_config_entry) -> None:
    mock_config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done()


async def test_proxy_get_forwards_with_token(hass, hass_client, mock_config_entry) -> None:
    """GET is forwarded to the backend with the customer token; response passes through."""
    await _setup(hass, mock_config_entry)
    with _mock_backend() as m:
        m.get(str(CONFIG_BACKEND_URL), status=200, payload={"agentName": "Support"})
        client = await hass_client()
        resp = await client.get(f"{PROXY_URL_BASE}/config")

        assert resp.status == 200
        assert await resp.json() == {"agentName": "Support"}
        call = m.requests[("GET", CONFIG_BACKEND_URL)][0]
        assert call.kwargs["headers"]["X-Customer-Token"] == API_TOKEN


async def test_proxy_post_messages_forwards_body(
    hass, hass_client, mock_config_entry
) -> None:
    """POST body and content type reach the backend unchanged."""
    await _setup(hass, mock_config_entry)
    messages_url = URL(f"{BACKEND_URL}/api/customer-chat/messages")
    with _mock_backend() as m:
        m.post(
            str(messages_url),
            status=200,
            payload={"conversationId": 7, "userMessageId": 42},
        )
        client = await hass_client()
        resp = await client.post(
            f"{PROXY_URL_BASE}/messages", json={"content": "Hallo"}
        )

        assert resp.status == 200
        assert await resp.json() == {"conversationId": 7, "userMessageId": 42}
        call = m.requests[("POST", messages_url)][0]
        assert b"Hallo" in call.kwargs["data"]
        assert call.kwargs["headers"]["Content-Type"] == "application/json"


async def test_proxy_stream_relays_sse(hass, hass_client, mock_config_entry) -> None:
    """The SSE endpoint is streamed through, not buffered like a JSON call."""
    await _setup(hass, mock_config_entry)
    body = (
        b": connected\n\n"
        b'event: assistant.delta\ndata: {"conversationId":12,"delta":"Hallo"}\n\n'
        b": ping\n\n"
    )
    with _mock_backend() as m:
        m.get(
            str(STREAM_BACKEND_URL),
            status=200,
            body=body,
            content_type="text/event-stream",
        )
        client = await hass_client()
        resp = await client.get(f"{PROXY_URL_BASE}/stream")

        assert resp.status == 200
        assert resp.content_type == "text/event-stream"
        assert resp.headers["Cache-Control"] == "no-cache"
        assert await resp.read() == body
        call = m.requests[("GET", STREAM_BACKEND_URL)][0]
        assert call.kwargs["headers"]["X-Customer-Token"] == API_TOKEN


async def test_proxy_stream_404_passes_through(
    hass, hass_client, mock_config_entry
) -> None:
    """An old backend without /stream answers 404 — the panel falls back to polling."""
    await _setup(hass, mock_config_entry)
    with _mock_backend() as m:
        m.get(str(STREAM_BACKEND_URL), status=404, payload={"error": "not_found"})
        client = await hass_client()
        resp = await client.get(f"{PROXY_URL_BASE}/stream")

        assert resp.status == 404


async def test_proxy_backend_unreachable_returns_502(
    hass, hass_client, mock_config_entry
) -> None:
    """A dead backend surfaces as 502, not as an HA-internal 500."""
    await _setup(hass, mock_config_entry)
    with _mock_backend() as m:
        m.get(str(CONFIG_BACKEND_URL), exception=aiohttp.ClientConnectionError("down"))
        client = await hass_client()
        resp = await client.get(f"{PROXY_URL_BASE}/config")

        assert resp.status == 502
        assert await resp.json() == {"error": "backend_unreachable"}


async def test_proxy_401_starts_reauth(hass, hass_client, mock_config_entry) -> None:
    """A 401 from the backend is passed through and starts the reauth flow once."""
    await _setup(hass, mock_config_entry)
    with _mock_backend() as m:
        m.get(str(CONFIG_BACKEND_URL), status=401, payload={})
        m.get(str(CONFIG_BACKEND_URL), status=401, payload={})
        client = await hass_client()
        resp = await client.get(f"{PROXY_URL_BASE}/config")
        assert resp.status == 401
        await hass.async_block_till_done()

        flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
        assert len(flows) == 1
        assert flows[0]["context"]["source"] == config_entries.SOURCE_REAUTH

        # A second 401 must not spawn a duplicate reauth flow.
        resp = await client.get(f"{PROXY_URL_BASE}/config")
        assert resp.status == 401
        await hass.async_block_till_done()
        flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
        assert len(flows) == 1

    for flow in flows:
        hass.config_entries.flow.async_abort(flow["flow_id"])
