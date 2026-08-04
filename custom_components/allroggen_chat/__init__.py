"""The Allroggen support chat integration.

Registers the backend proxy view, serves the panel's static files and adds
the sidebar panel.
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    DOMAIN,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    PANEL_WEBCOMPONENT,
    STATIC_URL_PATH,
)
from .proxy import AllroggenChatProxyView

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the integration from a config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data["entry"] = entry

    # HTTP views and static paths cannot be unregistered cleanly, so they are
    # registered exactly once (reload-safe). The proxy view resolves the active
    # entry dynamically from hass.data and fails closed when none is loaded.
    if "registered" not in domain_data:
        hass.http.register_view(AllroggenChatProxyView(hass))
        panel_dir = Path(__file__).parent / "panel"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL_PATH, str(panel_dir), cache_headers=False)]
        )
        domain_data["registered"] = True

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=PANEL_WEBCOMPONENT,
        frontend_url_path=PANEL_URL_PATH,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL_PATH}/allroggen-chat-panel.js",
        require_admin=False,
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the integration: remove the sidebar panel and the entry reference.

    Note: HTTP views and static paths stay registered until restart but are
    harmless — the proxy view fails closed (503) without a loaded entry.
    """
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    domain_data = hass.data.get(DOMAIN)
    if domain_data is not None:
        domain_data.pop("entry", None)
    return True
