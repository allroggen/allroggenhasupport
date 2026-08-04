"""Constants for the Allroggen support chat integration."""

DOMAIN = "allroggen_chat"

# Config entry keys
CONF_BACKEND_URL = "backend_url"
# homeassistant.const.CONF_API_TOKEN is reused for the customer token.

# HTTP proxy view
PROXY_URL_BASE = "/api/allroggen_chat"
STATIC_URL_PATH = "/allroggen_chat_static"

# Panel
PANEL_WEBCOMPONENT = "allroggen-chat-panel"
PANEL_URL_PATH = "allroggen-chat"
PANEL_TITLE = "Allroggen Support"
PANEL_ICON = "mdi:robot-happy-outline"

# Backend timeouts (seconds)
TIMEOUT_DEFAULT = 15
TIMEOUT_SEND = 60
