// Mocked end-to-end test of the OpenRouter OAuth PKCE wiring, with NO real OpenRouter account.
// Starts a mock OpenRouter (auth + exchange) and the real app server, then drives:
//   login redirect params -> state rejection -> successful exchange -> key never exposed -> disconnect.
// Run: node scripts/openrouter-e2e.mjs
import http from "node:http";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const MOCK_PORT = 8097, APP_PORT = 8098;
const APP = `http://127.0.0.1:${APP_PORT}`;

// --- mock OpenRouter exchange endpoint ---
const mock = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/v1/auth/keys") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const j = JSON.parse(b || "{}");
      if (j.code === "goodcode" && j.code_verifier && j.code_challenge_method === "S256")
        return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ key: "sk-or-v1-MOCKKEY1234567890", user_id: "mock-user" }));
      return res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid code or code_verifier" } }));
    });
  } else res.writeHead(404).end("{}");
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

// --- boot the real app with test env ---
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.HOST = "127.0.0.1";
process.env.PORT = String(APP_PORT);
process.env.BASE_URL = APP;
process.env.DEV_AUTH_BYPASS = "1";
process.env.ALLOWED_LOGINS = "";
process.env.OPENROUTER_AUTH_URL = `http://127.0.0.1:${MOCK_PORT}/auth`;
process.env.OPENROUTER_EXCHANGE_URL = `http://127.0.0.1:${MOCK_PORT}/api/v1/auth/keys`;
await import("../src/server.mjs");
await new Promise((r) => setTimeout(r, 400));

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; console.log("  ok -", n); };
const jar = {};
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
function stash(res) { for (const sc of res.headers.getSetCookie?.() || []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v === "") delete jar[k]; else jar[k] = v; } }
const f = (path, opts = {}) => fetch(APP + path, { redirect: "manual", ...opts, headers: { Origin: APP, cookie: cookieHeader(), ...(opts.headers || {}) } });

// 1) dev-bypass session (stands in for a GitHub-gated identity)
let r = await f("/auth/dev", { method: "POST" }); stash(r);
ok("dev session established", r.status === 200 && jar.bt_sess);

// 2) login redirect carries correct PKCE params
r = await f("/auth/openrouter/login"); stash(r);
const loc = new URL(r.headers.get("location"));
ok("login 302s to the (mock) OpenRouter /auth", r.status === 302 && loc.pathname === "/auth");
ok("code_challenge_method is S256", loc.searchParams.get("code_challenge_method") === "S256");
ok("code_challenge present (43+ base64url)", /^[A-Za-z0-9_-]{43,}$/.test(loc.searchParams.get("code_challenge") || ""));
ok("state present", !!loc.searchParams.get("state"));
ok("callback_url points back to the app", loc.searchParams.get("callback_url") === APP + "/auth/openrouter/callback");
ok("key_label set to Browser Tutor (login)", /^Browser Tutor \(/.test(loc.searchParams.get("key_label") || ""));
ok("pkce verifier cookie set (HttpOnly, not readable by JS)", !!jar.bt_or);
const goodState = loc.searchParams.get("state");

// 3) callback with WRONG state is rejected
r = await f(`/auth/openrouter/callback?code=goodcode&state=WRONGSTATE`);
ok("wrong state -> /?or=state_error", r.status === 302 && r.headers.get("location") === "/?or=state_error");

// re-run login to get a fresh verifier cookie + state (previous callback cleared bt_or)
r = await f("/auth/openrouter/login"); stash(r);
const st2 = new URL(r.headers.get("location")).searchParams.get("state");

// 4) callback with correct state + good code -> exchange succeeds
r = await f(`/auth/openrouter/callback?code=goodcode&state=${st2}`); stash(r);
ok("good exchange -> /?or=connected", r.status === 302 && r.headers.get("location") === "/?or=connected");

// 5) /api/me shows connected, default model, settings link, and NEVER the key
r = await f("/api/me"); const me = await r.json();
const meStr = JSON.stringify(me);
ok("me.provider is openrouter", me.provider === "openrouter");
ok("me.or.connected true", me.or.connected === true);
ok("me.or.model is a free default", /:free$|openrouter\/free/.test(me.or.model));
ok("me.or has a key settings deep-link", /openrouter\.ai\/keys\//.test(me.or.settingsUrl));
ok("the sk-or- key is NEVER sent to the client", !meStr.includes("MOCKKEY") && !/sk-or-/.test(meStr));

// 6) switch model within the curated list
r = await f("/api/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openrouter", model: me.or.models[1].id }) });
const pj = await r.json();
ok("model switch within allowlist works", r.status === 200 && pj.model === me.or.models[1].id);
// a non-allowlisted model is rejected
r = await f("/api/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openrouter", model: "openai/gpt-4o" }) });
ok("non-curated model rejected (400)", r.status === 400);

// 7) switch to copilot engine, then back is blocked until reconnected only if disconnected
r = await f("/api/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "copilot" }) }); stash(r);
ok("can switch to copilot engine", r.status === 200 && (await r.json()).provider === "copilot");

// 8) disconnect drops the key and returns revoke guidance
r = await f("/api/openrouter/disconnect", { method: "POST" }); stash(r);
const dj = await r.json();
ok("disconnect ok with revoke url", r.status === 200 && /openrouter\.ai\/settings\/keys/.test(dj.revokeUrl));
r = await f("/api/me"); const me2 = await r.json();
ok("after disconnect, or.connected is false", me2.or.connected === false);
// switching to openrouter now requires reconnect
r = await f("/api/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openrouter" }) });
ok("openrouter without a key -> 400 with connect link", r.status === 400 && (await r.json()).connect === "/auth/openrouter/login");

console.log(`\nALL OPENROUTER E2E TESTS PASSED (${pass})`);
mock.close();
process.exit(0);
