"""Tests for setting up and unloading the integration."""
from __future__ import annotations

from homeassistant.components.frontend import DATA_PANELS
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant

from custom_components.allroggen_chat.const import DOMAIN, PANEL_URL_PATH


async def test_setup_and_unload(hass: HomeAssistant, mock_config_entry) -> None:
    """Setup registers panel/view state; unload tears the entry down again."""
    mock_config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done()

    assert mock_config_entry.state == ConfigEntryState.LOADED
    assert hass.data[DOMAIN]["entry"] is mock_config_entry
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]

    assert await hass.config_entries.async_unload(mock_config_entry.entry_id)
    await hass.async_block_till_done()

    assert mock_config_entry.state == ConfigEntryState.NOT_LOADED
    assert "entry" not in hass.data[DOMAIN]
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]


async def test_setup_is_reload_safe(hass: HomeAssistant, mock_config_entry) -> None:
    """Reloading must not fail on double view/static-path registration."""
    mock_config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done()

    assert await hass.config_entries.async_reload(mock_config_entry.entry_id)
    await hass.async_block_till_done()
    assert mock_config_entry.state == ConfigEntryState.LOADED
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]
