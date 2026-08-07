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

// Material Design Icons (24x24), eingefärbt über currentColor.
const ICON_PAPERCLIP =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M16.5,6V17.5A4,4 0 0,1 12.5,21.5A4,4 0 0,1 8.5,17.5V5A2.5,2.5 0 0,1 11,2.5A2.5,2.5 0 0,1 13.5,5V15.5A1,1 0 0,1 12.5,16.5A1,1 0 0,1 11.5,15.5V6H10V15.5A2.5,2.5 0 0,0 12.5,18A2.5,2.5 0 0,0 15,15.5V5A4,4 0 0,0 11,1A4,4 0 0,0 7,5V17.5A5.5,5.5 0 0,0 12.5,23A5.5,5.5 0 0,0 18,17.5V6H16.5Z"/></svg>';
const ICON_MIC =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z"/></svg>';
const ICON_SEND =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M2,21L23,12L2,3V10L17,12L2,14V21Z"/></svg>';

class AllroggenChatPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._conversations = [];
    this._conversation = null; // full conversation with messages
    this._busy = false;
    this._error = null;
    this._pollTimer = null;
    this._draft = ""; // streamed assistant text, not yet persisted
    this._mounted = true;
    this._sseOk = false; // stream usable; false → polling fallback on send
    this._sseAbort = null; // AbortController for the current stream fetch
    this._sseBackoff = SSE_BACKOFF_START_MS;
    this._sseReconnectTimer = null;
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
    this._drawerOpen = false; // Drawer im narrow-Modus
    this._resizeObserver = null;
    try {
      this._sidebarCollapsed =
        localStorage.getItem("allroggenChat.sidebarCollapsed") === "1";
    } catch (_) {
      this._sidebarCollapsed = false;
    }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
  }

  disconnectedCallback() {
    this._mounted = false;
    this._stopPolling();
    this._stopSpeech();
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
      this._conversations = await this._api("GET", "conversations");
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
    if (err && err.status === 401) {
      return "Zugang ungültig — das Integrations-Token wurde widerrufen oder ist abgelaufen. Bitte in den Integrationseinstellungen ein neues Token eintragen.";
    }
    if (err && err.status === 502) {
      return "Das Support-Backend ist gerade nicht erreichbar. Bitte später erneut versuchen.";
    }
    return "Verbindungsfehler. Bitte Seite neu laden.";
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
      this._sseBackoff = SSE_BACKOFF_START_MS;
      await this._readStream(resp.body);
      throw { status: 0 }; // stream ended cleanly → reconnect below
    } catch (err) {
      if (!this._mounted || abort.signal.aborted) return;
      this._sseOk = false;
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

  async _readStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          this._handleSseFrame(frame);
        }
      }
    } finally {
      try { reader.cancel(); } catch (_) { /* already done */ }
    }
  }

  _handleSseFrame(frame) {
    let event = "message";
    const dataLines = [];
    for (const line of frame.split("\n")) {
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
    if (!payload || !this._conversation) return;
    if (payload.conversationId !== this._conversation.id) return;
    switch (event) {
      case "assistant.delta":
        this._draft += payload.delta || "";
        this._updateDraftBubble();
        break;
      case "assistant.message":
        if (payload.message) this._conversation.messages.push(payload.message);
        this._draft = "";
        this._render();
        this._onNewContent();
        break;
      case "assistant.state":
        if (payload.state === "done" || payload.state === "cancelled") {
          this._busy = false;
          this._cancelling = false;
          this._draft = "";
          this._render();
          // Quota/costs and the conversation list moved — refresh both.
          this._api("GET", "config")
            .then((c) => { this._config = c; this._render(); })
            .catch(() => {});
          this._api("GET", "conversations")
            .then((l) => { this._conversations = l; this._render(); })
            .catch(() => {});
        } else if (payload.state === "error") {
          this._busy = false;
          this._cancelling = false;
          this._draft = "";
          this._error = payload.error || "Der Agent konnte die Nachricht nicht verarbeiten.";
          this._render();
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

  /** Update the streaming draft bubble in place — no full re-render per token. */
  _updateDraftBubble() {
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
    this._draft = "";
    // Beim Öffnen einer Unterhaltung immer ans Ende springen.
    this._nearBottom = true;
    this._unseenBelow = false;
    this._conversation = await this._api("GET", `conversations/${id}`);
    this._render();
  }

  async _newConversation() {
    this._stopPolling();
    this._draft = "";
    this._conversation = null;
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
    this._draft = "";
    this._conversations = this._conversations.filter((c) => c.id !== id);
    this._conversation = null;
    if (this._conversations.length > 0) {
      await this._openConversation(this._conversations[0].id);
    }
    this._render();
  }

  // ---- Sending + polling fallback -------------------------------------------

  async _send() {
    const input = this.shadowRoot.getElementById("msg");
    const content = (input.value || "").trim();
    const image = this._pendingImage;
    if ((!content && !image) || this._busy) return;

    this._stopSpeech();
    this._busy = true;
    this._error = null;
    this._speechError = null;
    this._draft = "";
    // Eigene Nachricht: immer ans Ende scrollen.
    this._nearBottom = true;
    this._unseenBelow = false;
    input.value = "";
    this._render();

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
      const result = await this._api("POST", "messages", body);
      this._clearPendingImage();
      await this._openConversation(result.conversationId);
      // Refresh the conversation list (title / ordering may have changed).
      this._conversations = await this._api("GET", "conversations");
      if (this._sseOk) {
        // The answer arrives via assistant.delta/message/state events —
        // no polling, no timeout needed. _busy clears on state=done/error.
        this._render();
      } else {
        this._startPolling(result.conversationId, result.userMessageId);
      }
    } catch (err) {
      this._busy = false;
      if (err && err.status === 429 && err.body && err.body.quota) {
        const q = err.body.quota;
        const reset = new Date(q.resetsAt).toLocaleDateString("de-DE");
        this._error = `Dein monatliches Chat-Kontingent ist aufgebraucht. Es wird am ${reset} zurückgesetzt.`;
        if (this._config) this._config.quota = q;
      } else {
        this._error = this._describeError(err);
      }
      this._render();
    }
  }

  _startPolling(conversationId, afterMessageId) {
    this._stopPolling();
    const started = Date.now();
    this._pollTimer = setInterval(async () => {
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        this._stopPolling();
        this._busy = false;
        this._cancelling = false;
        this._error = "Die Antwort dauert länger als erwartet — bitte später erneut prüfen.";
        this._render();
        return;
      }
      try {
        const conv = await this._api("GET", `conversations/${conversationId}`);
        const done = conv.messages.some(
          (m) =>
            m.id > afterMessageId &&
            (m.role === "Assistant" || m.role === "Error")
        );
        if (done) {
          this._stopPolling();
          this._busy = false;
          this._cancelling = false;
          this._conversation = conv;
          // Quota may have moved — refresh config in the background.
          this._api("GET", "config").then((c) => { this._config = c; this._render(); });
          this._render();
          this._onNewContent();
        }
      } catch (_) { /* keep polling on transient errors */ }
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
    if (!this._conversation || !this._busy || this._cancelling) return;
    this._cancelling = true;
    this._render();
    try {
      await this._api("POST", `conversations/${this._conversation.id}/cancel`);
      // _busy bleibt bestehen, bis das terminale Event eintrifft (SSE
      // assistant.state cancelled/done/error bzw. die persistierte
      // Abbruch-Nachricht im Polling-Fallback).
    } catch (err) {
      this._cancelling = false;
      this._error = this._describeError(err);
      this._render();
    }
  }

  // ---- Bild-Upload -------------------------------------------------------------

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
      if (el) el.value = this._speechBase + this._speechFinal + interim;
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
    this._openConversation(id);
  }

  /** Kurzdatum der letzten Aktivität einer Unterhaltung („06.08., 14:32“). */
  _convDateHtml(c) {
    if (!c.updatedAt) return "";
    const d = new Date(c.updatedAt);
    if (isNaN(d.getTime())) return "";
    const date = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
    const time = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    return `<div class="conv-date">${date}, ${time}</div>`;
  }

  _sidebarHtml() {
    const cards = this._conversations
      .map((c) => {
        const active = this._conversation && this._conversation.id === c.id;
        return `
          <div class="conv-card ${active ? "active" : ""}" data-conv-id="${c.id}">
            <div class="conv-title">${this._esc(c.title)}</div>
            ${this._convDateHtml(c)}
            ${active ? `<button type="button" class="conv-del" id="del" title="Unterhaltung löschen">✕</button>` : ""}
          </div>`;
      })
      .join("");
    return `
      <aside class="sidebar">
        <button type="button" class="new-btn" id="new">＋ Neue Unterhaltung</button>
        <div class="conv-list" id="conv-list">
          ${cards || `<div class="conv-empty">Noch keine Unterhaltungen.</div>`}
        </div>
      </aside>
      <div class="backdrop" id="backdrop"></div>`;
  }

  // ---- Rendering -----------------------------------------------------------

  _esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Markdown-light: bold, italic, inline code, line breaks. Input is escaped first. */
  _md(s) {
    return this._esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\n/g, "<br>");
  }

  /** Kontingent-Ring im Header: nur Prozent, keine Euro-Werte. */
  _quotaHtml() {
    const q = this._config && this._config.quota;
    if (!q || q.costLimit == null) return ""; // ohne Limit keine Kontingent-Anzeige
    const pct = q.costLimit > 0
      ? Math.min(100, Math.round((Number(q.usedCost || 0) / Number(q.costLimit)) * 100))
      : 100;
    const cls = q.exceeded ? "quota-exceeded" : q.warning ? "quota-warning" : "";
    const reset = new Date(q.resetsAt).toLocaleDateString("de-DE");
    return `
      <div class="quota ${cls}" title="${pct} % des Monatskontingents verbraucht · Reset am ${reset}">
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
    return `Diese Unterhaltung: ${tokens} Tokens`;
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
    if (m.role === "User") {
      const img = m.hasAttachment
        ? `<img class="attachment" data-attachment-id="${m.id}" alt="${this._esc(m.attachmentFileName || "Anhang")}" hidden />`
        : "";
      return `<div class="msg user"><div class="bubble">${img}${this._md(m.content)}</div>${this._timeHtml(m)}</div>`;
    }
    if (m.role === "Tool") {
      return `<div class="msg tool">⚙️ ${this._esc(m.content).slice(0, 120)}</div>`;
    }
    if (m.role === "Error") {
      return `<div class="msg assistant"><div class="bubble error">⚠️ ${this._md(m.content)}</div>${this._timeHtml(m)}</div>`;
    }
    return `<div class="msg assistant"><div class="bubble">${this._md(m.content)}</div>${this._timeHtml(m)}</div>`;
  }

  _messagesHtml() {
    if (this._conversation === null) {
      return `<div class="empty"><div class="empty-icon">💬</div>Neue Unterhaltung — schreib einfach unten deine Frage.</div>`;
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
    const inputDisabled = this._busy || noAgent || quotaExceeded;

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
        .conv-card { position: relative; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--divider-color, #e2e2e2); border-left: 3px solid transparent; background: var(--card-background-color, #fff); cursor: pointer; }
        .conv-card:hover { background: var(--secondary-background-color, #f3f3f3); }
        .conv-card.active { border-left-color: var(--primary-color, #03a9f4); background: var(--secondary-background-color, #f3f3f3); }
        .conv-title { font-size: 13px; font-weight: 500; color: var(--primary-text-color, #222); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .conv-card.active .conv-title { padding-right: 20px; }
        .conv-date { font-size: 11px; color: var(--secondary-text-color, #888); margin-top: 4px; }
        .conv-del { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; background: transparent; color: var(--secondary-text-color, #888); font-size: 11px; display: flex; align-items: center; justify-content: center; }
        .conv-del:hover { background: #fdecea; color: #b71c1c; }
        .conv-empty { font-size: 12px; color: var(--secondary-text-color, #888); text-align: center; padding: 16px 8px; }
        .backdrop { display: none; }
        .narrow .sidebar { position: absolute; left: 0; top: 0; bottom: 0; z-index: 5; width: 260px; padding: 8px; background: var(--card-background-color, #fff); border-right: 1px solid var(--divider-color, #ddd); box-shadow: 2px 0 12px rgba(0,0,0,0.25); transform: translateX(-110%); transition: transform 0.2s ease; }
        .narrow.drawer-open .sidebar { transform: none; }
        .narrow.drawer-open .backdrop { display: block; position: absolute; inset: 0; z-index: 4; background: rgba(0,0,0,0.35); }

        /* Nachrichten */
        .messages-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
        .messages { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 6px; display: flex; flex-direction: column; gap: 10px; scroll-behavior: smooth; }
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
        .bubble.error { background: #fdecea; color: #b71c1c; border-color: #f5c6c0; box-shadow: none; }
        .bubble code { font-family: monospace; background: rgba(127,127,127,0.15); padding: 1px 4px; border-radius: 4px; }
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
        .error-banner { background: #fdecea; color: #b71c1c; padding: 10px 14px; border-radius: 12px; font-size: 13px; }
        .notice { background: var(--secondary-background-color, #fff8e1); color: var(--primary-text-color, #795548); padding: 10px 14px; border-radius: 12px; font-size: 13px; }

        /* Bild-Vorschau-Chip */
        .img-preview { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 12px; border: 1px solid var(--divider-color, #ddd); background: var(--card-background-color, #fff); }
        .img-preview img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; }
        .img-preview .file-name { flex: 1; min-width: 0; font-size: 12px; color: var(--secondary-text-color, #666); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .img-preview button { width: 28px; height: 28px; flex-shrink: 0; border-radius: 50%; background: var(--secondary-background-color, #eee); color: var(--primary-text-color, #222); font-size: 12px; }
        .speech-error { font-size: 12px; color: #b71c1c; }

        /* Composer */
        .composer { display: flex; align-items: center; gap: 4px; padding: 6px; border-radius: 24px; border: 1px solid var(--divider-color, #ddd); background: var(--card-background-color, #fff); box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
        .composer:focus-within { border-color: var(--primary-color, #03a9f4); }
        .composer input#msg { flex: 1; min-width: 0; border: none; background: transparent; padding: 8px 10px; font-size: 14px; color: var(--primary-text-color, #222); }
        .composer input#msg:focus, .composer input#msg:focus-visible { outline: none; }
        .icon-btn { width: 36px; height: 36px; flex-shrink: 0; border-radius: 50%; background: transparent; color: var(--secondary-text-color, #666); font-size: 17px; display: flex; align-items: center; justify-content: center; }
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
      </style>
      <div class="${wrapClasses}">
        <div class="header">
          <button type="button" class="icon-btn" id="conv-toggle" title="Unterhaltungen ein-/ausblenden">☰</button>
          <div class="avatar"><img src="/allroggen_chat_static/logo.svg" alt="" onerror="this.outerHTML='${this._esc(agentName.trim().charAt(0).toUpperCase() || "?")}'"></div>
          <div class="header-text">
            <h1>${this._esc(agentName)}</h1>
          </div>
          ${this._quotaHtml()}
        </div>
        ${this._modelHtml()}
        ${this._error ? `<div class="error-banner">${this._esc(this._error)}</div>` : ""}
        ${noAgent ? `<div class="notice">Der Chat ist für deinen Zugang noch nicht eingerichtet. Bitte kontaktiere deinen Dienstleister.</div>` : ""}
        ${quotaExceeded ? `<div class="notice">Monatliches Chat-Kontingent erschöpft — der Chat ist bis zum Reset pausiert.</div>` : ""}
        <div class="body">
          ${this._sidebarHtml()}
          <div class="main">
            ${this._usageHtml()}
            <div class="messages-wrap">
              <div class="messages" id="messages">
                ${this._messagesHtml()}
                ${this._draft ? `<div class="msg assistant" id="draft-bubble"><div class="bubble draft">${this._md(this._draft)}</div></div>` : ""}
                ${this._busy && !this._draft ? `
                  <div class="msg assistant busy">
                    <div class="bubble typing" title="${this._cancelling ? "Wird abgebrochen…" : "Der Agent arbeitet…"}"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
                    ${this._cancelling ? `<div class="meta">Wird abgebrochen…</div>` : ""}
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
              <input id="msg" placeholder="Nachricht schreiben…" ${inputDisabled ? "disabled" : ""} />
              ${this._busy && this._conversation
                ? `<button type="button" class="cancel-btn" id="cancel" ${this._cancelling ? "disabled" : ""}>Abbrechen</button>`
                : `<button type="button" class="send-btn" id="send" title="Senden" ${inputDisabled ? "disabled" : ""}>${ICON_SEND}</button>`}
            </div>
          </div>
        </div>
      </div>
    `;

    const send = this.shadowRoot.getElementById("send");
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
    const msgInput = this.shadowRoot.getElementById("msg");
    if (prevValue) msgInput.value = prevValue;
    if (hadFocus && !msgInput.disabled) msgInput.focus();
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._send();
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
    if (this._nearBottom) {
      this._scrollDown();
    } else if (prevScrollTop > 0) {
      // Leseposition über den Re-Render hinweg wiederherstellen.
      const top = prevScrollTop;
      requestAnimationFrame(() => {
        if (messagesEl.isConnected) {
          messagesEl.scrollTop = top;
          this._lastScrollTop = top;
        }
      });
    }
  }

}

customElements.define("allroggen-chat-panel", AllroggenChatPanel);
