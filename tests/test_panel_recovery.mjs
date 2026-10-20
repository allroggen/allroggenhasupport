// Regressionen für Versand, Streaming und Nachrichtenaktionen ohne echten Server.
import "./test_panel_logic.mjs";
import assert from "node:assert/strict";

function panel() {
  const p = new globalThis.__Panel();
  p._config = { enabled: true };
  p._hass = { auth: { data: { access_token: "test" } } };
  p._stopSpeech = () => {};
  p._render = () => {};
  const input = { value: "Bitte Flurlicht prüfen" };
  p.shadowRoot = { getElementById: () => input };
  return { p, input };
}

{
  const { p } = panel();
  p._api = async () => { throw new TypeError("offline"); };
  await p._send();
  assert.equal(p._restoredText, "Bitte Flurlicht prüfen");
  assert.match(p._error, /Versandstatus ist unklar/);
  assert.equal(p._busy, false);
}
{
  const { p } = panel();
  let tracked = null;
  p._api = async (method) => {
    if (method === "POST") return { conversationId: 10, userMessageId: 20 };
    throw new TypeError("GET offline");
  };
  p._startPolling = (...args) => { tracked = args; };
  await p._send();
  assert.deepEqual(tracked, [10, 20]);
  assert.equal(p._busy, true);
  assert.equal(p._restoredText, null);
  assert.match(p._error, /Nachricht gesendet/);
}
{
  const { p } = panel();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("stream disconnected"); };
  p._busy = true; p._busyConversationId = 10; p._busyUserMessageId = 20;
  let tracked = null;
  p._startPolling = (...args) => { tracked = args; };
  p._scheduleReconnect = () => {};
  await p._connectStream();
  assert.deepEqual(tracked, [10, 20]);
  assert.equal(p._sseOk, false);
  globalThis.fetch = originalFetch;
}
{
  const { p } = panel();
  p._conversation = { id: 10, messages: [{ id: 21, role: "assistant", content: "Fertig" }] };
  p._onNewContent = () => {};
  p._handleSseEvent("assistant.message", { conversationId: 10, message: { id: 21, role: "assistant", content: "Fertig" } });
  assert.equal(p._conversation.messages.length, 1);
  assert.match(p._messageHtml({ id: 22, role: "error", content: "HTTP 503 ALL_TARGETS_SKIPPED <script>" }), /&lt;script&gt;/);
  assert.match(p._friendlyError("HTTP 503 ALL_TARGETS_SKIPPED"), /kein verfügbares Modell/);
  assert.doesNotMatch(p._md("- eins\n- zwei\n\nDanach"), /<\/ul><br>/);
  p._config.quota = { includedMonthlyEur: 0, includedRemainingEur: 0, creditRemainingEur: 21.79, costLimit: 100 };
  assert.equal(p._quotaHtml(), "");
  assert.match(p._creditLabel(), /21,79/);
}
{
  const { p } = panel();
  let requests = 0;
  p._conversation = { id: 10, messages: [] };
  globalThis.confirm = () => false;
  p._api = async () => { requests++; };
  await p._forkConversation(20);
  assert.equal(requests, 0);
  globalThis.confirm = () => true;
  p._api = async (method, path, body) => {
    requests++;
    if (method === "POST") {
      assert.equal(path, "conversations/10/fork");
      assert.deepEqual(body, { messageId: 20 });
      return { conversationId: 11 };
    }
    if (path === "conversations") return [];
    return { id: 11, messages: [] };
  };
  await p._forkConversation(20);
  assert.equal(p._conversation.id, 11);
  assert.equal(p._forking, false);
  assert.match(p._error, /Änderungen in Home Assistant bleiben bestehen/);
}
{
  const { p } = panel();
  const interval = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  let tick;
  globalThis.setInterval = (callback) => { tick = callback; return 1; };
  globalThis.clearInterval = () => {};
  p._busy = true; p._busyConversationId = 10; p._busyUserMessageId = 20;
  let resolve;
  p._api = () => new Promise((r) => { resolve = r; });
  p._startPolling(10, 20);
  const pending = tick();
  // Ein alter GET darf einen neu begonnenen Turn derselben Unterhaltung nicht beenden.
  p._busyUserMessageId = 30;
  resolve({ id: 10, messages: [{ id: 21, role: "assistant" }] });
  await pending;
  assert.equal(p._busy, true);
  p._stopPolling();
  globalThis.setInterval = interval;
  globalThis.clearInterval = clear;
}
console.log("Panel recovery/action regressions passed");
