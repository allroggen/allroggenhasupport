/**
 * Logik-Tests für die Guthaben-/Nachkauf-UI des Panels — ohne Browser.
 *
 * Das Panel ist eine dependency-freie Webcomponent ohne Build-Schritt; dieser
 * Test führt die Datei mit minimalen Browser-Stubs aus und prüft die reinen
 * Helper plus die kritischen Nachkauf-Pfade (Fail-closed, Idempotenz über
 * dieselbe requestId, 409/Netz-Unklar-Behandlung, XSS-Escaping).
 *
 * Ausführen: node tests/test_panel_logic.mjs   (Exit 0 = alles grün)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const panelPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../custom_components/allroggen_chat/panel/allroggen-chat-panel.js"
);
const source = readFileSync(panelPath, "utf8");

// ---- Minimaler Browser-S Stub ---------------------------------------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.customElements = { define() {} };
globalThis.window = { SpeechRecognition: undefined }; // crypto weg → UUID-Fallback
globalThis.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = null; // _render() verzichtet darauf (Early-Return)
    return null;
  }
};

// Indirect eval läuft im globalen Scope; class-Bindings bleiben lokal, daher
// wird die Klasse am Ende explizit nach außen gereicht.
(0, eval)(source + "\nglobalThis.__Panel = AllroggenChatPanel;");

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let failed = 0;
let passed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${name}`);
  }
}
const settle = () => new Promise((r) => setTimeout(r, 0));

function newPanel() {
  // Isolation: ein persistierter offener Auftrag darf nicht in andere
  // Testblöcke überschwappen (im echten Panel ist genau das gewollt).
  localStorage.removeItem("allroggenChat.topupRequestId");
  const p = new globalThis.__Panel();
  p._hass = { auth: { data: { access_token: "test-token" } } };
  return p;
}

// fetch-Stub: zeichnet jeden Aufruf auf, fetchImpl liefert die Antwort.
let fetchCalls = [];
let fetchImpl = async () => { throw new Error("fetchImpl nicht gesetzt"); };
globalThis.fetch = (...args) => {
  fetchCalls.push(args);
  return fetchImpl(...args);
};

// ---- _toNum / _eur: decimal-string UND json-number robust -------------------
{
  const p = newPanel();
  check("_toNum decimal-string", p._toNum("5.00") === 5);
  check("_toNum json-number", p._toNum(3.5) === 3.5);
  check("_toNum ungültig → null", p._toNum("abc") === null);
  check("_toNum null → null", p._toNum(null) === null);
  check("_eur string → de-DE", p._eur("5", "EUR") === "5,00 €");
  check("_eur number → de-DE", p._eur(3.5) === "3,50 €");
  check("_eur ungültig → null", p._eur("x") === null);
  check("_eur ohne Währung → EUR", p._eur(1) === "1,00 €");
  check("_eur Fremdwährung → Code", p._eur(1, "USD") === "1,00 USD");
}

// ---- requestId: eine ID pro Auftrag, neue erst nach eindeutigem Erfolg ------
{
  const p = newPanel();
  check("initial keine requestId", p._topupRequestId === null);
  const id1 = p._ensureTopupRequestId();
  check("requestId ist GUID", GUID_RE.test(id1));
  check("requestId persistiert", localStorage.getItem("allroggenChat.topupRequestId") === id1);
  check("Wiederholung nutzt dieselbe ID", p._ensureTopupRequestId() === id1);
  p._clearTopupRequestId();
  check("clear leert Speicher", localStorage.getItem("allroggenChat.topupRequestId") === null);
  const id2 = p._ensureTopupRequestId();
  check("neuer Auftrag → neue ID", id2 !== id1 && GUID_RE.test(id2));
}

// ---- Reason-Mapping + XSS ----------------------------------------------------
{
  const p = newPanel();
  check(
    "known reason invoice-overdue",
    p._topupReasonText("invoice-overdue").includes("überfällige Rechnung")
  );
  check(
    "known reason credit-awaiting-validated-invoice",
    p._topupReasonText("credit-awaiting-validated-invoice").includes("validierte Rechnung")
  );
  check(
    "known reason credit-limit-exceeded",
    p._topupReasonText("credit-limit-exceeded") ===
      "Kreditrahmen für offene Nachkäufe erreicht. Bitte Rechnung begleichen/abwarten oder Support kontaktieren."
  );
  const limitHtml = p._topupReasonsHtml(["credit-limit-exceeded"]);
  check(
    "credit-limit-exceeded freundlich ohne Rohcode",
    limitHtml.includes("Kreditrahmen") && !limitHtml.includes("credit-limit-exceeded")
  );
  check("unknown reason enthält code", p._topupReasonText("sonstiges-xyz").includes("sonstiges-xyz"));
  check(
    "known reason credit-product-not-configured",
    p._topupReasonText("credit-product-not-configured") ===
      "KI-Guthabenartikel noch nicht eingerichtet. Bitte Support kontaktieren."
  );
  const html = p._topupReasonsHtml(['<script>alert(1)</script>', "invoice-overdue"]);
  check("reasons escapen <script>", !html.includes("<script>") && html.includes("&lt;script&gt;"));
  check("_esc quote-kontext", p._esc('a"b') === "a&quot;b");
}

// ---- _quotaInfoHtml / _quotaNoticeHtml: alte & neue Backends -----------------
{
  const p = newPanel();
  check("quota-info ohne Felder → leer", p._quotaInfoHtml() === "");
  p._config = { quota: { costLimit: 5, usedCost: 5, exceeded: true } };
  check("quota-info altes Backend → leer", p._quotaInfoHtml() === "");
  check(
    "notice altes Backend → alter Text",
    p._quotaNoticeHtml().includes("Monatliches Chat-Kontingent erschöpft")
  );
  p._config = {
    quota: {
      costLimit: 5, usedCost: 5, exceeded: true, currency: "EUR",
      includedMonthlyEur: "5.00", includedRemainingEur: "0.00", creditRemainingEur: "3.50",
      resetsAt: "2026-11-01T00:00:00Z",
    },
    topup: { allowed: true, amountEur: "10.00", pending: false, reasons: [] },
  };
  const info = p._quotaInfoHtml();
  check("quota-info zeigt Inklusiv-Rest", info.includes("0,00 €") && info.includes("5,00 €"));
  check("quota-info zeigt Guthaben", info.includes("3,50 €"));
  const notice = p._quotaNoticeHtml();
  check("notice neu: nur KI pausiert", notice.includes("Tickets und Support laufen normal weiter"));
  check("notice neu: Nachkauf-Hinweis", notice.includes("10,00 €"));
}

// ---- _sendTopup: Fail-closed -------------------------------------------------
{
  const p = newPanel();
  fetchCalls = [];
  p._config = null;
  p._sendTopup();
  check("ohne Config kein Kauf", fetchCalls.length === 0);
  p._config = { topup: { allowed: false, amountEur: "10.00" } };
  p._sendTopup();
  check("ohne Freigabe kein Kauf", fetchCalls.length === 0);
  p._config = { topup: { allowed: false, amountEur: "10.00", reasons: ["credit-product-not-configured"] } };
  p._sendTopup();
  p._topupStartConfirm();
  check("fehlender Guthabenartikel → kein Kauf oder Bestätigung", fetchCalls.length === 0 && p._topupStage === null);
  check("Config-Grund freundlich gerendert", p._topupReasonsHtml(p._config.topup.reasons).includes("KI-Guthabenartikel noch nicht eingerichtet") && !p._topupReasonsHtml(p._config.topup.reasons).includes("credit-product-not-configured"));
  p._config = { topup: { allowed: false, amountEur: "10.00", reasons: ["credit-limit-exceeded"] } };
  fetchCalls = [];
  p._sendTopup();
  p._topupStartConfirm();
  check("Kreditrahmen erreicht → kein Kauf oder Bestätigung", fetchCalls.length === 0 && p._topupStage === null);
  check(
    "Kreditrahmen-Grund freundlich gerendert",
    p._topupReasonsHtml(p._config.topup.reasons).includes("Kreditrahmen") &&
      !p._topupReasonsHtml(p._config.topup.reasons).includes("credit-limit-exceeded")
  );
  p._config = { topup: { allowed: true, amountEur: "abc" } };
  p._sendTopup();
  check("ohne Betrag kein Kauf", fetchCalls.length === 0);
  p._sendTopup(true);
  check("Retry ohne offenen Auftrag → kein Kauf", fetchCalls.length === 0);
}

// ---- _sendTopup: Erfolg + Doppelklick-Schutz ---------------------------------
{
  const p = newPanel();
  fetchCalls = [];
  p._config = {
    quota: { currency: "EUR" },
    topup: { allowed: true, amountEur: "10.00", pending: false, reasons: [] },
  };
  fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ status: "granted", amountEur: "10.00" }),
  });
  p._sendTopup();
  check("POST topup abgesetzt", fetchCalls.length === 1);
  const [url, opts] = fetchCalls[0];
  check("POST auf /topup", url === "/api/allroggen_chat/topup" && opts.method === "POST");
  check("Body enthält requestId (GUID)", GUID_RE.test(JSON.parse(opts.body).requestId));
  check("Body enthält nur requestId, keine Artikel-/Steuer-/Statusvorgaben", Object.keys(JSON.parse(opts.body)).join(",") === "requestId");
  check("HA-Token als Bearer", opts.headers.Authorization === "Bearer test-token");
  const usedId = JSON.parse(opts.body).requestId;
  p._sendTopup(); // Doppelklick während des Flugs
  check("Doppelklick erzeugt keinen zweiten Kauf", fetchCalls.length === 1);
  await settle(); await settle(); await settle();
  check("Erfolg → stage done", p._topupStage === "done");
  check("Erfolg → requestId freigegeben", p._topupRequestId === null);
  check("Erfolg → Config neu geladen", fetchCalls.some(([u]) => String(u).endsWith("/config")));
  check("Erfolg → amount übernommen", p._topupDoneAmount === "10.00");
  void usedId;
}

// ---- _sendTopup: 409 topup_blocked ------------------------------------------
for (const reason of ["invoice-overdue", "credit-product-not-configured"]) {
  const p = newPanel();
  fetchCalls = [];
  p._config = { topup: { allowed: true, amountEur: "10.00" } };
  fetchImpl = async (u) =>
    String(u).endsWith("/config")
      ? { ok: true, status: 200, json: async () => ({ quota: {}, topup: { allowed: false, reasons: [reason] } }) }
      : { ok: false, status: 409, json: async () => ({ error: "topup_blocked", reasons: [reason] }) };
  p._sendTopup();
  await settle(); await settle(); await settle();
  check("409 → zurück zur Übersicht", p._topupStage === null);
  check(`409 → Grund ${reason} übernommen (aus Config)`, p._config.topup.reasons[0] === reason);
  check(
    "409 → requestId verworfen (definitive Ablehnung, kein offener Auftrag)",
    p._topupRequestId === null &&
      localStorage.getItem("allroggenChat.topupRequestId") === null
  );
  check("409 → kein offener-Auftrag-Alert", p._topupAlert() === false);
}

// ---- _sendTopup: 400/401 definitive Ablehnung verwirft requestId ------------
{
  const p = newPanel();
  fetchCalls = [];
  p._config = { topup: { allowed: true, amountEur: "10.00" } };
  fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}) });
  p._sendTopup();
  await settle();
  check("400 → zurück zur Übersicht", p._topupStage === null);
  check("400 → requestId verworfen", p._topupRequestId === null);

  const q = newPanel();
  fetchCalls = [];
  q._config = { topup: { allowed: true, amountEur: "10.00" } };
  fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  q._sendTopup();
  await settle();
  check("401 → zurück zur Übersicht", q._topupStage === null);
  check("401 → requestId verworfen", q._topupRequestId === null);
}

// ---- _sendTopup: Retry-Erfolg ohne Config und ohne Amount in der Response ----
{
  const p = newPanel();
  fetchCalls = [];
  // Retry-Pfad: Config kann null sein (z. B. Reload vorher fehlgeschlagen),
  // die Antwort darf amountEur fehlen — _topupDoneAmount muss dann null-safe
  // bleiben und "done" trotzdem rendern (Anzeige "–").
  p._topupRequestId = "0e0d7bc6-6f5e-4bd8-a27a-2bf4ba49a26e";
  localStorage.setItem("allroggenChat.topupRequestId", p._topupRequestId);
  p._config = null;
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status: "granted" }) });
  p._sendTopup(true);
  await settle();
  check("Retry ohne Config → Erfolg ohne Crash", p._topupStage === "done");
  check("fehlender Amount → null statt TypeError", p._topupDoneAmount === null);
  check("Erfolg → requestId freigegeben", p._topupRequestId === null);
  localStorage.removeItem("allroggenChat.topupRequestId");
}

// ---- requestId aus localStorage: GUID-Regex statt nur Länge ------------------
{
  localStorage.setItem("allroggenChat.topupRequestId", "kaputter-eintrag");
  let p = new globalThis.__Panel();
  check("ungültiger Eintrag verworfen", p._topupRequestId === null);
  check("ungültiger Eintrag aus Speicher entfernt", localStorage.getItem("allroggenChat.topupRequestId") === null);
  const fresh = p._ensureTopupRequestId();
  check("nach Verwurf: neue gültige GUID", GUID_RE.test(fresh));

  // 36 Zeichen, aber kein gültiges Hex/v4-Muster — Längen-Check allein
  // würde ihn fälschlich akzeptieren.
  localStorage.setItem("allroggenChat.topupRequestId", "z".repeat(36));
  p = new globalThis.__Panel();
  check("36-Zeichen-Nicht-GUID verworfen", p._topupRequestId === null);

  const valid = "0e0d7bc6-6f5e-4bd8-a27a-2bf4ba49a26e";
  localStorage.setItem("allroggenChat.topupRequestId", valid);
  p = new globalThis.__Panel();
  check("gültige GUID wird geladen", p._topupRequestId === valid);
  check("gültige GUID wird wiederverwendet", p._ensureTopupRequestId() === valid);
  localStorage.removeItem("allroggenChat.topupRequestId");
}

// ---- _sendTopup: unklarem Netz-Ergebnis → gleiche requestId wiederholen ------
{
  const p = newPanel();
  fetchCalls = [];
  p._config = { topup: { allowed: true, amountEur: "10.00" } };
  fetchImpl = async () => { throw new TypeError("Failed to fetch"); };
  p._sendTopup();
  const firstId = JSON.parse(fetchCalls[0][1].body).requestId;
  await settle();
  check("Netzfehler → stage unclear", p._topupStage === "unclear");
  check("Netzfehler → requestId bleibt", p._topupRequestId === firstId);
  // Retry mit derselben ID — auch ohne Freigabe in der (ggf. frischen) Config:
  p._config = { topup: { allowed: false, reasons: ["credit-awaiting-validated-invoice"] } };
  fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ status: "idempotent", amountEur: "10.00" }),
  });
  p._sendTopup(true);
  check("Retry sendet erneut", fetchCalls.length === 2);
  const retryId = JSON.parse(fetchCalls[1][1].body).requestId;
  check("Retry nutzt DIESELBE requestId", retryId === firstId);
  await settle(); await settle(); await settle();
  check("idempotent → done", p._topupDoneStatus === "idempotent" && p._topupStage === "done");
  check("idempotent → requestId freigegeben", p._topupRequestId === null);
}

// ---- _topupStartConfirm: Fail-closed ----------------------------------------
{
  const p = newPanel();
  p._config = { topup: { allowed: false, amountEur: "10.00" } };
  p._topupStartConfirm();
  check("Bestätigung ohne Freigabe verworfen", p._topupStage === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
