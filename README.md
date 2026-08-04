# Allroggen Support-Chat (Home Assistant Integration)

Sidebar-Chat in Home Assistant, über den Kunden direkt mit dem Support-Agenten
des Allroggen-Ticketsystems schreiben — z. B. „Erstelle mir ein Dashboard fürs
Obergeschoss" oder „Passe die Nachtabsenkung an". Der Agent kann dabei live im
Home Assistant des Kunden arbeiten (Automationen, Dashboards, Helfer).

## Voraussetzungen

- Home Assistant ≥ 2024.8
- Backend-URL und Integrations-Token vom Dienstleister
  (wird im Ticket-System unter *Kunde → Home-Assistant-Chat* erzeugt)

## Installation über HACS (empfohlen)

1. HACS → **Integrationen** → ⋮ (Menü) → **Benutzerdefinierte Repositories**
2. `https://github.com/allroggen/allroggenhasupport` als *Integration* hinzufügen
3. **Allroggen Support-Chat** installieren
4. Home Assistant neu starten

## Manuelle Installation

1. Den Ordner `custom_components/allroggen_chat` aus diesem Repo nach
   `<config>/custom_components/allroggen_chat` kopieren
2. Home Assistant neu starten

## Einrichtung

1. **Einstellungen → Geräte & Dienste → Integration hinzufügen** →
   „Allroggen Support-Chat"
2. Backend-Adresse (z. B. `https://ticket.example.com`) und Token eintragen
3. In der Seitenleiste erscheint **Allroggen Support** — fertig.

## Token-Kontingent

Der Chat hat je nach Vereinbarung ein monatliches Token-Limit. Den aktuellen
Verbrauch zeigt der Balken oben im Panel; bei Überschreitung pausiert der
Chat bis zum Monatswechsel.

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Backend nicht erreichbar" beim Einrichten | URL prüfen (https, kein abschließender `/`), Backend/Proxy erreichbar? |
| „Token ungültig" | Token im Ticket-System prüfen (widerrufen/abgelaufen?) und ggf. neu ausstellen lassen, dann in den Integrationseinstellungen das neue Token eintragen |
| „Chat ist nicht eingerichtet" im Panel | Für den Kunden ist kein Chat-Agent hinterlegt — Dienstleister kontaktieren |
| Panel fehlt nach Update | Browser-Cache leeren / harte Aktualisierung (Strg+F5) |

## Token erneuern (Reauth)

Läuft das Integrations-Token ab oder wird es widerrufen, meldet die Integration
automatisch **„Erneute Authentifizierung erforderlich"**. Dort das neue Token
eintragen — die Integration lädt sich danach selbst neu, Einrichtung und
Unterhaltungen bleiben erhalten.

## Entwicklung

Architektur-Grundprinzipien:

- `proxy.py` leitet `/api/allroggen_chat/*` mit `X-Customer-Token` an
  `<backend>/api/customer-chat/*` weiter — Token bleibt serverseitig, kein
  CORS-Problem. Bei 401 vom Backend startet die Integration automatisch den
  Reauth-Flow.
- `panel/allroggen-chat-panel.js` ist eine dependency-freie Webcomponent,
  die per `fetch` mit dem HA-Access-Token gegen die Proxy-View arbeitet und
  nach dem Senden alle 3 s pollt.

### Tests

```bash
pip install -r requirements_test.txt
pytest tests/
```
