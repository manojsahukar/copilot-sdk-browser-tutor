// Hugging Face provider pilot (mocked HF). The REAL /widget/ page is served with the two opt-in attributes injected
// by request interception (data-providers="openrouter,huggingface" + a PLACEHOLDER data-hf-client-id), under its real
// CSP header + meta. huggingface.co/oauth/token and router.huggingface.co are mocked; any other HF request fails the test.
// Covers: off by default, provider switching, PKCE S256 + one-time 10-min verifier, NEW-tab return, forged state,
// expiry, remember, disconnect, chat headers, error mapping, CSP hint, no token/code leakage. Mobile screenshots.
// Run: node scripts/widget-hf-e2e.mjs [baseUrl]   (default http://localhost:8080)
import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
const BASE = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080").replace(/\/$/, "");
const PAGE = BASE + "/widget/";
const CLIENT_ID = "TEST-CLIENT-0001-placeholder";
const MOCK_TOKEN = "hf_oauth_MOCKTOKEN_DO_NOT_PRINT_9f8e7d";
const CODE = "hf-test-code-DO-NOT-PRINT-4321";
const MOCK_OR_KEY = "sk-or-v1-MOCKKEY-DO-NOT-PRINT-1234";
const MOBILE = { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Mobile Safari/537.36" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const OR_CORS = { ...CORS, "Access-Control-Allow-Headers": "authorization, content-type, http-referer, x-title" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString("base64url");
let fail = 0; const must = (c, m) => { if (!c) { fail++; console.log("  FAIL -", m); } else console.log("  ok -", m); };

const realPage = await fetch(PAGE); const realHtml = await realPage.text(); const realCsp = realPage.headers.get("content-security-policy");
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let ctx = await b.createBrowserContext();
const seen = { token: [], chat: [], or: [], unexpected: [] };
let chatMode = "ok";  // ok | 402 | 401

// opts.enable: inject the HF opt-in; opts.stripCsp: remove HF hosts from the page CSP (host forgot them)
async function newTab(path = "/widget/", opts = { enable: true }) {
  const p = await ctx.newPage(); await p.emulate(MOBILE);
  await p.evaluateOnNewDocument(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push((e.effectiveDirective || e.violatedDirective) + " " + e.blockedURI)); });
  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    if (u.startsWith(PAGE) && r.resourceType() === "document") {
      let html = realHtml, csp = realCsp;
      if (opts.enable) html = html.replace('<script src="/static/widget.js"', `<script src="/static/widget.js" data-providers="openrouter,huggingface" data-hf-client-id="${CLIENT_ID}"`);
      if (opts.stripCsp) { html = html.replace(/ https:\/\/huggingface\.co https:\/\/router\.huggingface\.co/g, ""); csp = csp.replace(/ https:\/\/huggingface\.co https:\/\/router\.huggingface\.co/g, ""); }
      return r.respond({ status: 200, contentType: "text/html; charset=utf-8", headers: { "content-security-policy": csp }, body: html });
    }
    if (u === "https://huggingface.co/oauth/token") {
      if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });
      seen.token.push({ body: Object.fromEntries(new URLSearchParams(r.postData() || "")), headers: r.headers() });
      return r.respond({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ access_token: MOCK_TOKEN, token_type: "bearer", expires_in: 28800, scope: "openid profile inference-api", id_token: "x.y.z" }) });
    }
    if (u === "https://router.huggingface.co/v1/chat/completions") {
      if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });
      seen.chat.push({ body: JSON.parse(r.postData() || "{}"), headers: r.headers() });
      if (chatMode === "402") return r.respond({ status: 402, contentType: "application/json", headers: CORS, body: JSON.stringify({ error: "You have exceeded your monthly included credits for Inference Providers." }) });
      if (chatMode === "401") return r.respond({ status: 401, contentType: "application/json", headers: CORS, body: JSON.stringify({ error: "Invalid username or password." }) });
      const sse = ["Hello from ", "**Hugging Face** (mocked)."].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join("") + "data: [DONE]\n\n";
      return r.respond({ status: 200, contentType: "text/event-stream", headers: CORS, body: sse });
    }
    if (u === "https://openrouter.ai/api/v1/chat/completions") {
      if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: OR_CORS, body: "" });
      seen.or.push({ headers: r.headers() });
      return r.respond({ status: 200, contentType: "text/event-stream", headers: CORS, body: `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from OpenRouter (mocked)." } }] })}\n\ndata: [DONE]\n\n`, headers: OR_CORS });
    }
    if (/^https:\/\/([a-z.]*\.)?huggingface\.co\//.test(u)) { seen.unexpected.push(u.slice(0, 80)); return r.abort(); }
    r.continue();
  });
  await p.goto(BASE + path, { waitUntil: "networkidle0" });
  await p.waitForFunction(() => !!window.__btwUI, { timeout: 15000 });
  return p;
}
const ui = (p) => p.evaluate(() => {
  const U = window.__btwUI;
  return { providers: U.providers(), provider: U.provider(), connected: U.connected(), conn: U.els.conn.textContent,
    picker: !!document.querySelector(".btw-prov"), pickerBtns: [...document.querySelectorAll(".btw-prov-b")].map((x) => x.textContent + (x.getAttribute("aria-checked") === "true" ? "*" : "")),
    models: [...U.els.sel.options].map((o) => o.value), model: U.els.sel.value, note: U.els.note.textContent,
    msgs: [...document.querySelectorAll(".btw-assistant")].map((m) => m.textContent), url: location.href,
    pkce: localStorage.getItem("btw_pkce"), tok: sessionStorage.getItem("btw_hf_token"), exp: sessionStorage.getItem("btw_hf_exp"),
    persist: localStorage.getItem("btw_hf_token_persist"), dbg: (document.querySelector(".btw-debug") || {}).textContent || "",
    html: document.documentElement.outerHTML, csp: window.__csp.slice() };
});
const start = (p) => p.evaluate(async () => { const url = await window.__btwUI.prepareAuth("huggingface"); return { url, pk: JSON.parse(localStorage.getItem("btw_pkce")), sess: sessionStorage.getItem("btw_pkce") }; });
async function ret(qs) { const B = await newTab("/widget/" + qs); await B.evaluate(() => window.__btwUI.exchangeDone()); await sleep(300); return B; }
async function send(p, text) { await p.evaluate((t) => { window.__btwUI.open(); window.__btwUI.setInput(t); return window.__btwUI.submit(); }, text); await sleep(400); }

