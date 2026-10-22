// Fast, offline assertions for the security-critical invariants. Run: node scripts/unit-tests.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { clientOptions, permissionDecision, ALLOWED_TOOLS, providerKeyOf, validateFollowups, _toolsForTest } from "../src/agent.mjs";
import { LAB_LESSONS } from "../src/demos.mjs";
import { makeVerifier, challengeFor, buildProvider, isAllowedModel, OR_BASE_URL, OR_DEFAULT_MODEL, OR_MODELS, OR_KEY_RE } from "../src/openrouter.mjs";

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ok -", name); };

console.log("gotcha 3: mode must be empty");
ok("empty mode is accepted", () => assert.equal(clientOptions({ mode: "empty", baseDirectory: "/tmp/x" }).mode, "empty"));
ok("copilot-cli mode is rejected", () => assert.throws(() => clientOptions({ mode: "copilot-cli" }), /only "empty" is allowed/));
ok("default/undefined mode is rejected", () => assert.throws(() => clientOptions({ baseDirectory: "/tmp/x" })));

console.log("gotcha 7: permission handler denies by default");
for (const t of ["get_browser_fingerprint", "get_request_headers", "get_gotchas", "run_demo", "suggest_followups", "query_metrics", "render_widget", "update_widget", "query_logs", "check_health"])
  ok(`allows custom tool ${t}`, () => assert.equal(permissionDecision({ kind: "custom-tool", toolName: t }).kind, "approve-once"));
ok("rejects unknown custom tool", () => assert.equal(permissionDecision({ kind: "custom-tool", toolName: "exec_shell" }).kind, "reject"));
ok("rejects shell kind", () => assert.equal(permissionDecision({ kind: "shell", toolName: "bash" }).kind, "reject"));
ok("rejects write kind", () => assert.equal(permissionDecision({ kind: "write", toolName: "write_file" }).kind, "reject"));
ok("rejects empty request", () => assert.equal(permissionDecision(undefined).kind, "reject"));
ok("allowlist has exactly 10 tools (5 tutor + 5 read-only observability)", () => assert.equal(ALLOWED_TOOLS.size, 10));
ok("rejects look-alike write tools", () => { for (const t of ["put_metric", "delete_widget", "run_logs_query", "query_logs_raw"]) assert.equal(permissionDecision({ kind: "custom-tool", toolName: t }).kind, "reject"); });

console.log("openrouter: PKCE S256 code challenge");
ok("verifier is a 43-char base64url string", () => { const v = makeVerifier(); assert.match(v, /^[A-Za-z0-9_-]{43}$/); });
ok("challengeFor == base64url(sha256(verifier))", () => {
  const v = makeVerifier();
  const expect = crypto.createHash("sha256").update(v).digest("base64url");
  assert.equal(challengeFor(v), expect);
});

console.log("openrouter: model allowlist (tool calling required)");
ok("default model is Auto (openrouter/auto) and allowlisted", () => { assert.equal(OR_DEFAULT_MODEL, "openrouter/auto"); assert.ok(isAllowedModel(OR_DEFAULT_MODEL)); });
ok("Auto is flagged as not free with a paid-routing note", () => { const a = OR_MODELS.find((m) => m.id === "openrouter/auto"); assert.ok(a && a.free === false && /paid/i.test(a.note)); });
ok("the list still contains free (:free or /free) models", () => assert.ok(OR_MODELS.some((m) => m.free && /:free$|\/free$/.test(m.id))));
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

console.log("suggest_followups: server-side validation neutralises malicious chips");
ok("drops HTML, javascript:, URLs; keeps plain questions", () => {
  const r = validateFollowups(["<img src=x onerror=alert(1)>", "javascript:alert(1)", "See http://evil.com/x", "What does my UA reveal?"]);
  assert.deepEqual(r, ["What does my UA reveal?"]);
});
ok("caps at 4 and dedupes case-insensitively", () => {
  const r = validateFollowups(["one", "ONE", "two", "three", "four", "five"]);
  assert.equal(r.length, 4); assert.deepEqual(r, ["one", "two", "three", "four"]);
});
ok("truncates to <=80 chars and strips markdown/control chars", () => {
  const r = validateFollowups(["**bold** `code` " + "x".repeat(100), "a\u0000b"]);
  assert.ok(r[0].length <= 80); assert.ok(!/[*`\u0000]/.test(r[0])); assert.equal(r[1], "a b");
});
ok("non-array / junk yields empty list", () => { assert.deepEqual(validateFollowups(null), []); assert.deepEqual(validateFollowups([1, {}, "", "   "]), []); });

console.log("run_demo: xss_lab lessons are names from an enum, never code");
{
  const ctx = { demoResults: { xss_lab: { runs: [{ demo: "links", variant: "vuln", executed: false, blocked: false }, { demo: "dom", variant: "vuln", executed: true }] } } };
  const raw = _toolsForTest(ctx).find((t) => t.name === "run_demo");
  const unwrap = (w) => JSON.parse(w.untrusted_data.split("\n").slice(1, -1).join("\n"));
  const rd = { parameters: raw.parameters, handler: async (a) => unwrap(await raw.handler(a)) };
  const en = rd.parameters.properties.lesson.enum;
  ok("lesson enum lists the four new lessons", () => { for (const l of ["links", "hooks", "csp3p", "keystore"]) assert.ok(en.includes(l)); assert.deepEqual(en, LAB_LESSONS); });
  const r1 = await rd.handler({ demo: "xss_lab", lesson: "links" });
  ok("lesson notes + only that lesson's runs are returned", () => { assert.equal(r1.lesson.id, "links"); assert.equal(r1.lesson.runs.length, 1); assert.ok(/\/\//.test(r1.lesson.teaches)); });
  const r2 = await rd.handler({ demo: "xss_lab", lesson: "keystore" });
  ok("unrun lesson gets a 'tap the preset' hint and links its gotcha", () => { assert.equal(r2.lesson.ranByUser, false); assert.ok(/tap/.test(r2.lesson.hint)); assert.deepEqual(r2.lesson.gotchas, ["client-side-byok-key"]); });
  const r3 = await rd.handler({ demo: "xss_lab", lesson: "<script>" });
  ok("unknown lesson rejected", () => assert.equal(r3.error, "unknown lesson"));
  const r4 = await rd.handler({ demo: "camera", lesson: "links" });
  ok("lesson ignored for non-lab demos", () => assert.equal(r4.lesson, undefined));
}

console.log(`\nALL UNIT TESTS PASSED (${pass})`);
