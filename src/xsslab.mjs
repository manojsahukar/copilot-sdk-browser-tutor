// ============================================================================
// Contained XSS teaching lab — served on a DEDICATED origin (xss-lab.demo...).
// Deliberately vulnerable pages, isolated so curiosta.com never becomes a real
// XSS/phishing host:
//   - separate origin + its own response headers (NOT the main strict CSP);
//   - the main session cookie (bt_sess) is host-only, so it never reaches here;
//   - this origin only ever sets labelled, host-only DUMMY cookies/localStorage;
//   - the lab is only usable when framed by the main origin (frame-ancestors);
//   - NO payload is ever read from the URL (query/hash/path) — no shareable links;
//   - payloads arrive only via postMessage (origin-checked) from the main app, or
//     from an in-lab custom box gated behind a short-lived, login-signed token;
//   - "exfiltration" goes only to this lab's own echo endpoint (connect-src 'self');
//   - endpoints are rate-limited.
// The tutor only ever receives metadata (which payload, executed/blocked, defence).
// ============================================================================
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");
const MIME = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8" };

// This origin is identified the same way the sibling is: a CloudFront custom header
// that viewers cannot forge, with a local port/host fallback for dev.
export function isLab(req, cfg) {
  if (req.headers["x-bt-site"] === "xss-lab") return true;
  if (cfg.labPort && req.socket.localPort === cfg.labPort) return true;
  const host = String(req.headers.host || "").toLowerCase().split(":")[0];
  return !!cfg.labHost && host === cfg.labHost;
}

// --- short-lived token tying the custom box to a logged-in main-app session ---
export function signLabToken(key, login, ttlMs = 5 * 60e3) {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs, u: String(login || "").slice(0, 64) })).toString("base64url");
  const mac = crypto.createHmac("sha256", key).update("xss-lab:" + body).digest("base64url");
  return body + "." + mac;
}
export function verifyLabToken(key, tok) {
  try {
    const [body, mac] = String(tok || "").split(".");
    if (!body || !mac) return null;
    const exp = crypto.createHmac("sha256", key).update("xss-lab:" + body).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
    const o = JSON.parse(Buffer.from(body, "base64url").toString());
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
}

const labRate = new Map();
function rateOk(ip, max = 60) {
  const now = Date.now(); const arr = (labRate.get(ip) || []).filter((t) => now - t < 60e3);
  if (arr.length >= max) return false;
  arr.push(now); labRate.set(ip, arr); return true;
}

function headers(kind, mainOrigin, extra = {}) {
  const common = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
  if (kind === "vuln") {
    // Deliberately permissive so injected inline handlers FIRE — but connect-src is
    // locked to this origin (no exfiltration elsewhere) and only the main app may frame it.
    common["Content-Security-Policy"] =
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ` +
      `connect-src 'self'; frame-src 'self'; frame-ancestors ${mainOrigin}; base-uri 'none'; form-action 'self'; object-src 'none'`;
  } else if (kind === "strict") {
    // The "defended" page: strict CSP with NO inline script — injected payloads are blocked.
    common["Content-Security-Policy"] =
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ` +
      `connect-src 'self'; frame-ancestors 'self' ${mainOrigin}; base-uri 'none'; form-action 'self'; object-src 'none'`;
  } else {
    common["Content-Security-Policy"] = `default-src 'self'; frame-ancestors ${mainOrigin}; base-uri 'none'`;
  }
  return { ...common, ...extra };
}
function sendLab(res, code, body, type, hdrs) { res.writeHead(code, { "Content-Type": type, ...hdrs }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); }

function serveLabStatic(res, rel, mainOrigin) {
  const p = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return sendLab(res, 404, "not found", "text/plain", headers("other", mainOrigin));
  // Static assets load under script-src 'self'; serve them with the vuln frame-ancestors so they work in both pages.
  sendLab(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || "application/octet-stream", headers("other", mainOrigin));
}

export function handleLab(req, res, p, ctx) {
  const { mainOrigin, key } = ctx;
  const ip = (req.headers["cloudfront-viewer-address"] || req.socket.remoteAddress || "ip").toString().split(":")[0];

  if (p === "/healthz") return sendLab(res, 200, { ok: true, role: "xss-lab" }, "application/json", headers("other", mainOrigin));

  // Seed labelled, HOST-ONLY dummy cookies on the lab document: one JS-visible, one HttpOnly (to show HttpOnly protects it).
  if (p === "/lab" || p === "/lab/") {
    const jsCk = `lab_dummy_js=LAB-DUMMY-${crypto.randomBytes(3).toString("hex")}; Path=/; SameSite=Lax; Max-Age=3600${ctx.secure ? "; Secure" : ""}`;
    const hoCk = `lab_secret_httponly=LAB-SECRET-${crypto.randomBytes(3).toString("hex")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${ctx.secure ? "; Secure" : ""}`;
    return sendLab(res, 200, labHtml(mainOrigin), "text/html; charset=utf-8", headers("vuln", mainOrigin, { "Set-Cookie": [jsCk, hoCk] }));
  }
  if (p === "/lab/strict" || p === "/lab/strict/") return sendLab(res, 200, strictHtml(mainOrigin), "text/html; charset=utf-8", headers("strict", mainOrigin));
  if (p.startsWith("/lab/static/")) return serveLabStatic(res, p.slice("/lab/static/".length), mainOrigin);

  // Echo endpoint: the ONLY place a payload can "exfiltrate" to. It just reflects back what it captured.
  if (p === "/lab/echo" && req.method === "POST") {
    if (!rateOk(ip)) return sendLab(res, 429, { error: "slow down" }, "application/json", headers("other", mainOrigin));
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on("end", () => {
      let captured = null; try { captured = JSON.parse(raw || "{}").captured; } catch {}
      const s = typeof captured === "string" ? captured.slice(0, 500) : JSON.stringify(captured || null).slice(0, 500);
      sendLab(res, 200, { echoed: s, note: "This is the lab's own echo endpoint. A real attacker would send this to their server; the lab keeps it in-origin." }, "application/json", headers("other", mainOrigin));
    });
    return;
  }
  // Custom payload: gated behind a short-lived token minted only for a logged-in main-app session.
  if (p === "/lab/run-custom" && req.method === "POST") {
    if (!rateOk(ip, 20)) return sendLab(res, 429, { error: "slow down" }, "application/json", headers("other", mainOrigin));
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on("end", () => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch {}
      if (!verifyLabToken(key, b.token)) return sendLab(res, 403, { error: "This box is gated behind signing in on the main app." }, "application/json", headers("other", mainOrigin));
      const payload = String(b.payload || "").slice(0, 200); // length-capped
      sendLab(res, 200, { payload }, "application/json", headers("other", mainOrigin));
    });
    return;
  }
  return sendLab(res, 404, "not found", "text/plain", headers("other", mainOrigin));
}

