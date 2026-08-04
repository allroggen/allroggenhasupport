"""Global fixtures for the Allroggen support chat tests."""
from __future__ import annotations

import pytest
from homeassistant.const import CONF_API_TOKEN
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.allroggen_chat.const import CONF_BACKEND_URL, DOMAIN

BACKEND_URL = "https://ticket.example.com"
API_TOKEN = "test-token"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Enable loading custom integrations in all tests."""
    yield


@pytest.fixture
def mock_config_entry() -> MockConfigEntry:
    """A configured entry pointing at the (mocked) ticket-system backend."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Allroggen Support-Chat",
        data={CONF_BACKEND_URL: BACKEND_URL, CONF_API_TOKEN: API_TOKEN},
        unique_id=BACKEND_URL,
    )
