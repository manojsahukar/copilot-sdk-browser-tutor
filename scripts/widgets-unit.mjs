// Offline tests for agent-editable widgets + observability (no AWS: memory store + mocked Logs Insights runner).
// Run: node scripts/widgets-unit.mjs
import assert from "node:assert/strict";
import { validateSpec, mergeChanges, WIDGET_SCHEMA } from "../src/widgets.mjs";
import * as M from "../src/metrics.mjs";
import { _toolsForTest } from "../src/agent.mjs";
import { readiness } from "../src/health.mjs";

let pass = 0;
const ok = async (n, fn) => { await fn(); pass++; console.log("  ok -", n); };
const base = { widget_id: "lat", type: "line", series: [{ metric: "reply_latency_ms", agg: "p95" }], range: "24h" };
const rej = (spec, re) => { const v = validateSpec(spec); assert.equal(v.ok, false, "expected rejection: " + JSON.stringify(spec).slice(0, 120)); if (re) assert.match(v.errors.join(" | "), re); return v; };

console.log("schema: accepts small specs, fills defaults, rebuilds from known fields");
await ok("minimal spec ok + defaults", () => { const v = validateSpec(base); assert.ok(v.ok); assert.equal(v.spec.interval, "auto"); assert.equal(v.spec.scope, "me"); assert.equal(v.spec.title, "Reply latency"); });
await ok("schema is draft-07 with additionalProperties:false at every object", () => {
  assert.equal(WIDGET_SCHEMA.additionalProperties, false);
  for (const k of ["filters", "axes"]) assert.equal(WIDGET_SCHEMA.properties[k].additionalProperties, false);
  assert.equal(WIDGET_SCHEMA.properties.series.items.additionalProperties, false);
  assert.equal(WIDGET_SCHEMA.properties.thresholds.items.additionalProperties, false);
});
await ok("infra + health specs ok", () => {
  assert.ok(validateSpec({ widget_id: "cf", type: "stacked", series: [{ metric: "cf_requests" }], group_by: "distribution", range: "7d" }).ok);
  assert.ok(validateSpec({ widget_id: "up", type: "uptime", series: [{ metric: "uptime_pct" }], range: "30d", slo: 99.5 }).ok);
});

console.log("schema: rejects unknown keys");
await ok("unknown top-level keys (data/option/html/script)", () => { for (const k of ["data", "option", "html", "script", "formatter", "url"]) rej({ ...base, [k]: "x" }, /unknown key/); });
await ok("unknown nested keys (series.formatter, axes.formatter, thresholds.onclick)", () => {
  rej({ ...base, series: [{ metric: "turns", formatter: "function(){}" }] }, /unknown key/);
  rej({ ...base, axes: { y_label: "ms", formatter: "{value}" } }, /unknown key/);
  rej({ ...base, thresholds: [{ value: 1, onclick: "x" }] }, /unknown key/);
});

console.log("schema: rejects script, URLs and markup in any text");
for (const [name, title] of [["<script>", "<script>alert(1)</script>"], ["img onerror", "<img src=x onerror=alert(1)>"], ["javascript:", "javascript:alert(1)"],
  ["https URL", "see https://evil.example/x"], ["protocol-relative", "//evil.example"], ["data: URL", "data:text/html,hi"], ["template", "${process.env}"], ["moustache", "{{constructor}}"], ["control chars", "a\u0007b"], ["backtick", "`rm`"]])
  await ok(`title rejects ${name}`, () => rej({ ...base, title }, /plain text/));
await ok("series label / threshold label / axis label checked too", () => {
  rej({ ...base, series: [{ metric: "turns", label: "<b>x</b>" }] }, /plain text/);
  rej({ ...base, thresholds: [{ value: 1, label: "https://x.y" }] }, /plain text/);
  rej({ ...base, axes: { y_label: "javascript:void(0)" } }, /plain text/);
});
await ok("colours must be #rrggbb (no url(), no CSS)", () => { rej({ ...base, series: [{ metric: "turns", color: "url(https://e/x)" }] }); rej({ ...base, series: [{ metric: "turns", color: "red;background:url(x)" }] }); assert.ok(validateSpec({ ...base, series: [{ metric: "turns", color: "#AABBCC" }] }).ok); });
await ok("widget_id pattern (no spaces, quotes, html)", () => { for (const id of ["A", "<x>", "a b", "a\"b", "x".repeat(40)]) rej({ ...base, widget_id: id }); });

