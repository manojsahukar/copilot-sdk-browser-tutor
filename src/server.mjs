// Browser Tutor PoC — GitHub sign-in + Copilot SDK agent that explains what your browser reveals.
// Plain Node (no framework). Stateless sessions (encrypted cookie) so it runs on Lambda or a VM.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgent, runTurn } from "./agent.mjs";
import { serverView } from "./serverview.mjs";
import { appSecrets, oauthConfigured, refreshGitHubToken } from "./appsecrets.mjs";
import { GOTCHAS } from "./gotchas.mjs";
import { DEMOS, DEMO_IDS } from "./demos.mjs";
import { OR_MODELS, OR_DEFAULT_MODEL, OR_REVOKE_URL, OR_KEY_RE, isAllowedModel, makeVerifier, challengeFor, authorizeUrl, exchangeCode, keySettingsUrl } from "./openrouter.mjs";
import { isLab, handleLab, signLabToken } from "./xsslab.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");
const prod = process.env.NODE_ENV === "production";

const cfg = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "127.0.0.1",
  baseUrl: (process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, ""),
  devBypass: process.env.DEV_AUTH_BYPASS === "1",
  maxTurnsPerHour: Number(process.env.MAX_TURNS_PER_HOUR || 30),
  allowedLogins: (process.env.ALLOWED_LOGINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  siblingHost: (process.env.SIBLING_HOST || "").toLowerCase(),
  siblingUrl: (process.env.SIBLING_URL || "").replace(/\/$/, ""),
  siblingPort: Number(process.env.SIBLING_PORT || 0),
  labHost: (process.env.LAB_HOST || "").toLowerCase(),
  labUrl: (process.env.LAB_URL || "").replace(/\/$/, ""),
  labPort: Number(process.env.LAB_PORT || 0),
  cookieDomain: process.env.COOKIE_DOMAIN || "",
  sessionCapDays: 7, // session lifetime cap; access tokens are refreshed underneath (refresh token lasts 6 months)
};
// Gotcha 4: the dev bypass must be impossible in production.
if (prod && (cfg.devBypass || process.env.DEV_AUTH_BYPASS || process.env.ALLOW_DEV_BYPASS)) {
  throw new Error("DEV_AUTH_BYPASS must never be set in production");
}
if (cfg.devBypass && !["127.0.0.1", "localhost", "::1"].includes(cfg.host)) {
  throw new Error("DEV_AUTH_BYPASS=1 is only allowed when HOST is localhost");
}
const secure = cfg.baseUrl.startsWith("https://");

// ---------- secrets (loaded once, lazily; nothing secret in env) ----------
let KEY = null, ORIGIN_VERIFY = "", secretsP = null;
async function ensureSecrets() {
  if (KEY) return;
  if (!secretsP) secretsP = (async () => {
    const s = await appSecrets();
    let ss = s.sessionSecret;
    if (!ss) {
      if (prod) throw new Error("session secret missing (set session_secret in the secret, or SESSION_SECRET locally)");
      ss = crypto.randomBytes(32).toString("hex");
      console.warn("[warn] no session secret; using an ephemeral one (sessions reset on restart)");
    }
    KEY = crypto.createHash("sha256").update("browser-tutor:" + ss).digest();
    ORIGIN_VERIFY = s.originVerify || "";
  })();
  await secretsP;
}

