// OAuth callback robustness for the client-side widget. The return is simulated in a NEW tab (a separate page
// in the same browser context = same localStorage, empty sessionStorage), like a Custom Tab / installed-app
// return on Android. Mocks only the successful exchange (no real account); the bogus-code case hits the REAL
// https://openrouter.ai/api/v1/auth/keys and checks its exact error reaches the UI.
// Run: node scripts/widget-oauth-e2e.mjs [baseUrl]   (default http://localhost:8080)
import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
const BASE = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080").replace(/\/$/, "");
const PAGE = BASE + "/widget/";
const MOBILE = { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Mobile Safari/537.36" };
const MOCK_KEY = "sk-or-v1-MOCKKEY-DO-NOT-PRINT-1234";
const CODE = "test-code-DO-NOT-PRINT-5678";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" };

const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const ctx = b.defaultBrowserContext();
let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log("  FAIL -", m); } else console.log("  ok -", m); };
const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function tabA(qs = "") {
  const A = await ctx.newPage(); await A.emulate(MOBILE);
  await A.goto(PAGE + qs, { waitUntil: "networkidle0" }); await A.waitForFunction(() => !!window.__btwUI);
  return A;
}
async function start(A) {
  return A.evaluate(async () => { const url = await window.__btwUI.prepareAuth(); return { url, pk: JSON.parse(localStorage.getItem("btw_pkce")), sess: sessionStorage.getItem("btw_pkce") }; });
}
// Open the OAuth return in a NEW tab. mode: "mock" (200 + key), "real" (no interception).
async function tabB(path, mode, seen) {
  const B = await ctx.newPage(); await B.emulate(MOBILE);
  if (mode === "mock") {
    await B.setRequestInterception(true);
    B.on("request", (r) => {
      if (r.url() === "https://openrouter.ai/api/v1/auth/keys") {
        if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });
        seen.calls++; seen.body = JSON.parse(r.postData() || "{}");
        return r.respond({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ key: MOCK_KEY, user_id: "u1" }) });
      }
      r.continue();
    });
  } else if (seen) {
    B.on("request", (r) => { if (r.url() === "https://openrouter.ai/api/v1/auth/keys" && r.method() === "POST") seen.calls++; });
  }
  await B.goto(BASE + path, { waitUntil: "networkidle0" });
  await B.waitForFunction(() => !!window.__btwUI, { timeout: 15000 });
  await B.evaluate(() => window.__btwUI.exchangeDone());
  await new Promise((r) => setTimeout(r, 300));
  return B;
}
const state = (B) => B.evaluate(() => ({
  connected: window.__btwUI.connected(), sheet: getComputedStyle(document.querySelector(".btw-sheet")).display,
  msgs: [...document.querySelectorAll(".btw-assistant")].map((m) => m.textContent), note: document.querySelector(".btw-note").textContent,
  url: location.href, pkce: localStorage.getItem("btw_pkce"), persist: localStorage.getItem("btw_or_key_persist"),
  dbg: (document.querySelector(".btw-debug") || {}).textContent || "", html: document.documentElement.outerHTML,
}));

console.log("1) return lands in a NEW tab -> exchange works, sheet opens Connected");
let A = await tabA(); let s0 = await start(A);
must(s0.pk && s0.pk.v && s0.pk.exp - Date.now() > 9 * 60e3 && s0.pk.exp - Date.now() <= 10 * 60e3 + 1000, "verifier+state stored in localStorage with a 10-minute TTL");
must(s0.sess === null, "verifier is NOT in sessionStorage (would be lost in a new tab)");
const au = new URL(s0.url);
must(au.searchParams.get("code_challenge_method") === "S256", "auth URL uses code_challenge_method=S256");
must(au.searchParams.get("code_challenge") === b64url(createHash("sha256").update(s0.pk.v).digest()), "code_challenge == base64url(sha256(verifier)), no padding");
must(au.searchParams.get("callback_url") === PAGE.replace(/^http:\/\/localhost/, "http://localhost"), "callback_url is this exact page");
let seen = { calls: 0 }; let B = await tabB("/widget/?code=" + CODE + "&state=" + encodeURIComponent(s0.pk.st), "mock", seen);
let st = await state(B);
must(seen.calls === 1 && seen.body.code_verifier === s0.pk.v && seen.body.code_challenge_method === "S256" && seen.body.code === CODE, "new tab POSTed the original tab's verifier + S256 + code");
must(st.connected, "new tab is CONNECTED");
must(st.sheet === "flex" && st.msgs.some((m) => /Connected to OpenRouter/.test(m)) && /^Connected/.test(st.note), "sheet auto-opened showing Connected");
must(st.pkce === null, "verifier deleted right after use (one-time)");
must(!/code=|state=/.test(st.url), "code/state scrubbed from the URL");
must(st.persist === null, "default: key NOT persisted to localStorage (sessionStorage only)");
must(!st.html.includes(MOCK_KEY) && !st.html.includes(CODE), "neither the key nor the code appears anywhere in the page");
await B.screenshot({ path: "docs/widget-oauth-connected.png" });
await B.close(); await A.close();

console.log("2) state mismatch is rejected (no exchange), visible error");
A = await tabA(); s0 = await start(A); seen = { calls: 0 };
B = await tabB("/widget/?code=" + CODE + "&state=forged-state", "mock", seen); st = await state(B);
must(seen.calls === 0, "no exchange request on a state mismatch");
must(!st.connected && st.sheet === "flex" && st.msgs.some((m) => /state mismatch/i.test(m)), "sheet shows the state-mismatch error");
must(st.pkce === null, "pending verifier discarded");
await B.screenshot({ path: "docs/widget-oauth-state-mismatch.png" });
await B.close(); await A.close();

