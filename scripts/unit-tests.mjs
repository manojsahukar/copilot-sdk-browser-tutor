// Fast, offline assertions for the security-critical invariants. Run: node scripts/unit-tests.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { clientOptions, permissionDecision, ALLOWED_TOOLS, providerKeyOf } from "../src/agent.mjs";
import { makeVerifier, challengeFor, buildProvider, isAllowedModel, OR_BASE_URL, OR_DEFAULT_MODEL, OR_MODELS, OR_KEY_RE } from "../src/openrouter.mjs";

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ok -", name); };

console.log("gotcha 3: mode must be empty");
ok("empty mode is accepted", () => assert.equal(clientOptions({ mode: "empty", baseDirectory: "/tmp/x" }).mode, "empty"));
ok("copilot-cli mode is rejected", () => assert.throws(() => clientOptions({ mode: "copilot-cli" }), /only "empty" is allowed/));
ok("default/undefined mode is rejected", () => assert.throws(() => clientOptions({ baseDirectory: "/tmp/x" })));

console.log("gotcha 7: permission handler denies by default");
for (const t of ["get_browser_fingerprint", "get_request_headers", "get_gotchas", "run_demo"])
  ok(`allows custom tool ${t}`, () => assert.equal(permissionDecision({ kind: "custom-tool", toolName: t }).kind, "approve-once"));
ok("rejects unknown custom tool", () => assert.equal(permissionDecision({ kind: "custom-tool", toolName: "exec_shell" }).kind, "reject"));
ok("rejects shell kind", () => assert.equal(permissionDecision({ kind: "shell", toolName: "bash" }).kind, "reject"));
ok("rejects write kind", () => assert.equal(permissionDecision({ kind: "write", toolName: "write_file" }).kind, "reject"));
ok("rejects empty request", () => assert.equal(permissionDecision(undefined).kind, "reject"));
ok("allowlist has exactly 4 tools", () => assert.equal(ALLOWED_TOOLS.size, 4));

console.log("openrouter: PKCE S256 code challenge");
ok("verifier is a 43-char base64url string", () => { const v = makeVerifier(); assert.match(v, /^[A-Za-z0-9_-]{43}$/); });
ok("challengeFor == base64url(sha256(verifier))", () => {
  const v = makeVerifier();
  const expect = crypto.createHash("sha256").update(v).digest("base64url");
  assert.equal(challengeFor(v), expect);
});

console.log("openrouter: model allowlist (tool calling required)");
ok("default model is allowlisted", () => assert.ok(isAllowedModel(OR_DEFAULT_MODEL)));
ok("every curated model is free (:free or auto)", () => assert.ok(OR_MODELS.every((m) => /:free$/.test(m.id) || m.id === "openrouter/free")));
ok("a non-curated model is rejected", () => assert.equal(isAllowedModel("openai/gpt-4o"), false));

console.log("openrouter: BYOK provider is SSRF-safe and OpenAI-compatible");
ok("baseUrl is the hard-coded allowlisted constant", () => assert.equal(buildProvider("sk-or-v1-x", OR_DEFAULT_MODEL).baseUrl, "https://openrouter.ai/api/v1"));
ok("OR_BASE_URL constant matches", () => assert.equal(OR_BASE_URL, "https://openrouter.ai/api/v1"));
ok("provider is openai-compatible with the key as apiKey", () => { const p = buildProvider("sk-or-v1-x", OR_DEFAULT_MODEL); assert.equal(p.type, "openai"); assert.equal(p.apiKey, "sk-or-v1-x"); assert.equal(p.modelId, OR_DEFAULT_MODEL); });

console.log("openrouter: engine selection key");
ok("copilot session key", () => assert.equal(providerKeyOf({ token: "gho_x" }), "copilot"));
ok("openrouter session key includes model", () => assert.equal(providerKeyOf({ provider: "openrouter", or: { key: "sk-or-v1-x", model: "google/gemma-4-31b-it:free" } }), "or:google/gemma-4-31b-it:free"));
ok("openrouter without a key falls back to copilot", () => assert.equal(providerKeyOf({ provider: "openrouter", token: "gho_x" }), "copilot"));

console.log("openrouter: sk-or- keys are scrubbable");
ok("OR_KEY_RE matches a real-shaped key", () => assert.match("err for sk-or-v1-0a1b2c3d".replace(OR_KEY_RE, "[redacted]"), /\[redacted\]/));
ok("OR_KEY_RE leaves normal text alone", () => assert.equal("hello world".replace(OR_KEY_RE, "[redacted]"), "hello world"));

console.log(`\nALL UNIT TESTS PASSED (${pass})`);
