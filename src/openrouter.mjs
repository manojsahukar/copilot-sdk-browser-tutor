// OpenRouter "bring your own credits" via OAuth PKCE (no client secret), wired through the Copilot SDK's
// BYOK provider. The issued sk-or- key is billed to the USER's OpenRouter credits, never Manoj's account.
// Docs: https://openrouter.ai/docs/guides/overview/auth/oauth
import crypto from "node:crypto";

// Hard-allowlisted base URL. Never take a base URL from the user (SSRF / exfiltration). See /gotchas.
export const OR_BASE_URL = "https://openrouter.ai/api/v1";
// Auth/exchange endpoints allow a test-only override (operator env, never user input). The model base URL
// (OR_BASE_URL, the SSRF-sensitive fetch target) is NEVER overridable.
export const OR_AUTH_URL = process.env.OPENROUTER_AUTH_URL || "https://openrouter.ai/auth";
export const OR_EXCHANGE_URL = process.env.OPENROUTER_EXCHANGE_URL || (OR_BASE_URL + "/auth/keys");
export const OR_REVOKE_URL = "https://openrouter.ai/settings/keys";

// Any sk-or- key, so logs/errors can be scrubbed of it.
export const OR_KEY_RE = /sk-or-[A-Za-z0-9._-]+/g;

// Tool calling is REQUIRED (the tutor's whole value is its tools), so every model here must support it.
// This list was filtered from the live GET https://openrouter.ai/api/v1/models (supported_parameters includes
// "tools" and pricing is free). Override with OPENROUTER_MODELS / OPENROUTER_DEFAULT_MODEL if OpenRouter's
// free line-up changes. All are ":free" (or the free auto-router), so the default costs the user nothing.
// All support tool calling (verified against the live GET /api/v1/models). "openrouter/auto" is OpenRouter's
// router: it picks a model per request and MAY route to PAID models (pricing is dynamic), so it can bill the
// user's credits. The ":free" / free-router entries cost nothing. The default is Auto for reliability (it avoids
// the shared free-pool 429s), with an honest paid-routing note shown in the UI.
const CURATED = [
  { id: "openrouter/auto", label: "Auto (best available)", free: false, note: "May route to paid models and bill your OpenRouter credits." },
  { id: "openrouter/free", label: "Auto (free models only)", free: true, note: "Only free models. No charge, but the shared free pool is often rate-limited." },
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B", free: true, note: "Free. Shared free pool; may be rate-limited." },
  { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B", free: true, note: "Free. Shared free pool; may be rate-limited." },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B", free: true, note: "Free. Shared free pool; may be rate-limited." },
];
export const OR_MODELS = (() => {
  const env = (process.env.OPENROUTER_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!env.length) return CURATED;
  return env.map((id) => ({ id, label: id, free: /:free$|\/free$/.test(id), note: "" }));
})();
export const OR_DEFAULT_MODEL = process.env.OPENROUTER_DEFAULT_MODEL || OR_MODELS[0].id;
const ALLOWED_MODELS = new Set(OR_MODELS.map((m) => m.id));
export const isAllowedModel = (m) => ALLOWED_MODELS.has(m);

// ---- PKCE ----
const b64url = (buf) => Buffer.from(buf).toString("base64url");
export function makeVerifier() { return b64url(crypto.randomBytes(32)); }            // 43-char RFC verifier
export function challengeFor(verifier) { return b64url(crypto.createHash("sha256").update(verifier).digest()); }
export function keyHashHex(key) { return crypto.createHash("sha256").update(key).digest("hex"); }
// The owner-only key settings/limits page (works only for the signed-in owner of the key).
export const keySettingsUrl = (key) => `https://openrouter.ai/keys/${keyHashHex(key)}`;

// Build the /auth redirect URL (step 1). key_label shows the user what they're authorizing.
export function authorizeUrl({ callbackUrl, challenge, state, label }) {
  const u = new URL(OR_AUTH_URL);
  u.searchParams.set("callback_url", callbackUrl);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (state) u.searchParams.set("state", state);
  if (label) u.searchParams.set("key_label", label);
  return u.toString();
}

// Step 2: exchange the one-time code for a user-controlled key. Runs server-side so the key never touches the client JS.
export async function exchangeCode({ code, verifier }) {
  const r = await fetch(OR_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.key) {
    const m = r.status === 403 ? "authorization code invalid or expired" : (j?.error?.message || j?.message || `exchange failed (HTTP ${r.status})`);
    throw new Error(String(m).replace(OR_KEY_RE, "[redacted]"));
  }
  return { key: j.key, userId: j.user_id || null };
}

// Copilot SDK BYOK provider config for an OpenRouter-backed session (OpenAI-compatible wire API).
export function buildProvider(key, model) {
  return {
    type: "openai",
    wireApi: "completions",
    baseUrl: OR_BASE_URL,           // hard-allowlisted; never user-supplied
    apiKey: key,                    // billed to the user's OpenRouter credits
    modelId: model,
    headers: {
      "HTTP-Referer": (process.env.BASE_URL || "https://copilot-sdk.demo.curiosta.com").replace(/\/$/, ""),
      "X-Title": "Browser Tutor",
    },
  };
}
