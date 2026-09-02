# AGENTS.md

Home Assistant custom integration (HACS): **Allroggen Support-Chat** (`allroggen_chat`).
Adds a sidebar chat panel in which customers talk to the support agent of the
Allroggen ticket system; the agent can work live in the customer's Home Assistant.

## Layout

- `custom_components/allroggen_chat/` — the integration (Python backend + panel)
  - `__init__.py` — setup: registers proxy view + static paths **once** (reload-safe), registers sidebar panel
  - `proxy.py` — aiohttp view proxying `/api/allroggen_chat/*` → `<backend>/api/customer-chat/*` with `X-Customer-Token`; SSE passthrough on `/stream`; 401 → reauth flow
  - `config_flow.py` — setup + reauth flow, validates against backend `/config` endpoint
  - `const.py` — domain, panel names, HTTP timeouts
  - `panel/allroggen-chat-panel.js` — the entire UI: dependency-free web component (Shadow DOM, vanilla JS, **no build step** — edit directly)
  - `translations/` + `strings.json` — German-first UI (`de.json`, `en.json`)
  - `brand/` — icons/logos for HA ≥ 2026.3 local brands
- `tests/` — pytest suite (`test_proxy.py`, `test_config_flow.py`, `test_init.py`)
- `.github/workflows/validate.yaml` — CI: hassfest + HACS validation + pytest (Python 3.13)

## Commands

```bash
pip install -r requirements_test.txt   # pytest-homeassistant-custom-component, aioresponses
pytest                                 # full suite (pytest.ini: testpaths=tests, asyncio_mode=auto)
pytest tests/test_proxy.py -k stream   # focused
```

No lint/format config in repo; CI validates via hassfest (manifest/strings correctness) and HACS action. Bump `version` in `manifest.json` for releases (HACS).

## Architecture rules

- **Token security:** the per-customer token lives only in `entry.data`; it is attached server-side by the proxy (`X-Customer-Token`) and must never reach the browser. The panel authenticates with HA's own access token against the proxy view only.
- **Register-once:** HTTP views and static paths cannot be unregistered; `__init__.py` guards registration with `domain_data["registered"]`. The proxy resolves the active entry dynamically from `hass.data` and fails closed (503) when unloaded. Preserve this pattern when touching setup.
- **Reauth:** any 401 from the backend triggers the reauth flow exactly once (`_start_reauth_once` checks for in-progress flows). Keep this dedup.
- **SSE streaming:** `/stream` must not be buffered — relay chunks as they arrive (`iter_any`). No total timeout (backend heartbeats every 15 s); `sock_read=90` guards dead peers. On the panel side: fetch-based frame parsing (EventSource can't send an Authorization header), with polling fallback (3 s interval, 5 min timeout) and stream retry backoff 5 s → 60 s. Don't break the fallback paths.
- **Single instance:** config flow aborts with `single_instance_allowed`; one entry per HA instance.

## Conventions

- Python: `from __future__ import annotations`, modern union typing (`str | None`), module + method docstrings, module-level `_LOGGER`. No external requirements (`requirements: []` — aiohttp/voluptuous come from HA).
- Tests: `pytest-homeassistant-custom-component` fixtures + `MockConfigEntry` (see `conftest.py`). **Gotcha:** `aioresponses` patches every aiohttp session — construct it with `passthrough` for loopback URLs (`http(s)://127.0.0.1`, `http://localhost`) or the HA test client breaks.
- Panel JS: no frameworks, no bundler, no external assets; icons are inline MDI SVG paths colored via `currentColor`. Responsive: container `< 640 px` switches the conversation sidebar to an overlay drawer (ResizeObserver). UI strings and code comments in the panel are German.
- User-facing language is German (strings.json is German; keep translations in sync).
- HA minimum: 2024.8 (hacs.json); dependencies `http`, `frontend`.

## Docs to read before sensitive changes

- `README.md` — architecture section (proxy/panel contract, streaming/fallback behavior) and the user-facing feature/troubleshooting tables; update it together with behavior changes.