console.log("3) verifier missing (different browser / cleared data) -> visible error, no exchange");
const inc = await b.createBrowserContext(); const C = await inc.newPage(); await C.emulate(MOBILE);
let callsC = 0; C.on("request", (r) => { if (r.url().includes("/api/v1/auth/keys") && r.method() === "POST") callsC++; });
await C.goto(PAGE + "?code=" + CODE + "&state=abc", { waitUntil: "networkidle0" }); await C.waitForFunction(() => !!window.__btwUI);
await C.evaluate(() => window.__btwUI.exchangeDone()); await new Promise((r) => setTimeout(r, 300)); st = await state(C);
must(callsC === 0 && !st.connected && st.msgs.some((m) => /wasn.t started in this browser/i.test(m)) && st.sheet === "flex", "explains the sign-in started elsewhere; nothing silent");
await inc.close();

console.log("4) expired verifier (>10 min) -> visible error");
A = await tabA(); s0 = await start(A);
await A.evaluate(() => { const p = JSON.parse(localStorage.getItem("btw_pkce")); p.exp = Date.now() - 1000; localStorage.setItem("btw_pkce", JSON.stringify(p)); });
seen = { calls: 0 }; B = await tabB("/widget/?code=" + CODE + "&state=" + encodeURIComponent(s0.pk.st), "mock", seen); st = await state(B);
must(seen.calls === 0 && st.msgs.some((m) => /expired/i.test(m)), "expired sign-in shows an 'expired' message, no exchange");
await B.close(); await A.close();

console.log("5) user denied on OpenRouter -> visible 'cancelled or denied'");
A = await tabA(); await start(A); seen = { calls: 0 };
B = await tabB("/widget/?error=access_denied", "mock", seen); st = await state(B);
must(seen.calls === 0 && st.msgs.some((m) => /cancelled or denied/i.test(m)), "denied return shows a clear message");
await B.close(); await A.close();

console.log("6) path variants: /widget (no slash) and /widget/index.html");
for (const v of ["/widget", "/widget/index.html"]) {
  A = await tabA(); s0 = await start(A); seen = { calls: 0 };
  B = await tabB(v + "?code=" + CODE + "&state=" + encodeURIComponent(s0.pk.st), "mock", seen); st = await state(B);
  must(seen.calls === 1 && st.connected, v + " return completes the exchange");
  await B.close(); await A.close();
}

console.log("7) ?btw_debug=1 trace survives the round-trip and never prints the code or key");
A = await tabA("?btw_debug=1"); s0 = await start(A); seen = { calls: 0 };
B = await tabB("/widget/?code=" + CODE + "&state=" + encodeURIComponent(s0.pk.st), "mock", seen); st = await state(B);
must(/callback detected: code present, state present/.test(st.dbg) && /state match: yes/.test(st.dbg) && /exchange: HTTP 200/.test(st.dbg) && /key stored/.test(st.dbg), "debug line shows each callback step");
must(!st.dbg.includes(CODE) && !st.dbg.includes(MOCK_KEY) && !/sk-or-/.test(st.dbg), "debug trace contains neither the code nor the key");
await B.screenshot({ path: "docs/widget-oauth-debug.png" });
await B.evaluate(() => { localStorage.removeItem("btw_debug"); });
await B.close(); await A.close();

console.log("8) opt-in 'remember on this device' -> persisted with expiry; original tab picks it up; Disconnect wipes");
A = await tabA(); await A.evaluate(() => { window.__btwUI.open(); document.querySelector(".btw-remember input").click(); });
s0 = await start(A); seen = { calls: 0 };
B = await tabB("/widget/?code=" + CODE + "&state=" + encodeURIComponent(s0.pk.st), "mock", seen); st = await state(B);
const per = st.persist ? JSON.parse(st.persist) : null;
must(per && per.exp - Date.now() > 6.9 * 864e5 && per.exp - Date.now() <= 7 * 864e5 + 1000, "remembered key stored in localStorage with a 7-day expiry");
await new Promise((r) => setTimeout(r, 500));
must(await A.evaluate(() => window.__btwUI.connected()), "original tab became connected via the storage event");
await A.evaluate(() => window.__btwUI.disconnect());
must(await A.evaluate(() => !localStorage.getItem("btw_or_key_persist") && !localStorage.getItem("btw_remember")), "Disconnect wipes the remembered key and the preference");
await B.close(); await A.close();

console.log("9) REAL OpenRouter: bogus code -> exact error text shown in the UI");
A = await tabA(); s0 = await start(A); seen = { calls: 0 };
B = await tabB("/widget/?code=bogus-" + Date.now() + "&state=" + encodeURIComponent(s0.pk.st), "real", seen); st = await state(B);
const errMsg = st.msgs.find((m) => /OpenRouter said/.test(m)) || "";
must(seen.calls === 1, "a real POST to openrouter.ai/api/v1/auth/keys was made");
must(/OpenRouter said: .+\(HTTP 4\d\d\)/.test(errMsg) && /invalid code/i.test(errMsg), "UI shows OpenRouter's exact error: " + errMsg.slice(0, 90));
must(!st.connected && st.sheet === "flex", "not connected, sheet open with the error (not silent)");
await B.screenshot({ path: "docs/widget-oauth-real-error.png" });
await B.close(); await A.close();

await b.close();
if (fail) { console.log(`\nWIDGET OAUTH E2E FAILED (${fail})`); process.exit(1); }
console.log("\nWIDGET OAUTH E2E PASSED");