// ---------- encrypted cookie session ----------
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}
function unseal(s) {
  try {
    const b = Buffer.from(s, "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const o = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((p) => {
    const i = p.indexOf("="); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
  }));
}
function setCookie(res, name, val, maxAge) {
  const c = `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const prev = res.getHeader("Set-Cookie") || [];
  res.setHeader("Set-Cookie", [...[].concat(prev), c]);
}
const getSession = (req) => { const v = cookies(req).bt_sess; return v ? unseal(v) : null; };
const sessSeconds = (sess) => Math.max(1, Math.floor(((sess.exp || Date.now()) - Date.now()) / 1000));
const resealSession = (res, sess) => setCookie(res, "bt_sess", seal(sess), sessSeconds(sess));

// ---------- helpers ----------
function send(res, code, body, type = "application/json", extra = {}) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'" + (cfg.siblingUrl ? " " + cfg.siblingUrl : "") + "; frame-src 'self'" + (cfg.labUrl ? " " + cfg.labUrl : "") + "; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(self), browsing-topics=()",
    ...extra,
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const redirect = (res, to) => { res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); };
function readBody(req, limit = 96 * 1024) {
  return new Promise((ok, fail) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { fail(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { ok(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { fail(e); } });
    req.on("error", fail);
  });
}
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return false;
  try { return new URL(o).host === req.headers.host || o === new URL(cfg.baseUrl).origin; } catch { return false; }
}
const scrubTokens = (s) => String(s).replace(/gh[opsur]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-or-[A-Za-z0-9._-]+/g, "[redacted]");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
function serveStatic(res, file, extra = {}) {
  const p = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, { error: "not found" });
  send(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || "application/octet-stream", extra);
}
// The widget pilot is a STATIC site that talks straight to OpenRouter, so its documents need a
// different CSP than the app's strict "connect-src 'self'": connect to openrouter.ai is allowed.
// This mirrors the page's own <meta> CSP (on real GitHub Pages only the meta applies — a host that
// can't set headers; here we also send it as a header, with frame-ancestors, as defence in depth).
const WIDGET_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https://openrouter.ai; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const turnLog = new Map();
function rateOk(sid) {
  const now = Date.now(); const arr = (turnLog.get(sid) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= cfg.maxTurnsPerHour) return false;
  arr.push(now); turnLog.set(sid, arr); return true;
}

// ---------- SIBLING origin (a genuinely different site, for cross-site demos) ----------
function isSibling(req) {
  // In production both distributions share one Function URL origin and Host is not forwarded, so the sibling
  // CloudFront distribution tags its requests with an origin custom header (set by CloudFront, not forwardable
  // from a viewer, so it can't be forged). Locally we fall back to the port / hostname.
  if (req.headers["x-bt-site"] === "sibling") return true;
  if (cfg.siblingPort && req.socket.localPort === cfg.siblingPort) return true;
  const host = String(req.headers.host || "").toLowerCase().split(":")[0];
  return !!cfg.siblingHost && host === cfg.siblingHost;
}
const maskCookieVal = (v) => (v ? v.slice(0, 4) + "…" + v.slice(-2) : null);
function handleSibling(req, res, p) {
  const origin = req.headers.origin || "";
  const allowOrigin = cfg.siblingUrl ? (origin && origin !== cfg.siblingUrl ? origin : "null") : (origin || "*");
  const cors = { "Access-Control-Allow-Origin": allowOrigin, "Access-Control-Allow-Credentials": "true", "Vary": "Origin", "Cache-Control": "no-store" };
  const jar = cookies(req);
  const seen = {
    sibling: cfg.siblingHost || "localhost:" + (cfg.siblingPort || cfg.port),
    method: req.method, sawDemoCookie: !!jar.demo_tracker, demoCookieMasked: maskCookieVal(jar.demo_tracker),
    userAgent: req.headers["user-agent"], acceptLanguage: req.headers["accept-language"],
    referer: req.headers["referer"] || null, secChUa: req.headers["sec-ch-ua"] || null, origin: origin || null,
    note: "A third-party origin sees these on every cross-site request your browser makes to it, even for an unreadable (no-CORS) response.",
  };
  if (req.method === "OPTIONS") return res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "content-type" }).end();
  if (p === "/" || p === "/s" || p === "/s/") return send(res, 200, siblingIndexHtml(), "text/html; charset=utf-8", { "Permissions-Policy": "camera=(), microphone=(), geolocation=()" });
  if (p === "/s/seen") return send(res, 200, seen, "application/json", cors);
  if (p === "/s/cors") return send(res, 200, { readable: true, ...seen }, "application/json", cors);
  if (p === "/s/nocors") return send(res, 200, { readable: false, ...seen }, "application/json", { "Cache-Control": "no-store" }); // intentionally NO CORS headers
  if (p === "/s/set-cookie") {
    const id = jar.demo_tracker || crypto.randomBytes(8).toString("hex");
    const dom = cfg.cookieDomain ? `; Domain=${cfg.cookieDomain}` : "";
    const ss = cfg.cookieDomain ? "; SameSite=None; Secure" : "; SameSite=Lax";
    res.setHeader("Set-Cookie", `demo_tracker=${id}${dom}; Path=/; Max-Age=3600${ss}`);
    return send(res, 200, { set: true, scope: cfg.cookieDomain ? `Domain=${cfg.cookieDomain} (shared by both subdomains)` : "host-only (local dev)", idMasked: maskCookieVal(id) }, "application/json", cors);
  }
  if (p === "/s/clear-cookie") {
    const dom = cfg.cookieDomain ? `; Domain=${cfg.cookieDomain}` : "";
    res.setHeader("Set-Cookie", `demo_tracker=${dom}; Path=/; Max-Age=0${cfg.cookieDomain ? "; SameSite=None; Secure" : ""}`);
    return send(res, 200, { cleared: true }, "application/json", cors);
  }
  if (p === "/healthz") return send(res, 200, { ok: true, role: "sibling" });
  return send(res, 404, { error: "not found" }, "application/json", cors);
}
function siblingIndexHtml() {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>sibling.demo</title>` +
    `<body style="font:16px system-ui;background:#0d1117;color:#c9d1d9;max-width:640px;margin:0 auto;padding:24px">` +
    `<h1>👋 I am a different origin</h1><p>This host (<code>${cfg.siblingHost || "the sibling"}</code>) is separate from the main Browser Tutor site. ` +
    `It shows what a <em>third-party</em> domain learns when another site makes your browser talk to it. Endpoints: ` +
    `<code>/s/cors</code>, <code>/s/nocors</code>, <code>/s/set-cookie</code>, <code>/s/seen</code>. Open the Demos page on the main site to try them.</p>`;
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, cfg.baseUrl);
  const p = url.pathname;

  // Health check is hit by the Lambda Web Adapter from inside the sandbox (no CloudFront), so it must bypass the gate.
  if (p === "/healthz") return send(res, 200, { ok: true });

  // Gotcha 9: only CloudFront may reach the origin. CloudFront injects X-Origin-Verify as a custom origin header;
  // direct hits to the Function URL lack it. (Disabled locally when no secret is configured.)
  await ensureSecrets();
  // Staged rollout: when ORIGIN_VERIFY_ENFORCE=0 the header is checked but NOT enforced (lets CloudFront's custom
  // header propagate before the origin starts rejecting). Default (unset) = enforce.
  const enforceOrigin = ORIGIN_VERIFY && process.env.ORIGIN_VERIFY_ENFORCE !== "0";
  if (!enforceOrigin && ORIGIN_VERIFY && p === "/api/origin-check")
    return send(res, 200, { enforcing: false, originHeaderPresent: !!req.headers["x-origin-verify"], matches: req.headers["x-origin-verify"] === ORIGIN_VERIFY });
  if (enforceOrigin && req.headers["x-origin-verify"] !== ORIGIN_VERIFY) return send(res, 403, { error: "Direct origin access is blocked; use the site via CloudFront." });

  if (isSibling(req)) return handleSibling(req, res, p);
  if (isLab(req, cfg)) return handleLab(req, res, p, { mainOrigin: new URL(cfg.baseUrl).origin, key: KEY, secure });
  const sess = getSession(req);

  if (p === "/healthz/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    for (let i = 1; i <= 5; i++) { res.write(`data: {"chunk":${i},"t":${Date.now()}}\n\n`); await new Promise((r) => setTimeout(r, 1000)); }
    return res.end();
  }
  if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }

  if (p === "/") return serveStatic(res, sess ? "app.html" : "index.html");
  if (p === "/gotchas" || p === "/gotchas/") return serveStatic(res, "gotchas.html");
  if (p === "/demos" || p === "/demos/") return serveStatic(res, "demos.html");
  if (p === "/api/gotchas") return send(res, 200, GOTCHAS);
  if (p === "/api/demos") return send(res, 200, { demos: DEMO_IDS.map((id) => DEMOS[id]), sibling: cfg.siblingUrl || null, lab: cfg.labUrl || null });
  if (p.startsWith("/static/")) return serveStatic(res, p.slice(8));

  // Widget pilot: a STATIC site (article pages + the client-side OpenRouter chat widget).
  // Served as plain files; the widget makes ZERO calls back to this server (it talks straight to OpenRouter).
  if (p === "/widget") return redirect(res, "/widget/" + url.search); // keep ?code&state on the OAuth return
  if (p === "/widget/") return serveStatic(res, "widget/index.html", { "Content-Security-Policy": WIDGET_CSP });
  if (p.startsWith("/widget/")) return serveStatic(res, p.slice(1), p.endsWith(".html") ? { "Content-Security-Policy": WIDGET_CSP } : {});

  if (p === "/api/config") return send(res, 200, { devBypass: cfg.devBypass, oauthConfigured: oauthConfigured(), sibling: cfg.siblingUrl || null });

  // GitHub OAuth web flow
  if (p === "/auth/login") {
    const { clientId } = await appSecrets();
    if (!clientId) return send(res, 500, "GitHub OAuth not configured", "text/plain");
    const state = crypto.randomBytes(16).toString("hex");
    setCookie(res, "bt_state", state, 600);
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", cfg.baseUrl + "/auth/callback");
    u.searchParams.set("state", state);
    u.searchParams.set("scope", "read:user");
    u.searchParams.set("allow_signup", "false");
    return redirect(res, u.toString());
  }
  if (p === "/auth/callback") {
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    if (!code || !state || state !== cookies(req).bt_state) return send(res, 400, "Invalid OAuth state", "text/plain");
    const { clientId, clientSecret } = await appSecrets();
    const tr = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: cfg.baseUrl + "/auth/callback" }),
    }).then((r) => r.json());
    if (!tr.access_token) return send(res, 400, "OAuth exchange failed: " + scrubTokens(tr.error_description || tr.error || "unknown"), "text/plain");
    const u = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${tr.access_token}`, "User-Agent": "browser-tutor" } }).then((r) => r.json());
    if (!u.login) return send(res, 400, "Could not read GitHub user", "text/plain");
    if (cfg.allowedLogins.length && !cfg.allowedLogins.includes(u.login.toLowerCase())) return send(res, 403, "This PoC is limited to invited GitHub accounts.", "text/plain");
    const now = Date.now();
    const cap = now + cfg.sessionCapDays * 86400e3; // session cap (gotcha 5): 7 days; access token refreshed underneath
    const atExp = now + (tr.expires_in ? tr.expires_in * 1000 : 8 * 3600e3);
    setCookie(res, "bt_state", "", 0);
    setCookie(res, "bt_sess", seal({ sid: crypto.randomUUID(), login: u.login, name: u.name, avatar: u.avatar_url, token: tr.access_token, refresh: tr.refresh_token || null, atExp, exp: cap }), cfg.sessionCapDays * 86400);
    return redirect(res, "/");
  }
  if (p === "/auth/dev" && req.method === "POST") {
    if (!cfg.devBypass) return send(res, 404, { error: "not found" });
    if (!sameOrigin(req)) return send(res, 403, { error: "bad origin" });
    setCookie(res, "bt_sess", seal({ sid: crypto.randomUUID(), login: "dev-local", name: "Local dev (bypass)", avatar: null, token: null, dev: true, exp: Date.now() + 8 * 3600e3 }), 8 * 3600);
    return send(res, 200, { ok: true });
  }
  if (p === "/auth/logout" && req.method === "POST") {
    if (!sameOrigin(req)) return send(res, 403, { error: "bad origin" });
    setCookie(res, "bt_sess", "", 0);
    return send(res, 200, { ok: true });
  }

  // ---- OpenRouter OAuth PKCE (model engine = "user's own OpenRouter credits"). GitHub sign-in stays the gate. ----
  if (p === "/auth/openrouter/login") {
    if (!sess) return redirect(res, "/");
    const verifier = makeVerifier();
    const state = crypto.randomBytes(16).toString("hex");
    // Short-lived, encrypted, HttpOnly: the verifier never reaches client JS (PKCE done server-side).
    setCookie(res, "bt_or", seal({ v: verifier, st: state, exp: Date.now() + 600e3 }), 600);
    return redirect(res, authorizeUrl({
      callbackUrl: cfg.baseUrl + "/auth/openrouter/callback",
      challenge: challengeFor(verifier), state,
      label: `Browser Tutor (${sess.login})`,
    }));
  }
  if (p === "/auth/openrouter/callback") {
    if (!sess) return redirect(res, "/");
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    const pkRaw = cookies(req).bt_or; const pk = pkRaw ? unseal(pkRaw) : null;
    setCookie(res, "bt_or", "", 0);
    if (!code || !state || !pk || state !== pk.st) return redirect(res, "/?or=state_error");
    try {
      const { key, userId } = await exchangeCode({ code, verifier: pk.v });
      sess.or = { key, uid: userId, model: OR_DEFAULT_MODEL, at: Date.now() };
      sess.provider = "openrouter";
      resealSession(res, sess);
      return redirect(res, "/?or=connected");
    } catch (e) {
      console.error("[openrouter]", scrubTokens(e?.message || e));
      return redirect(res, "/?or=exchange_error");
    }
  }

  if (p === "/api/server-view") return send(res, 200, serverView(req));

  if (!sess) return send(res, 401, { error: "sign in first" });
  if (p === "/api/me") return send(res, 200, {
    login: sess.login, name: sess.name, avatar: sess.avatar, dev: !!sess.dev,
    provider: sess.provider === "openrouter" && sess.or ? "openrouter" : "copilot",
    or: sess.or
      ? { connected: true, model: sess.or.model, models: OR_MODELS, default: OR_DEFAULT_MODEL, settingsUrl: keySettingsUrl(sess.or.key), revokeUrl: OR_REVOKE_URL }
      : { connected: false, models: OR_MODELS, default: OR_DEFAULT_MODEL },
  });

  // Short-lived token that unlocks the lab's custom-payload box (only for a signed-in session).
  if (p === "/api/lab") return send(res, 200, { labUrl: cfg.labUrl || null, token: cfg.labUrl ? signLabToken(KEY, sess.login) : null });

  // Choose the model engine (and, for OpenRouter, the model). GitHub identity is unchanged.
  if (p === "/api/provider" && req.method === "POST") {
    if (!sameOrigin(req)) return send(res, 403, { error: "bad origin" });
    let b; try { b = await readBody(req); } catch { return send(res, 400, { error: "bad body" }); }
    if (b.provider === "openrouter") {
      if (!sess.or) return send(res, 400, { error: "Connect OpenRouter first", connect: "/auth/openrouter/login" });
      sess.provider = "openrouter";
      if (b.model && isAllowedModel(b.model)) sess.or.model = b.model;
      else if (b.model) return send(res, 400, { error: "model not in the curated list" });
    } else {
      sess.provider = "copilot";
    }
    resealSession(res, sess);
    return send(res, 200, { ok: true, provider: sess.provider, model: sess.or ? sess.or.model : null });
  }
  // Disconnect OpenRouter: drop the key from the session and tell the user how to revoke it.
  if (p === "/api/openrouter/disconnect" && req.method === "POST") {
    if (!sameOrigin(req)) return send(res, 403, { error: "bad origin" });
    const settingsUrl = sess.or ? keySettingsUrl(sess.or.key) : null;
    delete sess.or; sess.provider = "copilot";
    resealSession(res, sess);
    return send(res, 200, { ok: true, revokeUrl: OR_REVOKE_URL, settingsUrl, note: "Key dropped from this session. Revoke it in your OpenRouter key settings to be sure." });
  }

  if (p === "/api/chat" && req.method === "POST") {
    if (!sameOrigin(req)) return send(res, 403, { error: "bad origin" });
    if (!rateOk(sess.sid)) return send(res, 429, { error: `Limit of ${cfg.maxTurnsPerHour} messages/hour reached` });
    let body; try { body = await readBody(req); } catch { return send(res, 400, { error: "bad body" }); }
    const message = String(body.message || "").slice(0, 4000).trim();
    if (!message) return send(res, 400, { error: "empty message" });

    // Gotcha 5: refresh the access token before it expires, and persist the rotated refresh token in the cookie.
    // Only needed for the Copilot engine; the OpenRouter engine authenticates to the model with the sk-or- key.
    if (sess.provider !== "openrouter" && sess.token && sess.refresh && sess.atExp - Date.now() < 15 * 60e3) {
      try {
        const r = await refreshGitHubToken(sess.refresh);
        sess.token = r.token; sess.refresh = r.refresh; sess.atExp = Date.now() + r.expiresIn * 1000;
        setCookie(res, "bt_sess", seal(sess), Math.max(1, Math.floor((sess.exp - Date.now()) / 1000)));
      } catch (e) {
        console.error("[refresh]", scrubTokens(e?.message || e));
        setCookie(res, "bt_sess", "", 0);
        return send(res, 401, { error: "Your GitHub session expired. Please sign in again.", reauth: true });
      }
    }

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    let produced = false;
    const emit = (o) => { if (o && (o.type === "delta" || o.type === "final")) produced = true; res.write(`data: ${JSON.stringify(o)}\n\n`); };
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    const isRateLimited = (m) => /\b429\b|rate.?limit|too many requests/i.test(m);
    try {
      const agent = await getAgent(sess, cfg.devBypass);
      const turn = () => runTurn(agent, {
        message,
        fingerprint: body.fingerprint && typeof body.fingerprint === "object" ? body.fingerprint : null,
        demoResults: body.demoResults && typeof body.demoResults === "object" ? body.demoResults : null,
        history: Array.isArray(body.history) ? body.history.slice(-12) : [],
        serverView: serverView(req),
        emit,
      });
      try {
        await turn();
      } catch (e) {
        const raw = scrubTokens(e?.message || e);
        // One automatic retry with backoff for an OpenRouter 429 (free pool is noisy), but only if we have not
        // streamed any answer yet, so the user never sees a duplicated reply.
        if (sess.provider === "openrouter" && isRateLimited(raw) && !produced) {
          emit({ type: "notice", text: "OpenRouter rate-limited that request. Retrying once…" });
          await new Promise((r) => setTimeout(r, 1500));
          await turn();
        } else { throw e; }
      }
      emit({ type: "done" });
    } catch (e) {
      const msg = scrubTokens(e?.message || e);
      console.error("[chat]", msg);
      emit({ type: "error", message: friendlyError(msg, sess.provider), canSwitch: isRateLimited(msg) || /deadline|tool call/i.test(msg) }); // gotcha 10
    } finally { clearInterval(ping); }
    return res.end();
  }
  send(res, 404, { error: "not found" });
}

// Gotcha 10: turn raw Copilot / OpenRouter / auth failures into specific, friendly guidance.
function friendlyError(msg, provider) {
  const m = msg.toLowerCase();
  if (m.includes("deadline")) return provider === "openrouter"
    ? "That model took too long (often a rate-limited free model). Tap the engine chip and switch to Auto or another model, then try again."
    : "GitHub Copilot took too long to respond (it may be overloaded or rate-limited). Try again in a moment.";
  if (provider === "openrouter") {
    if (m.includes("402") || m.includes("insufficient") || m.includes("credit") || m.includes("negative")) return "Your OpenRouter account is out of credits for this model. Add credits at openrouter.ai, or switch to a free model from the engine picker.";
    if (m.includes("429") || m.includes("rate limit") || m.includes("rate-limit")) return "OpenRouter rate-limited this request (free models share a limited pool). Wait a moment and try again, or pick a different model.";
    if (m.includes("no endpoints") || m.includes("does not support") || m.includes("tool use") || m.includes("tool call") || m.includes("function call") || m.includes("tools")) return "The selected OpenRouter model can't do tool calling, which the tutor needs. Pick another model from the engine picker.";
    if (m.includes("401") || m.includes("invalid api key") || m.includes("no auth")) return "OpenRouter didn't accept the connected key. Disconnect and reconnect OpenRouter.";
    if (m.includes("404") || m.includes("not a valid model") || m.includes("unknown model")) return "That OpenRouter model is no longer available. Pick another from the engine picker.";
    return "Something went wrong talking to OpenRouter: " + msg;
  }
  if (m.includes("quota") || m.includes("rate limit") || m.includes("429")) return "You've hit a GitHub Copilot usage/rate limit for your account. Copilot Free has a monthly cap; wait or check your Copilot plan, then try again.";
  if (m.includes("not authenticated") || m.includes("401") || m.includes("token")) return "GitHub Copilot didn't accept your account. Make sure Copilot is enabled for your GitHub account, then sign out and back in.";
  if (m.includes("403") || m.includes("forbidden") || m.includes("sso") || m.includes("org")) return "Access was blocked. If your Copilot seat is managed by an organization, it may restrict third-party OAuth apps, or require SSO authorization. Ask an org admin to allow this app, or use a personal Copilot account.";
  if (m.includes("no github token")) return "No Copilot credential for this session. Please sign in with GitHub again.";
  return "Something went wrong talking to GitHub Copilot: " + msg;
}

// ---------- listen ----------
const server = (req, res) => handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: "server error" }); else res.end(); });
http.createServer(server).listen(cfg.port, cfg.host, () => console.log(`browser-tutor listening on http://${cfg.host}:${cfg.port} (devBypass=${cfg.devBypass}, sibling=${cfg.siblingUrl || "none"})`));
if (cfg.siblingPort) http.createServer(server).listen(cfg.siblingPort, cfg.host, () => console.log(`sibling listening on http://${cfg.host}:${cfg.siblingPort}`));
if (cfg.labPort) http.createServer(server).listen(cfg.labPort, cfg.host, () => console.log(`xss-lab listening on http://${cfg.host}:${cfg.labPort}`));
