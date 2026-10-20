/**
 * Allroggen Support-Chat — sidebar panel webcomponent.
 *
 * Talks ONLY to Home Assistant's own API (/api/allroggen_chat/...), which the
 * integration proxies to the ticket-system backend. The per-customer token
 * never reaches the browser; HA's own session (access token) authenticates
 * the panel against the proxy.
 *
 * Realtime = SSE: a persistent fetch stream on /stream delivers assistant
 * deltas/messages/state/usage (EventSource can't send the Authorization
 * header, so frames are parsed manually). If the backend is too old (404) or
 * the stream fails, the panel falls back to polling every 3 s after sending
 * (5 min timeout) and retries the stream with backoff.
 */

const API_BASE = "/api/allroggen_chat";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const SSE_BACKOFF_START_MS = 5000;
const SSE_BACKOFF_MAX_MS = 60000;
const DRAFT_FLUSH_MS = 80; // DOM-Update-Takt beim Delta-Streaming
const CONV_REFRESH_DELAY_MS = 1500; // Debounce für Listen-Refreshs (Badges)
// requestId eines Nachkauf-Auftrags: echter v4-GUID (auch beim Laden aus
// dem localStorage geprüft — Länge allein fängt keine kaputten Einträge ab).
const TOPUP_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Material Design Icons (24x24), eingefärbt über currentColor.
const ICON_PAPERCLIP =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M16.5,6V17.5A4,4 0 0,1 12.5,21.5A4,4 0 0,1 8.5,17.5V5A2.5,2.5 0 0,1 11,2.5A2.5,2.5 0 0,1 13.5,5V15.5A1,1 0 0,1 12.5,16.5A1,1 0 0,1 11.5,15.5V6H10V15.5A2.5,2.5 0 0,0 12.5,18A2.5,2.5 0 0,0 15,15.5V5A4,4 0 0,0 11,1A4,4 0 0,0 7,5V17.5A5.5,5.5 0 0,0 12.5,23A5.5,5.5 0 0,0 18,17.5V6H16.5Z"/></svg>';
const ICON_MIC =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z"/></svg>';
const ICON_SEND =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M2,21L23,12L2,3V10L17,12L2,14V21Z"/></svg>';
// mdi:forum — Unterhaltungsliste (bewusst KEIN Hamburger, damit der Button
// nicht mit HAs eigenem Sidebar-Toggle verwechselt wird).
const ICON_FORUM =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M17,12V3A1,1 0 0,0 16,2H3A1,1 0 0,0 2,3V17L6,13H16A1,1 0 0,0 17,12M21,6H19V15H6V17A1,1 0 0,0 7,18H18L22,22V7A1,1 0 0,0 21,6Z"/></svg>';

class AllroggenChatPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._conversations = [];
    this._conversation = null; // full conversation with messages
    this._busy = false;
    this._busyConversationId = null; // Unterhaltung des laufenden Turns — unabhängig von der offenen Ansicht
    this._busyUserMessageId = null; // User-Nachricht-ID des laufenden Turns (Selbstheilung nach Stream-Lücke)
    this._error = null;
    this._detailsOpen = false;
    this._search = "";
    this._menuOpen = false;
    this._restoredText = null;
    this._forking = false;
    this._pollTimer = null;
    this._draft = ""; // streamed assistant text, not yet persisted
    this._draftFlushTimer = null; // drosselt DOM-Updates beim Delta-Streaming
    this._convRefreshTimer = null; // debounced Refresh der Unterhaltungsliste
    this._mounted = true;
    this._sseOk = false; // stream usable; false → polling fallback on send
    this._sseAbort = null; // AbortController for the current stream fetch
    this._sseBackoff = SSE_BACKOFF_START_MS;
    this._sseReconnectTimer = null;
    this._healAfterGap = false; // Stream nach Lücke neu verbunden → Zustand nachziehen
    this._pendingImage = null; // { base64, contentType, fileName, previewUrl }
    this._attachmentUrls = new Map(); // messageId → object URL
    this._attachmentPromises = new Map(); // messageId → Promise<object URL>
    this._cancelling = false; // cancel requested, waiting for terminal event
    this._recognition = null; // active SpeechRecognition instance
    this._recording = false;
    this._speechError = null;
    this._speechBase = ""; // input content before dictation started
    this._speechFinal = ""; // committed final transcripts of this session
    this._nearBottom = true; // Nutzer ist (fast) am unteren Ende der Nachrichten
    this._unseenBelow = false; // neue Inhalte unterhalb der sichtbaren Position
    this._lastScrollTop = 0; // Unterscheidung Nutzer-Scroll vs. Content-Wachstum
    this._narrow = false; // schmaler Container → Sidebar als Overlay-Drawer
    this._haNarrow = false; // HA-Viewport ist narrow (Property vom Panel-Host)
    this._drawerOpen = false; // Drawer im narrow-Modus
    this._resizeObserver = null;
    try {
      this._sidebarCollapsed =
        localStorage.getItem("allroggenChat.sidebarCollapsed") === "1";
    } catch (_) {
      this._sidebarCollapsed = false;
    }
    try {
      this._lastSeen = new Map(
        Object.entries(
          JSON.parse(localStorage.getItem("allroggenChat.lastSeen") || "{}")
        )
      );
    } catch (_) {
      this._lastSeen = new Map(); // convId → updatedAt beim letzten Ansehen
    }
    // ---- KI-Guthaben / Nachkauf -------------------------------------------
    // Ein Nachkauf-Auftrag läuft IMMER unter einer requestId (GUID). Nach
    // unklarem Netz-Ergebnis wird dieselbe ID wiederholt (Idempotenz —
    // nichts wird doppelt gekauft). Gelöscht wird sie bei EINDEUTIGEM
    // Abschluss: Erfolg (neue ID für den nächsten Kauf) ODER definitiver
    // Ablehnung durch den Server (409 topup_blocked / 400) — ein abgelehnter
    // Schlüssel wird nie wiederverwendet und vor allem nicht als "offener
    // Auftrag mit unklarem Ergebnis" angezeigt.
    this._topupOpen = false; // Guthaben-Karte aufgeklappt
    this._topupStage = null; // null | "confirm" | "sending" | "unclear" | "done"
    this._topupRequestInFlight = false; // Doppelklick-Schutz
    this._topupBlockedReasons = null; // reasons aus 409 topup_blocked
    this._topupError = null; // sonstige Fehlermeldung
    this._topupDoneStatus = null; // "granted" | "idempotent"
    this._topupDoneAmount = null; // EUR-String der Buchung
    try {
      const stored = localStorage.getItem("allroggenChat.topupRequestId");
      if (stored && TOPUP_REQUEST_ID_RE.test(stored)) {
        this._topupRequestId = stored;
      } else {
        // Defekter/veralteter Eintrag: verwerfen, sonst täuschte er für
        // immer einen nie auflösbaren "offenen Auftrag" vor.
        this._topupRequestId = null;
        if (stored) localStorage.removeItem("allroggenChat.topupRequestId");
      }
    } catch (_) {
      this._topupRequestId = null;
    }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
  }

  // Vom HA-Panel-Host gesetzt, wenn der Viewport narrow ist (Sidebar wird
  // dann zum Drawer). Steuert, ob das eigene <ha-menu-button> sichtbar ist.
  set narrow(value) {
    const v = !!value;
    if (v !== this._haNarrow) {
      this._haNarrow = v;
      if (this._hass) this._render();
    }
  }

  disconnectedCallback() {
    this._mounted = false;
    this._stopPolling();
    this._stopSpeech();
    if (this._draftFlushTimer) {
      clearTimeout(this._draftFlushTimer);
      this._draftFlushTimer = null;
    }
    if (this._convRefreshTimer) {
      clearTimeout(this._convRefreshTimer);
      this._convRefreshTimer = null;
    }
    this._clearPendingImage();
    for (const url of this._attachmentUrls.values()) URL.revokeObjectURL(url);
    this._attachmentUrls.clear();
    this._attachmentPromises.clear();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._sseReconnectTimer) {
      clearTimeout(this._sseReconnectTimer);
      this._sseReconnectTimer = null;
    }
    if (this._sseAbort) {
      this._sseAbort.abort();
      this._sseAbort = null;
    }
  }

  async _init() {
    this._render();
    // Unter ~640 px Container-Breite wird die Sidebar zum Overlay-Drawer.
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver((entries) => {
        const narrow = entries[0].contentRect.width < 640;
        if (narrow !== this._narrow) {
          this._narrow = narrow;
          if (narrow) this._drawerOpen = false; // startet eingeklappt
          this._render();
        }
      });
      this._resizeObserver.observe(this);
    }
    try {
      this._config = await this._api("GET", "config");
      const conversations = await this._api("GET", "conversations");
      // Erster Abgleich: Unterhaltungen ohne Seen-Stand gelten als gesehen —
      // sonst gäbe es beim allerersten Öffnen lauter falsche Badges.
      for (const c of conversations) {
        if (c.updatedAt && !this._lastSeen.has(c.id)) {
          this._lastSeen.set(c.id, c.updatedAt);
        }
      }
      this._lastSeenPersist();
      this._applyConversations(conversations);
      if (this._conversations.length > 0) {
        await this._openConversation(this._conversations[0].id);
      }
    } catch (err) {
      this._error = this._describeError(err);
    }
    this._render();
    this._connectStream(); // fire and forget — reconnects itself
  }

  // ---- API helper ----------------------------------------------------------

  async _api(method, path, data) {
    const resp = await fetch(`${API_BASE}/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._hass.auth.data.access_token}`,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!resp.ok) {
      let body = null;
      try { body = await resp.json(); } catch (_) { /* non-JSON */ }
      throw { status: resp.status, body };
    }
    return resp.status === 204 ? null : resp.json();
  }

  _describeError(err) {
    if (err && err.status === 503 && err.body?.error === "not_configured") {
      return "Die Chat-Integration ist nicht geladen. Bitte prüfe sie unter Einstellungen → Geräte & Dienste.";
    }
    if (err && err.status === 503) return "Der KI-Dienst ist momentan nicht verfügbar. Bitte später erneut versuchen.";
    if (err && err.status === 403) return "Für diese Aktion fehlt die Berechtigung. Bitte kontaktiere den Support.";
    if (err && err.status === 404) return "Die Unterhaltung ist nicht mehr verfügbar. Bitte öffne eine andere Unterhaltung.";
    if (err && err.status === 409) return "Diese Unterhaltung wird bereits bearbeitet. Bitte warte auf die Antwort.";
    if (err && err.status === 429) return "Das Anfragelimit ist erreicht. Bitte warte kurz und versuche es erneut.";
    if (err && err.status === 400) return "Die Anfrage konnte nicht angenommen werden. Bitte prüfe deine Eingabe.";
    if (err && err.status === 401) {
      return "Zugang ungültig — das Integrations-Token wurde widerrufen oder ist abgelaufen. Bitte in den Integrationseinstellungen ein neues Token eintragen.";
    }
    if (err && err.status === 502) {
      return "Das Support-Backend ist gerade nicht erreichbar. Bitte später erneut versuchen.";
    }
    return "Die Verbindung zum Support wurde unterbrochen. Bitte prüfe deine Verbindung und versuche es später erneut.";
  }

  /** Auch historische Providerfehler bekommen eine verständliche Zusammenfassung. */
  _friendlyError(text) {
    const raw = String(text || "");
    if (/ALL_TARGETS_SKIPPED|pre-dispatch filters/i.test(raw)) {
      return "Der KI-Dienst hat gerade kein verfügbares Modell für diese Anfrage. Bitte versuche es später erneut. Bleibt das Problem bestehen, kontaktiere den Support mit dem Fehlercode ALL_TARGETS_SKIPPED.";
    }
    if (/HTTP 50[234]|service_unavailable/i.test(raw)) return "Der KI-Dienst ist momentan nicht verfügbar. Bitte versuche es später erneut.";
    return raw || "Die Anfrage konnte nicht verarbeitet werden. Bitte kontaktiere den Support.";
  }

  // ---- SSE stream ----------------------------------------------------------

  async _connectStream() {
    if (!this._mounted) return;
    const abort = new AbortController();
    this._sseAbort = abort;
    try {
      const resp = await fetch(`${API_BASE}/stream`, {
        headers: {
          Authorization: `Bearer ${this._hass.auth.data.access_token}`,
        },
        signal: abort.signal,
      });
      if (!resp.ok || !resp.body) {
        // 404 = old backend without the stream endpoint → polling fallback.
        throw { status: resp.status };
      }
      this._sseOk = true;
      this._render();
      this._sseBackoff = SSE_BACKOFF_START_MS;
      // Nach einer Stream-Lücke könnten Events verpasst worden sein —
      // offene Unterhaltung, eigener Busy-Turn und Liste nachziehen.
      if (this._healAfterGap) {
        this._healAfterGap = false;
        this._healAfterStreamGap();
      }
      await this._readStream(resp.body);
      throw { status: 0 }; // stream ended cleanly → reconnect below
    } catch (err) {
      if (!this._mounted || abort.signal.aborted) return;
      this._sseOk = false;
      this._healAfterGap = true;
      if (this._busy && this._busyConversationId != null && this._busyUserMessageId != null && !this._pollTimer) {
        this._startPolling(this._busyConversationId, this._busyUserMessageId);
      }
      this._render();
      // 404 = old backend without the stream endpoint: stay on the polling
      // fallback, but keep retrying (backoff max 60 s) so an upgraded
      // backend is picked up without a page reload.
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (!this._mounted || this._sseReconnectTimer) return;
    this._sseReconnectTimer = setTimeout(() => {
      this._sseReconnectTimer = null;
      this._connectStream();
    }, this._sseBackoff);
    this._sseBackoff = Math.min(this._sseBackoff * 2, SSE_BACKOFF_MAX_MS);
  }

  /**
   * Nach einer Stream-Unterbrechung verpasste Events nachziehen: offene
   * Unterhaltung und Liste auffrischen; endete der eigene Turn in der Lücke
   * (terminales Event kam nie an), ihn anhand der Historie freigeben —
   * gleiche Erkennungslogik wie der Polling-Fallback.
   */
  _healAfterStreamGap() {
    this._refreshOpenConversation();
    this._scheduleConversationsRefresh();
    if (!this._busy || this._busyConversationId == null) return;
    const busyId = this._busyConversationId;
    const userId = this._busyUserMessageId || 0;
    this._api("GET", `conversations/${busyId}`)
      .then((conv) => {
        if (!this._busy || this._busyConversationId !== busyId || (this._busyUserMessageId || 0) !== userId) return;
        const done = conv.messages.some(
          (m) =>
            m.id > userId &&
            ["assistant", "error"].includes((m.role || "").toLowerCase())
        );
        if (!done) return;
        this._stopPolling();
        this._busy = false;
        this._busyConversationId = null;
        this._busyUserMessageId = null;
        this._cancelling = false;
        this._clearDraft();
        if (this._conversation && this._conversation.id === busyId) {
          this._conversation = conv;
        }
        this._render();
      })
      .catch(() => {});
  }

  async _readStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        // Frame-Ende kann \n\n oder \r\n\r\n sein (manche Proxies schreiben
        // CRLF um); ein über Chunk-Grenzen gerissener Separator wird mit dem
        // nächsten Decode vervollständigt.
        let sep = /\r?\n\r?\n/.exec(buffer);
        while (sep) {
          const frame = buffer.slice(0, sep.index);
          buffer = buffer.slice(sep.index + sep[0].length);
          this._handleSseFrame(frame);
          sep = /\r?\n\r?\n/.exec(buffer);
        }
      }
    } finally {
      try { reader.cancel(); } catch (_) { /* already done */ }
    }
  }

  _handleSseFrame(frame) {
    let event = "message";
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue; // heartbeats / comments
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return;
    let payload;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch (_) {
      return; // malformed frame — drop it, keep the stream
    }
    this._handleSseEvent(event, payload);
  }

  _handleSseEvent(event, payload) {
    if (!payload) return;
    // Terminale State-Events des laufenden Turns müssen immer verarbeitet
    // werden — auch wenn der Nutzer inzwischen eine andere Unterhaltung
    // geöffnet oder eine neue angelegt hat. Sonst bliebe der Composer für
    // immer gesperrt.
    if (
      event === "assistant.state" &&
      this._busyConversationId != null &&
      payload.conversationId === this._busyConversationId
    ) {
      this._handleTurnState(payload);
      return;
    }
    // Alles weitere rendert nur in die gerade geöffnete Unterhaltung.
    if (!this._conversation || payload.conversationId !== this._conversation.id) {
      // Aktivität in einer anderen Unterhaltung (z. B. anderer Tab oder der
      // laufende Turn nach einem Ansichtswechsel): Liste nachziehen → Badge.
      if (event === "assistant.message" || event === "assistant.state") {
        this._scheduleConversationsRefresh();
      }
      return;
    }
    switch (event) {
      case "assistant.delta":
        this._draft += payload.delta || "";
        this._scheduleDraftFlush();
        break;
      case "assistant.message":
        if (payload.message && !this._conversation.messages.some((m) => m.id === payload.message.id)) this._conversation.messages.push(payload.message);
        this._clearDraft();
        this._render();
        this._onNewContent();
        break;
      case "assistant.state":
        // Terminal-Event eines fremden Turns (z. B. anderes Browser-Tab):
        // nur die Ansicht aktualisieren, den eigenen Busy-Zustand nicht anfassen.
        if (payload.state === "done" || payload.state === "cancelled" || payload.state === "error") {
          this._refreshOpenConversation();
        }
        break;
      case "assistant.usage":
        if (payload.usage) {
          this._conversation.usage = payload.usage;
          this._updateUsageLine();
        }
        break;
    }
  }

  /** Terminalzustand des eigenen Turns: Busy freigeben, Meta-Daten nachziehen. */
  _handleTurnState(payload) {
    if (payload.state !== "done" && payload.state !== "cancelled" && payload.state !== "error") {
      return;
    }
    const finishedId = payload.conversationId;
    this._stopPolling();
    this._busy = false;
    this._busyConversationId = null;
    this._busyUserMessageId = null;
    this._cancelling = false;
    this._clearDraft();
    if (payload.state === "error") {
      this._error = this._friendlyError(payload.error);
    }
    this._render();
    // Quota/costs and the conversation list moved — refresh both. The open
    // conversation is refetched as well, in case an assistant.message event
    // was missed during a stream reconnect.
    this._api("GET", "config")
      .then((c) => { this._config = c; this._render(); })
      .catch(() => {});
    this._api("GET", "conversations")
      .then((l) => { this._applyConversations(l); this._render(); })
      .catch(() => {});
    this._refreshOpenConversation(finishedId);
  }

  /** Offene Unterhaltung neu laden (heilt verpasste SSE-Events). */
  _refreshOpenConversation(onlyId) {
    if (!this._conversation) return;
    const id = onlyId != null ? onlyId : this._conversation.id;
    if (this._conversation.id !== id) return;
    this._api("GET", `conversations/${id}`)
      .then((conv) => {
        if (this._conversation && this._conversation.id === id) {
          this._conversation = conv;
          this._render();
          this._onNewContent();
        }
      })
      .catch(() => {});
  }

  /** Draft zurücksetzen (Commit/Abbruch/Wechsel) inkl. ausstehendem Flush-Timer. */
  _clearDraft() {
    this._draft = "";
    if (this._draftFlushTimer) {
      clearTimeout(this._draftFlushTimer);
      this._draftFlushTimer = null;
    }
  }

  /**
   * Delta-Streaming drosseln: Token kommen in Bursts — ein innerHTML-Re-Write
   * plus Scroll pro Token ruckelt bei langen Antworten sichtbar. Die Bulle
   * wird maximal alle DRAFT_FLUSH_MS ms neu aufgebaut.
   */
  _scheduleDraftFlush() {
    if (this._draftFlushTimer || !this._mounted) return;
    this._draftFlushTimer = setTimeout(() => {
      this._draftFlushTimer = null;
      this._updateDraftBubble();
    }, DRAFT_FLUSH_MS);
  }

  /** Update the streaming draft bubble in place — no full re-render per token. */
  _updateDraftBubble() {
    if (!this._draft) return; // leerer Flush nach Commit — nichts tun
    const messages = this.shadowRoot && this.shadowRoot.getElementById("messages");
    if (!messages) return;
    let el = this.shadowRoot.getElementById("draft-bubble");
    if (!el) {
      const busy = messages.querySelector(".busy");
      if (busy) busy.remove();
      el = document.createElement("div");
      el.className = "msg assistant";
      el.id = "draft-bubble";
      el.innerHTML = '<div class="bubble draft"></div>';
      messages.appendChild(el);
    }
    el.firstElementChild.innerHTML = this._md(this._draft);
    this._onNewContent();
  }

  /** Live-update the per-conversation cost line (usage events are rare). */
  _updateUsageLine() {
    const el = this.shadowRoot && this.shadowRoot.getElementById("conv-usage");
    const u = this._conversation && this._conversation.usage;
    if (!el || !u) return; // the state=done re-render adds the line if missing
    el.textContent = this._usageText(u);
  }

  // ---- Conversations -------------------------------------------------------

  async _openConversation(id) {
    this._clearDraft();
    // Beim Öffnen einer Unterhaltung immer ans Ende springen.
    this._nearBottom = true;
    this._unseenBelow = false;
    this._conversation = await this._api("GET", `conversations/${id}`);
    // Öffnen markiert alles bis zum aktuellen Listen-Stand als gesehen.
    const meta = this._conversations.find((c) => c.id === id);
    if (meta && meta.updatedAt) {
      this._lastSeen.set(id, meta.updatedAt);
      this._lastSeenPersist();
    }
    this._render();
  }

  /** _openConversation mit Fehler-Banner statt unbehandelter Promise-Rejection. */
  async _openConversationSafe(id) {
    try {
      await this._openConversation(id);
    } catch (err) {
      this._error = this._describeError(err);
      this._render();
    }
  }

  async _newConversation() {
    // Bewusst KEIN _stopPolling(): Ein laufender Polling-Turn wird weiter
    // beobachtet — er räumt nur den Busy-Zustand ab und fasst die neue,
    // leere Ansicht nicht mehr an (siehe _startPolling).
    this._clearDraft();
    this._conversation = null;
    this._error = null;
    this._menuOpen = false;
    this._nearBottom = true;
    this._unseenBelow = false;
    this._drawerOpen = false;
    this._render();
  }

  async _deleteConversation() {
    if (!this._conversation) return;
    if (!confirm("Diese Unterhaltung wirklich löschen?")) return;
    const id = this._conversation.id;
    try {
      await this._api("DELETE", `conversations/${id}`);
    } catch (err) {
      this._error = this._describeError(err);
      this._render();
      return;
    }
    this._clearDraft();
    // Läuft der Turn in der gelöschten Unterhaltung, wird er hier
    // freigegeben — seine terminalen Events landen sonst ins Leere.
    if (this._busyConversationId === id) {
      this._stopPolling();
      this._busy = false;
      this._busyConversationId = null;
      this._busyUserMessageId = null;
      this._cancelling = false;
    }
    this._lastSeen.delete(id);
    this._lastSeenPersist();
    this._conversations = this._conversations.filter((c) => c.id !== id);
    this._conversation = null;
    if (this._conversations.length > 0) {
      await this._openConversationSafe(this._conversations[0].id);
    }
    this._render();
  }

  // ---- Sending + polling fallback -------------------------------------------

  async _refreshHistory() {
    try {
      const list = await this._api("GET", "conversations");
      this._applyConversations(list);
      const id = this._conversation?.id || list[0]?.id;
      if (id != null) await this._openConversation(id);
      this._error = null;
    } catch (err) { this._error = this._describeError(err); }
    this._render();
  }

  async _renameConversation() {
    const conversation = this._conversation;
    if (!conversation) return;
    const title = prompt("Titel der Unterhaltung (maximal 60 Zeichen)", conversation.title);
    if (title == null || !title.trim()) return;
    if (title.trim().length > 60) { this._error = "Der Titel darf höchstens 60 Zeichen lang sein."; this._render(); return; }
    try {
      await this._api("POST", `conversations/${conversation.id}/rename`, { title: title.trim() });
      conversation.title = title.trim();
      const item = this._conversations.find((c) => c.id === conversation.id);
      if (item) item.title = title.trim();
      this._menuOpen = false;
    } catch (err) { this._error = this._describeError(err); }
    this._render();
  }

  /** Bewusst nur bearbeiten: keine automatische Wiederholung von HA-Aktionen. */
  _reuseQuestion() {
    if (this._busy) return;
    const message = [...(this._conversation?.messages || [])].reverse().find((m) => m.role?.toLowerCase() === "user");
    if (!message) return;
    const input = this.shadowRoot.getElementById("msg");
    if (input.value && !confirm("Aktuellen Entwurf durch die letzte Frage ersetzen?")) return;
    this._restoredText = message.content;
    this._menuOpen = false;
    if (message.hasAttachment) this._error = "Bitte hänge das Bild bei Bedarf erneut an.";
    this._render();
    this.shadowRoot.getElementById("msg").focus();
  }

  _creditLabel() {
    const q = this._config?.quota;
    const included = this._toNum(q?.includedRemainingEur);
    const credit = this._toNum(q?.creditRemainingEur);
    return included != null && credit != null
      ? `Verfügbar: ${this._esc(this._eur(included + credit, q.currency))}`
      : "KI-Guthaben";
  }

  async _copyMessage(id, button) {
    const message = this._conversation?.messages.find((m) => m.id === id);
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message.content || "");
      button.textContent = "Kopiert ✓";
      button.setAttribute("aria-label", "Nachricht kopiert");
    } catch (_) {
      this._error = "Kopieren ist im Browser nicht erlaubt. Bitte markiere den Nachrichtentext und kopiere ihn manuell.";
      this._render();
    }
  }

  async _forkConversation(messageId) {
    if (this._busy || this._forking || !this._conversation) return;
    if (!confirm("Neue Unterhaltung mit dem Verlauf bis einschließlich dieser Nachricht starten? Der ursprüngliche Chat bleibt erhalten. Bereits ausgeführte Änderungen in Home Assistant werden NICHT rückgängig gemacht.")) return;
    const id = this._conversation.id;
    this._forking = true;
    this._render();
    try {
      const result = await this._api("POST", `conversations/${id}/fork`, { messageId });
      this._error = "Neue Unterhaltung erstellt. Du kannst hier weiterschreiben. Änderungen in Home Assistant bleiben bestehen.";
      await this._openConversation(result.conversationId);
      this._applyConversations(await this._api("GET", "conversations"));
    } catch (err) {
      this._error = err?.status === 404 ? "Diese Funktion benötigt ein aktuelles Support-Backend." : this._describeError(err);
      if (!err?.status || err.status >= 500) this._error += " Bitte prüfe die Unterhaltungsliste vor einem erneuten Versuch; die Fortsetzung könnte bereits erstellt worden sein.";
    } finally { this._forking = false; this._render(); }
  }

  _messageActionsHtml(m) {
    return `<div class="message-actions"><button type="button" class="message-action" data-copy="${m.id}" aria-label="Nachricht kopieren">Kopieren</button><button type="button" class="message-action" data-fork="${m.id}" title="Neue Unterhaltung bis zu dieser Nachricht · keine HA-Änderungen rückgängig machen" ${this._busy || this._forking ? "disabled" : ""}>Ab hier neu starten</button></div>`;
  }

  async _send() {
    const input = this.shadowRoot.getElementById("msg");
    const content = (input.value || "").trim();
    const image = this._pendingImage;
    if ((!content && !image) || this._busy || this._forking || !this._config?.enabled || this._config?.quota?.exceeded) return;

    this._stopSpeech();
    this._busy = true;
    // Der Turn gehört zu dieser Unterhaltung; bei ganz neuen Unterhaltungen
    // steht die echte ID erst nach der Antwort fest. Terminale Events darüber
    // geben den Busy-Zustand frei — egal, was gerade geöffnet ist.
    this._busyConversationId = this._conversation ? this._conversation.id : null;
    this._error = null;
    this._speechError = null;
    this._clearDraft();
    // Eigene Nachricht: immer ans Ende scrollen.
    this._nearBottom = true;
    this._unseenBelow = false;
    input.value = "";
    this._render();

    let result;
    try {
      const body = {
        content,
        conversationId: this._conversation ? this._conversation.id : null,
      };
      if (image) {
        body.imageBase64 = image.base64;
        body.imageContentType = image.contentType;
        body.imageFileName = image.fileName;
      }
      result = await this._api("POST", "messages", body);
      this._clearPendingImage();
      this._busyConversationId = result.conversationId;
      this._busyUserMessageId =
        result.userMessageId != null ? result.userMessageId : null;
    } catch (err) {
      this._busy = false;
      this._busyConversationId = null;
      this._busyUserMessageId = null;
      if (err && err.status === 429 && err.body && err.body.quota) {
        const q = err.body.quota;
        const reset = new Date(q.resetsAt).toLocaleDateString("de-DE");
        const t = this._config && this._config.topup;
        const topupHint =
          t && t.allowed && this._toNum(t.amountEur) > 0
            ? ` Du kannst ${this._eur(t.amountEur, q.currency) || "Guthaben"} auf Rechnung nachbuchen (€-Button oben).`
            : "";
        this._error = `Dein KI-Kontingent ist aufgebraucht (Reset am ${reset}). Tickets und Support laufen normal weiter.${topupHint}`;
        if (this._config) this._config.quota = q;
      } else {
        this._error = this._describeError(err);
      }
      // Ein Netz-/Serverfehler beweist nicht, dass die Nachricht abgelehnt wurde.
      // Entwurf behalten, aber niemals automatisch erneut absenden.
      if (!err?.status || err.status >= 500) {
        this._error += " Der Versandstatus ist unklar. Prüfe zuerst den Verlauf, bevor du erneut sendest.";
        this._api("GET", "conversations").then((list) => { this._applyConversations(list); this._render(); }).catch(() => {});
      }
      this._restoredText = content;
      this._render();
      return;
    }
    // Nach angenommenem Versand darf ein fehlgeschlagenes GET nicht als
    // Sendefehler erscheinen. Das Antwort-Tracking läuft trotzdem weiter.
    try { await this._openConversation(result.conversationId); }
    catch (_) { this._error = "Nachricht gesendet. Der Verlauf wird erneut geladen, sobald die Verbindung verfügbar ist."; }
    // Refresh the conversation list (title / ordering may have changed) —
    // entkoppelt vom Turn: Schlägt er fehl, ist die Nachricht trotzdem raus,
    // und das Antwort-Tracking (SSE/Polling) darf nicht abgebrochen werden.
    this._api("GET", "conversations")
      .then((l) => { this._applyConversations(l); this._render(); })
      .catch(() => {});
    if (this._busy) {
      // Auch bei SSE: Historie als Watchdog gegen verpasste Terminal-Events
      // (z. B. eine sehr schnelle Antwort vor der POST-Bestätigung).
      this._startPolling(result.conversationId, result.userMessageId);
    }
    this._render();
  }

  /** Composer-Textarea passend zum Inhalt wachsen lassen (max. 132 px). */
  _autoGrow(el) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }

  _startPolling(conversationId, afterMessageId) {
    this._stopPolling();
    const started = Date.now();
    let fetching = false;
    this._pollTimer = setInterval(async () => {
      if (fetching) return;
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        this._stopPolling();
        this._busy = false;
        this._busyConversationId = null;
        this._busyUserMessageId = null;
        this._cancelling = false;
        this._error = "Die Antwort dauert länger als erwartet — bitte später erneut prüfen.";
        this._render();
        return;
      }
      try {
        fetching = true;
        const conv = await this._api("GET", `conversations/${conversationId}`);
        if (!this._busy || this._busyConversationId !== conversationId || this._busyUserMessageId !== afterMessageId) return;
        // Rollen case-insensitive prüfen: SSE liefert "tool", die Historie
        // "Tool" — das Terminal-Ereignis darf davon nicht abhängen.
        const done = conv.messages.some(
          (m) =>
            m.id > afterMessageId &&
            ["assistant", "error"].includes((m.role || "").toLowerCase())
        );
        if (done) {
          this._stopPolling();
          this._busy = false;
          this._busyConversationId = null;
          this._busyUserMessageId = null;
          this._cancelling = false;
          this._clearDraft();
          // Nur in die Ansicht übernehmen, wenn die Unterhaltung noch
          // geöffnet ist — sonst wird der Turn still abgeräumt.
          if (this._conversation && this._conversation.id === conversationId) {
            this._conversation = conv;
            this._onNewContent();
          }
          // Quota may have moved — refresh config in the background.
          this._api("GET", "config")
            .then((c) => { this._config = c; this._render(); })
            .catch(() => {});
          this._api("GET", "conversations")
            .then((l) => { this._applyConversations(l); this._render(); })
            .catch(() => {});
          this._render();
        }
      } catch (_) { /* Bei temporären Fehlern weiter abgleichen. */ }
      finally { fetching = false; }
    }, POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ---- Scrollen ---------------------------------------------------------------

  _isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  /**
   * Ans Ende scrollen — per doppeltem requestAnimationFrame, damit Layout
   * und Paint nach einem _render() abgeschlossen sind.
   */
  _scrollDown(smooth) {
    const el = this.shadowRoot && this.shadowRoot.getElementById("messages");
    if (!el) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      });
    });
  }

  /**
   * Nach neuem Inhalt (Delta, Nachricht, Polling-Treffer): nur scrollen,
   * wenn der Nutzer unten ist — sonst die „Neue Nachrichten"-Pille zeigen.
   */
  _onNewContent() {
    if (this._nearBottom) {
      this._scrollDown();
    } else {
      this._unseenBelow = true;
      this._showNewMsgsPill();
    }
  }

  /** Pille ohne Full-Re-Render einblenden (z. B. während Delta-Streaming). */
  _showNewMsgsPill() {
    const wrap = this.shadowRoot && this.shadowRoot.querySelector(".messages-wrap");
    if (!wrap || this.shadowRoot.getElementById("new-msgs")) return;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "new-msgs";
    pill.id = "new-msgs";
    pill.textContent = "↓ Neue Nachrichten";
    pill.addEventListener("click", () => this._jumpToLatest());
    wrap.appendChild(pill);
  }

  _hideNewMsgsPill() {
    this._unseenBelow = false;
    const pill = this.shadowRoot && this.shadowRoot.getElementById("new-msgs");
    if (pill) pill.remove();
  }

  _jumpToLatest() {
    this._hideNewMsgsPill();
    this._nearBottom = true;
    this._scrollDown(true);
  }

  // ---- Abbrechen -------------------------------------------------------------

  async _cancel() {
    if (this._busyConversationId == null || !this._busy || this._cancelling) return;
    this._cancelling = true;
    this._render();
    try {
      // Abbrechen zielt immer auf die Unterhaltung des laufenden Turns,
      // auch wenn der Nutzer inzwischen eine andere geöffnet hat.
      await this._api("POST", `conversations/${this._busyConversationId}/cancel`);
      // _busy bleibt bestehen, bis das terminale Event eintrifft (SSE
      // assistant.state cancelled/done/error bzw. die persistierte
      // Abbruch-Nachricht im Polling-Fallback).
    } catch (err) {
      this._cancelling = false;
      this._error = this._describeError(err);
      this._render();
    }
  }

  // ---- KI-Guthaben / Nachkauf (topup) ----------------------------------------

  /** Deutsches EUR-Format für decimal-string ODER json-number (robust). */
  _toNum(v) {
    if (v == null) return null;
    const n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }

  _eur(v, currency) {
    const n = this._toNum(v);
    if (n == null) return null;
    const cur = currency || "EUR";
    const sym = cur === "EUR" ? "€" : cur;
    return `${new Intl.NumberFormat("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)} ${sym}`;
  }

  _uuid() {
    if (window.crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // RFC-4122-v4-Fallback für ältere WebViews.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * requestId des offenen Nachkauf-Auftrags — wird einmal erzeugt und
   * persistiert. Wiederholungen nach UNKLAREM Netz-Ergebnis (auch nach
   * Seiten-Reload) nutzen dieselbe ID, damit das Backend idempotent
   * antworten kann statt doppelt zu buchen; bei eindeutigem Erfolg oder
   * definitiver Ablehnung wird sie freigegeben (_clearTopupRequestId).
   *
   * Die ID ist ein reiner Idempotenz-Schlüssel und NICHT vom Kunden-Token
   * abgeleitet. Sie lebt pro Browser-Profil/Origin: Wechselt an derselben
   * HA-Instanz der Kunde (neues Token), bleibt im schlimmsten Fall ein
   * verwaister Schlüssel in localStorage übrig — serverseitig wird eine
   * requestId immer im Kontext des authentifizierten Kunden ausgewertet,
   * ein Auftrag im Namen eines anderen Kunden ist damit ausgeschlossen.
   */
  _ensureTopupRequestId() {
    if (this._topupRequestId && TOPUP_REQUEST_ID_RE.test(this._topupRequestId)) {
      return this._topupRequestId;
    }
    this._topupRequestId = this._uuid();
    try {
      localStorage.setItem("allroggenChat.topupRequestId", this._topupRequestId);
    } catch (_) { /* localStorage nicht verfügbar */ }
    return this._topupRequestId;
  }

  _clearTopupRequestId() {
    this._topupRequestId = null;
    try {
      localStorage.removeItem("allroggenChat.topupRequestId");
    } catch (_) { /* localStorage nicht verfügbar */ }
  }

  /** Verbindliche Bestätigung öffnen (kein Netz-Call, nur UI-Schritt). */
  _topupStartConfirm() {
    const t = this._config && this._config.topup;
    // Fail-closed: ohne serverseitig freigegebenen Betrag kein Angebot.
    if (!t || !t.allowed || !(this._toNum(t.amountEur) > 0)) return;
    this._topupStage = "confirm";
    this._topupError = null;
    this._render();
  }

  _topupCancel() {
    if (this._topupRequestInFlight) return; // während des Flugs nicht abbrechbar
    this._topupStage = null;
    this._topupError = null;
    this._render();
  }

  _topupClose() {
    this._topupOpen = false;
    this._topupStage = null;
    this._topupError = null;
    this._topupBlockedReasons = null;
    this._render();
  }

  /**
   * Nachkauf senden — robust gegen unklare Netz-Ergebnisse:
   * - 200 granted/idempotent → Erfolg, requestId freigeben, Config neu laden.
   * - 409 topup_blocked / 400 / 401 → DEFINITIVE Ablehnung: nichts wurde
   *   gebucht, requestId verwerfen (kein "offener Auftrag", keine Wiederver-
   *   wendung des abgelehnten Schlüssels) und Config neu laden (409).
   * - sonst (Netz/5xx)  → "unclear": Offener Auftrag bleibt mit derselben
   *   requestId bestehen; "Erneut senden" ist sicher (idempotent).
   * Ein Kauf wird NUR durch den expliziten Klick hier ausgelöst — nie still.
   */
  _sendTopup(isRetry = false) {
    const t = this._config && this._config.topup;
    if (!isRetry) {
      // Fail-closed: Ein NEUER Kauf braucht die serverseitige Freigabe samt
      // Betrag. Ein Retry eines offenen Auftrags prüft der Server selbst —
      // er antwortet idempotent (200) oder mit 409 + Gründen.
      if (!t || !t.allowed || !(this._toNum(t.amountEur) > 0)) return;
    } else if (!this._topupRequestId) {
      return; // kein offener Auftrag — nichts zu wiederholen
    }
    if (this._topupRequestInFlight) return; // Doppelklick-Schutz
    const requestId = this._ensureTopupRequestId();
    this._topupRequestInFlight = true;
    this._topupStage = "sending";
    this._topupError = null;
    this._render();
    this._api("POST", "topup", { requestId })
      .then((res) => {
        this._topupRequestInFlight = false;
        this._topupDoneStatus = res && res.status === "idempotent" ? "idempotent" : "granted";
        // Response-Betrag ist führend; t kann beim Retry null sein (Config
        // hat sich geändert) — dann bleibt null und "done" zeigt "–".
        this._topupDoneAmount =
          (res && res.amountEur != null && this._toNum(res.amountEur) != null && res.amountEur)
          || (t && t.amountEur)
          || null;
        // Eindeutiger Erfolg → Auftrag abschließen; der nächste Kauf bekommt
        // beim nächsten Bestätigen automatisch eine neue ID.
        this._clearTopupRequestId();
        this._topupStage = "done";
        this._render();
        // Config neu laden: Guthaben/topup-Zustand (allowed/pending) folgt
        // der Buchung. Schlägt das nach, holt es der nächste Turn nach.
        this._api("GET", "config")
          .then((c) => { this._config = c; this._render(); })
          .catch(() => {});
      })
      .catch((err) => {
        this._topupRequestInFlight = false;
        if (err && err.status === 409 && err.body && err.body.error === "topup_blocked") {
          this._topupStage = null;
          this._topupBlockedReasons = Array.isArray(err.body.reasons) ? err.body.reasons : [];
          // Definitive Blockade: nichts gebucht → offenen Auftrag auflösen,
          // der abgelehnte Schlüssel wird nicht wiederverwendet.
          this._clearTopupRequestId();
          this._api("GET", "config")
            .then((c) => {
              this._config = c;
              // Die frische Config liefert die Gründe autoritativ über
              // topup.reasons — die lokale 409-Kopie wird frei, damit sie
              // nicht veraltet stehen bleibt.
              this._topupBlockedReasons = null;
              this._render();
            })
            .catch(() => {});
        } else if (err && (err.status === 400 || err.status === 401)) {
          // Definitive Ablehnung (ungültiger Auftrag / Auth): nichts gebucht
          // → requestId ebenfalls verwerfen.
          this._topupStage = null;
          this._clearTopupRequestId();
          this._topupError =
            err.status === 401
              ? this._describeError(err)
              : "Der Nachkauf-Auftrag wurde abgelehnt. Bitte später erneut versuchen.";
        } else {
          // Netz unklar (Timeout, Verbindungsabbruch, 5xx/502): Der Auftrag
          // KÖNNTE bereits gebucht sein. Kein Fehlerergebnis als Erfolg
          // ausgeben — status "unclear" bietet denselben Auftrag zum
          // Wiederholen an.
          this._topupStage = "unclear";
        }
        this._render();
      });
  }

  /** Server-Reason-Codes verständlich ausformulieren (unbekannte roh — Escaping passiert im Aufrufer). */
  _topupReasonText(code) {
    const known = {
      "credit-awaiting-validated-invoice":
        "Der vorherige Nachkauf wartet noch auf eine validierte Rechnung. Der nächste Nachkauf wird möglich, sobald diese validiert ist.",
      "invoice-overdue":
        "Es gibt eine überfällige Rechnung. Bitte zuerst begleichen — danach ist der Nachkauf wieder möglich.",
      "topup-not-configured":
        "Für deinen Vertrag ist kein Nachkauf-Betrag hinterlegt. Bitte kontaktiere deinen Dienstleister.",
      "credit-product-not-configured":
        "KI-Guthabenartikel noch nicht eingerichtet. Bitte Support kontaktieren.",
      "contract-inactive":
        "Dein Vertrag ist nicht aktiv — der Nachkauf ist daher gesperrt.",
    };
    if (known[code]) return known[code];
    return `Nachkauf aktuell nicht möglich (Grund: ${code}).`;
  }

  _topupReasonsHtml(reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) return "";
    const items = reasons
      .map((r) => `<li>${this._esc(this._topupReasonText(String(r)))}</li>`)
      .join("");
    return `<ul class="topup-reasons">${items}</ul>`;
  }

  /** Kompakte EUR-Zeile unter dem Header — nur wenn das Backend die neuen Felder liefert. */
  _quotaInfoHtml() {
    const q = this._config && this._config.quota;
    if (!q) return "";
    const cur = q.currency || "EUR";
    const included = this._toNum(q.includedMonthlyEur);
    const includedLeft = this._toNum(q.includedRemainingEur);
    const credit = this._toNum(q.creditRemainingEur);
    if (included == null && includedLeft == null && credit == null) return "";
    const parts = [];
    if (included != null || includedLeft != null) {
      parts.push(
        `KI-Budget diesen Monat: <strong>${this._esc(
          this._eur(includedLeft != null ? includedLeft : 0, cur) || "–"
        )}</strong> von ${this._esc(this._eur(included != null ? included : 0, cur) || "–")} inklusive übrig`
      );
    }
    if (credit != null) {
      parts.push(`Gekauftes Guthaben: <strong>${this._esc(this._eur(credit, cur) || "–")}</strong> (bleibt erhalten)`);
    }
    const reset = q.resetsAt
      ? ` · Inklusivbudget resetzt am ${this._esc(new Date(q.resetsAt).toLocaleDateString("de-DE"))}`
      : "";
    return `<div class="quota-info">💰 ${parts.join(" · ")}${reset}</div>`;
  }

  /**
   * Notice bei erschöpftem Kontingent. Neue Backends (EUR-Felder vorhanden)
   * sagen explizit: nur die KI pausiert, Tickets/Support laufen weiter.
   * Ältere Backends ohne die neuen Felder behalten den alten Text.
   */
  _quotaNoticeHtml() {
    const c = this._config;
    const q = c && c.quota;
    if (!q || !q.exceeded) return "";
    const hasNew =
      this._toNum(q.includedMonthlyEur) != null ||
      this._toNum(q.includedRemainingEur) != null ||
      this._toNum(q.creditRemainingEur) != null;
    if (!hasNew) {
      return `<div class="notice">Monatliches Chat-Kontingent erschöpft — der Chat ist bis zum Reset pausiert.</div>`;
    }
    const reset = q.resetsAt ? new Date(q.resetsAt).toLocaleDateString("de-DE") : null;
    const resetTxt = reset ? ` bis zum Reset am ${this._esc(reset)}` : "";
    const t = c.topup;
    const topupTxt =
      t && t.allowed && this._toNum(t.amountEur) > 0
        ? ` Du kannst ${this._esc(this._eur(t.amountEur, q.currency) || "Guthaben")} auf Rechnung nachbuchen (€-Button oben).`
        : "";
    return `<div class="notice">Inklusives KI-Budget und gekauftes Guthaben sind aufgebraucht — die KI-Antwort pausiert${resetTxt}. Tickets und Support laufen normal weiter.${topupTxt}</div>`;
  }

  /** Guthaben-/Nachkauf-Karte (nur sichtbar bei aufgeklapptem Zustand). */
  _topupHtml() {
    const c = this._config || {};
    const q = c.quota || {};
    const t = c.topup;
    if (!this._topupOpen) return "";
    // Ohne topup-Objekt (älteres Backend): Karte erklärt nur das Budget,
    // zeigt aber bewusst KEIN Nachkauf-Angebot (kein erfundenes Guthaben).
    const cur = q.currency || "EUR";
    const included = this._eur(q.includedMonthlyEur, cur);
    let inner = "";

    const expl = included
      ? `<p>Dein Vertrag enthält jeden Monat <strong>${this._esc(included)}</strong> KI-Nutzung inklusive — unverbrauchter Rest verfällt zum Monatswechsel (kein Übertrag). Erst danach wird gekauftes Guthaben verbraucht; es bleibt über Monate erhalten. Ist beides aufgebraucht, pausiert nur die KI-Antwort — Tickets und Support laufen ganz normal weiter.</p>`
      : `<p>Dein Vertrag enthält jeden Monat ein KI-Budget inklusive — unverbrauchter Rest verfällt zum Monatswechsel (kein Übertrag). Erst danach wird gekauftes Guthaben verbraucht; es bleibt über Monate erhalten. Ist beides aufgebraucht, pausiert nur die KI-Antwort — Tickets und Support laufen ganz normal weiter.</p>`;

    const unresolved =
      this._topupRequestId && this._topupStage !== "done" && !this._topupRequestInFlight;
    // Bestätigungs-Ansicht nur mit weiterhin gültiger serverseitiger Freigabe
    // (ein Config-Refresh kann allowed zwischendurch kippen → Übersicht).
    const confirmValid = !!(t && t.allowed && this._toNum(t.amountEur) > 0);
    const stage = this._topupStage === "confirm" && !confirmValid ? null : this._topupStage;

    if (stage === "sending") {
      inner = `
        <div class="topup-status">⏳ Nachbuchung läuft — bitte warten, das Fenster nicht schließen …</div>`;
    } else if (stage === "unclear") {
      inner = `
        <div class="topup-status warn">⚠ Das Ergebnis der Nachbuchung ist unklar (Verbindungsproblem). Sie könnte bereits gebucht sein.</div>
        <p>Bitte <strong>erneut senden</strong>: derselbe Auftrag (gleiche Anfrage-ID <code>${this._esc(this._topupRequestId || "")}</code>) wird sicher fortgesetzt — es wird garantiert nichts doppelt gekauft.</p>
        <div class="topup-actions">
          <button type="button" class="btn-secondary" id="topup-close2">Später erneut versuchen</button>
          <button type="button" class="btn-primary" id="topup-retry">Erneut senden (gleicher Auftrag)</button>
        </div>`;
    } else if (stage === "done") {
      const amount = this._eur(this._topupDoneAmount, cur);
      const msg = this._topupDoneStatus === "idempotent"
        ? `Dieser Nachkauf war bereits gebucht — Guthaben über <strong>${this._esc(amount || "–")}</strong> ist aktiv. Nichts wurde doppelt gekauft.`
        : `Guthaben über <strong>${this._esc(amount || "–")}</strong> wurde gebucht und ist sofort aktiviert.`;
      inner = `
        <div class="topup-status ok">✓ ${msg}</div>
        <p>Der Betrag wird auf deiner nächsten Rechnung ausgewiesen. Ein weiterer Nachkauf ist erst möglich, wenn dieser auf einer validierten Rechnung erfasst ist.</p>
        <div class="topup-actions">
          <button type="button" class="btn-primary" id="topup-close">Schließen</button>
        </div>`;
    } else if (stage === "confirm") {
      const amount = this._eur(t && t.amountEur, cur);
      inner = `
        <div class="topup-confirm-line">Kostenpflichtig: <strong>${this._esc(amount || "–")}</strong> auf Rechnung nachbuchen</div>
        <ul class="topup-details">
          <li>Sofort nutzbar, sobald die Buchhaltung (ERP) die Buchung annimmt — in der Regel sofort.</li>
          <li>Wird erst nach dem Inklusivbudget verbraucht und verfällt nicht.</li>
          <li>Wird auf deiner nächsten Rechnung ausgewiesen.</li>
          <li>Ein weiterer Nachkauf ist erst möglich, wenn dieser auf einer validierten Rechnung erfasst ist.</li>
        </ul>
        <div class="topup-actions">
          <button type="button" class="btn-secondary" id="topup-back">Zurück</button>
          <button type="button" class="btn-danger" id="topup-confirm">Kostenpflichtig: ${this._esc(amount || "–")} auf Rechnung nachbuchen</button>
        </div>`;
    } else {
      // Übersicht
      const stateParts = [];
      const credit = this._eur(q.creditRemainingEur, cur);
      if (credit) stateParts.push(`Gekauftes Guthaben übrig: <strong>${this._esc(credit)}</strong>.`);
      const pending = t && t.pending;
      if (pending) {
        stateParts.push(
          `<div class="topup-status warn">⏳ Ein Nachkauf liegt bereits auf einer Rechnung, die noch nicht validiert ist. Der nächste Nachkauf wird möglich, sobald diese validiert wurde.</div>`
        );
      }
      let action = "";
      if (t && t.allowed && this._toNum(t.amountEur) > 0) {
        action = `
          <div class="topup-actions">
            <button type="button" class="btn-primary" id="topup-start">Nachkauf starten — ${this._esc(this._eur(t.amountEur, cur) || "–")} auf Rechnung</button>
          </div>`;
      } else if (t && Array.isArray(t.reasons) && t.reasons.length > 0) {
        stateParts.push(`<div class="topup-blocked">Nachkauf aktuell nicht möglich:${this._topupReasonsHtml(t.reasons)}</div>`);
      } else if (t && !t.allowed && !pending) {
        stateParts.push(`<div class="topup-blocked">Nachkauf aktuell nicht möglich. Bitte kontaktiere deinen Dienstleister.</div>`);
      }
      if (this._topupBlockedReasons) {
        stateParts.push(`<div class="topup-blocked">Der Nachkauf wurde abgelehnt:${this._topupReasonsHtml(this._topupBlockedReasons)}</div>`);
      }
      if (this._topupError) {
        stateParts.push(`<div class="topup-status warn">⚠ ${this._esc(this._topupError)}</div>`);
      }
      if (unresolved) {
        stateParts.push(`
          <div class="topup-status warn">⚠ Es gibt einen noch nicht abgeschlossenen Nachkauf-Auftrag (Ergebnis unklar). Erneutes Senden ist sicher — derselbe Auftrag wird fortgesetzt, nichts wird doppelt gekauft.</div>
          <div class="topup-actions"><button type="button" class="btn-primary" id="topup-retry">Auftrag erneut senden</button></div>`);
      }
      inner = `${expl}<div class="topup-state">${stateParts.join("")}</div>${action}`;
    }

    return `
      <div class="topup-card">
        <div class="topup-head">
          <strong>KI-Guthaben &amp; Nachkauf</strong>
          <button type="button" class="conv-del" id="topup-x" title="Schließen">✕</button>
        </div>
        ${inner}
      </div>`;
  }

  /** Warn-Hinweis auf dem €-Chip: offener Auftrag, Pending oder leerer Chat. */
  _topupAlert() {
    const t = this._config && this._config.topup;
    const q = this._config && this._config.quota;
    if (this._topupRequestId && this._topupStage !== "done") return true;
    if (t && t.pending) return true;
    if (q && q.exceeded && t && t.allowed) return true;
    return false;
  }


  async _handleImageFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      this._error = "Nur Bilddateien können angehängt werden.";
      this._render();
      return;
    }
    try {
      let blob = file;
      let contentType = file.type;
      // Kleine Bilder unverändert lassen, große clientseitig als JPEG
      // verkleinern (max. 1600 px, Qualität 0.85).
      if (file.size >= 300 * 1024) {
        const downscaled = await this._downscaleImage(file);
        if (downscaled) {
          blob = downscaled;
          contentType = "image/jpeg";
        }
      }
      const base64 = await this._blobToBase64(blob);
      this._clearPendingImage();
      this._pendingImage = {
        base64,
        contentType,
        fileName: file.name,
        previewUrl: URL.createObjectURL(blob),
      };
    } catch (_) {
      this._error = "Das Bild konnte nicht verarbeitet werden.";
    }
    this._render();
  }

  _downscaleImage(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 1600;
        let { width, height } = img;
        if (width > max || height > max) {
          const scale = max / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null); // Fallback: Originaldatei verwenden
      };
      img.src = url;
    });
  }

  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  _clearPendingImage() {
    if (this._pendingImage && this._pendingImage.previewUrl) {
      URL.revokeObjectURL(this._pendingImage.previewUrl);
    }
    this._pendingImage = null;
  }

  // ---- Spracheingabe (Web Speech API) ------------------------------------------

  _speechSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  _toggleSpeech() {
    if (this._recording) {
      this._stopSpeech();
      this._render();
      return;
    }
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return;
    const input = this.shadowRoot.getElementById("msg");
    this._speechBase = input && input.value ? input.value.trimEnd() + " " : "";
    this._speechFinal = "";
    const rec = new Ctor();
    rec.lang = "de-DE";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this._speechFinal += r[0].transcript;
        else interim += r[0].transcript;
      }
      const el = this.shadowRoot.getElementById("msg");
      if (el) {
        el.value = this._speechBase + this._speechFinal + interim;
        this._autoGrow(el);
      }
    };
    rec.onerror = (e) => {
      this._speechError =
        e && e.error === "not-allowed"
          ? "Mikrofon-Zugriff verweigert — bitte im Browser freigeben."
          : "Spracherkennung fehlgeschlagen.";
      this._stopSpeech();
      this._render();
    };
    rec.onend = () => {
      this._stopSpeech();
      this._render();
    };
    this._recognition = rec;
    this._recording = true;
    this._speechError = null;
    try {
      rec.start();
    } catch (_) {
      this._stopSpeech();
    }
    this._render();
  }

  _stopSpeech() {
    if (this._recognition) {
      try { this._recognition.stop(); } catch (_) { /* schon beendet */ }
      this._recognition = null;
    }
    this._recording = false;
  }

  // ---- Anhänge in Nachrichten ----------------------------------------------------

  /** Object-URL für den Anhang einer User-Nachricht (ein Fetch pro id). */
  _attachmentUrl(messageId) {
    if (!this._attachmentPromises.has(messageId)) {
      this._attachmentPromises.set(
        messageId,
        (async () => {
          const resp = await fetch(`${API_BASE}/messages/${messageId}/attachment`, {
            headers: {
              Authorization: `Bearer ${this._hass.auth.data.access_token}`,
            },
          });
          if (!resp.ok) throw { status: resp.status };
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          this._attachmentUrls.set(messageId, url);
          return url;
        })()
      );
    }
    return this._attachmentPromises.get(messageId);
  }

  /** Anhang-Bilder nach einem _render() nachladen (img src wird verworfen). */
  _loadAttachments() {
    const imgs = this.shadowRoot.querySelectorAll("img.attachment[data-attachment-id]");
    for (const img of imgs) {
      img.addEventListener("load", () => {
        // Nachgeladene Bilder verschieben das Layout — unten mitziehen.
        if (this._nearBottom) this._scrollDown();
      });
      this._attachmentUrl(Number(img.dataset.attachmentId))
        .then((url) => {
          if (img.isConnected) {
            img.src = url;
            img.hidden = false;
          }
        })
        .catch(() => { /* Platzhalter bleibt verborgen */ });
    }
  }

  // ---- Sidebar (Unterhaltungsliste) -------------------------------------------

  _toggleSidebar() {
    if (this._narrow) {
      this._drawerOpen = !this._drawerOpen;
    } else {
      this._sidebarCollapsed = !this._sidebarCollapsed;
      try {
        localStorage.setItem(
          "allroggenChat.sidebarCollapsed",
          this._sidebarCollapsed ? "1" : "0"
        );
      } catch (_) { /* localStorage nicht verfügbar */ }
    }
    this._render();
  }

  _selectConversation(id) {
    if (this._narrow) this._drawerOpen = false; // Drawer nach Auswahl schließen
    if (this._conversation && this._conversation.id === id) {
      this._render();
      return;
    }
    this._openConversationSafe(id);
  }

  // ---- Ungesehene Aktivität (Badges) ----------------------------------------

  _lastSeenPersist() {
    try {
      localStorage.setItem(
        "allroggenChat.lastSeen",
        JSON.stringify(Object.fromEntries(this._lastSeen))
      );
    } catch (_) { /* localStorage nicht verfügbar */ }
  }

  /** Conversations-Liste übernehmen; die offene Unterhaltung gilt als gesehen. */
  _applyConversations(list) {
    this._conversations = list;
    if (this._conversation) {
      const open = list.find((c) => c.id === this._conversation.id);
      if (open && open.updatedAt) {
        this._lastSeen.set(open.id, open.updatedAt);
        this._lastSeenPersist();
      }
    }
  }

  /** true, wenn es seit dem letzten Ansehen Aktivität in der Unterhaltung gab. */
  _hasUnseen(c) {
    if (!c.updatedAt) return false;
    const seen = this._lastSeen.get(c.id);
    return seen !== undefined && c.updatedAt > seen;
  }

  _unseenCount() {
    return this._conversations.filter((c) => this._hasUnseen(c)).length;
  }

  /** Debounced Refresh der Liste (Aktivität in anderen Unterhaltungen). */
  _scheduleConversationsRefresh() {
    if (this._convRefreshTimer || !this._mounted) return;
    this._convRefreshTimer = setTimeout(() => {
      this._convRefreshTimer = null;
      this._api("GET", "conversations")
        .then((l) => { this._applyConversations(l); this._render(); })
        .catch(() => {});
    }, CONV_REFRESH_DELAY_MS);
  }

  /** Kurzdatum der letzten Aktivität einer Unterhaltung („06.08., 14:32“). */
  _convDateHtml(c) {
    if (!c.updatedAt) return "";
    const d = new Date(c.updatedAt);
    if (isNaN(d.getTime())) return "";
    const date = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
    const time = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    const unseen = this._hasUnseen(c) ? ` <span class="conv-new">neu</span>` : "";
    return `<div class="conv-date">${date}, ${time}${unseen}</div>`;
  }

  _sidebarHtml() {
    const cards = this._conversations
      .filter((c) => !this._search || String(c.title).toLocaleLowerCase("de").includes(this._search.toLocaleLowerCase("de")))
      .map((c) => {
        const active = this._conversation && this._conversation.id === c.id;
        return `
          <button type="button" class="conv-card ${active ? "active" : ""}" data-conv-id="${c.id}" ${active ? 'aria-current="true"' : ""}>
            <span class="conv-title">${this._esc(c.title)}</span>
            ${this._convDateHtml(c)}
          </button>`;
      })
      .join("");
    return `
      <aside class="sidebar" aria-label="Unterhaltungen" ${this._narrow && !this._drawerOpen ? "inert" : ""}>
        <button type="button" class="new-btn" id="new">+ Neue Unterhaltung</button>
        <input type="search" id="conv-search" aria-label="Unterhaltungen durchsuchen" placeholder="Unterhaltungen suchen…" value="${this._esc(this._search)}" />
        <div class="conv-list" id="conv-list">
          ${cards || `<div class="conv-empty">${this._search ? "Keine passende Unterhaltung." : "Noch keine Unterhaltungen."}</div>`}
        </div>
      </aside>
      <div class="backdrop" id="backdrop"></div>`;
  }

  // ---- Rendering -----------------------------------------------------------

  /** Escaping für Text- UND Attribut-Kontexte — Anführungszeichen gehören dazu. */
  _esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /**
   * Markdown-light: Code-Blöcke, Listen, bold, italic, inline code, Umbrüche.
   * Der Input wird zuerst komplett escapet, dann zeilenweise strukturiert.
   */
  _md(s) {
    const inline = (t) => t
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
    const out = [];
    let listTag = null; // "ul" | "ol" — aktuell offene Liste
    let listItems = [];
    let code = null; // Inhalt eines offenen ```-Codeblocks
    const closeList = () => {
      if (listTag) {
        out.push(`<${listTag}>${listItems.join("")}</${listTag}>`);
        listTag = null;
        listItems = [];
      }
    };
    for (const line of this._esc(s).split("\n")) {
      if (code !== null) {
        if (/^\s*```/.test(line)) {
          // &#10; statt \n — die globale Umbruch-Ersetzung unten darf den
          // Code-Inhalt nicht anfassen; im Browser wird &#10; innerhalb
          // von pre wieder als Zeilenumbruch gerendert.
          out.push(`<pre><code>${code.replace(/\n$/, "").replace(/\n/g, "&#10;")}</code></pre>`);
          code = null;
        } else {
          code += `${line}\n`;
        }
        continue;
      }
      if (/^\s*```/.test(line)) {
        closeList();
        code = "";
        continue;
      }
      const ul = line.match(/^\s*[-*] +(.*)$/);
      const ol = line.match(/^\s*\d+[.)] +(.*)$/);
      if (ul) {
        if (listTag !== "ul") { closeList(); listTag = "ul"; }
        listItems.push(`<li>${inline(ul[1])}</li>`);
      } else if (ol) {
        if (listTag !== "ol") { closeList(); listTag = "ol"; }
        listItems.push(`<li>${inline(ol[1])}</li>`);
      } else {
        closeList();
        out.push(inline(line));
      }
    }
    closeList();
    if (code !== null) {
      out.push(`<pre><code>${code.replace(/\n$/, "").replace(/\n/g, "&#10;")}</code></pre>`);
    }
    return out.join("\n").replace(/\n/g, "<br>")
      .replace(/(<\/(?:ul|ol|pre)>)(?:<br>)+/g, "$1")
      .replace(/(?:<br>)+(<(?:ul|ol|pre)>)/g, "$1");
  }

  /** Kontingent-Ring im Header: Prozent des Inklusivbudgets; EUR-Details in der Zeile darunter. */
  _quotaHtml() {
    const q = this._config && this._config.quota;
    const included = this._toNum(q?.includedMonthlyEur);
    const left = this._toNum(q?.includedRemainingEur);
    const limit = included != null ? included : this._toNum(q?.costLimit);
    if (!q || !(limit > 0)) return "";
    const used = included != null && left != null ? included - left : Number(q.usedCost || 0);
    const pct = Math.max(0, Math.min(100, Math.round(used / limit * 100)));
    const cls = q.exceeded ? "quota-exceeded" : q.warning ? "quota-warning" : "";
    const reset = new Date(q.resetsAt).toLocaleDateString("de-DE");
    const cur = q.currency || "EUR";
    const credit = this._toNum(q.creditRemainingEur);
    const creditInfo = credit != null && credit > 0
      ? ` · Gekauftes Guthaben: ${this._esc(this._eur(credit, cur))} (wird nach dem Inklusivbudget verbraucht)`
      : "";
    return `
      <div class="quota ${cls}" title="${pct} % des Monatskontingents verbraucht · Reset am ${reset}${creditInfo}">
        <svg viewBox="0 0 36 36" class="quota-ring" role="img" aria-label="${pct} % des Monatskontingents verbraucht">
          <circle class="ring-track" cx="18" cy="18" r="15.9155"></circle>
          <circle class="ring-fill" cx="18" cy="18" r="15.9155" stroke-dasharray="${pct} ${100 - pct}"></circle>
          <text class="ring-text" x="18" y="18" text-anchor="middle" dominant-baseline="central">${pct} %</text>
        </svg>
      </div>`;
  }

  _modelHtml() {
    const c = this._config;
    if (!c || !c.enabled || !c.modelName) return "";
    const parts = [this._esc(c.modelName)];
    if (c.providerName) parts[0] = `${this._esc(c.providerName)} · ${parts[0]}`;
    if (c.contextWindowTokens) {
      parts.push(`Kontext: ${Number(c.contextWindowTokens).toLocaleString("de-DE")} Token`);
    }
    return `<div class="model-info">⚙ ${parts.join(" · ")}</div>`;
  }

  _usageText(u) {
    const tokens = Number(u.totalTokens).toLocaleString("de-DE");
    let text = `Diese Unterhaltung: ${tokens} Tokens`;
    // Kontext-Füllstand: tatsächliche Input-Tokens der letzten Runde im
    // Verhältnis zum Kontextfenster des Modells (Backend liefert beides im
    // Usage-Objekt; das Fenster aus der Config dient als Fallback).
    const win = Number(u.contextWindowTokens || (this._config && this._config.contextWindowTokens) || 0);
    if (u.lastInputTokens && win > 0) {
      const pct = Math.round((Number(u.lastInputTokens) / win) * 100);
      text += pct >= 85
        ? ` · ⚠ Kontext zu ${pct} % belegt — bald neue Unterhaltung nötig`
        : ` · Kontext ${pct} % belegt`;
    }
    return text;
  }

  _usageHtml() {
    const u = this._conversation && this._conversation.usage;
    if (!u) return "";
    return `<div class="conv-usage" id="conv-usage">${this._esc(this._usageText(u))}</div>`;
  }

  /** Zeitstempel unter einer Nachricht (HH:MM, de-DE). */
  _timeHtml(m) {
    const d = new Date(m.sentAt);
    if (isNaN(d.getTime())) return "";
    const t = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    return `<div class="meta">${t}</div>`;
  }

  /** Label für den Tages-Trenner: „Heute“ / „Gestern“ / Datum. */
  _dayLabel(d) {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Heute";
    if (d.toDateString() === yesterday.toDateString()) return "Gestern";
    return d.toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
  }

  _messageHtml(m) {
    // Groß-/Kleinschreibung ignorieren: Live-SSE-Events liefern die Rolle
    // ggf. anders serialisiert ("tool") als die gespeicherte Historie ("Tool").
    const role = (m.role || "").toLowerCase();
    if (role === "user") {
      const img = m.hasAttachment
        ? `<img class="attachment" data-attachment-id="${m.id}" alt="${this._esc(m.attachmentFileName || "Anhang")}" hidden />`
        : "";
      return `<div class="msg user"><div class="bubble">${img}${this._md(m.content)}</div>${this._timeHtml(m)}${this._messageActionsHtml(m)}</div>`;
    }
    if (role === "tool") {
      return `<div class="msg tool">⚙️ ${this._esc(m.content).slice(0, 120)}</div>`;
    }
    if (role === "error") {
      const friendly = this._friendlyError(m.content);
      const details = friendly !== m.content ? `<details data-state-key="error-${m.id}"><summary>Technische Details</summary><pre>${this._esc(m.content)}</pre></details>` : "";
      return `<div class="msg assistant"><div class="bubble error"><strong>Antwort nicht möglich</strong><p>${this._esc(friendly)}</p>${details}</div>${this._timeHtml(m)}${this._messageActionsHtml(m)}</div>`;
    }
    return `<div class="msg assistant"><div class="bubble">${this._md(m.content)}</div>${this._timeHtml(m)}${this._messageActionsHtml(m)}</div>`;
  }

  _messagesHtml() {
    if (this._conversation === null) {
      return `<div class="empty"><div class="empty-icon">💬</div><h2>Wie kann ich dir helfen?</h2><p>Fragen zu deinem Smart Home, Automationen oder einem Problem — wir schauen gemeinsam drauf.</p><div class="suggestions">${["Welche Automationen sind gerade aktiv?", "Hilf mir, eine Automation anzupassen.", "Ich habe ein Problem mit meinem Smart Home."].map((s) => `<button type="button" class="btn-secondary suggestion" data-prompt="${this._esc(s)}">${this._esc(s)}</button>`).join("")}</div></div>`;
    }
    if (this._conversation.messages.length === 0) {
      return `<div class="empty"><div class="empty-icon">⏳</div>Lade…</div>`;
    }
    // Nach Kalendertag gruppieren, Trenner zwischen den Gruppen.
    const parts = [];
    let lastDay = "";
    for (const m of this._conversation.messages) {
      const d = new Date(m.sentAt);
      const dayKey = isNaN(d.getTime()) ? "" : d.toDateString();
      if (dayKey && dayKey !== lastDay) {
        parts.push(`<div class="day-sep"><span>${this._dayLabel(d)}</span></div>`);
        lastDay = dayKey;
      }
      parts.push(this._messageHtml(m));
    }
    return parts.join("");
  }

  _render() {
    if (!this.shadowRoot) return;
    // Preserve the composer's content and focus across the full re-render.
    const prevInput = this.shadowRoot.getElementById("msg");
    const prevValue = prevInput ? prevInput.value : "";
    const activeId = this.shadowRoot.activeElement?.id;
    const selection = prevInput ? [prevInput.selectionStart, prevInput.selectionEnd] : [0, 0];
    const openDetails = [...this.shadowRoot.querySelectorAll("details[open][data-state-key]")].map((el) => el.dataset.stateKey);
    const hadFocus = prevInput !== null && this.shadowRoot.activeElement === prevInput;
    // Scroll-Position merken, wenn der Nutzer weiter oben liest.
    const prevMessages = this.shadowRoot.getElementById("messages");
    const prevScrollTop = prevMessages ? prevMessages.scrollTop : 0;
    // Scroll-Position der Sidebar-Liste über den Re-Render behalten.
    const prevConvList = this.shadowRoot.getElementById("conv-list");
    const prevConvScrollTop = prevConvList ? prevConvList.scrollTop : 0;
    const agentName = this._config && this._config.assistantName
      ? this._config.assistantName
      : "Support";
    const noAgent = this._config && !this._config.enabled;
    const quotaExceeded = this._config && this._config.quota && this._config.quota.exceeded;
    const inputDisabled = this._busy || this._forking || !this._config || noAgent || quotaExceeded;
    // Zähler für Unterhaltungen mit ungelesener Aktivität (wie der
    // Reparaturen-Zähler — nur eben im Panel, HA-Seitenleiste bietet dafür
    // für Custom Panels keine Badge-API).
    const unseenCount = this._unseenCount();
    const hasTopup = !!(this._config && this._config.topup);
    const quotaInfo = this._quotaInfoHtml();
    const topupAlert = this._topupAlert();

    const wrapClasses = [
      "wrap",
      this._narrow ? "narrow" : "",
      this._narrow && this._drawerOpen ? "drawer-open" : "",
      !this._narrow && this._sidebarCollapsed ? "sidebar-collapsed" : "",
    ].filter(Boolean).join(" ");

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: calc(100vh - var(--header-height, 64px)); height: calc(100dvh - var(--header-height, 64px)); }
        .wrap { display: flex; flex-direction: column; height: 100%; max-height: 100%; overflow: hidden; padding: 16px 16px 12px; box-sizing: border-box; gap: 8px; }

        /* Header */
        .header { display: flex; align-items: center; gap: 12px; }
        .ha-menu { flex-shrink: 0; margin-left: -8px; color: var(--primary-text-color, #222); }
        .avatar { width: 42px; height: 42px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 600; color: #fff; background: var(--primary-color, #03a9f4); background: linear-gradient(135deg, var(--primary-color, #03a9f4), var(--accent-color, #5c6bc0)); overflow: hidden; }
        .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .header-text { flex: 1; min-width: 0; }
        .header h1 { font-size: 18px; margin: 0; font-weight: 600; }
        .quota { flex-shrink: 0; display: flex; align-items: center; }
        .quota-ring { width: 38px; height: 38px; display: block; }
        .quota-ring .ring-track { fill: none; stroke: var(--divider-color, #ddd); stroke-width: 3.5; }
        .quota-ring .ring-fill { fill: none; stroke: var(--primary-color, #03a9f4); stroke-width: 3.5; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dasharray 0.3s; }
        .quota-warning .ring-fill { stroke: #f57c00; }
        .quota-exceeded .ring-fill { stroke: #d32f2f; }
        .quota-ring .ring-text { font-size: 8.5px; fill: var(--secondary-text-color, #666); }
        .model-info, .conv-usage { font-size: 12px; color: var(--secondary-text-color, #666); }

        /* Buttons */
        button { font: inherit; border: none; cursor: pointer; }
        button:disabled { opacity: 0.5; cursor: default; }
        button:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 1px; }

        /* Body: Sidebar + Hauptspalte — nur .messages bzw. .conv-list scrollen */
        .body { position: relative; flex: 1; min-height: 0; display: flex; gap: 12px; }
        .main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
        .sidebar { width: 240px; flex-shrink: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
        .sidebar-collapsed .sidebar { display: none; }
        .new-btn { padding: 9px 14px; border-radius: 10px; background: var(--primary-color, #03a9f4); color: #fff; font-size: 13px; font-weight: 600; }
        .new-btn:hover { filter: brightness(1.1); }
        .conv-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 2px; }
        .conv-list::-webkit-scrollbar { width: 6px; }
        .conv-list::-webkit-scrollbar-thumb { background: var(--divider-color, #ccc); border-radius: 3px; }
        .conv-list::-webkit-scrollbar-track { background: transparent; }
        .conv-card { position: relative; text-align: left; width: 100%; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--divider-color, #e2e2e2); border-left: 3px solid transparent; background: var(--card-background-color, #fff); cursor: pointer; }
        .conv-card:hover { background: var(--secondary-background-color, #f3f3f3); }
        .conv-card.active { border-left-color: var(--primary-color, #03a9f4); background: var(--secondary-background-color, #f3f3f3); }
        .conv-title { font-size: 13px; font-weight: 500; color: var(--primary-text-color, #222); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .conv-card.active .conv-title { padding-right: 20px; }
        .conv-date { font-size: 11px; color: var(--secondary-text-color, #888); margin-top: 4px; }
        .conv-new { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; background: var(--error-color, #db4437); color: #fff; font-size: 10px; font-weight: 600; vertical-align: 1px; }
        .conv-del { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; background: transparent; color: var(--secondary-text-color, #888); font-size: 11px; display: flex; align-items: center; justify-content: center; }
        .conv-del:hover { background: #fdecea; color: #b71c1c; }
        .conv-empty { font-size: 12px; color: var(--secondary-text-color, #888); text-align: center; padding: 16px 8px; }
        .backdrop { display: none; }
        .narrow .sidebar { position: absolute; left: 0; top: 0; bottom: 0; z-index: 5; width: 260px; padding: 8px; background: var(--card-background-color, #fff); border-right: 1px solid var(--divider-color, #ddd); box-shadow: 2px 0 12px rgba(0,0,0,0.25); transform: translateX(-110%); transition: transform 0.2s ease; }
        .narrow.drawer-open .sidebar { transform: none; }
        .narrow.drawer-open .backdrop { display: block; position: absolute; inset: 0; z-index: 4; background: rgba(0,0,0,0.35); }

        /* Nachrichten */
        .messages-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
        .messages { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 6px; display: flex; flex-direction: column; gap: 10px; }
        .day-sep { display: flex; align-items: center; justify-content: center; margin: 4px 0 0; }
        .day-sep span { font-size: 11px; color: var(--secondary-text-color, #888); background: var(--secondary-background-color, #eee); padding: 3px 12px; border-radius: 999px; }
        .messages::-webkit-scrollbar { width: 6px; }
        .messages::-webkit-scrollbar-thumb { background: var(--divider-color, #ccc); border-radius: 3px; }
        .messages::-webkit-scrollbar-track { background: transparent; }
        .empty { margin: auto; padding: 24px; text-align: center; color: var(--secondary-text-color, #666); }
        .empty .empty-icon { font-size: 40px; margin-bottom: 8px; }
        .msg { display: flex; flex-direction: column; align-items: flex-start; }
        .msg.user { align-items: flex-end; }
        .msg.tool { align-items: center; font-size: 12px; font-style: italic; color: var(--secondary-text-color, #888); }
        .bubble { max-width: 78%; padding: 10px 14px; border-radius: 16px; border-bottom-left-radius: 4px; background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #e2e2e2); box-shadow: 0 1px 2px rgba(0,0,0,0.07); color: var(--primary-text-color, #222); line-height: 1.45; word-wrap: break-word; }
        .msg.user .bubble { background: var(--primary-color, #03a9f4); background: linear-gradient(135deg, var(--primary-color, #03a9f4), color-mix(in srgb, var(--primary-color, #03a9f4) 78%, #000)); color: #fff; border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.18); border-radius: 16px; border-bottom-right-radius: 4px; }
        .bubble.draft { opacity: 0.85; }
        .bubble.error { background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); border-color: var(--error-color, #db4437); border-left-width: 3px; box-shadow: none; }
        .bubble code { font-family: monospace; background: rgba(127,127,127,0.15); padding: 1px 4px; border-radius: 4px; }
        .bubble pre { background: rgba(127,127,127,0.15); padding: 8px 10px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; margin: 6px 0; }
        .bubble pre code { background: transparent; padding: 0; }
        .bubble ul, .bubble ol { margin: 6px 0; padding-left: 20px; }
        .meta { font-size: 11px; color: var(--secondary-text-color, #888); margin: 2px 6px 0; }
        .bubble.typing { display: inline-flex; gap: 5px; align-items: center; padding: 13px 16px; }
        .bubble.typing .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--secondary-text-color, #999); animation: typing-bounce 1.2s infinite; }
        .bubble.typing .dot:nth-child(2) { animation-delay: 0.15s; }
        .bubble.typing .dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes typing-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }
        .new-msgs { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 2; padding: 6px 14px; border-radius: 999px; background: var(--primary-color, #03a9f4); color: #fff; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
        .new-msgs:hover { filter: brightness(1.1); }
        img.attachment { display: block; max-width: 250px; border-radius: 12px; margin-bottom: 6px; }

        /* Banner */
        .error-banner { background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); border-left: 3px solid var(--error-color, #db4437); padding: 10px 14px; border-radius: 12px; font-size: 13px; }
        .notice { background: var(--secondary-background-color, #fff8e1); color: var(--primary-text-color, #795548); padding: 10px 14px; border-radius: 12px; font-size: 13px; }

        /* KI-Guthaben / Nachkauf */
        .quota-info { font-size: 12px; color: var(--secondary-text-color, #666); }
        .quota-info strong { color: var(--primary-text-color, #222); font-weight: 600; }
        .icon-btn#topup-toggle { font-weight: 700; }
        .topup-card { border: 1px solid var(--divider-color, #e2e2e2); border-radius: 12px; background: var(--card-background-color, #fff); padding: 12px 14px; font-size: 13px; color: var(--primary-text-color, #222); }
        .topup-card p { margin: 6px 0; line-height: 1.45; }
        .topup-card code { font-family: monospace; background: rgba(127,127,127,0.15); padding: 1px 4px; border-radius: 4px; word-break: break-all; }
        .topup-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
        .topup-head strong { font-size: 14px; }
        .topup-head .conv-del { position: static; }
        .topup-status { padding: 9px 12px; border-radius: 10px; margin: 6px 0; line-height: 1.45; }
        .topup-status.ok { background: #e8f5e9; color: #1b5e20; }
        .topup-status.warn { background: #fff8e1; color: #795548; }
        .topup-confirm-line { background: #fff8e1; border: 1px solid #f5e1a4; color: #795548; padding: 10px 12px; border-radius: 10px; font-size: 14px; margin: 6px 0; }
        .topup-details { margin: 6px 0; padding-left: 20px; }
        .topup-details li { margin: 3px 0; line-height: 1.4; }
        .topup-reasons { margin: 4px 0 0; padding-left: 20px; }
        .topup-reasons li { margin: 3px 0; line-height: 1.4; }
        .topup-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
        .btn-primary { padding: 9px 14px; border-radius: 10px; background: var(--primary-color, #03a9f4); color: #fff; font-size: 13px; font-weight: 600; }
        .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
        .btn-secondary { padding: 9px 14px; border-radius: 10px; background: var(--secondary-background-color, #eee); color: var(--primary-text-color, #222); font-size: 13px; }
        .btn-secondary:hover:not(:disabled) { filter: brightness(0.97); }
        .btn-danger { padding: 9px 14px; border-radius: 10px; background: #d32f2f; color: #fff; font-size: 13px; font-weight: 600; }
        .btn-danger:hover:not(:disabled) { filter: brightness(1.1); }
        .topup-blocked { background: var(--secondary-background-color, #f3f3f3); border-radius: 10px; padding: 8px 12px; margin-top: 6px; }

        /* Bild-Vorschau-Chip */
        .img-preview { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 12px; border: 1px solid var(--divider-color, #ddd); background: var(--card-background-color, #fff); }
        .img-preview img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; }
        .img-preview .file-name { flex: 1; min-width: 0; font-size: 12px; color: var(--secondary-text-color, #666); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .img-preview button { width: 28px; height: 28px; flex-shrink: 0; border-radius: 50%; background: var(--secondary-background-color, #eee); color: var(--primary-text-color, #222); font-size: 12px; }
        .speech-error { font-size: 12px; color: #b71c1c; }

        /* Composer */
        .composer { display: flex; align-items: center; gap: 4px; padding: 6px; border-radius: 24px; border: 1px solid var(--divider-color, #ddd); background: var(--card-background-color, #fff); box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
        .composer:focus-within { border-color: var(--primary-color, #03a9f4); }
        .composer textarea#msg { flex: 1; min-width: 0; border: none; background: transparent; padding: 8px 10px; font-size: 14px; font-family: inherit; line-height: 1.45; color: var(--primary-text-color, #222); resize: none; height: 36px; max-height: 132px; overflow-y: auto; }
        .composer textarea#msg:focus, .composer textarea#msg:focus-visible { outline: none; }
        .icon-btn { width: 36px; height: 36px; flex-shrink: 0; border-radius: 50%; background: transparent; color: var(--secondary-text-color, #666); font-size: 17px; display: flex; align-items: center; justify-content: center; }
        .icon-btn.badged { position: relative; }
        .toggle-badge { position: absolute; top: 1px; right: 1px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px; background: var(--error-color, #db4437); color: #fff; font-size: 10px; font-weight: 600; line-height: 15px; text-align: center; box-sizing: border-box; }
        .icon-btn:hover:not(:disabled) { background: var(--secondary-background-color, #eee); }
        .icon-btn.recording { background: #d32f2f; color: #fff; animation: mic-pulse 1.2s infinite; }
        @keyframes mic-pulse { 0% { opacity: 1; } 50% { opacity: 0.55; } 100% { opacity: 1; } }
        .send-btn { width: 38px; height: 38px; flex-shrink: 0; border-radius: 50%; background: var(--primary-color, #03a9f4); color: #fff; font-size: 16px; display: flex; align-items: center; justify-content: center; }
        .send-btn:hover:not(:disabled) { filter: brightness(1.1); }
        .cancel-btn { padding: 8px 14px; flex-shrink: 0; border-radius: 19px; background: transparent; border: 1px solid #d32f2f; color: #d32f2f; font-size: 13px; }
        .cancel-btn:hover:not(:disabled) { background: rgba(211,47,47,0.08); }

        @media (max-width: 560px) {
          .wrap { padding: 8px; }
          .bubble { max-width: 88%; }
          .header h1 { font-size: 16px; }
          .avatar { width: 36px; height: 36px; font-size: 16px; }
        }
        /* Ruhige Lesespalte, Theme-Kontrast und Touch-/Tastaturbedienung. */
        .main { max-width: 960px; margin-inline: auto; }
        .messages { padding: 16px 4px; gap: 18px; }
        .bubble { max-width: min(85%, 72ch); line-height: 1.6; }
        .bubble p { margin: 8px 0; }
        .bubble details { margin-top: 12px; font-size: 12px; }
        summary { cursor: pointer; padding: 8px 0; }
        .bubble pre { white-space: pre-wrap; overflow-wrap: anywhere; }
        .msg.user .bubble { background: var(--secondary-background-color, #eef3f8); color: var(--primary-text-color, #222); border: 1px solid var(--divider-color, #ccc); border-right: 3px solid var(--primary-color, #03a9f4); }
        .new-btn, .send-btn, .btn-primary { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
        .new-btn { background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); border: 1px solid var(--divider-color, #ccc); min-height: 44px; }
        .send-btn { background: var(--primary-text-color, #222); color: var(--card-background-color, #fff); }
        .icon-btn, .send-btn { min-width: 44px; min-height: 44px; }
        .connection, .composer-hint { color: var(--secondary-text-color, #666); font-size: 12px; }
        .connection { margin-top: 4px; }
        .composer-hint { text-align: center; }
        .conversation-head { display: flex; align-items: center; min-height: 44px; gap: 8px; }
        .conversation-head strong { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .conversation-actions, .suggestions { display: flex; flex-wrap: wrap; gap: 8px; }
        .suggestions { justify-content: center; }
        .suggestion { min-height: 44px; }
        .message-actions { display: flex; flex-wrap: wrap; gap: 4px; }
        .message-action { background: transparent; color: var(--secondary-text-color, #666); border-radius: 8px; min-height: 36px; padding: 6px 10px; font-size: 12px; }
        .message-action:hover { background: var(--secondary-background-color, #eee); color: var(--primary-text-color, #222); }
        .narrow .message-action { min-height: 44px; }
        .empty { max-width: 520px; line-height: 1.6; }
        .empty h2 { color: var(--primary-text-color, #222); font-size: 23px; }
        .chat-details { border: 1px solid var(--divider-color, #ccc); border-radius: 12px; padding: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
        #conv-search { font: inherit; box-sizing: border-box; width: 100%; min-height: 44px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); }
        .narrow .header { flex-wrap: wrap; gap: 6px; }
        .narrow .header-text { flex-basis: calc(100% - 160px); }
        .narrow .bubble { max-width: 92%; }
        .narrow .sidebar { width: min(280px, calc(100% - 32px)); box-sizing: border-box; }
        .narrow .composer-hint { display: none; }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
      </style>
      <div class="${wrapClasses}">
        <div class="header">
          ${this._narrow || this._haNarrow
            ? `<ha-menu-button class="ha-menu" narrow></ha-menu-button>`
            : ""}
          <button type="button" class="icon-btn badged" id="conv-toggle" aria-label="Unterhaltungen ein-/ausblenden" aria-expanded="${this._narrow ? this._drawerOpen : !this._sidebarCollapsed}" title="Unterhaltungen ein-/ausblenden">${ICON_FORUM}${unseenCount > 0 ? `<span class="toggle-badge">${unseenCount > 9 ? "9+" : unseenCount}</span>` : ""}</button>
          <div class="avatar"><img id="avatar-img" src="/allroggen_chat_static/logo.svg" alt="" /></div>
          <div class="header-text">
            <h1>${this._esc(agentName)}</h1>
            <div class="connection" role="status">${!this._config ? "Verbindung wird aufgebaut…" : this._sseOk ? "Live-Verbindung aktiv" : "Live-Verbindung wird wiederhergestellt · Verlauf wird abgeglichen"}</div>
          </div>
          ${hasTopup || quotaInfo ? `<button type="button" class="btn-secondary credit-btn" id="topup-toggle" aria-expanded="${this._topupOpen}" title="KI-Guthaben & Nachkauf">${this._creditLabel()}${topupAlert ? " · !" : ""}</button>` : ""}
          <button type="button" class="icon-btn" id="details-toggle" aria-label="Chat-Details" aria-expanded="${this._detailsOpen}" title="Chat-Details"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M11,7H13V9H11V7M11,11H13V17H11V11M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4Z"/></svg></button>
        </div>
        ${this._detailsOpen ? `<section class="chat-details" aria-label="Chat-Details">${this._modelHtml()}${quotaInfo}${this._quotaHtml()}${this._usageHtml()}</section>` : ""}
        ${this._error ? `<div class="error-banner" role="alert">${this._esc(this._error)} <button type="button" class="btn-secondary" id="refresh-history">Verlauf prüfen</button> <button type="button" class="icon-btn" id="dismiss-error" aria-label="Hinweis schließen">×</button></div>` : ""}
        ${noAgent ? `<div class="notice">Der Chat ist für deinen Zugang noch nicht eingerichtet. Bitte kontaktiere deinen Dienstleister.</div>` : ""}
        ${this._quotaNoticeHtml()}
        ${this._topupHtml()}
        <div class="body">
          ${this._sidebarHtml()}
          <div class="main">
            <div class="conversation-head"><strong>${this._esc(this._conversation?.title || "Neue Unterhaltung")}</strong>${this._conversation ? `<button type="button" class="icon-btn" id="conversation-menu" aria-label="Unterhaltungsaktionen" aria-expanded="${this._menuOpen}">⋯</button>` : ""}</div>
            ${this._menuOpen && this._conversation ? `<div class="conversation-actions"><button type="button" class="btn-secondary" id="rename">Umbenennen</button><button type="button" class="btn-secondary" id="reuse">Letzte Frage bearbeiten</button><button type="button" class="btn-secondary" id="del">Unterhaltung löschen</button></div>` : ""}
            <div class="messages-wrap">
              <div class="messages" id="messages" role="region" aria-label="Chatverlauf" tabindex="0">
                ${this._messagesHtml()}
                ${this._draft ? `<div class="msg assistant" id="draft-bubble"><div class="bubble draft">${this._md(this._draft)}</div></div>` : ""}
                ${this._busy && !this._draft && this._conversation && this._conversation.id === this._busyConversationId ? `
                  <div class="msg assistant busy">
                    <div class="bubble typing" title="${this._cancelling ? "Wird abgebrochen…" : "Der Agent arbeitet…"}"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
                    <div class="meta" role="status">${this._cancelling ? "Wird abgebrochen…" : "Antwort wird erstellt…"}</div>
                  </div>` : ""}
              </div>
              ${this._unseenBelow ? `<button type="button" class="new-msgs" id="new-msgs">↓ Neue Nachrichten</button>` : ""}
            </div>
            ${this._pendingImage ? `
              <div class="img-preview">
                <img src="${this._esc(this._pendingImage.previewUrl)}" alt="${this._esc(this._pendingImage.fileName)}" />
                <span class="file-name">${this._esc(this._pendingImage.fileName)}</span>
                <button type="button" id="rmimg" title="Bild entfernen">✕</button>
              </div>` : ""}
            ${this._speechError ? `<div class="speech-error">${this._esc(this._speechError)}</div>` : ""}
            <div class="composer">
              <input type="file" id="imgfile" accept="image/*" hidden />
              <button type="button" class="icon-btn" id="attach" title="Bild anhängen" ${inputDisabled ? "disabled" : ""}>${ICON_PAPERCLIP}</button>
              ${this._speechSupported() ? `<button type="button" class="icon-btn ${this._recording ? "recording" : ""}" id="mic" title="Spracheingabe" ${inputDisabled ? "disabled" : ""}>${ICON_MIC}</button>` : ""}
              <textarea id="msg" rows="1" aria-label="Nachricht" aria-describedby="composer-hint" placeholder="Nachricht schreiben…" ${inputDisabled ? "disabled" : ""}></textarea>
              ${this._busy && this._busyConversationId != null
                ? `<button type="button" class="cancel-btn" id="cancel" ${this._cancelling ? "disabled" : ""}>Abbrechen</button>`
                : `<button type="button" class="send-btn" id="send" title="Senden" ${inputDisabled ? "disabled" : ""}>${ICON_SEND}</button>`}
            </div>
            <div class="composer-hint" id="composer-hint">Enter sendet · Umschalt + Enter für eine neue Zeile</div>
          </div>
        </div>
      </div>
    `;

    const send = this.shadowRoot.getElementById("send");
    this.shadowRoot.querySelector(".wrap").addEventListener("keydown", (event) => {
      if (event.key === "Escape" && (this._drawerOpen || this._menuOpen)) {
        this._drawerOpen = false; this._menuOpen = false; this._render();
        this.shadowRoot.getElementById("conv-toggle").focus();
      }
    });
    if (send) send.addEventListener("click", () => this._send());
    const cancel = this.shadowRoot.getElementById("cancel");
    if (cancel) cancel.addEventListener("click", () => this._cancel());
    const imgfile = this.shadowRoot.getElementById("imgfile");
    this.shadowRoot.getElementById("attach").addEventListener("click", () => imgfile.click());
    imgfile.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) this._handleImageFile(f);
    });
    const rmimg = this.shadowRoot.getElementById("rmimg");
    if (rmimg) rmimg.addEventListener("click", () => { this._clearPendingImage(); this._render(); });
    const mic = this.shadowRoot.getElementById("mic");
    if (mic) mic.addEventListener("click", () => this._toggleSpeech());
    // ---- KI-Guthaben / Nachkauf -------------------------------------------
    const topupToggle = this.shadowRoot.getElementById("topup-toggle");
    if (topupToggle) topupToggle.addEventListener("click", () => {
      this._topupOpen = !this._topupOpen;
      this._render();
    });
    const topupX = this.shadowRoot.getElementById("topup-x");
    if (topupX) topupX.addEventListener("click", (e) => { e.stopPropagation(); this._topupClose(); });
    const topupStart = this.shadowRoot.getElementById("topup-start");
    if (topupStart) topupStart.addEventListener("click", () => this._topupStartConfirm());
    const topupConfirm = this.shadowRoot.getElementById("topup-confirm");
    if (topupConfirm) topupConfirm.addEventListener("click", () => this._sendTopup());
    const topupBack = this.shadowRoot.getElementById("topup-back");
    if (topupBack) topupBack.addEventListener("click", () => this._topupCancel());
    // Retry nach unklarem Ergebnis: derselbe Auftrag (gleiche requestId),
    // niemals eine neue ID — der Server löst Idempotenz/Blockade auf.
    const topupRetry = this.shadowRoot.getElementById("topup-retry");
    if (topupRetry) topupRetry.addEventListener("click", () => this._sendTopup(true));
    const topupCloseBtn = this.shadowRoot.getElementById("topup-close");
    if (topupCloseBtn) topupCloseBtn.addEventListener("click", () => this._topupClose());
    const topupClose2 = this.shadowRoot.getElementById("topup-close2");
    if (topupClose2) topupClose2.addEventListener("click", () => this._topupClose());
    const msgInput = this.shadowRoot.getElementById("msg");
    for (const button of this.shadowRoot.querySelectorAll("[data-copy]")) button.addEventListener("click", () => this._copyMessage(Number(button.dataset.copy), button));
    for (const button of this.shadowRoot.querySelectorAll("[data-fork]")) button.addEventListener("click", () => this._forkConversation(Number(button.dataset.fork)));
    for (const button of this.shadowRoot.querySelectorAll("button[title]")) if (!button.hasAttribute("aria-label")) button.setAttribute("aria-label", button.title);
    if (prevValue) msgInput.value = prevValue;
    if (this._restoredText !== null) { msgInput.value = this._restoredText; this._restoredText = null; }
    this._autoGrow(msgInput);
    if (hadFocus && !msgInput.disabled) {
      msgInput.focus();
      msgInput.setSelectionRange(...selection);
    }
    for (const el of this.shadowRoot.querySelectorAll("details[data-state-key]")) el.open = openDetails.includes(el.dataset.stateKey);
    if (!hadFocus && activeId) this.shadowRoot.getElementById(activeId)?.focus({ preventScroll: true });
    this.shadowRoot.getElementById("details-toggle").addEventListener("click", () => { this._detailsOpen = !this._detailsOpen; this._render(); });
    this.shadowRoot.getElementById("conversation-menu")?.addEventListener("click", () => { this._menuOpen = !this._menuOpen; this._render(); });
    this.shadowRoot.getElementById("rename")?.addEventListener("click", () => this._renameConversation());
    this.shadowRoot.getElementById("reuse")?.addEventListener("click", () => this._reuseQuestion());
    this.shadowRoot.getElementById("dismiss-error")?.addEventListener("click", () => { this._error = null; this._render(); });
    this.shadowRoot.getElementById("refresh-history")?.addEventListener("click", () => this._refreshHistory());
    const search = this.shadowRoot.getElementById("conv-search");
    search.addEventListener("input", () => {
      this._search = search.value;
      const start = search.selectionStart;
      this._render();
      const next = this.shadowRoot.getElementById("conv-search");
      next.focus(); next.setSelectionRange(start, start);
    });
    for (const suggestion of this.shadowRoot.querySelectorAll(".suggestion")) suggestion.addEventListener("click", () => {
      if (msgInput.disabled) return;
      msgInput.value = suggestion.dataset.prompt; msgInput.focus(); this._autoGrow(msgInput);
    });
    msgInput.addEventListener("input", () => this._autoGrow(msgInput));
    msgInput.addEventListener("keydown", (e) => {
      // Enter sendet, Umschalt+Enter macht einen Zeilenumbruch; während
      // einer IME-Komposition (isComposing) darf Enter nicht senden.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this._send();
      }
    });
    const avatarImg = this.shadowRoot.getElementById("avatar-img");
    avatarImg.addEventListener("error", () => {
      // Logo nicht ladbar → Initial des Agenten-Namens als Fallback.
      avatarImg.outerHTML = this._esc(agentName.trim().charAt(0).toUpperCase() || "?");
    });
    this.shadowRoot.getElementById("conv-toggle").addEventListener("click", () => this._toggleSidebar());
    this.shadowRoot.getElementById("new").addEventListener("click", () => this._newConversation());
    for (const card of this.shadowRoot.querySelectorAll(".conv-card[data-conv-id]")) {
      card.addEventListener("click", () => this._selectConversation(Number(card.dataset.convId)));
    }
    const del = this.shadowRoot.getElementById("del");
    if (del) del.addEventListener("click", (e) => { e.stopPropagation(); this._deleteConversation(); });
    const backdrop = this.shadowRoot.getElementById("backdrop");
    backdrop.addEventListener("click", () => {
      this._drawerOpen = false;
      this._render();
    });
    const convList = this.shadowRoot.getElementById("conv-list");
    if (prevConvScrollTop > 0) convList.scrollTop = prevConvScrollTop;
    const pill = this.shadowRoot.getElementById("new-msgs");
    if (pill) pill.addEventListener("click", () => this._jumpToLatest());
    const messagesEl = this.shadowRoot.getElementById("messages");
    messagesEl.addEventListener("scroll", () => {
      if (this._isNearBottom(messagesEl)) {
        this._nearBottom = true;
        if (this._unseenBelow) this._hideNewMsgsPill();
      } else if (messagesEl.scrollTop < this._lastScrollTop) {
        // Nur ein aktives Hochscrollen des Nutzers löst das "unten" los —
        // reines Content-Wachstum (Deltas, nachgeladene Bilder) nicht.
        this._nearBottom = false;
      }
      this._lastScrollTop = messagesEl.scrollTop;
    });
    this._loadAttachments();
    this._lastScrollTop = messagesEl.scrollTop;
    if (this._nearBottom) {
      this._scrollDown(false);
    } else if (prevScrollTop > 0) {
      requestAnimationFrame(() => {
        if (messagesEl.isConnected) {
          messagesEl.scrollTop = prevScrollTop;
          this._lastScrollTop = prevScrollTop;
        }
      });
    }
  }
}

customElements.define("allroggen-chat-panel", AllroggenChatPanel);
