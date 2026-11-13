// Regressionen für Desktop-Layout-Helfer, Werkzeuggruppen und Kontextgrenzen.
import "./test_panel_logic.mjs";
import assert from "node:assert/strict";

const p = new globalThis.__Panel();
p._config = { enabled: true, contextWindowTokens: 100000 };
assert.equal(p._contextHtml(), "");
p._conversation = { id: 1, messages: [], usage: { totalTokens: 558085 } };
assert.equal(p._contextHtml(), "", "Abrechnungstokens sind kein Kontextfüllstand");
p._conversation.usage.lastInputTokens = 90000;
assert.match(p._contextHtml(), /Kontext 90 %/);
assert.match(p._contextHtml(), /Neuer Chat empfohlen/);
p._conversation.usage.contextWindowTokens = 200000;
assert.match(p._contextHtml(), /Kontext 45 %/);
assert.doesNotMatch(p._contextHtml(), /context-warning/);
p._conversation.usage.lastInputTokens = Infinity;
assert.equal(p._contextHtml(), "");
p._conversation.usage.lastInputTokens = 250000;
assert.match(p._contextHtml(), /width:100%/);

p._conversation.messages = [
  { id: 1, role: "User", content: "Bitte prüfen", sentAt: "2026-11-13T10:00:00Z" },
  { id: 2, role: "Tool", content: 'ha_search({"query":"<script>&"})', sentAt: "2026-11-13T10:00:01Z" },
  { id: 3, role: "tool", content: "x".repeat(400), sentAt: "2026-11-13T10:00:02Z" },
  { id: 4, role: "Assistant", content: "Fertig", sentAt: "2026-11-13T10:00:03Z" },
  { id: 5, role: "tool", content: "Noch eine Prüfung", sentAt: "2026-11-13T10:00:04Z" },
];
const html = p._messagesHtml();
assert.equal((html.match(/class="tool-group"/g) || []).length, 2);
assert.match(html, /2 Werkzeugaufrufe/);
assert.match(html, /1 Werkzeugaufruf/);
assert.match(html, /data-state-key="tools-2"/);
assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/, "Werkzeuge starten eingeklappt");
assert.doesNotMatch(html, /<script>/);
assert.match(html, /&lt;script&gt;&amp;/);
assert.ok(html.includes("x".repeat(400)), "Details werden nicht abgeschnitten");
assert.ok(html.indexOf("Bitte prüfen") < html.indexOf("tools-2"));
assert.ok(html.indexOf("tools-2") < html.indexOf("Fertig"));

const tokenError = "Token-Budget erreicht (558085/500000 Tokens).";
assert.match(p._friendlyError(tokenError), /serverseitige Limit/);
assert.match(p._friendlyError(tokenError), /nicht automatisch zurück/);
assert.match(p._messageHtml({ id: 6, role: "error", content: tokenError }), /Technische Details/);
assert.match(p._messageHtml({ id: 6, role: "error", content: tokenError }), /558085\/500000/);
assert.match(p._friendlyError("context_length_exceeded"), /neuen Chat/);
assert.match(p._friendlyError("maximum context length is 200000"), /neuen Chat/);
assert.equal(p._friendlyError("Unbekannter Fehler"), "Unbekannter Fehler");

let requests = 0;
p._api = async () => { requests++; };
p._conversation = { id: 7, messages: [{ id: 1, role: "user", content: "Alter Verlauf" }] };
const original = p._conversation;
await p._newConversation();
assert.equal(requests, 0, "Frischer Chat ruft weder KI noch Fork-Endpunkt auf");
assert.equal(p._conversation, null);
assert.equal(original.messages.length, 1, "Alter Verlauf bleibt erhalten");
assert.doesNotMatch(p._messagesHtml(), /Alter Verlauf/);

const composer = new globalThis.__Panel();
const send = { disabled: false };
composer.shadowRoot = { getElementById: () => send };
const input = { style: {}, scrollHeight: 42, disabled: false, value: "  " };
composer._autoGrow(input);
assert.equal(send.disabled, true, "Leere Nachrichten sind nicht sendbar");
input.value = "Bitte helfen";
composer._autoGrow(input);
assert.equal(send.disabled, false);
input.disabled = true;
composer._autoGrow(input);
assert.equal(send.disabled, true, "Busy-/Kontingent-Sperre bleibt bestehen");
input.disabled = false;
input.value = "";
composer._pendingImage = { base64: "test" };
composer._autoGrow(input);
assert.equal(send.disabled, false, "Ein Bild ohne Text bleibt sendbar");
console.log("Panel desktop/context regressions passed");
