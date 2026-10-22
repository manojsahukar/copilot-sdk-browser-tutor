// Security + host-integration E2E for the client-side widget (no app server needed: it serves public/ itself).
//  1) Link filter in the REAL renderer: //host, /\host, javascript:, data:, relative -> no href; http(s) + /root kept.
//  2) DOMPurify hook scoping: the widget's link hook never leaks into the page's global DOMPurify, a host page's
//     own (old) DOMPurify / marked globals are left untouched, and a host DOMPurify < 3.2.4 is never used.
//  3) Recommended host CSP WITH Giscus (real https://giscus.app client): zero CSP violations, giscus iframe +
//     stylesheet load, widget works (custom label, chips), connect to openrouter.ai allowed.
//  4) A host CSP that forgets openrouter.ai: the visitor gets a clear CSP message, not a bare "Failed to fetch".
//  5) Site options: data-exclude removes nodes from the page context, data-persona reaches the system prompt,
//     data-page-cap caps page text, data-greeting shown, chips hide after the first question.
//  6) An unsent question survives the OAuth round trip (returned in a NEW tab) and is put back in the box.
// Run: node scripts/widget-security-e2e.mjs
import puppeteer from "puppeteer-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../public", import.meta.url).pathname);
const PORT = 8091, BASE = `http://127.0.0.1:${PORT}`;
const MOCK_KEY = "mock-key-not-real-0000";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, http-referer, x-title", "Access-Control-Allow-Methods": "POST, OPTIONS" };

export const RECOMMENDED_CSP = "default-src 'self'; script-src 'self' https://giscus.app; style-src 'self' https://giscus.app; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self' https://openrouter.ai; frame-src https://giscus.app; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'";
const NO_OR_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'";

const TAG = (extra = "") => `<script src="/static/widget.js" data-site-name="Fixture Site" data-context-selector="article" data-index="/widget/site-index.json" ${extra}></script>`;
const doc = (csp, body, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">${head}<title>Fixture</title></head><body>${body}</body></html>`;
const ARTICLE = `<article><h1>Fixture page</h1><p>VISIBLE-FACT the sky is blue.</p><div id="comments">EXCLUDED-COMMENT-TEXT</div><p class="quiz">EXCLUDED-QUIZ-TEXT</p><p>${"filler ".repeat(1500)}TAIL-BEYOND-CAP</p></article>`;
const OPTS = `data-exclude="#comments, .quiz" data-page-cap="1000" data-persona="PERSONA-MARKER be a physics tutor" data-fab-label="💬 Ask Fixture" data-greeting="GREETING-MARKER hello" data-suggestions='["Chip one?","Chip two?"]'`;
const FIX = {
  "/fx/plain.html": doc("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://openrouter.ai", ARTICLE + TAG(OPTS)),
  // Host already uses its own OLD DOMPurify + marked (as globals) and its own hook on them.
  "/fx/host-old-libs.html": doc("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://openrouter.ai", ARTICLE + `<script src="/fx/host-libs.js"></script>` + TAG(OPTS)),
  "/fx/host-libs.js": `window.DOMPurify = { version: "2.0.0", sanitize: function (s) { return "HOST-OLD-PURIFY:" + s; }, addHook: function () {}, removeHook: function () {} };
window.marked = { parse: function (s) { return "HOST-MARKED:" + s; } };`,
  "/fx/giscus.html": doc(RECOMMENDED_CSP, ARTICLE + `<section id="giscus-host"><script src="https://giscus.app/client.js" data-repo="curiosta/kinetic" data-repo-id="R_kgDOU5lPeg" data-category="Comments" data-category-id="DIC_kwDOU5lPes4DG967" data-mapping="pathname" data-strict="1" data-reactions-enabled="1" data-emit-metadata="0" data-input-position="top" data-theme="light" data-lang="en" crossorigin="anonymous" async></script></section>` + TAG(OPTS)),
  "/fx/no-openrouter-csp.html": doc(NO_OR_CSP, ARTICLE + TAG(OPTS)),
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  if (FIX[u.pathname]) { res.writeHead(200, { "Content-Type": u.pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" }); return res.end(FIX[u.pathname]); }
  let p = null;
  if (u.pathname.startsWith("/static/")) p = path.join(ROOT, u.pathname.slice(8));
  else if (u.pathname.startsWith("/widget/")) p = path.join(ROOT, u.pathname.slice(1));
  if (!p || !p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end("nf"); }
  const ct = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct }); fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let fail = 0, pass = 0;
const must = (c, m) => { if (!c) { fail++; console.log("  FAIL -", m); } else { pass++; console.log("  ok -", m); } };

async function open(pathname, { mockChat = null, ctx = null } = {}) {
  const c = ctx || await b.createBrowserContext(); const p = await c.newPage();
  await p.evaluateOnNewDocument(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.effectiveDirective + " " + (e.blockedURI || e.sample || ""))); });
  const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  if (mockChat) {
    await p.setRequestInterception(true);
    p.on("request", (r) => {
      if (r.url() === "https://openrouter.ai/api/v1/chat/completions") {
        if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });
        mockChat.bodies.push(JSON.parse(r.postData() || "{}"));
        const sse = 'data: {"choices":[{"delta":{"content":"' + mockChat.reply.replace(/"/g, '\\"') + '"}}]}\n\ndata: [DONE]\n\n';
        return r.respond({ status: 200, contentType: "text/event-stream", headers: CORS, body: sse });
      }
      if (r.url() === "https://openrouter.ai/api/v1/auth/keys") {
        if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" });
        return r.respond({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ key: MOCK_KEY, user_id: "u1" }) });
      }
            r.continue();
    });
  }
  await p.goto(BASE + pathname, { waitUntil: "networkidle0" });
  await p.waitForFunction(() => !!window.__btwUI, { timeout: 15000 });
  return { p, ctx: c, errors };
}

