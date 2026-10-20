// Headless end-to-end for the client-side OpenRouter widget on the pilot page.
// - loads /widget/ under the meta CSP and asserts ZERO CSP violations / page errors
// - mocks OpenRouter (auth-keys exchange + streaming chat) via request interception
// - drives connect -> chat stream (with a cited source link) -> disconnect wipes storage
// - checks the Markdown renderer neutralises hostile model output
// - captures docs/widget-mobile.png, widget-desktop.png, widget-cited.png
// Run: node scripts/widget-e2e.mjs [baseUrl]   (default http://localhost:8080)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
const BASE = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080").replace(/\/$/, "");
const PAGE = BASE + "/widget/";

const SSE = [
  'data: {"choices":[{"delta":{"content":"Your OpenRouter key is kept in "}}]}',
  'data: {"choices":[{"delta":{"content":"**sessionStorage** (key `btw_or_key`), cleared when the tab closes. See "}}]}',
  'data: {"choices":[{"delta":{"content":"[Where your OpenRouter key lives](/widget/storage.html)."}}]}',
  "data: [DONE]", "",
].join("\n\n");

const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
const csp = [], errors = [];
p.on("console", (m) => { const t = m.text(); if (/content security policy|refused to/i.test(t)) csp.push(t); });
p.on("pageerror", (e) => errors.push(String(e.message || e)));

await p.setRequestInterception(true);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, http-referer, x-title", "Access-Control-Allow-Methods": "POST, OPTIONS" };
p.on("request", (req) => {
  const u = req.url();
  if (u.startsWith("https://openrouter.ai/")) {
    if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" }); // CORS preflight
    if (u === "https://openrouter.ai/api/v1/auth/keys") return req.respond({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ key: "sk-or-v1-MOCKKEY0000", user_id: "mock-user" }) });
    if (u === "https://openrouter.ai/api/v1/chat/completions") return req.respond({ status: 200, contentType: "text/event-stream", headers: CORS, body: SSE });
    return req.respond({ status: 200, headers: CORS, body: "" });
  }
  return req.continue();
});

let fail = 0;
const must = (cond, msg) => { if (!cond) { fail++; console.log("  FAIL -", msg); } else console.log("  ok -", msg); };

// 1) load under meta CSP
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await p.goto(PAGE, { waitUntil: "networkidle0" });
await p.waitForFunction(() => !!window.__btwUI, { timeout: 15000 });
must(csp.length === 0, "no CSP violations on load (meta CSP) " + (csp[0] ? "— " + csp[0] : ""));
must(errors.length === 0, "no page errors on load " + (errors[0] ? "— " + errors[0] : ""));

// widget mounted, marked+DOMPurify loaded despite strict CSP
const libs = await p.evaluate(() => ({ marked: !!window.marked, purify: !!window.DOMPurify, fab: !!document.querySelector(".btw-fab") }));
must(libs.marked && libs.purify, "vendored marked + DOMPurify loaded under script-src 'self'");
must(libs.fab, "floating button mounted");

// 2) renderer neutralises hostile output
const rr = await p.evaluate(() => {
  const host = document.createElement("div"); document.body.appendChild(host);
  window.__pwned = 0;
  const cases = ["<script>window.__pwned=1<\/script>", "<img src=x onerror=window.__pwned=1>", "[x](javascript:window.__pwned=1)", "[ok](/widget/storage.html)"];
  // Mount each rendered output into the live DOM and inspect real elements (escaped text like
  // "&lt;img onerror=...&gt;" is inert, so we check for live nodes/attributes, not the HTML string).
  let scriptEl = false, imgEl = false, onerrorAttr = false, jsHref = false, relLink = null;
  cases.forEach((c) => {
    host.innerHTML = window.__btwUI.render(c);
    if (host.querySelector("script")) scriptEl = true;
    if (host.querySelector("img")) imgEl = true;
    host.querySelectorAll("*").forEach((e) => { if (e.getAttribute && e.getAttribute("onerror") != null) onerrorAttr = true; });
    host.querySelectorAll("a").forEach((a) => { if (/^javascript:/i.test(a.getAttribute("href") || "")) jsHref = true; if (!relLink) relLink = a.getAttribute("rel"); });
  });
  return { pwned: window.__pwned, hasScript: scriptEl, hasImg: imgEl, onerror: onerrorAttr, jsHref, relLink };
});
must(!rr.hasScript && !rr.hasImg && !rr.onerror && !rr.jsHref && rr.pwned === 0, "renderer strips <script>/<img onerror>/javascript: (no live node, no execution)" + (rr.hasScript||rr.hasImg||rr.onerror||rr.jsHref||rr.pwned?" "+JSON.stringify(rr):""));
must(/noopener/.test(rr.relLink || ""), "safe links keep rel=noopener");

