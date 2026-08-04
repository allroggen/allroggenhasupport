"""Config flow for the Allroggen support chat integration."""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlparse

import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.const import CONF_API_TOKEN
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_BACKEND_URL, DOMAIN, TIMEOUT_DEFAULT

_LOGGER = logging.getLogger(__name__)

DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_BACKEND_URL): str,
        vol.Required(CONF_API_TOKEN): str,
    }
)

REAUTH_SCHEMA = vol.Schema({vol.Required(CONF_API_TOKEN): str})


def _normalize_url(url: str) -> str:
    return url.strip().rstrip("/")


def _is_valid_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


class AllroggenChatConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle the setup flow: backend URL + per-customer API token."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        # One support chat per Home Assistant instance.
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}

        if user_input is not None:
            backend_url = _normalize_url(user_input[CONF_BACKEND_URL])
            api_token = user_input[CONF_API_TOKEN].strip()

            if not _is_valid_url(backend_url):
                errors["base"] = "invalid_url"
            else:
                error = await self._validate(backend_url, api_token)
                if error is None:
                    await self.async_set_unique_id(backend_url)
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(
                        title="Allroggen Support-Chat",
                        data={
                            CONF_BACKEND_URL: backend_url,
                            CONF_API_TOKEN: api_token,
                        },
                    )
                errors["base"] = error

        return self.async_show_form(
            step_id="user", data_schema=DATA_SCHEMA, errors=errors
        )

    async def async_step_reauth(
        self, entry_data: dict[str, Any]
    ) -> config_entries.ConfigFlowResult:
        """Handle reauth triggered by a 401 from the backend (token revoked)."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        entry = self.hass.config_entries.async_get_entry(self.context["entry_id"])
        if entry is None:
            return self.async_abort(reason="reauth_failed")

        errors: dict[str, str] = {}
        if user_input is not None:
            api_token = user_input[CONF_API_TOKEN].strip()
            error = await self._validate(entry.data[CONF_BACKEND_URL], api_token)
            if error is None:
                return self.async_update_reload_and_abort(
                    entry, data={**entry.data, CONF_API_TOKEN: api_token}
                )
            errors["base"] = error

        return self.async_show_form(
            step_id="reauth_confirm", data_schema=REAUTH_SCHEMA, errors=errors
        )

    async def _validate(self, backend_url: str, api_token: str) -> str | None:
        """Check the token against the backend's config endpoint.

        Returns None on success, otherwise the form error key.
        """
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(
                f"{backend_url}/api/customer-chat/config",
                headers={"X-Customer-Token": api_token},
                timeout=aiohttp.ClientTimeout(total=TIMEOUT_DEFAULT),
            ) as resp:
                if resp.status == 200:
                    return None
                if resp.status == 401:
                    return "invalid_auth"
                _LOGGER.warning(
                    "Unexpected backend status %s during validation", resp.status
                )
                return "unknown"
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.warning("Cannot connect to backend %s: %s", backend_url, err)
            return "cannot_connect"