console.log("1) link filter in the real renderer (marked -> private DOMPurify -> link hook)");
{
  const { p, ctx } = await open("/fx/plain.html");
  const r = await p.evaluate(() => {
    const md = "[a](//evil.example/x) [b](/\\evil.example) [c](javascript:alert(1)) [d](data:text/html,x) [e](relative/p.html) [f](https://ok.example/p) [g](/widget/storage.html) [h](HTTP://ok2.example/) <a href=\"//evil2.example\">raw</a> <a href=\"/\\evil4.example\">rawbs</a> [i](  //evil3.example)";
    const div = document.createElement("div"); div.innerHTML = window.__btwUI.render(md);
    return [...div.querySelectorAll("a")].map((a) => ({ t: a.textContent, href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") }));
  });
  const by = Object.fromEntries(r.map((x) => [x.t, x]));
  // "/\\host" in Markdown: marked percent-encodes the backslash ("/%5Cevil.example"), which is a harmless same-site
  // path. Either no href or a path that resolves to THIS origin is acceptable; raw-HTML "/\\host" must lose its href.
  must(by.b && (by.b.href === null || (by.b.href.startsWith("/") && !by.b.href.startsWith("//") && !by.b.href.includes("\\"))), `markdown "/\\host" link has no href or a same-site path (${by.b && by.b.href})`);
  must(by.rawbs && by.rawbs.href === null, `raw-HTML "/\\host" link lost its href (${by.rawbs && by.rawbs.href})`);
  for (const k of ["a", "c", "d", "e", "raw", "i"]) must(by[k] && by[k].href === null, `link "${k}" lost its href (${by[k] && by[k].href})`);
  must(by.f && by.f.href === "https://ok.example/p", "absolute https link kept");
  must(by.g && by.g.href === "/widget/storage.html", "same-site root link kept");
  must(by.h && /^http:\/\/ok2\.example\/$/i.test(by.h.href), "absolute http link kept (normalised)");
  must(r.every((x) => x.target === "_blank" && x.rel === "noopener noreferrer nofollow"), "every link gets target=_blank rel=noopener noreferrer nofollow");

  console.log("2) DOMPurify hook scoping (widget-loaded vendored copy left as the page global)");
  const g = await p.evaluate(() => {
    const D = window.DOMPurify; const out = D.sanitize('<a href="//evil.example/x">x</a>');
    const div = document.createElement("div"); div.innerHTML = out; const a = div.querySelector("a");
    return { version: D.version, href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") };
  });
  must(/^3\.(\d+)\./.test(g.version) && (Number(g.version.split(".")[1]) > 2 || (Number(g.version.split(".")[1]) === 2 && Number(g.version.split(".")[2]) >= 4)), `vendored DOMPurify is >= 3.2.4 (${g.version})`);
  must(g.href === "//evil.example/x" && g.target === null && g.rel === null, "global DOMPurify.sanitize is NOT affected by the widget's link hook (no href rewrite, no target/rel added)");
  // Render again then check the global one more time (hook must be removed after every call).
  await p.evaluate(() => window.__btwUI.render("[x](https://a.example)"));
  const g2 = await p.evaluate(() => { const d = document.createElement("div"); d.innerHTML = window.DOMPurify.sanitize('<a href="https://a.example">x</a>'); return d.querySelector("a").getAttribute("target"); });
  must(g2 === null, "after more widget renders the global instance still has no widget hook");
  await ctx.close();
}
{
  const { p, ctx } = await open("/fx/host-old-libs.html");
  const s = await p.evaluate(() => ({ dp: window.DOMPurify.version, dpOut: window.DOMPurify.sanitize("x"), mk: window.marked.parse("y"),
    render: (() => { const d = document.createElement("div"); d.innerHTML = window.__btwUI.render("**bold** [z](//evil.example)"); return { strong: !!d.querySelector("strong"), href: d.querySelector("a") && d.querySelector("a").getAttribute("href"), raw: d.innerHTML }; })() }));
  must(s.dp === "2.0.0" && s.dpOut === "HOST-OLD-PURIFY:x", "host's own (old) DOMPurify global is restored and untouched");
  must(s.mk === "HOST-MARKED:y", "host's own marked global is restored and untouched");
  must(s.render.strong && s.render.href === null && !/HOST-/.test(s.render.raw), "widget ignored the host's DOMPurify < 3.2.4 and rendered with its own vendored copy");
  await ctx.close();
}

console.log("3) recommended host CSP with Giscus (real giscus.app client)");
{
  const { p, ctx, errors } = await open("/fx/giscus.html");
  await p.waitForSelector("iframe.giscus-frame", { timeout: 20000 }).catch(() => null);
  await new Promise((r) => setTimeout(r, 2500));
  const s = await p.evaluate(async () => {
    let orOk = false; try { await fetch("https://openrouter.ai/api/v1/models", { method: "GET" }); orOk = true; } catch (e) { orOk = String(e); }
    const css = [...document.styleSheets].some((ss) => (ss.href || "").startsWith("https://giscus.app/"));
    return { csp: window.__csp.slice(), iframe: (document.querySelector("iframe.giscus-frame") || {}).src || "", css, orOk,
      fab: document.querySelector(".btw-fab").textContent, fabAria: document.querySelector(".btw-fab").getAttribute("aria-label"),
      fabHidden: [...document.querySelectorAll(".btw-fab [aria-hidden=true]")].map((e) => e.textContent).join(""), chips: [...document.querySelectorAll(".btw-chip")].map((c) => c.textContent) };
  });
  must(/^https:\/\/giscus\.app\//.test(s.iframe), "giscus iframe created from https://giscus.app");
  must(s.css, "giscus stylesheet (https://giscus.app/default.css) applied");
  must(s.orOk === true, "connect to https://openrouter.ai allowed by the CSP (" + s.orOk + ")");
  must(s.csp.length === 0, "zero CSP violations on the host page (" + JSON.stringify(s.csp) + ")");
  must(s.fab === "💬 Ask Fixture", "data-fab-label applied");
  must(s.fabAria === null && s.fabHidden === "💬", "FAB name = its visible text (WCAG 2.5.3 label in name): no generic aria-label, leading emoji aria-hidden");
  must(s.chips.join("|") === "Chip one?|Chip two?", "data-suggestions chips rendered");
  must(errors.length === 0, "no page errors (" + errors.join("; ") + ")");
  await ctx.close();
}

console.log("4) host CSP that forgets openrouter.ai -> clear message");
{
  const { p, ctx } = await open("/fx/no-openrouter-csp.html");
  await p.evaluate(() => { sessionStorage.setItem("btw_or_key", "mock-key-not-real-0000"); window.__btwUI.refresh(); window.__btwUI.open(); window.__btwUI.setInput("hello?"); return window.__btwUI.submit(); });
  await p.waitForFunction(() => { const m = [...document.querySelectorAll(".btw-assistant")].pop(); return m && m.textContent !== "…"; }, { timeout: 10000 });
  const last = await p.evaluate(() => ({ msg: [...document.querySelectorAll(".btw-assistant")].pop().textContent, blocked: window.__btwUI.cspBlocked() }));
  must(last.blocked === "connect-src", "widget saw the connect-src violation for openrouter.ai");
  must(/Content-Security-Policy blocks https:\/\/openrouter\.ai/.test(last.msg), "visitor is told the site's CSP blocks openrouter.ai (" + last.msg.slice(0, 90) + ")");
  await ctx.close();
}

console.log("5) site options reach the model correctly");
{
  const mock = { bodies: [], reply: "See [Storage](/widget/storage.html) and [bad](//evil.example)." };
  const { p, ctx } = await open("/fx/plain.html", { mockChat: mock });
  await p.evaluate(() => { sessionStorage.setItem("btw_or_key", "mock-key-not-real-0000"); window.__btwUI.open(); window.__btwUI.refresh(); });
  const g = await p.evaluate(() => ({ greet: [...document.querySelectorAll(".btw-assistant")].map((m) => m.textContent).join("|"), chipsHidden: document.querySelector(".btw-chips").hidden, chipsDisplay: getComputedStyle(document.querySelector(".btw-chips")).display }));
  must(/GREETING-MARKER hello/.test(g.greet), "data-greeting shown after connect");
  must(!g.chipsHidden && g.chipsDisplay !== "none", "chips visible before the first question");
  await p.click(".btw-chip");
  await p.waitForFunction(() => /Storage/.test(([...document.querySelectorAll(".btw-assistant")].pop() || {}).textContent || ""), { timeout: 10000 });
  const body = mock.bodies[0] || { messages: [] }; const sys = (body.messages[0] || {}).content || "";
  must(body.model === "openrouter/free", "default model is openrouter/free");
  must(body.messages.at(-1).content === "Chip one?", "tapped chip sent exactly its text");
  must(sys.includes("Site guidance from the site owner:\nPERSONA-MARKER be a physics tutor"), "data-persona appended to the system prompt");
  must(sys.includes("VISIBLE-FACT") && !sys.includes("EXCLUDED-COMMENT-TEXT") && !sys.includes("EXCLUDED-QUIZ-TEXT"), "data-exclude removed #comments and .quiz from the page context");
  must(!sys.includes("TAIL-BEYOND-CAP"), "data-page-cap=1000 caps the page text");
  const after = await p.evaluate(() => { const last = [...document.querySelectorAll(".btw-assistant")].pop(); return { hrefs: [...last.querySelectorAll("a")].map((a) => a.getAttribute("href")), chips: getComputedStyle(document.querySelector(".btw-chips")).display }; });
  must(after.hrefs[0] === "/widget/storage.html" && after.hrefs[1] === null, "streamed reply: same-site citation kept, // link stripped");
  must(after.chips === "none", "chips hidden after the first question");
  await ctx.close();
}

console.log("6) unsent question survives the OAuth round trip (return in a NEW tab)");
{
  const mock = { bodies: [], reply: "ok" };
  const { p, ctx } = await open("/fx/plain.html", { mockChat: mock });
  await p.evaluate(() => { window.__btwUI.open(); window.__btwUI.setInput("What is VISIBLE-FACT about?"); return window.__btwUI.submit(); });
  const pend = await p.evaluate(() => sessionStorage.getItem("btw_pending_q"));
  must(pend === "What is VISIBLE-FACT about?", "pre-connect Send keeps the question (sessionStorage, this tab)");
  // What the Connect button does, minus the redirect itself.
  const authUrl = await p.evaluate(() => window.__btwUI.prepareAuth());
  const pk = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem("btw_pkce") || "null"); } catch (e) { return null; } });
  must(pk && pk.q === "What is VISIBLE-FACT about?" && pk.exp > Date.now() && pk.exp - Date.now() <= 10 * 60 * 1000, "question rides with the one-time PKCE record (10-min TTL)");
  const st = new URL(authUrl).searchParams.get("state");
  // Return in a NEW tab (empty sessionStorage, same localStorage).
  const mock2 = { bodies: [], reply: "ok" };
  const B = await ctx.newPage();
  await B.setRequestInterception(true);
  B.on("request", (r) => {
    if (r.url() === "https://openrouter.ai/api/v1/auth/keys") { if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS, body: "" }); return r.respond({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ key: MOCK_KEY, user_id: "u1" }) }); }
    r.continue();
  });
  await B.goto(BASE + "/fx/plain.html?code=mock-code&state=" + encodeURIComponent(st), { waitUntil: "networkidle0" });
  await B.waitForFunction(() => !!window.__btwUI); await B.evaluate(() => window.__btwUI.exchangeDone()); await new Promise((r) => setTimeout(r, 300));
  const s = await B.evaluate(() => ({ ta: document.querySelector(".btw-input").value, connected: window.__btwUI.connected(), pkce: localStorage.getItem("btw_pkce"), url: location.href }));
  must(s.connected && s.ta === "What is VISIBLE-FACT about?", "after the return the question is back in the box (" + JSON.stringify(s.ta) + ")");
  must(s.pkce === null && !/code=|state=/.test(s.url), "PKCE record consumed and code scrubbed from the URL");
  await B.evaluate(() => window.__btwUI.disconnect());
  must(await B.evaluate(() => sessionStorage.getItem("btw_pending_q") === null && localStorage.getItem("btw_or_key_persist") === null), "Disconnect wipes the pending question too");
  await ctx.close();
}

await b.close(); server.close();
console.log(fail ? `\nWIDGET SECURITY E2E: ${fail} FAILED, ${pass} passed` : `\nWIDGET SECURITY E2E PASSED (${pass})`);
process.exit(fail ? 1 : 0);