console.log("1) OFF by default: the unmodified page offers OpenRouter only");
let P0 = await newTab("/widget/", { enable: false }); let s = await ui(P0);
must(s.providers.join() === "openrouter" && !s.picker && s.conn === "Connect OpenRouter", "no data-* opt-in -> no picker, 'Connect OpenRouter', providers=[openrouter]");
must(s.model === "openrouter/free" && s.models.includes("openrouter/auto"), "OpenRouter models + free default unchanged");
await P0.close();

console.log("2) enabled: provider picker + switching");
let A = await newTab(); await A.evaluate(() => window.__btwUI.open()); s = await ui(A);
must(s.picker && s.pickerBtns.join() === "OpenRouter*,Hugging Face", "picker shows OpenRouter (selected) and Hugging Face");
await A.click('.btw-prov-b[data-provider="huggingface"]'); await sleep(150); s = await ui(A);
must(s.provider === "huggingface" && s.conn === "Connect Hugging Face" && s.pickerBtns.join() === "OpenRouter,Hugging Face*", "switch to Hugging Face: button + selection follow");
must(s.model === "meta-llama/Llama-3.1-8B-Instruct:cheapest" && s.models.length === 5 && s.models.every((m) => m.endsWith(":cheapest")), "HF curated models, cheap default");
must(/billed to your HF account/i.test(s.note) && /sessionStorage/.test(s.note), "HF note explains billing + tab-only token");
await A.screenshot({ path: "docs/widget-hf-picker-390.png" });
await A.click('.btw-prov-b[data-provider="openrouter"]'); await sleep(150); s = await ui(A);
must(s.provider === "openrouter" && s.conn === "Connect OpenRouter" && s.model === "openrouter/free", "switch back to OpenRouter restores its models/default");
await A.click('.btw-prov-b[data-provider="huggingface"]'); await sleep(100);

console.log("3) sign-in start: PKCE S256, exact redirect, scopes, one-time 10-min verifier in localStorage");
let s0 = await start(A); let au = new URL(s0.url);
must(au.origin + au.pathname === "https://huggingface.co/oauth/authorize", "redirects to huggingface.co/oauth/authorize");
must(au.searchParams.get("client_id") === CLIENT_ID && au.searchParams.get("redirect_uri") === PAGE && au.searchParams.get("response_type") === "code", "client_id, exact redirect_uri (this page) and response_type=code");
must(au.searchParams.get("code_challenge_method") === "S256" && au.searchParams.get("code_challenge") === b64url(createHash("sha256").update(s0.pk.v).digest()), "S256 challenge = base64url(sha256(verifier))");
must(/(^| )inference-api( |$)/.test(au.searchParams.get("scope")) && !au.searchParams.has("client_secret"), "scope includes inference-api; no client secret anywhere");
must(s0.pk.p === "huggingface" && s0.pk.st === au.searchParams.get("state") && Math.abs(s0.pk.exp - Date.now() - 600000) < 15000 && s0.sess === null, "verifier+state in localStorage (not sessionStorage), 10-minute TTL, tagged provider=huggingface");