// 3) simulate the OAuth return: prepare PKCE, then land back with ?code&state
const state = await p.evaluate(async () => { await window.__btwUI.prepareAuth(); return JSON.parse(sessionStorage.getItem("btw_pkce")).st; });
await p.goto(PAGE + "?code=goodcode&state=" + encodeURIComponent(state), { waitUntil: "networkidle0" });
await p.waitForFunction(() => !!window.__btwUI, { timeout: 15000 });
await p.waitForFunction(() => !!sessionStorage.getItem("btw_or_key"), { timeout: 8000 });
const afterConnect = await p.evaluate(() => ({ key: sessionStorage.getItem("btw_or_key"), url: location.search, connected: window.__btwUI.connected() }));
must(afterConnect.key === "sk-or-v1-MOCKKEY0000", "exchange stored sk-or key in sessionStorage");
must(afterConnect.url === "", "code/state scrubbed from the URL after exchange");
must(afterConnect.connected, "widget reports connected");

// 4) chat stream with a cited source
await p.evaluate(() => { window.__btwUI.open(); window.__btwUI.setInput("where is my key stored?"); return window.__btwUI.submit(); });
await p.waitForFunction(() => { const m = document.querySelectorAll(".btw-assistant"); const last = m[m.length - 1]; return last && /sessionStorage/i.test(last.textContent); }, { timeout: 10000 });
const chat = await p.evaluate(() => {
  const m = document.querySelectorAll(".btw-assistant"); const last = m[m.length - 1];
  const a = last.querySelector('a[href="/widget/storage.html"]');
  return { text: last.textContent, hasCite: !!a, bold: !!last.querySelector("strong"), hist: !!sessionStorage.getItem("btw_chat") };
});
must(/sessionStorage/i.test(chat.text), "assistant reply streamed and rendered");
must(chat.hasCite, "reply cites the source page as a link (/widget/storage.html)");
must(chat.bold, "Markdown rendered (bold)");
must(chat.hist, "chat history persisted to sessionStorage (btw_chat)");
await p.screenshot({ path: "docs/widget-mobile.png" });
await p.screenshot({ path: "docs/widget-cited.png" });

// 5) disconnect wipes storage
await p.evaluate(() => { window.__btwUI.disconnect(); window.__btwUI.refresh(); });
const afterDisc = await p.evaluate(() => ["btw_or_key", "btw_or_uid", "btw_chat", "btw_model"].map((k) => sessionStorage.getItem(k)));
must(afterDisc.every((v) => v === null), "disconnect wiped btw_or_key / uid / chat / model");

// 6) desktop screenshot
await p.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
await p.goto(PAGE, { waitUntil: "networkidle0" });
await p.evaluate(() => window.__btwUI && window.__btwUI.open());
await new Promise((r) => setTimeout(r, 300));
await p.screenshot({ path: "docs/widget-desktop.png" });

// 7) isolation: never touches bt_sess / bt_chat
const iso = await p.evaluate(() => ({ btSess: localStorage.getItem("bt_chat"), onlyBtw: Object.keys(sessionStorage).every((k) => k.startsWith("btw_")) }));
must(iso.btSess === null, "widget did not write the tutor's bt_chat");
must(iso.onlyBtw, "widget only used btw_* storage keys");

await b.close();
console.log(csp.length ? "\nCSP violations:\n" + csp.join("\n") : "");
if (fail) { console.log(`\nWIDGET E2E FAILED (${fail})`); process.exit(1); }
console.log("\nWIDGET E2E PASSED");
