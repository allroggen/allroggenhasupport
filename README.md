<div align="center">

<img src="logo.svg" alt="Allroggen Support-Chat Logo" width="180">

# Allroggen Support-Chat

**Der Support-Agent für dein Smart Home — direkt in der Home-Assistant-Seitenleiste.**

[![HACS](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?logo=home-assistant)](https://hacs.xyz)
[![Release](https://img.shields.io/github/v/release/allroggen/allroggenhasupport)](https://github.com/allroggen/allroggenhasupport/releases)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2024.8%2B-41BDF5.svg?logo=homeassistant&logoColor=white)](https://www.home-assistant.io)

</div>

---

Sidebar-Chat in Home Assistant, über den Kunden direkt mit dem Support-Agenten
des Allroggen-Ticketsystems schreiben — z. B. *„Erstelle mir ein Dashboard fürs
Obergeschoss"* oder *„Passe die Nachtabsenkung an"*. Der Agent kann dabei live im
Home Assistant des Kunden arbeiten (Automationen, Dashboards, Helfer).

## ✨ Funktionen

| | |
|---|---|
| 💬 **Streaming-Antworten** | Der Agent antwortet Token für Token live (SSE, mit Polling-Fallback) |
| 🏠 **Arbeitet direkt in HA** | Automationen, Dashboards, Helfer und Skripte auf Zuruf |
| 🖼️ **Bild-Upload** | Per 📎-Button Bilder anhängen (clientseitig verkleinert, max. 1600 px). Erfordert ein vision-fähiges Chat-Modell im Ticket-System — der voreingestellte MiniMax-M2 ist reine Text-KI und ignoriert Anhänge |
| 🎤 **Spracheingabe** | Diktieren statt tippen (Web Speech API, Deutsch). Erfordert Chrome oder Edge — in Firefox wird der Button nicht angezeigt |
| ⏹️ **Abbrechen** | Ein laufender Turn lässt sich jederzeit per „Abbrechen"-Button stoppen |
| 💶 **Transparente Kosten** | Monatsbudget-Balken und Token-/Kostensumme pro Unterhaltung |
| 🔒 **Datenschutz** | Das Kunden-Token bleibt serverseitig — es erreicht nie den Browser |

## 📋 Voraussetzungen

- Home Assistant ≥ 2024.8
- Backend-URL und Integrations-Token vom Dienstleister
  (wird im Ticket-System unter *Kunde → Home-Assistant-Chat* erzeugt)

## 🚀 Installation über HACS (empfohlen)

1. HACS → **Integrationen** → ⋮ (Menü) → **Benutzerdefinierte Repositories**
2. `https://github.com/allroggen/allroggenhasupport` als *Integration* hinzufügen
3. **Allroggen Support-Chat** installieren
4. Home Assistant neu starten

<details>
<summary><strong>Manuelle Installation</strong> (ohne HACS)</summary>

1. Den Ordner `custom_components/allroggen_chat` aus diesem Repo nach
   `<config>/custom_components/allroggen_chat` kopieren
2. Home Assistant neu starten

</details>

## ⚙️ Einrichtung

1. **Einstellungen → Geräte & Dienste → Integration hinzufügen** →
   „Allroggen Support-Chat"
2. Backend-Adresse (z. B. `https://ticket.example.com`) und Token eintragen
3. In der Seitenleiste erscheint **Allroggen Support** — fertig 🎉

## 💶 Chat-Budget

Der Chat hat je nach Vereinbarung ein monatliches Kostenlimit in Euro. Der
Balken oben im Panel zeigt, wie viel Budget bereits verbraucht wurde, wie
hoch das Limit ist und wie viel noch übrig ist; bei Überschreitung pausiert
der Chat bis zum Monatswechsel. Ohne festes Limit wird nur der bisherige
Monatsverbrauch in Euro angezeigt. Zusätzlich zeigt eine dezente Zeile unter
der Werkzeugleiste die Token- und Kostensumme der gerade geöffneten
Unterhaltung.

## 🛠️ Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Backend nicht erreichbar" beim Einrichten | URL prüfen (https, kein abschließender `/`), Backend/Proxy erreichbar? |
| „Token ungültig" | Token im Ticket-System prüfen (widerrufen/abgelaufen?) und ggf. neu ausstellen lassen, dann in den Integrationseinstellungen das neue Token eintragen |
| „Chat ist nicht eingerichtet" im Panel | Für den Kunden ist kein Chat-Agent hinterlegt — Dienstleister kontaktieren |
| Panel fehlt nach Update | Browser-Cache leeren / harte Aktualisierung (Strg+F5) |

## 🔑 Token erneuern (Reauth)

Läuft das Integrations-Token ab oder wird es widerrufen, meldet die Integration
automatisch **„Erneute Authentifizierung erforderlich"**. Dort das neue Token
eintragen — die Integration lädt sich danach selbst neu, Einrichtung und
Unterhaltungen bleiben erhalten.

## 🧑‍💻 Entwicklung

Architektur-Grundprinzipien:

- `proxy.py` leitet `/api/allroggen_chat/*` mit `X-Customer-Token` an
  `<backend>/api/customer-chat/*` weiter — Token bleibt serverseitig, kein
  CORS-Problem. Bei 401 vom Backend startet die Integration automatisch den
  Reauth-Flow. Der Pfad `/stream` (SSE) wird nicht gepuffert, sondern Chunk
  für Chunk durchgereicht.
- `panel/allroggen-chat-panel.js` ist eine dependency-freie Webcomponent,
  die per `fetch` mit dem HA-Access-Token gegen die Proxy-View arbeitet.
  Realtime läuft über **SSE (Token-Streaming)**: Das Panel hält einen
  persistenten Stream auf `/stream` (EventSource kann keinen
  Authorization-Header senden, daher fetch-basiertes Frame-Parsing) und
  rendert Antwort-Token live in eine Entwurfs-Blase. Backends ohne
  Stream-Endpoint (404) oder Stream-Fehler fallen automatisch auf Polling
  zurück (alle 3 s nach dem Senden, 5 min Timeout); der Stream wird mit
  Backoff (5 s → max. 60 s) erneut versucht.

### 🧪 Tests

```bash
pip install -r requirements_test.txt
pytest tests/
```