console.log("4) return lands in a NEW tab -> token exchanged (public client + PKCE), connected");
let B = await ret(`?code=${CODE}&state=${s0.pk.st}`); s = await ui(B);
const tb = seen.token[0] && seen.token[0].body;
must(seen.token.length === 1 && tb.grant_type === "authorization_code" && tb.code === CODE && tb.code_verifier === s0.pk.v && tb.redirect_uri === PAGE && tb.client_id === CLIENT_ID, "token request: authorization_code + code + verifier + exact redirect_uri + client_id");
must(!("client_secret" in tb) && !/^basic /i.test((seen.token[0].headers || {}).authorization || ""), "no client_secret and no Basic auth header");
must(s.connected && s.provider === "huggingface" && s.tok === MOCK_TOKEN && s.conn === "Disconnect", "connected to Hugging Face in the new tab; token in sessionStorage");
must(Math.abs(Number(s.exp) - Date.now() - 28800e3) < 30e3 && /expires in about 8 h/.test(s.note), "token expiry tracked (8 h) and shown");
must(s.pkce === null && s.url === PAGE && !s.url.includes("code="), "verifier deleted (one-time) and ?code/state scrubbed from the URL");
must(s.msgs.some((m) => /Connected to Hugging Face/.test(m)), "sheet opens with 'Connected to Hugging Face'");

console.log("5) chat goes to router.huggingface.co with the visitor's token");
await send(B, "What is this site?"); s = await ui(B);
const ch = seen.chat[0] || { headers: {}, body: {} };
must(seen.chat.length === 1 && ch.headers.authorization === "Bearer " + MOCK_TOKEN && ch.body.model === "meta-llama/Llama-3.1-8B-Instruct:cheapest" && ch.body.stream === true, "router call: Bearer token, default model, stream");
must(!ch.headers["http-referer"] && !ch.headers["x-title"], "no OpenRouter attribution headers sent to Hugging Face");
must(s.msgs.some((m) => /Hello from Hugging Face \(mocked\)/.test(m)), "streamed reply rendered (Markdown sanitised)");
must(seen.or.length === 0, "nothing went to OpenRouter");
await B.evaluate(() => { const l = document.querySelector(".btw-log"); l.scrollTop = l.scrollHeight; });
await B.screenshot({ path: "docs/widget-hf-connected-390.png" });

