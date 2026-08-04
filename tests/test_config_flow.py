"""Tests for the Allroggen chat config flow."""
from __future__ import annotations

import aiohttp
from aioresponses import aioresponses
from homeassistant import config_entries
from homeassistant.const import CONF_API_TOKEN
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType

from custom_components.allroggen_chat.const import CONF_BACKEND_URL, DOMAIN

from .conftest import API_TOKEN, BACKEND_URL

CONFIG_URL = f"{BACKEND_URL}/api/customer-chat/config"


async def test_user_flow_success(hass: HomeAssistant) -> None:
    """Happy path: valid URL + token accepted by the backend."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] == FlowResultType.FORM
    assert result["errors"] == {}

    with aioresponses() as m:
        m.get(CONFIG_URL, status=200, payload={})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            # Trailing slash and whitespace must be normalized away.
            {CONF_BACKEND_URL: f" {BACKEND_URL}/ ", CONF_API_TOKEN: API_TOKEN},
        )

    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert result["data"] == {
        CONF_BACKEND_URL: BACKEND_URL,
        CONF_API_TOKEN: API_TOKEN,
    }


async def test_user_flow_invalid_url(hass: HomeAssistant) -> None:
    """A non-URL is rejected before any backend call is made."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_BACKEND_URL: "not-a-url", CONF_API_TOKEN: API_TOKEN},
    )
    assert result["type"] == FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_url"}


async def test_user_flow_invalid_auth_then_recover(hass: HomeAssistant) -> None:
    """401 from the backend shows invalid_auth; a valid token recovers."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    with aioresponses() as m:
        m.get(CONFIG_URL, status=401, payload={})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            {CONF_BACKEND_URL: BACKEND_URL, CONF_API_TOKEN: "bad-token"},
        )
    assert result["type"] == FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}

    with aioresponses() as m:
        m.get(CONFIG_URL, status=200, payload={})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            {CONF_BACKEND_URL: BACKEND_URL, CONF_API_TOKEN: API_TOKEN},
        )
    assert result["type"] == FlowResultType.CREATE_ENTRY


async def test_user_flow_cannot_connect(hass: HomeAssistant) -> None:
    """Connection problems map to cannot_connect."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    with aioresponses() as m:
        m.get(CONFIG_URL, exception=aiohttp.ClientConnectionError("boom"))
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            {CONF_BACKEND_URL: BACKEND_URL, CONF_API_TOKEN: API_TOKEN},
        )
    assert result["type"] == FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_user_flow_single_instance(hass: HomeAssistant, mock_config_entry) -> None:
    """Only one entry per Home Assistant instance."""
    mock_config_entry.add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] == FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_reauth_flow(hass: HomeAssistant, mock_config_entry) -> None:
    """Reauth replaces the token and reloads the entry."""
    mock_config_entry.add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={
            "source": config_entries.SOURCE_REAUTH,
            "entry_id": mock_config_entry.entry_id,
        },
        data=mock_config_entry.data,
    )
    assert result["type"] == FlowResultType.FORM
    assert result["step_id"] == "reauth_confirm"

    # A wrong new token is rejected...
    with aioresponses() as m:
        m.get(CONFIG_URL, status=401, payload={})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {CONF_API_TOKEN: "still-bad"}
        )
    assert result["type"] == FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}

    # ...a valid one updates the entry.
    with aioresponses() as m:
        m.get(CONFIG_URL, status=200, payload={})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {CONF_API_TOKEN: "new-token"}
        )
    assert result["type"] == FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert mock_config_entry.data[CONF_API_TOKEN] == "new-token"
