/**
 * Allroggen Support-Chat — sidebar panel webcomponent.
 *
 * Talks ONLY to Home Assistant's own API (/api/allroggen_chat/...), which the
 * integration proxies to the ticket-system backend. The per-customer token
 * never reaches the browser; HA's own session (access token) authenticates
 * the panel against the proxy.
 *
 * Realtime = polling: after sending, the conversation is refetched every 3 s
 * until a new Assistant/Error message appears (5 min timeout).
 */

const API_BASE = "/api/allroggen_chat";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

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
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
  }

  disconnectedCallback() {
    this._stopPolling();
  }

  async _init() {
    this._render();
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

  // ---- Conversations -------------------------------------------------------

  async _openConversation(id) {
    this._conversation = await this._api("GET", `conversations/${id}`);
    this._render();
    this._scrollDown();
  }

  async _newConversation() {
    this._stopPolling();
    this._conversation = null;
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
    this._conversations = this._conversations.filter((c) => c.id !== id);
    this._conversation = null;
    if (this._conversations.length > 0) {
      await this._openConversation(this._conversations[0].id);
    }
    this._render();
  }

  // ---- Sending + polling ---------------------------------------------------

  async _send() {
    const input = this.shadowRoot.getElementById("msg");
    const content = (input.value || "").trim();
    if (!content || this._busy) return;

    this._busy = true;
    this._error = null;
    input.value = "";
    this._render();

    try {
      const result = await this._api("POST", "messages", {
        content,
        conversationId: this._conversation ? this._conversation.id : null,
      });
      await this._openConversation(result.conversationId);
      // Refresh the conversation list (title / ordering may have changed).
      this._conversations = await this._api("GET", "conversations");
      this._startPolling(result.conversationId, result.userMessageId);
    } catch (err) {
      this._busy = false;
      if (err && err.status === 429 && err.body && err.body.quota) {
        const q = err.body.quota;
        const reset = new Date(q.resetsAt).toLocaleDateString("de-DE");
        this._error = `Dein monatliches Token-Kontingent ist erschöpft (${q.used.toLocaleString("de-DE")} von ${q.limit.toLocaleString("de-DE")} Tokens). Es wird am ${reset} zurückgesetzt.`;
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
          this._conversation = conv;
          // Quota may have moved — refresh config in the background.
          this._api("GET", "config").then((c) => { this._config = c; this._render(); });
          this._render();
          this._scrollDown();
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

  _quotaHtml() {
    const q = this._config && this._config.quota;
    if (!q || q.limit == null) return "";
    const pct = Math.min(100, Math.round((q.used / q.limit) * 100));
    const cls = q.exceeded ? "quota-exceeded" : q.warning ? "quota-warning" : "";
    const reset = new Date(q.resetsAt).toLocaleDateString("de-DE");
    return `
      <div class="quota ${cls}" title="Reset am ${reset}">
        <div class="quota-bar"><div class="quota-fill" style="width:${pct}%"></div></div>
        <span>${q.used.toLocaleString("de-DE")} / ${q.limit.toLocaleString("de-DE")} Tokens</span>
      </div>`;
  }

  _messagesHtml() {
    if (this._conversation === null) {
      return `<div class="empty">Neue Unterhaltung — schreib einfach unten deine Frage. 🙂</div>`;
    }
    if (this._conversation.messages.length === 0) {
      return `<div class="empty">Lade…</div>`;
    }
    return this._conversation.messages
      .map((m) => {
        if (m.role === "User") {
          return `<div class="msg user"><div class="bubble">${this._md(m.content)}</div></div>`;
        }
        if (m.role === "Tool") {
          return `<div class="msg tool">⚙️ ${this._esc(m.content).slice(0, 120)}</div>`;
        }
        if (m.role === "Error") {
          return `<div class="msg assistant"><div class="bubble error">⚠️ ${this._md(m.content)}</div></div>`;
        }
        return `<div class="msg assistant"><div class="bubble">${this._md(m.content)}</div></div>`;
      })
      .join("");
  }

  _render() {
    if (!this.shadowRoot) return;
    // Preserve the composer's content and focus across the full re-render.
    const prevInput = this.shadowRoot.getElementById("msg");
    const prevValue = prevInput ? prevInput.value : "";
    const hadFocus = prevInput !== null && this.shadowRoot.activeElement === prevInput;
    const agentName = this._config && this._config.assistantName
      ? this._config.assistantName
      : "Support";
    const noAgent = this._config && !this._config.enabled;
    const quotaExceeded = this._config && this._config.quota && this._config.quota.exceeded;
    const inputDisabled = this._busy || noAgent || quotaExceeded;

    const convOptions = this._conversations
      .map(
        (c) =>
          `<option value="${c.id}" ${this._conversation && this._conversation.id === c.id ? "selected" : ""}>${this._esc(c.title)}</option>`
      )
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        .wrap { display: flex; flex-direction: column; height: 100%; max-width: 900px; margin: 0 auto; padding: 16px; box-sizing: border-box; }
        .header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
        .header h1 { font-size: 20px; margin: 0; flex: 1; }
        .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
        select { flex: 1; padding: 8px; border-radius: 6px; border: 1px solid var(--divider-color, #ddd); background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); }
        button { padding: 8px 14px; border: none; border-radius: 6px; background: var(--primary-color, #03a9f4); color: #fff; cursor: pointer; font-size: 14px; }
        button:disabled { opacity: 0.5; cursor: default; }
        button.secondary { background: var(--secondary-background-color, #e0e0e0); color: var(--primary-text-color, #222); }
        .quota { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--secondary-text-color, #666); }
        .quota-bar { width: 120px; height: 8px; border-radius: 4px; background: var(--divider-color, #ddd); overflow: hidden; }
        .quota-fill { height: 100%; background: var(--primary-color, #03a9f4); }
        .quota-warning .quota-fill { background: #f57c00; }
        .quota-exceeded .quota-fill { background: #d32f2f; }
        .messages { flex: 1; overflow-y: auto; padding: 12px 4px; display: flex; flex-direction: column; gap: 8px; }
        .empty { text-align: center; color: var(--secondary-text-color, #666); margin-top: 40px; }
        .msg { display: flex; }
        .msg.user { justify-content: flex-end; }
        .bubble { max-width: 75%; padding: 10px 14px; border-radius: 14px; background: var(--secondary-background-color, #eee); color: var(--primary-text-color, #222); line-height: 1.45; word-wrap: break-word; }
        .msg.user .bubble { background: var(--primary-color, #03a9f4); color: #fff; }
        .bubble.error { background: #ffebee; color: #b71c1c; }
        .bubble code { font-family: monospace; background: rgba(0,0,0,0.08); padding: 1px 4px; border-radius: 4px; }
        .msg.tool { font-size: 12px; color: var(--secondary-text-color, #888); padding-left: 8px; }
        .error-banner { background: #ffebee; color: #b71c1c; padding: 10px 14px; border-radius: 8px; margin-bottom: 8px; }
        .notice { background: #fff8e1; color: #795548; padding: 10px 14px; border-radius: 8px; margin-bottom: 8px; }
        .composer { display: flex; gap: 8px; padding-top: 8px; border-top: 1px solid var(--divider-color, #ddd); }
        .composer input { flex: 1; padding: 12px; border-radius: 8px; border: 1px solid var(--divider-color, #ddd); font-size: 14px; background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); }
        .busy { font-size: 13px; color: var(--secondary-text-color, #666); padding: 4px 8px; }
      </style>
      <div class="wrap">
        <div class="header">
          <h1>💬 ${this._esc(agentName)}</h1>
          ${this._quotaHtml()}
        </div>
        ${this._error ? `<div class="error-banner">${this._esc(this._error)}</div>` : ""}
        ${noAgent ? `<div class="notice">Der Chat ist für deinen Zugang noch nicht eingerichtet. Bitte kontaktiere deinen Dienstleister.</div>` : ""}
        ${quotaExceeded ? `<div class="notice">Monatliches Token-Kontingent erschöpft — der Chat ist bis zum Reset pausiert.</div>` : ""}
        <div class="toolbar">
          <select id="conv">
            ${this._conversation === null ? `<option value="" selected>— Neue Unterhaltung —</option>` : ""}
            ${convOptions}
          </select>
          <button class="secondary" id="new">Neu</button>
          ${this._conversation ? `<button class="secondary" id="del">Löschen</button>` : ""}
        </div>
        <div class="messages" id="messages">
          ${this._messagesHtml()}
          ${this._busy ? `<div class="busy">Der Agent arbeitet…</div>` : ""}
        </div>
        <div class="composer">
          <input id="msg" placeholder="Nachricht schreiben…" ${inputDisabled ? "disabled" : ""} />
          <button id="send" ${inputDisabled ? "disabled" : ""}>Senden</button>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById("send").addEventListener("click", () => this._send());
    const msgInput = this.shadowRoot.getElementById("msg");
    if (prevValue) msgInput.value = prevValue;
    if (hadFocus && !msgInput.disabled) msgInput.focus();
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._send();
    });
    this.shadowRoot.getElementById("conv").addEventListener("change", (e) => {
      if (e.target.value) this._openConversation(Number(e.target.value));
    });
    this.shadowRoot.getElementById("new").addEventListener("click", () => this._newConversation());
    const del = this.shadowRoot.getElementById("del");
    if (del) del.addEventListener("click", () => this._deleteConversation());
  }

  _scrollDown() {
    const el = this.shadowRoot && this.shadowRoot.getElementById("messages");
    if (el) el.scrollTop = el.scrollHeight;
  }
}

customElements.define("allroggen-chat-panel", AllroggenChatPanel);
