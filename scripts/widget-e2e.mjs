// Headless E2E for the client-side OpenRouter widget on the pilot page.
// Phase A (real touch, mobile 390x844): sheet opens/closes/reopens via taps, backdrop + back-button
//   close, no horizontal overflow, controls on-screen with >=44px tap targets, typing allowed before
//   connect and Send prompts to connect (never silent). Checks COMPUTED visibility, not the .hidden prop.
// Phase B (mocked OpenRouter): connect -> chat stream (cited) -> disconnect wipes storage; renderer XSS.
// Captures docs/widget-mobile.png, widget-desktop.png, widget-cited.png.
// Run: node scripts/widget-e2e.mjs [baseUrl]   (default http://localhost:8080)
import puppeteer from "puppeteer-core";
const BASE = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080").replace(/\/$/, "");
const PAGE = BASE + "/widget/";
const SSE = [
  'data: {"choices":[{"delta":{"content":"Your OpenRouter key is kept in "}}]}',
  'data: {"choices":[{"delta":{"content":"**sessionStorage** (key `btw_or_key`), cleared when the tab closes. See "}}]}',
  'data: {"choices":[{"delta":{"content":"[Where your OpenRouter key lives](/widget/storage.html)."}}]}',
  "data: [DONE]", "",
].join("\n\n");

const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let fail = 0;
const must = (cond, msg) => { if (!cond) { fail++; console.log("  FAIL -", msg); } else console.log("  ok -", msg); };
const disp = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).display : "missing"; }, sel);

// ---------------- Phase A: real touch on a mobile viewport ----------------
console.log("Phase A — mobile touch (390x844)");
const m = await b.newPage();
await m.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Mobile Safari/537.36" });
const cspA = []; m.on("console", (e) => { const t = e.text(); if (/content security|refused to/i.test(t)) cspA.push(t); });
await m.goto(PAGE, { waitUntil: "networkidle0" });
await m.waitForFunction(() => !!document.querySelector(".btw-fab"), { timeout: 15000 });

const over = await m.evaluate(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, docW: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
must(!over.overflow, "no horizontal overflow at 390px (docW " + over.docW + " <= " + over.cw + ")");

must((await disp(m, ".btw-sheet")) === "none", "sheet hidden on load (computed display:none)");
await m.tap(".btw-fab"); await new Promise((r) => setTimeout(r, 400));
must((await disp(m, ".btw-sheet")) === "flex", "FAB tap OPENS the sheet");
const geo = await m.evaluate(() => {
  const c = document.querySelector(".btw-close").getBoundingClientRect();
  const f = document.querySelector(".btw-fab").getBoundingClientRect();
  const on = (r) => r.width > 0 && r.height > 0 && r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;
  return { closeW: Math.round(c.width), closeH: Math.round(c.height), closeOn: on(c), fabOn: on(f) };
});
must(geo.closeW >= 44 && geo.closeH >= 44, "close button tap target >= 44x44 (" + geo.closeW + "x" + geo.closeH + ")");
must(geo.closeOn, "close button fully on-screen");
await m.screenshot({ path: "docs/widget-mobile.png" });

await m.tap(".btw-close"); await new Promise((r) => setTimeout(r, 400));
must((await disp(m, ".btw-sheet")) === "none", "close button CLOSES the sheet (visible)");
await m.tap(".btw-fab"); await new Promise((r) => setTimeout(r, 400));
must((await disp(m, ".btw-sheet")) === "flex", "FAB reopens the sheet");
await m.touchscreen.tap(8, 8); await new Promise((r) => setTimeout(r, 400));
must((await disp(m, ".btw-sheet")) === "none", "backdrop tap closes the sheet");
// Android back button closes (does not leave the page)
await m.tap(".btw-fab"); await new Promise((r) => setTimeout(r, 300));
must((await disp(m, ".btw-sheet")) === "flex", "sheet open before back-button test");
await m.goBack(); await new Promise((r) => setTimeout(r, 400));
const stillWidget = await m.evaluate(() => !!document.querySelector(".btw-sheet"));
must(stillWidget && (await disp(m, ".btw-sheet")) === "none", "Android back button closes the sheet (stays on page)");

// typing allowed before connect; Send prompts to connect (not silent)
await m.tap(".btw-fab"); await new Promise((r) => setTimeout(r, 300));
const pre = await m.evaluate(async () => {
  const t = document.querySelector(".btw-input"); const before = document.querySelectorAll(".btw-assistant").length;
  t.value = "where is my key stored?"; window.__btwUI.submit();
  await new Promise((r) => setTimeout(r, 100));
  const after = document.querySelectorAll(".btw-assistant").length;
  const last = document.querySelectorAll(".btw-assistant")[after - 1];
  return { disabled: t.disabled, added: after - before, msg: last ? last.textContent : "" };
});
must(!pre.disabled, "textarea is editable before connecting");
must(pre.added === 1 && /connect openrouter/i.test(pre.msg), "Send before connect shows a visible 'Connect OpenRouter first' prompt");
must(cspA.length === 0, "no CSP violations in the mobile flow " + (cspA[0] || ""));
await m.close();

// ---------------- Phase B: mocked OpenRouter connect/chat/disconnect ----------------
console.log("Phase B — mocked OpenRouter + renderer");
const p = await b.newPage();
const csp = [], errors = [];
p.on("console", (e) => { const t = e.text(); if (/content security|refused to/i.test(t)) csp.push(t); });
p.on("pageerror", (e) => errors.push(String(e.message || e)));
await p.setRequestInterception(true);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, http-referer, x-title", "Access-Control-Allow-Methods": "POST, OPTIONS" };
p.on("request", (req) => {
  const u = req.url();
  if (u.startsWith("https://openrouter.ai/")) {
    if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (u === "https://openrouter.ai/api/v1/auth/keys") return req.respond({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ key: "sk-or-v1-MOCKKEY0000", user_id: "mock-user" }) });
    if (u === "https://openrouter.ai/api/v1/chat/completions") return req.respond({ status: 200, contentType: "text/event-stream", headers: CORS, body: SSE });
    return req.respond({ status: 200, headers: CORS, body: "" });
  }
  return req.continue();
});
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await p.goto(PAGE, { waitUntil: "networkidle0" });
await p.waitForFunction(() => !!window.__btwUI, { timeout: 15000 });
must(csp.length === 0, "no CSP violations on load " + (csp[0] || ""));
must(errors.length === 0, "no page errors on load " + (errors[0] || ""));
const libs = await p.evaluate(() => ({ marked: !!window.marked, purify: !!window.DOMPurify }));
must(libs.marked && libs.purify, "vendored marked + DOMPurify loaded under script-src 'self'");