console.log("6) replaying the same return URL: verifier already used -> rejected, no 2nd exchange");
const n1 = seen.token.length; let B2 = await ret(`?code=${CODE}&state=${s0.pk.st}`); s = await ui(B2);
must(seen.token.length === n1, "no second token request");
must(s.msgs.some((m) => /wasn't started in this browser/.test(m)), "explains the sign-in can't be completed here");
await B2.close();

console.log("7) forged state -> rejected before any exchange");
await B.evaluate(() => window.__btwUI.disconnect()); await B.close();
s0 = await start(A); const n2 = seen.token.length;
let F = await ret(`?code=${CODE}&state=FORGED-state-value`); s = await ui(F);
must(seen.token.length === n2 && !s.connected && s.tok === null, "no token request, not connected");
must(s.msgs.some((m) => /state mismatch/.test(m)) && s.pkce === null, "state-mismatch error shown; verifier consumed");
await F.close();

console.log("8) expired verifier -> rejected");
s0 = await start(A); await A.evaluate(() => { const p = JSON.parse(localStorage.getItem("btw_pkce")); p.exp = Date.now() - 1000; localStorage.setItem("btw_pkce", JSON.stringify(p)); });
const n3 = seen.token.length; let E = await ret(`?code=${CODE}&state=${s0.pk.st}`); s = await ui(E);
must(seen.token.length === n3 && s.msgs.some((m) => /longer than 10 minutes/.test(m)), "expired sign-in rejected with a clear message, no exchange");
await E.close();

console.log("9) debug trace + DOM never contain the code or the token");
s0 = await start(A); let D = await ret(`?code=${CODE}&state=${s0.pk.st}&btw_debug=1`); s = await ui(D);
must(s.connected && /exchanging code at huggingface\.co/.test(s.dbg) && /token received/.test(s.dbg), "debug trace shows the steps");
must(!s.dbg.includes(CODE) && !s.dbg.includes(MOCK_TOKEN) && !s.html.includes(CODE) && !s.html.includes(MOCK_TOKEN), "neither the code nor the token appears in the trace or the page");

console.log("10) error mapping (402 credits, 401 token)");
chatMode = "402"; await send(D, "hi"); s = await ui(D);
must(s.msgs.some((m) => /no Inference Providers credits/.test(m)) && !s.html.includes(MOCK_TOKEN), "402 -> credits message (no token echoed)");
chatMode = "401"; await send(D, "hi again"); s = await ui(D);
must(s.msgs.some((m) => /didn't accept the token/.test(m)), "401 -> sign-in-again message");
chatMode = "ok";

console.log("11) token expiry: an expired token is purged, not sent");
const nChat = seen.chat.length;
await D.evaluate(() => sessionStorage.setItem("btw_hf_exp", String(Date.now() - 1000)));
s = await ui(D); must(!s.connected && s.tok === null, "expired token purged; shows Connect Hugging Face");
await send(D, "still there?"); must(seen.chat.length === nChat, "no router call with an expired token");
await D.close();

console.log("12) remember on this device: capped at the token lifetime, restored in a new tab, wiped by Disconnect");
await A.evaluate(() => localStorage.setItem("btw_remember", "1"));
s0 = await start(A); let R = await ret(`?code=${CODE}&state=${s0.pk.st}`); s = await ui(R);
const per = JSON.parse(s.persist || "null");
must(per && per.k === MOCK_TOKEN && per.exp <= Number(s.exp) + 5 && per.exp - Date.now() <= 7 * 864e5, "remembered copy expires at the token's expiry (<= 7 days)");
await R.close();
let R2 = await newTab(); s = await ui(R2);
must(s.connected && s.provider === "huggingface" && s.tok === MOCK_TOKEN, "a fresh tab restores the remembered HF token");
await R2.evaluate(() => sessionStorage.setItem("btw_or_key", "sk-or-v1-MOCKKEY-DO-NOT-PRINT-1234"));
await R2.evaluate(() => { window.__btwUI.open(); }); await R2.click(".btw-conn"); await sleep(200);
const wiped = await R2.evaluate(() => ["btw_hf_token", "btw_hf_exp", "btw_or_key"].every((k) => sessionStorage.getItem(k) === null) && ["btw_hf_token_persist", "btw_or_key_persist", "btw_remember", "btw_pkce"].every((k) => localStorage.getItem(k) === null));
must(wiped, "Disconnect wipes BOTH providers' credentials (session + remembered)");
await R2.close();

console.log("13) both connected: switching provider switches the endpoint");
s0 = await start(A); let S = await ret(`?code=${CODE}&state=${s0.pk.st}`);
await S.evaluate((k) => sessionStorage.setItem("btw_or_key", k), MOCK_OR_KEY);
await S.evaluate(() => window.__btwUI.switchProvider("openrouter")); const nOr = seen.or.length, nHf = seen.chat.length;
await send(S, "via openrouter"); s = await ui(S);
must(seen.or.length === nOr + 1 && seen.chat.length === nHf && s.pickerBtns.join() === "OpenRouter*,Hugging Face" && s.msgs.some((m) => /OpenRouter \(mocked\)/.test(m)), "OpenRouter selected -> chat goes to openrouter.ai only");
await S.evaluate(() => window.__btwUI.switchProvider("huggingface")); await send(S, "via hf");
must(seen.chat.length === nHf + 1 && seen.or.length === nOr + 1, "Hugging Face selected -> chat goes to router.huggingface.co only");
must((await ui(S)).csp.length === 0, "zero CSP violations with the tutor's updated widget CSP");
await S.close();

console.log("14) host CSP without the HF origins -> clear hint instead of a bare failure");
let C = await newTab("/widget/", { enable: true, stripCsp: true }); await C.evaluate(() => window.__btwUI.open());
s0 = await start(C); await C.close();
let C2 = await newTab(`/widget/?code=${CODE}&state=${s0.pk.st}`, { enable: true, stripCsp: true }); await C2.evaluate(() => window.__btwUI.exchangeDone()); await sleep(300); s = await ui(C2);
must(!s.connected && s.msgs.some((m) => /blocks https:\/\/huggingface\.co/.test(m) && /router\.huggingface\.co/.test(m)), "CSP hint names huggingface.co + router.huggingface.co for connect-src");
await C2.close();

must(seen.unexpected.length === 0, "no other huggingface.co request was attempted" + (seen.unexpected.length ? " " + JSON.stringify(seen.unexpected) : ""));
await b.close();
console.log(fail ? `\nWIDGET HF E2E FAILED (${fail})` : "\nWIDGET HF E2E PASSED");
process.exit(fail ? 1 : 0);
