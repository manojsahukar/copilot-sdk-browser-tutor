// Offline unit tests for the opt-in page-tools path of the widget and the /widget/ color picker tools.
//  - color tools: schemas, strict validation, state changes (public/widget/color-tools.js)
//  - widget tool loop with a MOCKED OpenRouter (no key, no network) (public/widget.js runToolLoop)
//  - WebMCP registration against a STUBBED document.modelContext (spec shape: registerTool(tool, {signal}) -> Promise)
//  - default-off: without data-tools the request body and prompt are unchanged
// Run: node scripts/widget-tools-unit.mjs
import vm from "node:vm";
import fs from "node:fs";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const load = (rel, extra = {}) => {
  const ctx = { console, URL, AbortController, TextEncoder, TextDecoder, crypto: webcrypto,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"), atob: (s) => Buffer.from(s, "base64").toString("binary"), ...extra };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(new URL(rel, import.meta.url), "utf8"), ctx); return ctx;
};
const C = load("../public/widget/color-tools.js").__btwColor;
const W = load("../public/widget.js").__btw;
assert.ok(C && W);
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => assert.deepStrictEqual(plain(a), plain(b), m); // vm objects come from another realm
let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ok -", name); };

console.log("Color tools: definitions");
const NAMES = ["set_color", "get_color", "reset_color"];
await ok("three tools with the expected names", () => deq(C.TOOL_SPECS.map((t) => t.name), NAMES));
await ok("every tool: WebMCP-valid name, description, object schema with additionalProperties:false", () => {
  for (const t of C.TOOL_SPECS) { assert.match(t.name, /^[A-Za-z0-9_.-]{1,128}$/); assert.ok(t.description.length > 20); assert.equal(t.inputSchema.type, "object"); assert.equal(t.inputSchema.additionalProperties, false); }
});
await ok("only get_color is read-only", () => deq(C.TOOL_SPECS.filter((t) => t.readOnly).map((t) => t.name), ["get_color"]));

console.log("Color tools: strict validation (bad input changes nothing)");
const s0 = { hex: C.DEFAULT, name: null };
const bad = [
  ["set_color", {}, /Missing/], ["set_color", { color: 5 }, /must be a string/], ["set_color", { color: "#12" }, /Not a valid color/],
  ["set_color", { color: "#gggggg" }, /Not a valid color/], ["set_color", { color: "#1234567" }, /Not a valid color/],
  ["set_color", { color: "red; background:url(x)" }, /Not a valid color/], ["set_color", { color: "rgb(1,2,3)" }, /Not a valid color/],
  ["set_color", { color: "url(javascript:alert(1))" }, /Not a valid color/], ["set_color", { color: "constructor" }, /Not a valid color/],
  ["set_color", { color: "__proto__" }, /Not a valid color/], ["set_color", { color: "x".repeat(40) }, /too long/],
  ["set_color", { color: "red", extra: 1 }, /Unknown input field/], ["set_color", [], /JSON object/], ["set_color", "red", /JSON object/],
  ["get_color", { x: 1 }, /Unknown input field/], ["reset_color", { now: true }, /Unknown input field/],
  ["eval", { code: "alert(1)" }, /Unknown tool/], ["__proto__", {}, /Unknown tool/],
];
for (const [name, input, re] of bad) await ok(`rejects ${name} ${JSON.stringify(input).slice(0, 50)}`, () => {
  const r = C.runTool(s0, name, input); assert.equal(r.result.ok, false); assert.match(r.result.error, re); deq(r.state, s0);
});
await ok("an invalid name lists the allowed names", () => assert.ok(C.runTool(s0, "set_color", { color: "blurple" }).result.allowedNames.includes("teal")));
await ok("prototype keys are not accepted as fields", () => assert.match(C.runTool(s0, "reset_color", JSON.parse('{"__proto__":{"x":1}}')).result.error, /Unknown input field/));

console.log("Color tools: valid calls");
await ok("hex #rrggbb, #rgb (expanded), upper case, spaces", () => {
  assert.equal(C.runTool(s0, "set_color", { color: "#FF8800" }).state.hex, "#ff8800");
  assert.equal(C.runTool(s0, "set_color", { color: " #f80 " }).state.hex, "#ff8800");
});
await ok("CSS name -> hex, name kept", () => { const r = C.runTool(s0, "set_color", { color: "Teal" }); deq(r.state, { hex: "#008080", name: "teal" }); assert.match(r.result.message, /teal \(#008080\)/); });
await ok("get_color reads, reset_color restores the default; input state not mutated", () => {
  const t = C.runTool(s0, "set_color", { color: "coral" }).state;
  assert.equal(C.runTool(t, "get_color", undefined).result.swatch.color, "#ff7f50");
  assert.equal(C.runTool(t, "reset_color", {}).state.hex, C.DEFAULT); assert.equal(s0.hex, C.DEFAULT);
});
await ok("controller: onChange fires with the source; failed calls do not change it", () => {
  const seen = []; const ctl = C.createController((st, ev) => seen.push([st.hex, ev.source, ev.name]));
  ctl.call("set_color", { color: "nope" }, "X"); assert.equal(seen.length, 0);
  ctl.call("set_color", { color: "red" }, "Chat widget"); deq(seen, [["#ff0000", "Chat widget", "set_color"]]);
});
await ok("toolList: WebMCP shape; execute returns a Promise; schema copies cannot widen the rules", async () => {
  const ctl = C.createController(); const list = C.toolList(ctl, "T");
  for (const t of list) deq(Object.keys(t).sort(), ["annotations", "description", "execute", "inputSchema", "name", "title"]);
  assert.equal((await list[0].execute({ color: "navy" })).ok, true); assert.equal(ctl.getState().hex, "#000080");
  list[0].inputSchema.properties.color.maxLength = 9999; assert.equal(C.runTool(s0, "set_color", { color: "x".repeat(40) }).result.ok, false);
});

console.log("WebMCP registration (stubbed modelContext)");
function stubMC({ rejectNames = [], throwSync = false } = {}) {
  const reg = new Map(), opts = [];
  return { reg, opts, mc: {
    registerTool(tool, o) {
      if (throwSync) throw new TypeError("bad"); opts.push(o);
      if (reg.has(tool.name) || rejectNames.includes(tool.name)) return Promise.reject(Object.assign(new Error("dup"), { name: "InvalidStateError" }));
      reg.set(tool.name, tool); if (o && o.signal) o.signal.addEventListener("abort", () => reg.delete(tool.name)); return Promise.resolve();
    },
    getTools: async () => [...reg.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: JSON.stringify(t.inputSchema) })),
    executeTool: async (t, input) => JSON.stringify(await reg.get(t.name).execute(input, {})),
  } };
}
await ok("no modelContext -> 'unavailable', nothing thrown", async () => {
  assert.equal((await C.registerWebMCP({}, C.createController(), {})).status, "unavailable");
  assert.equal((await C.registerWebMCP(null, C.createController())).status, "unavailable");
  assert.equal((await C.registerWebMCP({ modelContext: {} }, C.createController())).status, "unavailable");
});
await ok("document.modelContext: registers 3 tools with an AbortSignal; executeTool runs the same validated tool", async () => {
  const s = stubMC(); const ctl = C.createController(); const r = await C.registerWebMCP({ modelContext: s.mc }, ctl);
  assert.equal(r.status, "registered"); deq([...r.names].sort(), [...NAMES].sort()); assert.ok(s.opts.every((o) => o && o.signal));
  const t = (await s.mc.getTools()).find((x) => x.name === "set_color");
  assert.equal(JSON.parse(await s.mc.executeTool(t, { color: "#00ff00" })).ok, true); assert.equal(ctl.getState().hex, "#00ff00");
  assert.equal(JSON.parse(await s.mc.executeTool(t, { color: "javascript:x" })).ok, false); assert.equal(ctl.getState().hex, "#00ff00");
  r.abort(); assert.equal((await s.mc.getTools()).length, 0, "aborting the signal unregisters");
});
await ok("navigator.modelContext fallback (older builds); document wins when both exist", async () => {
  const n = stubMC(); assert.equal((await C.registerWebMCP({}, C.createController(), { modelContext: n.mc })).status, "registered"); assert.equal(n.reg.size, 3);
  const d = stubMC(), n2 = stubMC(); await C.registerWebMCP({ modelContext: d.mc }, C.createController(), { modelContext: n2.mc });
  assert.equal(d.reg.size, 3); assert.equal(n2.reg.size, 0);
});
await ok("a rejected registration is caught -> 'partial'; a sync throw -> 'failed'", async () => {
  const r = await C.registerWebMCP({ modelContext: stubMC({ rejectNames: ["reset_color"] }).mc }, C.createController());
  assert.equal(r.status, "partial"); assert.match(r.errors[0], /reset_color: InvalidStateError/);
  assert.equal((await C.registerWebMCP({ modelContext: stubMC({ throwSync: true }).mc }, C.createController())).status, "failed");
});

console.log("Widget: opt-in parsing and tool list");
await ok("data-tools: only 'page' turns it on", () => {
  for (const [raw, want] of [[null, ""], ["", ""], ["page", "page"], [" Page ", "page"], ["1", ""], ["all", ""], ["window", ""]]) assert.equal(W.parseToolsMode(raw), want, String(raw));
});
await ok("pageToolset: OpenAI 'tools' format; skips bad names, duplicates, non-functions; caps at 16", () => {
  const good = (name) => ({ name, description: "d", inputSchema: { type: "object", properties: {} }, execute: () => ({ ok: true }) });
  const list = [good("a_b"), good("a_b"), good("bad name"), good("x".repeat(65)), { name: "noexec", description: "d" }, null, 5, good("__proto__")];
  for (let i = 0; i < 20; i++) list.push(good("t" + i));
  const ts = W.pageToolset(list);
  assert.equal(ts.defs.length, 16); assert.equal(ts.defs[0].type, "function"); assert.equal(ts.defs[0].function.name, "a_b");
  deq(plain(ts.defs[0].function.parameters), { type: "object", properties: {} });
  assert.ok(!ts.defs.some((d) => /\s/.test(d.function.name)));
  assert.equal(Object.getPrototypeOf(ts.byName), null, "lookup table has no prototype");
  assert.equal(W.pageToolset(undefined).defs.length, 0); assert.equal(W.pageToolset({}).defs.length, 0);
});
await ok("parseToolArgs: object only, size-capped, never evaluated", () => {
  deq(plain(W.parseToolArgs('{"type":"line"}').value), { type: "line" });
  deq(plain(W.parseToolArgs("").value), {}); deq(plain(W.parseToolArgs(undefined).value), {});
  assert.match(W.parseToolArgs("[1]").error, /object/); assert.match(W.parseToolArgs("null").error, /object/);
  assert.match(W.parseToolArgs("alert(1)").error, /not valid JSON/); assert.match(W.parseToolArgs("{\"a\":\"" + "x".repeat(5000) + "\"}").error, /too long/);
});
await ok("withToolPrompt puts the tool rule before the delimited page data, and copies (no mutation)", () => {
  const m = W.buildMessages({ siteName: "S", page: { url: "/a", title: "T", text: "page" }, question: "q" });
  const before = JSON.stringify(m); const t = W.withToolPrompt(m);
  assert.equal(JSON.stringify(m), before);
  const c = t[0].content; assert.ok(c.indexOf(W.TOOL_PROMPT) > 0 && c.indexOf(W.TOOL_PROMPT) < c.indexOf("--- CONTEXT (data) ---"));
  assert.equal(t.length, m.length); deq(plain(t.slice(1)), plain(m.slice(1)));
});

console.log("Widget: tool-call loop with a mocked OpenRouter");
function mockOpenRouter(replies) {
  const bodies = [];
  return { bodies, send: async (body) => { bodies.push(JSON.parse(JSON.stringify(body))); const r = replies[bodies.length - 1]; if (!r) throw new Error("no more mock replies"); return typeof r === "function" ? r(body) : r; } };
}
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const toolReply = (...calls) => ({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls } }] });
const textReply = (t) => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: t } }] });
const baseMsgs = () => W.withToolPrompt(W.buildMessages({ siteName: "Tutor Docs", page: { url: "/widget/", title: "Home", text: "color page" }, question: "Make it teal, then #ff8800" }));