console.log("schema: rejects oversize data and out-of-catalogue values");
await ok("spec > 4 KB rejected (e.g. smuggled data points)", () => rej({ ...base, title: "x", data: Array.from({ length: 2000 }, (_, i) => [i, i]) }, /too large/));
await ok("more than 4 series rejected", () => rej({ ...base, series: Array.from({ length: 5 }, () => ({ metric: "turns" })) }, /at most 4/));
await ok("more than 3 thresholds rejected", () => rej({ ...base, thresholds: [1, 2, 3, 4].map((value) => ({ value })) }, /at most 3/));
await ok("title > 80 chars rejected", () => rej({ ...base, title: "a".repeat(81) }, /longer than 80/));
await ok("non-allowlisted metric / agg / range / type", () => { rej({ ...base, series: [{ metric: "AWS/EC2:CPUUtilization" }] }); rej({ ...base, series: [{ metric: "turns", agg: "median" }] }); rej({ ...base, range: "90d" }); rej({ ...base, type: "html" }); });
await ok("non-finite numbers rejected", () => { rej({ ...base, thresholds: [{ value: Infinity }] }); rej({ ...base, axes: { y_min: NaN } }); });
await ok("semantic: agg not valid for metric, group_by not available, health type with non-health metric", () => {
  rej({ ...base, series: [{ metric: "lambda_invocations", agg: "p95" }] }, /agg must be/);
  rej({ ...base, group_by: "distribution" }, /not available/);
  rej({ widget_id: "st", type: "status", series: [{ metric: "turns" }], range: "24h" }, /health widget/);
});

console.log("update-in-place: merge + full re-validation");
await ok("type change keeps series/range", () => { const v = mergeChanges(validateSpec(base).spec, { type: "bar", group_by: "model" }); assert.ok(v.ok); assert.equal(v.spec.type, "bar"); assert.equal(v.spec.group_by, "model"); assert.equal(v.spec.series[0].metric, "reply_latency_ms"); });
await ok("axes merge (not replace)", () => { const a = mergeChanges(validateSpec({ ...base, axes: { y_label: "ms" } }).spec, { axes: { y_min: 0 } }); assert.deepEqual(a.spec.axes, { y_label: "ms", y_min: 0 }); });
await ok("changes may not include widget_id or unknown keys", () => { assert.equal(mergeChanges(validateSpec(base).spec, { widget_id: "other" }).ok, false); assert.equal(mergeChanges(validateSpec(base).spec, { option: {} }).ok, false); });

console.log("data: point cap + interval coarsening");
await ok("30d at 1m is coarsened to <=500 total points", async () => {
  const v = validateSpec({ widget_id: "x1", type: "line", series: [{ metric: "lambda_invocations" }, { metric: "lambda_errors" }], range: "30d", interval: "1m", example_data: true });
  const d = await M.resolveData(v.spec, { uh: "u" });
  const total = d.series.reduce((a, x) => a + x.points.length, 0);
  assert.ok(total <= M.MAX_POINTS, "points " + total); assert.ok(d.notes.some((n) => /coarsened/.test(n))); assert.equal(d.example, true);
});

