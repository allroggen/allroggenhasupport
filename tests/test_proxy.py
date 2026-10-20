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


async def test_proxy_post_topup_forwards_request_id(
    hass, hass_client, mock_config_entry, monkeypatch
) -> None:
    """A top-up order is forwarded with the customer token and the top-up
    timeout branch selected.

    The three proxy timeouts are monkeypatched to distinct values so the
    assertion proves the /topup branch picks TIMEOUT_TOPUP specifically —
    not an accidental match because TIMEOUT_TOPUP == TIMEOUT_SEND.
    """
    import custom_components.allroggen_chat.proxy as proxy_module

    monkeypatch.setattr(proxy_module, "TIMEOUT_TOPUP", 61)
    monkeypatch.setattr(proxy_module, "TIMEOUT_SEND", 62)
    monkeypatch.setattr(proxy_module, "TIMEOUT_DEFAULT", 63)

    await _setup(hass, mock_config_entry)
    topup_url = URL(f"{BACKEND_URL}/api/customer-chat/topup")
    request_id = "0e0d7bc6-6f5e-4bd8-a27a-2bf4ba49a26e"
    with _mock_backend() as m:
        m.post(
            str(topup_url),
            status=200,
            payload={"status": "granted", "amountEur": "10.00"},
        )
        client = await hass_client()
        resp = await client.post(f"{PROXY_URL_BASE}/topup", json={"requestId": request_id})

        assert resp.status == 200
        assert await resp.json() == {"status": "granted", "amountEur": "10.00"}
        call = m.requests[("POST", topup_url)][0]
        assert call.kwargs["headers"]["X-Customer-Token"] == API_TOKEN
        assert request_id.encode() in call.kwargs["data"]
        # 61 = TIMEOUT_TOPUP (gemockt); 62 wäre SEND, 63 DEFAULT.
        assert call.kwargs["timeout"].total == 61


async def test_proxy_post_topup_blocked_409_passthrough(
    hass, hass_client, mock_config_entry
) -> None:
    """A 409 topup_blocked (with reasons) reaches the panel unchanged — the
    proxy must not turn a server-side block into a success."""
    await _setup(hass, mock_config_entry)
    topup_url = URL(f"{BACKEND_URL}/api/customer-chat/topup")
    blocked = {
        "error": "topup_blocked",
        "reasons": ["credit-awaiting-validated-invoice", "invoice-overdue"],
    }
    with _mock_backend() as m:
        m.post(str(topup_url), status=409, payload=blocked)
        client = await hass_client()
        resp = await client.post(
            f"{PROXY_URL_BASE}/topup", json={"requestId": "x" * 36}
        )

        assert resp.status == 409
        assert await resp.json() == blocked


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
        assert resp.headers["X-Accel-Buffering"] == "no"
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


async def test_proxy_delete_forwards_with_token(
    hass, hass_client, mock_config_entry
) -> None:
    """DELETE is forwarded to the backend with the customer token."""
    await _setup(hass, mock_config_entry)
    delete_url = URL(f"{BACKEND_URL}/api/customer-chat/conversations/5")
    with _mock_backend() as m:
        m.delete(str(delete_url), status=200, payload={"ok": True})
        client = await hass_client()
        resp = await client.delete(f"{PROXY_URL_BASE}/conversations/5")

        assert resp.status == 200
        call = m.requests[("DELETE", delete_url)][0]
        assert call.kwargs["headers"]["X-Customer-Token"] == API_TOKEN


async def test_proxy_forwards_query_string(
    hass, hass_client, mock_config_entry
) -> None:
    """Query parameters reach the backend unchanged."""
    await _setup(hass, mock_config_entry)
    backend_url = URL(f"{BACKEND_URL}/api/customer-chat/conversations?limit=25")
    with _mock_backend() as m:
        m.get(str(backend_url), status=200, payload=[])
        client = await hass_client()
        resp = await client.get(f"{PROXY_URL_BASE}/conversations?limit=25")

        assert resp.status == 200
        assert ("GET", backend_url) in m.requests


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


async def test_proxy_stream_401_starts_reauth(
    hass, hass_client, mock_config_entry
) -> None:
    """A 401 on the stream endpoint triggers the reauth flow exactly once."""
    await _setup(hass, mock_config_entry)
    with _mock_backend() as m:
        m.get(str(STREAM_BACKEND_URL), status=401, payload={})
        client = await hass_client()
        resp = await client.get(f"{PROXY_URL_BASE}/stream")
        assert resp.status == 401
        await hass.async_block_till_done()

        flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
        assert len(flows) == 1
        assert flows[0]["context"]["source"] == config_entries.SOURCE_REAUTH

    for flow in flows:
        hass.config_entries.flow.async_abort(flow["flow_id"])


async def test_proxy_fails_closed_after_unload(
    hass, hass_client, mock_config_entry
) -> None:
    """After unloading, the still-registered view fails closed with 503."""
    await _setup(hass, mock_config_entry)
    client = await hass_client()
    assert await hass.config_entries.async_unload(mock_config_entry.entry_id)
    await hass.async_block_till_done()

    resp = await client.get(f"{PROXY_URL_BASE}/config")
    assert resp.status == 503
    assert await resp.json() == {"error": "not_configured"}


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