await ok("two tool calls in one round -> results sent back -> final reply; color changed", async () => {
  const ctl = C.createController(); const ts = W.pageToolset(C.toolList(ctl, "Chat widget"));
  const mock = mockOpenRouter([
    toolReply(call("call_1", "get_color", {}), call("call_2", "set_color", { color: "teal" })),
    toolReply(call("call_3", "set_color", { color: "#ff8800" })),
    textReply("Done: the color is now #ff8800."),
  ]);
  const trace = [];
  const res = await W.runToolLoop({ messages: baseMsgs(), toolset: ts, model: "openrouter/free", send: mock.send, onTrace: (e) => trace.push(e) });
  assert.equal(res.text, "Done: the color is now #ff8800.");
  assert.equal(res.rounds, 3); deq(trace.map((e) => e.name), ["get_color", "set_color", "set_color"]);
  deq(ctl.getState(), { hex: "#ff8800", name: null });
  // request 1: tools sent, non-streaming, model kept
  const b1 = mock.bodies[0];
  assert.equal(b1.stream, false); assert.equal(b1.model, "openrouter/free"); assert.equal(b1.tools.length, 3); assert.equal(b1.tool_choice, undefined);
  deq(b1.tools.map((t) => t.function.name), NAMES);
  // request 2: assistant tool_calls message + one role:tool message per call, ids matched
  const b2 = mock.bodies[1], tail = b2.messages.slice(-3);
  assert.equal(tail[0].role, "assistant"); assert.equal(tail[0].content, null); deq(tail[0].tool_calls.map((c) => c.id), ["call_1", "call_2"]);
  deq(tail.slice(1).map((m) => [m.role, m.tool_call_id]), [["tool", "call_1"], ["tool", "call_2"]]);
  assert.equal(JSON.parse(tail[2].content).ok, true); assert.equal(b2.tools.length, 3, "tools re-sent on every request");
  assert.equal(mock.bodies[2].messages.length, b1.messages.length + 5);
});
await ok("invalid / unknown / malformed tool calls become structured errors sent back, color unchanged", async () => {
  const ctl = C.createController(); const ts = W.pageToolset(C.toolList(ctl, "Chat widget"));
  const mock = mockOpenRouter([
    toolReply(call("a", "set_color", { color: "<b>red</b>" }), call("b", "eval", { code: "alert(1)" }), call("c", "set_color", "{not json"), { function: { name: "reset_color" } }),
    textReply("Sorry, that is not a color I can use."),
  ]);
  const trace = [];
  const res = await W.runToolLoop({ messages: baseMsgs(), toolset: ts, model: "m", send: mock.send, onTrace: (e) => trace.push(e) });
  assert.equal(res.text, "Sorry, that is not a color I can use.");
  const toolMsgs = mock.bodies[1].messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  assert.match(toolMsgs[0].error, /Not a valid color/); assert.match(toolMsgs[1].error, /Unknown tool: eval/); assert.match(toolMsgs[2].error, /not valid JSON/);
  assert.equal(toolMsgs[3].ok, true, "a call without id/arguments still works (reset with {})");
  assert.ok(mock.bodies[1].messages.some((m) => m.role === "tool" && m.tool_call_id === "call_0_3"), "missing id is synthesised");
  deq(ctl.getState(), { hex: C.DEFAULT, name: null });
  assert.equal(trace[2].args, "{not json", "trace shows the raw (bad) arguments as text");
});
await ok("a throwing tool is contained: error result, loop continues", async () => {
  const ts = W.pageToolset([{ name: "boom", description: "d", inputSchema: { type: "object", properties: {} }, execute: () => { throw new Error("secret internals"); } }]);
  const mock = mockOpenRouter([toolReply(call("x", "boom", {})), textReply("ok")]);
  await W.runToolLoop({ messages: baseMsgs(), toolset: ts, model: "m", send: mock.send });
  const tm = mock.bodies[1].messages.find((m) => m.role === "tool");
  deq(JSON.parse(tm.content), { ok: false, error: "The tool failed." });
});
await ok("loop is capped: after 4 tool rounds the 5th request forces tool_choice 'none'", async () => {
  const ctl = C.createController(); const ts = W.pageToolset(C.toolList(ctl, "w"));
  const loop = () => toolReply(call("r", "get_color", {}));
  const mock = mockOpenRouter([loop, loop, loop, loop, (b) => (b.tool_choice === "none" ? textReply("final") : loop())]);
  const res = await W.runToolLoop({ messages: baseMsgs(), toolset: ts, model: "m", send: mock.send });
  assert.equal(mock.bodies.length, 5); assert.equal(mock.bodies[4].tool_choice, "none"); assert.equal(res.text, "final"); assert.equal(W.TOOL_ROUNDS, 4);
});
await ok("at most 8 tool calls per round are run", async () => {
  let n = 0; const ts = W.pageToolset([{ name: "t", description: "d", inputSchema: { type: "object", properties: {} }, execute: () => { n++; return { ok: true }; } }]);
  const many = []; for (let i = 0; i < 20; i++) many.push(call("c" + i, "t", {}));
  await W.runToolLoop({ messages: baseMsgs(), toolset: ts, model: "m", send: mockOpenRouter([toolReply(...many), textReply("x")]).send });
  assert.equal(n, 8);
});
await ok("reasoning_details are passed back with the assistant tool_calls message", async () => {
  const ts = W.pageToolset(C.toolList(C.createController(), "w"));
  const r1 = toolReply(call("a", "reset_color", {})); r1.choices[0].message.reasoning_details = [{ type: "reasoning.encrypted", data: "sig" }];
  const mock = mockOpenRouter([r1, textReply("x")]);
  await W.runToolLoop({ messages: baseMsgs(), toolset: ts, model: "m", send: mock.send });
  deq(plain(mock.bodies[1].messages.find((m) => m.role === "assistant" && m.tool_calls).reasoning_details), [{ type: "reasoning.encrypted", data: "sig" }]);
});
await ok("no tool calls -> plain answer in one request; empty/invalid reply throws a clear error", async () => {
  const ts = W.pageToolset(C.toolList(C.createController(), "w"));
  const res = await W.runToolLoop({ messages: baseMsgs(), toolset: ts, model: "m", send: mockOpenRouter([textReply("Just text.")]).send });
  assert.equal(res.text, "Just text."); assert.equal(res.rounds, 1);
  await assert.rejects(W.runToolLoop({ messages: baseMsgs(), toolset: ts, model: "m", send: mockOpenRouter([{ error: { message: "No endpoints found that support tool use" } }]).send }), /support tool use/);
});
await ok("huge tool results are capped before being sent back", () => {
  const s = W.toolResultText({ big: "x".repeat(10000) }); assert.ok(s.length < 4200); assert.equal(JSON.parse(s).truncated, true);
  const cyc = {}; cyc.self = cyc; assert.match(W.toolResultText(cyc), /could not be serialised/);
});
await ok("traceSummary is short plain text", () => {
  assert.equal(W.traceSummary({ ok: true, message: "The color is now red." }), "ok: The color is now red.");
  assert.equal(W.traceSummary({ ok: false, error: "Nope." }), "error: Nope.");
  assert.ok(W.traceSummary({ a: "<b>" }).includes("<b>"), "returned as text; the UI sets textContent");
});

console.log("Default off: sites without data-tools are unchanged");
await ok("buildMessages and corePrompt contain no tool text", () => {
  const m = W.buildMessages({ siteName: "S", page: { url: "/", title: "T", text: "x" }, question: "q" });
  assert.ok(!m[0].content.includes(W.TOOL_PROMPT)); assert.ok(!W.corePrompt("S").includes("tool"));
});
await ok("the only use of the tool path is gated on cfg.tools === 'page' AND the OpenRouter provider", () => {
  const src = fs.readFileSync(new URL("../public/widget.js", import.meta.url), "utf8");
  assert.equal((src.match(/runToolLoop\(\{/g) || []).length, 1);
  assert.match(src, /var tset = cfg\.tools === "page" && P\(\)\.id === "openrouter" \? pageToolset\(G\.btwPageTools\) : null;/);
  assert.match(src, /\} else full = await streamChat\(msgs, model,/);
  assert.match(src, /body: JSON\.stringify\(\{ model: model, messages: messages, stream: true \}\)/, "streaming body unchanged");
});

console.log(`\nWIDGET TOOLS UNIT TESTS PASSED (${pass})`);