// renderer neutralises hostile output (live DOM check, not string match)
const rr = await p.evaluate(() => {
  const host = document.createElement("div"); document.body.appendChild(host); window.__pwned = 0;
  const cases = ["<script>window.__pwned=1<\/script>", "<img src=x onerror=window.__pwned=1>", "[x](javascript:window.__pwned=1)", "[ok](/widget/storage.html)"];
  let s = false, i = false, o = false, j = false, rel = null;
  cases.forEach((c) => { host.innerHTML = window.__btwUI.render(c);
    if (host.querySelector("script")) s = true; if (host.querySelector("img")) i = true;
    host.querySelectorAll("*").forEach((e) => { if (e.getAttribute && e.getAttribute("onerror") != null) o = true; });
    host.querySelectorAll("a").forEach((a) => { if (/^javascript:/i.test(a.getAttribute("href") || "")) j = true; if (!rel) rel = a.getAttribute("rel"); }); });
  return { pwned: window.__pwned, s, i, o, j, rel };
});
must(!rr.s && !rr.i && !rr.o && !rr.j && rr.pwned === 0, "renderer strips <script>/<img onerror>/javascript: (no live node)");
must(/noopener/.test(rr.rel || ""), "safe links keep rel=noopener");

// OAuth return -> key stored
const state = await p.evaluate(async () => { await window.__btwUI.prepareAuth(); return JSON.parse(localStorage.getItem("btw_pkce")).st; });
await p.goto(PAGE + "?code=goodcode&state=" + encodeURIComponent(state), { waitUntil: "networkidle0" });
await p.waitForFunction(() => !!window.__btwUI, { timeout: 15000 });
await p.waitForFunction(() => !!sessionStorage.getItem("btw_or_key"), { timeout: 8000 });
const ac = await p.evaluate(() => ({ key: sessionStorage.getItem("btw_or_key"), url: location.search, connected: window.__btwUI.connected() }));
must(ac.key === "sk-or-v1-MOCKKEY0000", "exchange stored sk-or key in sessionStorage");
must(ac.url === "", "code/state scrubbed from the URL");
must(ac.connected, "widget reports connected");

// chat stream + citation
await p.evaluate(() => { window.__btwUI.open(); window.__btwUI.setInput("where is my key stored?"); return window.__btwUI.submit(); });
await p.waitForFunction(() => { const m = document.querySelectorAll(".btw-assistant"); const l = m[m.length - 1]; return l && /sessionStorage/i.test(l.textContent); }, { timeout: 10000 });
const chat = await p.evaluate(() => { const m = document.querySelectorAll(".btw-assistant"); const l = m[m.length - 1]; return { cite: !!l.querySelector('a[href="/widget/storage.html"]'), bold: !!l.querySelector("strong"), hist: !!sessionStorage.getItem("btw_chat") }; });
must(chat.cite, "reply cites the source page as a link");
must(chat.bold, "Markdown rendered (bold)");
must(chat.hist, "chat history persisted to sessionStorage (btw_chat)");
await p.screenshot({ path: "docs/widget-cited.png" });

// disconnect wipes storage
await p.evaluate(() => { window.__btwUI.disconnect(); window.__btwUI.refresh(); });
const ad = await p.evaluate(() => ["btw_or_key", "btw_or_uid", "btw_chat", "btw_model"].map((k) => sessionStorage.getItem(k)));
must(ad.every((v) => v === null), "disconnect wiped btw_or_key / uid / chat / model");
const iso = await p.evaluate(() => ({ bt: localStorage.getItem("bt_chat"), only: Object.keys(sessionStorage).every((k) => k.startsWith("btw_")) }));
must(iso.bt === null && iso.only, "isolated: only btw_* keys, never bt_sess/bt_chat");

// desktop screenshot
await p.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
await p.goto(PAGE, { waitUntil: "networkidle0" });
await p.evaluate(() => window.__btwUI && window.__btwUI.open());
await new Promise((r) => setTimeout(r, 300));
await p.screenshot({ path: "docs/widget-desktop.png" });
await b.close();

if (fail) { console.log(`\nWIDGET E2E FAILED (${fail})`); process.exit(1); }
console.log("\nWIDGET E2E PASSED");