console.log("per-user isolation (memory store)");
M.setStore(M.memoryStore());
const A = M.userHash("alice"), B = M.userHash("bob");
await ok("pseudonym is a keyed hash, not the login, stable per user", () => { assert.match(A, /^[0-9a-f]{24}$/); assert.notEqual(A, B); assert.equal(A, M.userHash("Alice")); assert.ok(!A.includes("alice")); });
for (let i = 0; i < 3; i++) await M.recordTurn(A, { t: Date.now() - i * 60e3, engine: "copilot", model: "m1", ms: 1000 + i, tools: 1, retries: 0, ok: 1 });
for (let i = 0; i < 5; i++) await M.recordTurn(B, { t: Date.now() - i * 60e3, engine: "openrouter", model: "m2", ms: 9000, tools: 2, retries: 1, ok: i ? 1 : 0, err: i ? undefined : "rate_limit" });
const turnsSpec = (scope) => validateSpec({ widget_id: "turns-me", type: "stat", series: [{ metric: "turns", agg: "count" }], range: "1h", scope }).spec;
await ok("scope=me: Alice sees only her 3 turns", async () => assert.equal((await M.resolveData(turnsSpec("me"), { uh: A })).series[0].total, 3));
await ok("scope=me: Bob sees only his 5 turns", async () => assert.equal((await M.resolveData(turnsSpec("me"), { uh: B })).series[0].total, 5));
await ok("scope=site: aggregate of everyone (8), no user ids in the payload", async () => { const d = await M.resolveData(turnsSpec("site"), { uh: A }); assert.equal(d.series[0].total, 8); const s = JSON.stringify(d); assert.ok(!s.includes(A) && !s.includes(B)); });
await ok("group_by model under scope=me never reveals the other user's models", async () => {
  const d = await M.resolveData(validateSpec({ widget_id: "grp", type: "bar", series: [{ metric: "reply_latency_ms", agg: "avg" }], group_by: "model", range: "1h" }).spec, { uh: A });
  assert.deepEqual(d.series.map((x) => x.name), ["m1"]);
});
await ok("stored telemetry has no content/login fields", () => { const row = M.store._rows[0]; for (const k of Object.keys(row)) assert.ok(["uh", "kind", "t", "engine", "model", "ms", "tools", "retries", "ok", "err"].includes(k), k); });

console.log("query_logs: allowlisted templates, per-user scoping, masking, admin-only rows");
let lastQ = null;
M.setLogsRunner(async (q) => { lastQ = q; return { status: "Complete", results: [[{ field: "@timestamp", value: "2026-10-22 01:00" }, { field: "@message", value: "[chat] token ghu_ABCDEF123456 for bob@example.com from 203.0.113.9 sid " + "x".repeat(48) }, { field: "@ptr", value: "secretptr" }]] }; });
const alice = { uh: A, admin: false }, owner = { uh: B, admin: true };
await ok("unknown template rejected", async () => assert.match((await M.queryLogs({ template: "fields @message" }, alice)).error, /unknown template/));
await ok("slow_turns scope=site for a non-owner is forced to their own turns", async () => { const r = await M.queryLogs({ template: "slow_turns", scope: "site" }, alice); assert.equal(r.scope, "me"); assert.ok(lastQ.includes(`uh = "${A}"`)); assert.ok(!r.query_shown_for_transparency.includes(A)); });
await ok("owner can see site-wide rows (no uh filter)", async () => { await M.queryLogs({ template: "slow_turns", scope: "site" }, owner); assert.ok(!/uh = /.test(lastQ)); });
await ok("recent_errors is owner-only", async () => { assert.match((await M.queryLogs({ template: "recent_errors" }, alice)).error, /site owner/); assert.ok((await M.queryLogs({ template: "recent_errors" }, owner)).rows); });
await ok("rows are masked (tokens, e-mail, IP, long ids) and @ptr dropped", async () => {
  const r = await M.queryLogs({ template: "recent_errors" }, owner); const s = JSON.stringify(r.rows);
  assert.ok(!/ghu_|bob@example|203\.0\.113\.9|x{48}|secretptr/.test(s), s); assert.match(s, /\[redacted\]/); assert.match(s, /\[email\]/); assert.match(s, /\[ip\]/);
});
await ok("parameters can't inject query text (threshold/limit coerced to allowlist)", async () => { await M.queryLogs({ template: "slow_turns", threshold_ms: "1 | fields @message", limit: 9999 }, alice); assert.match(lastQ, /ms >= 10000/); assert.match(lastQ, /limit 50$/); });