function labHtml(mainOrigin) {
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<meta name=color-scheme content=dark>
<title>Script injection lab</title>
<link rel=stylesheet href="/lab/static/lab.css">
<script>window.BT_MAIN_ORIGIN=${JSON.stringify(mainOrigin)};</script>
</head><body>
<div id=gate class=gate hidden><p>🔒 This is a deliberately vulnerable <b>teaching lab</b>. It only runs when opened inside the Browser Tutor app, and it ignores anything in the URL. Open it from the <b>Live demos → Script injection lab</b> section.</p></div>
<main id=lab hidden>
  <p class=intro>A contained XSS playground on its own throwaway origin (<code id=labhost></code>). Nothing here is real: dummy cookies, dummy storage, and an echo endpoint that only talks to itself. Pick a payload; compare the <b>vulnerable</b> and <b>fixed</b> renders.</p>
  <section class=demo data-demo=reflected>
    <h2>1 · Reflected XSS <span class=sub>a "search" that echoes your input</span></h2>
    <div class=cols>
      <div class=card vuln><h3>Vulnerable <span class=tag>innerHTML</span></h3><div class=sink id=s-reflected-v></div><div class=note id=n-reflected-v></div></div>
      <div class=card fixed><h3>Fixed <span class=tag>textContent</span></h3><div class=sink id=s-reflected-f></div><div class=note id=n-reflected-f></div></div>
    </div>
    <div class=runs><button data-run=reflected data-variant=vuln>Run against vulnerable</button><button data-run=reflected data-variant=fixed class=secondary>Run against fixed</button></div>
  </section>
  <section class=demo data-demo=stored>
    <h2>2 · Stored XSS <span class=sub>a guestbook kept only in THIS browser's lab storage</span></h2>
    <div class=cols>
      <div class=card vuln><h3>Vulnerable <span class=tag>innerHTML</span></h3><div class=sink id=s-stored-v></div><div class=note id=n-stored-v></div></div>
      <div class=card fixed><h3>Fixed <span class=tag>textContent</span></h3><div class=sink id=s-stored-f></div><div class=note id=n-stored-f></div></div>
    </div>
    <div class=runs><button data-run=stored data-variant=vuln>Post malicious entry (vuln)</button><button data-run=stored data-variant=fixed class=secondary>Post same entry (fixed)</button><button data-run=stored-clear data-variant=x class=secondary>Clear guestbook</button></div>
    <p class=fineprint>Stored only in this browser's lab <code>localStorage</code> — never on a server, so it can never affect another visitor.</p>
  </section>
  <section class=demo data-demo=dom>
    <h2>3 · DOM-based XSS <span class=sub>an innerHTML sink + a javascript: link</span></h2>
    <div class=cols>
      <div class=card vuln><h3>Vulnerable</h3><div class=sink id=s-dom-v></div><div class=note id=n-dom-v></div></div>
      <div class=card fixed><h3>Fixed <span class=tag>escape + scheme check</span></h3><div class=sink id=s-dom-f></div><div class=note id=n-dom-f></div></div>
    </div>
    <div class=runs><button data-run=dom data-variant=vuln>Run against vulnerable</button><button data-run=dom data-variant=fixed class=secondary>Run against fixed</button></div>
    <p class=fineprint>The "location value" is a simulated in-page variable. The lab never reads the real URL.</p>
  </section>
  <section class=demo data-demo=capabilities>
    <h2>4 · What injected script can do <span class=sub>once it runs on the vulnerable origin</span></h2>
    <div class=card vuln>
      <div class=sink id=s-cap></div>
      <ul class=caplist id=caplist></ul>
      <div id=cap-login></div>
    </div>
    <div class=runs><button data-run=capabilities data-variant=vuln>Fire capability payload</button><button data-run=cap-reset data-variant=x class=secondary>Reset</button></div>
    <p class=fineprint>All harmless: it reads the dummy JS cookie (never the HttpOnly one), reads dummy localStorage, draws a fake login, logs keystrokes in the lab box, and "exfiltrates" to the lab echo endpoint.</p>
  </section>
  <section class=demo data-demo=defences>
    <h2>5 · Defences in action</h2>
    <div class=card>
      <h3>Strict CSP (no inline) blocks the payload</h3>
      <iframe id=strictframe src="/lab/strict" title="strict-CSP sub-page"></iframe>
      <div class=note id=n-csp></div>
    </div>
    <div class=cols>
      <div class=card><h3>HttpOnly cookie</h3><div class=note id=n-httponly></div></div>
      <div class=card><h3>DOMPurify sanitiser</h3><div class=sink id=s-purify></div><div class=note id=n-purify></div></div>
    </div>
    <div class=card><h3>Trusted Types</h3><div class=note id=n-tt></div></div>
    <div class=runs><button data-run=defences data-variant=x>Run the defences</button></div>
  </section>
  <section class=demo data-demo=prompt>
    <h2>6 · Prompt-injection → XSS <span class=sub>model output as an attack vector (ties to gotcha 1)</span></h2>
    <div class=cols>
      <div class=card vuln><h3>Naive innerHTML render</h3><div class=sink id=s-prompt-v></div><div class=note id=n-prompt-v></div></div>
      <div class=card fixed><h3>Real app pipeline <span class=tag>marked + DOMPurify</span></h3><div class=sink id=s-prompt-f></div><div class=note id=n-prompt-f></div></div>
    </div>
    <div class=runs><button data-run=prompt data-variant=vuln>Render hostile "model output" naively</button><button data-run=prompt data-variant=fixed class=secondary>Render via marked + DOMPurify</button></div>
  </section>
  <section class=demo data-demo=custom>
    <h2>Custom payload <span class=sub>length-capped; unlocked only when you're signed in on the main app</span></h2>
    <div class=card>
      <label>Your payload <input id=custom-input maxlength=200 disabled placeholder="sign in on the main app to unlock"></label>
      <div class=runs><button id=custom-run disabled>Render in the vulnerable sink</button></div>
      <div class=sink id=s-custom></div><div class=note id=n-custom></div>
    </div>
  </section>
</main>
<script src="/lab/static/vendor/purify.min.js"></script>
<script src="/lab/static/vendor/marked.min.js"></script>
<script src="/lab/static/lab.js"></script>
</body></html>`;
}

function strictHtml(mainOrigin) {
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content=dark>
<title>strict-CSP sub-page</title><link rel=stylesheet href="/lab/static/lab.css"></head>
<body class=strict>
<p class=mini>This page sets <code>script-src 'self'</code> (no inline). Injected handlers cannot run; each attempt raises a <code>securitypolicyviolation</code>.</p>
<div class=sink id=s-strict></div>
<div class=note id=n-strict></div>
<script src="/lab/static/lab-strict.js"></script>
</body></html>`;
}