console.log("agent tools: render, update in place, reject, audit");
const events = []; const logs = []; const origLog = console.log; console.log = (...a) => logs.push(a.join(" "));
const ctx = { widgets: new Map(), user: alice, emit: (e) => events.push(e) };
const T = Object.fromEntries(_toolsForTest(ctx).map((t) => [t.name, t.handler]));
const parse = (r) => JSON.parse(r.untrusted_data.replace(/^<<<BEGIN_UNTRUSTED_DATA[^\n]*\n/, "").replace(/\n<<<END_UNTRUSTED_DATA>>>$/, ""));
const r1 = parse(await T.render_widget({ widget_id: "my-lat", type: "line", series: [{ metric: "reply_latency_ms", agg: "p95" }], range: "1h" }));
const r2 = parse(await T.update_widget({ widget_id: "my-lat", changes: { type: "bar", group_by: "engine" } }));
const r3 = parse(await T.update_widget({ widget_id: "nope", changes: { type: "bar" } }));
const r4 = parse(await T.render_widget({ widget_id: "evil", type: "line", series: [{ metric: "turns" }], range: "1h", option: { tooltip: { formatter: "function(){}" } } }));
console.log = origLog;
await ok("render_widget emits a widget event with server-fetched data", () => { assert.equal(r1.ok, true); assert.equal(events[0].type, "widget"); assert.equal(events[0].op, "render"); assert.ok(events[0].data.series.length); });
await ok("update_widget re-renders the SAME widget in place (op=update, merged spec)", () => { assert.equal(events[1].op, "update"); assert.equal(events[1].spec.widget_id, "my-lat"); assert.equal(events[1].spec.type, "bar"); assert.equal(events[1].spec.series[0].metric, "reply_latency_ms"); assert.equal(r2.action, "updated in place"); });
await ok("update of an unknown widget is refused with the existing ids", () => { assert.match(r3.error, /no such widget/); assert.deepEqual(r3.existing, ["my-lat"]); });
await ok("malicious render is rejected and NOTHING is emitted", () => { assert.match(r4.error, /rejected/); assert.equal(events.length, 2); });
await ok("model sees summaries + <=24 sampled points, not the full series", () => { const s = r1.data_summary.series[0]; assert.ok(s.sampled_points.length <= 25); assert.ok(!("points_full" in s)); });
await ok("every observability call is audited (no data in the audit line)", () => { const a = logs.filter((l) => l.includes('"bt":"audit"')); assert.ok(a.length >= 3); assert.ok(a.every((l) => !l.includes("points"))); assert.ok(a.some((l) => l.includes('"rejected":true'))); });

console.log("health: incidents + uptime from probe rows; readiness hygiene");
M.setStore(M.memoryStore());
const now = Date.now();
for (let i = 0; i < 24; i++) await M.store.put("health", null, { t: now - (23 - i) * 300e3, main_st: i >= 10 && i < 13 ? 0 : 1, main_ms: 200, main_code: i >= 10 && i < 13 ? 503 : 200, main_cert: 70, ready_st: 1, ready_ms: 400, sibling_st: 1, sibling_ms: 150, lab_st: 1, lab_ms: 150 });
await ok("contiguous failures become ONE incident with duration and codes", async () => {
  const d = await M.resolveData(validateSpec({ widget_id: "inc", type: "incidents", series: [{ metric: "uptime_pct" }], range: "24h" }).spec, { uh: A });
  const p = d.items.filter((x) => x.source === "probe"); assert.equal(p.length, 1); assert.equal(p[0].minutes, 15); assert.match(p[0].detail, /503/);
});
await ok("uptime 24h = 21/24 checks, thin coverage flagged, budget computed", async () => {
  const d = await M.resolveData(validateSpec({ widget_id: "up", type: "uptime", series: [{ metric: "uptime_pct" }], range: "30d", slo: 99.5 }).spec, { uh: A });
  const m = d.windows[0].endpoints.find((e) => e.id === "main"); assert.equal(m.pct, 87.5); assert.equal(m.thin, true); assert.ok(m.budget_remaining_pct < 0);
});
await ok("readiness output carries no secrets", async () => {
  process.env.SESSION_SECRET = "s3cr3t-session-value";
  const r = await readiness({ hosts: [] }); const s = JSON.stringify(r);
  assert.ok(["ok", "degraded", "down"].includes(r.status)); assert.ok(!s.includes("s3cr3t") && !/arn:aws|sk-or-|gh[opsu]_/.test(s), s);
});
console.log(`\nWIDGETS/OBSERVABILITY UNIT TESTS PASSED (${pass})`);
