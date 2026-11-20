// Offline tests for the read-only WebMCP tools on every public page.
// Covers schemas, inspector sample input, OpenRouter sanitising, secret scrubbing, and CSP shape of the HTML.
// Run: node scripts/page-tools-unit.mjs
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { ATLAS_EVAL } from "../src/atlas.mjs";
import { GOTCHAS } from "../src/gotchas.mjs";

const load = (rel) => {
  const ctx = { console, URL, AbortController, TextEncoder, TextDecoder, crypto: webcrypto,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"), atob: (s) => Buffer.from(s, "base64").toString("binary") };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(new URL(rel, import.meta.url), "utf8"), ctx); return ctx;
};
const P = load("../public/page-tools.js").__btwPage;
const W = load("../public/widget.js").__btw;
assert.ok(P && W);
let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ok -", name); };
const plain = (x) => JSON.parse(JSON.stringify(x));
const BANNED = ["examples", "default", "oneOf", "anyOf", "allOf", "$schema", "title"];
function walkBanned(node, at) {
  if (!node || typeof node !== "object") return;
  for (const k of Object.keys(node)) {
    assert.equal(BANNED.includes(k), false, at + "." + k);
    walkBanned(node[k], at + "." + k);
  }
}
function inspectorTemplate(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(schema, "const")) return schema.const;
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return inspectorTemplate(schema.oneOf[0]);
  if (Object.prototype.hasOwnProperty.call(schema, "default")) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === "object") {
    const obj = {};
    for (const key of Object.keys(schema.properties || {})) obj[key] = inspectorTemplate(schema.properties[key]);
    return obj;
  }
  if (schema.type === "string") return "";
  return null;
}

console.log("Tool definitions");
const ALL = Object.values(P.SPECS);
await ok("every tool is read-only, not consequential, and describes a repeatable call", () => {
  for (const spec of ALL) {
    assert.match(spec.name, /^[A-Za-z0-9_.-]{1,64}$/);
    assert.equal(spec.inputSchema.type, "object");
    assert.equal(spec.inputSchema.additionalProperties, false);
    assert.equal(spec.outputSchema.type, "object");
    assert.equal(spec.outputSchema.additionalProperties, false);
    assert.ok(spec.outputSchema.properties.ok && spec.outputSchema.properties.message && spec.outputSchema.properties.error);
    const hints = P.hints(spec.untrusted);
    assert.equal(hints.readOnlyHint, true);
    assert.equal(hints.consequentialHint, false);
    assert.equal(hints.debugging, false);
    assert.equal(hints.untrustedContentHint, !!spec.untrusted);
    assert.match(spec.description, /again/);
    assert.doesNotMatch(spec.description, /[;—]/);
  }
});
await ok("pages pick the tools that belong there", () => {
  const names = (m) => plain(P.specList(m).map((s) => s.name));
  assert.deepEqual(names({}), ["get_site_guide"]);
  assert.deepEqual(names({ probe: true }), ["get_site_guide", "get_browser_reveal", "get_connection_reveal"]);
  assert.deepEqual(names({ gotchas: true }), ["get_site_guide", "get_atlas_summary", "lookup_atlas_technique", "lookup_gotcha"]);
  assert.deepEqual(names({ architecture: true }), ["get_site_guide", "get_architecture_guide"]);
  assert.deepEqual(names({ demos: true }), ["get_site_guide", "get_demo_catalog", "read_demo_state"]);
  assert.deepEqual(names({ widget: true }), ["get_site_guide", "get_page_guide"]);
});
await ok("inspector samples succeed for lookup, architecture, and demos", () => {
  const atlasIn = inspectorTemplate(P.SPECS.atlasOne.inputSchema);
  assert.equal(atlasIn.id, "AML.T0051");
  const hit = P.lookupAtlas(ATLAS_EVAL, atlasIn);
  assert.equal(hit.ok, true);
  assert.match(hit.technique.name, /Prompt Injection/);
  assert.equal(hit.technique.id, "AML.T0051");
  const gotchaIn = inspectorTemplate(P.SPECS.gotcha.inputSchema);
  const g = P.lookupGotcha(GOTCHAS, gotchaIn);
  assert.equal(g.ok, true);
  assert.equal(g.gotcha.id, "llm-js-xss");
  const arch = P.architectureGuide(inspectorTemplate(P.SPECS.arch.inputSchema));
  assert.equal(arch.sections[0].id, "req");
  const demo = P.demoCatalog(inspectorTemplate(P.SPECS.catalog.inputSchema));
  assert.equal(demo.demos[0].id, "storage_inspector");
  assert.equal(inspectorTemplate(P.SPECS.site.inputSchema) && Object.keys(inspectorTemplate(P.SPECS.site.inputSchema)).length, 0);
});

console.log("ATLAS and gotchas");
await ok("summary counts the public evaluation and does not include exploit steps", () => {
  const s = P.summarizeAtlas(ATLAS_EVAL);
  assert.equal(s.ok, true);
  assert.equal(s.meta.version, "2026.10");
  assert.equal(s.counts.applicable, ATLAS_EVAL.applicable.length);
  assert.equal(s.counts.notApplicable, ATLAS_EVAL.notApplicable.length);
  assert.equal(s.applicable[0].apply, undefined);
  assert.ok(s.counts.mitigated > 0);
});
await ok("lookup by words and a missing code", () => {
  const many = P.lookupAtlas(ATLAS_EVAL, { query: "prompt" });
  assert.equal(many.ok, true);
  assert.ok(many.matches.length > 1 || many.technique);
  assert.equal(P.lookupAtlas(ATLAS_EVAL, { id: "AML.T9999" }).ok, false);
  assert.match(P.lookupAtlas(ATLAS_EVAL, {}).error, /AML\.T0051/);
  assert.match(P.lookupAtlas(ATLAS_EVAL, { id: "drop table" }).error, /AML\.T0051/);
  const na = P.lookupAtlas(ATLAS_EVAL, { id: "AML.T0070" });
  assert.equal(na.technique.applicable, false);
  assert.match(na.technique.reason, /retrieval/i);
});
await ok("gotcha lookup refuses unknown input fields", async () => {
  const tools = P.createTools({ gotchas: true }, { loadJson: async (url) => url.endsWith("atlas") ? ATLAS_EVAL : GOTCHAS });
  const gotcha = tools.find((t) => t.name === "lookup_gotcha");
  const bad = await gotcha.execute({ id: "llm-js-xss", extra: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown input field/);
  const good = await gotcha.execute({ id: "llm-js-xss", query: "" });
  assert.equal(good.ok, true);
  assert.equal(good.gotcha.id, "llm-js-xss");
});

console.log("Secrets stay out of tool results");
await ok("browser reveal scrubs tokens and drops storage contents", async () => {
  const fp = {
    collectedAt: "t", pageUrl: "https://example.test/app?code=sk-or-v1-SECRETKEY999",
    userAgent: { userAgent: "Mozilla sk-or-v1-SECRETKEY999" },
    storage: { cookieEnabled: true, localStorage: true, quota: { note: "bt_chat=CHATSECRET999" } },
    navigation: { referrer: "https://evil.test/?token=ghp_SECRETTOKEN999", historyLength: 3, online: true },
    cookies: "bt_sess=COOKIESECRET999",
    chat: [{ text: "CHATSECRET999" }],
  };
  const tools = P.createTools({ probe: true }, { fingerprint: () => fp, connectionText: () => "" });
  const res = await tools.find((t) => t.name === "get_browser_reveal").execute({});
  const blob = JSON.stringify(res);
  assert.equal(res.ok, true);
  assert.equal(res.reveal.pagePath, "/app");
  assert.equal(res.reveal.navigation.referrer, "present");
  assert.equal(res.reveal.cookies, undefined);
  assert.equal(res.reveal.chat, undefined);
  assert.doesNotMatch(blob, /SECRETKEY999|CHATSECRET999|COOKIESECRET999|ghp_SECRETTOKEN999/);
  assert.match(blob, /\[redacted\]/);
});
await ok("connection reveal hides cookie and authorization values", async () => {
  const view = JSON.stringify({
    clientIp: "203.0.113.7",
    headers: { "user-agent": "ok", cookie: "bt_sess=COOKIESECRET999", authorization: "Bearer sk-or-v1-SECRETKEY999" },
    note: "see sk-or-v1-SECRETKEY999 and bt_chat=CHATSECRET999",
  });
  const tools = P.createTools({ probe: true }, { fingerprint: () => null, connectionText: () => view });
  const res = await tools.find((t) => t.name === "get_connection_reveal").execute({});
  const blob = JSON.stringify(res);
  assert.equal(res.ok, true);
  assert.equal(res.connection.headers.cookie, "[hidden]");
  assert.equal(res.connection.headers.authorization, "[hidden]");
  assert.equal(res.connection.clientIp, "203.0.113.7");
  assert.doesNotMatch(blob, /COOKIESECRET999|SECRETKEY999|CHATSECRET999/);
  const early = await tools.find((t) => t.name === "get_connection_reveal").execute({});
  assert.equal(early.ok, true);
  const empty = P.connectionReveal("loading…");
  assert.equal(empty.ok, false);
});
await ok("demo state reports a boolean and not the on-screen text", () => {
  const doc = { getElementById: (id) => id === "out-storage_inspector" ? { textContent: "preview CHATSECRET999 sk-or-v1-SECRETKEY999" } : null };
  const res = P.demoState(doc, { id: "storage_inspector" });
  const blob = JSON.stringify(res);
  assert.equal(res.demos[0].hasResult, true);
  assert.equal(res.demos[0].onPage, true);
  assert.doesNotMatch(blob, /CHATSECRET999|SECRETKEY999/);
  assert.equal(P.demoState(doc, { id: "not-a-demo" }).ok, false);
});
await ok("page guide keeps hostile headings as text and drops unsafe links", () => {
  const doc = {
    get cookie() { throw new Error("cookie read"); },
    get localStorage() { throw new Error("localStorage read"); },
    get sessionStorage() { throw new Error("sessionStorage read"); },
    querySelector: (s) => s === "h1" ? { textContent: "<img onerror=alert(1)>" } : null,
    querySelectorAll: (s) => {
      if (s === "h1, h2, h3") return [{ textContent: "<script>alert(1)</script>" }];
      if (s === "a[href]") return [
        { getAttribute: () => "javascript:alert(1)" },
        { getAttribute: () => "//evil.example" },
        { getAttribute: () => "/\\evil.example" },
        { getAttribute: () => "/widget/xss.html?code=SECRETCODE999" },
        { getAttribute: () => "/gotchas" },
      ];
      return [];
    },
  };
  const info = P.readPage(doc, { pathname: "/widget/xss.html", search: "?code=SECRETCODE999" });
  assert.equal(info.path, "/widget/xss.html");
  assert.deepEqual(plain(info.links), ["/widget/xss.html", "/gotchas"]);
  assert.match(info.headings[0], /<script>/);
  const res = P.pageGuide(info);
  assert.doesNotMatch(JSON.stringify(res), /SECRETCODE999|javascript:/);
});
await ok("tool execute never fetches a caller-supplied URL", async () => {
  const seen = [];
  const tools = P.createTools({ gotchas: true }, { loadJson: async (url) => { seen.push(url); return url.endsWith("atlas") ? ATLAS_EVAL : GOTCHAS; } });
  await tools.find((t) => t.name === "lookup_atlas_technique").execute({ id: "https://evil.example/steal" });
  await tools.find((t) => t.name === "get_atlas_summary").execute({});
  assert.deepEqual(seen, ["/api/atlas"]);
});

console.log("OpenRouter payload and WebMCP registration");
await ok("page-tool schemas sent to OpenRouter drop examples and keep a strict subset", () => {
  const tools = P.createTools({ gotchas: true, widget: true, demos: true }, { loadJson: async () => ATLAS_EVAL });
  const sent = W.pageToolset(tools);
  for (const def of sent.defs) {
    walkBanned(def.function.parameters, def.function.name);
    assert.equal(def.function.outputSchema, undefined);
    assert.equal("annotations" in def.function, false);
  }
  const lookup = sent.defs.find((d) => d.function.name === "lookup_atlas_technique").function.parameters;
  assert.equal(lookup.properties.id.pattern, "^AML\\.T[0-9]{4}(?:\\.[0-9]{3})?$");
  assert.equal(lookup.properties.id.examples, undefined);
  const demo = sent.defs.find((d) => d.function.name === "get_demo_catalog").function.parameters;
  assert.deepEqual(plain(demo.properties.id.enum), plain(P.DEMOS.map((d) => d.id)));
});
await ok("registration uses document.modelContext and ignores an unavailable browser", async () => {
  const tools = P.createTools({});
  assert.equal((await P.registerWebMCP({}, tools, {})).status, "unavailable");
  const reg = new Map();
  const mc = { registerTool(tool, o) { reg.set(tool.name, { tool, signal: o && o.signal }); return Promise.resolve(); }, getTools: async () => [...reg.values()] };
  const r = await P.registerWebMCP({ modelContext: mc }, tools);
  assert.equal(r.status, "registered");
  assert.equal(reg.get("get_site_guide").tool.annotations.readOnlyHint, true);
  assert.equal(reg.get("get_site_guide").tool.annotations.consequentialHint, false);
  assert.ok(reg.get("get_site_guide").tool.outputSchema.properties.pages);
  const result = await reg.get("get_site_guide").tool.execute({});
  assert.equal(result.ok, true);
  assert.ok(result.pages.some((p) => p.path === "/gotchas"));
});

console.log("CSP and source limits");
await ok("page-tools.js does not read cookies, storage, or HTML sinks", () => {
  const src = fs.readFileSync(new URL("../public/page-tools.js", import.meta.url), "utf8");
  for (const banned of ["document.cookie", "localStorage.getItem", "localStorage.setItem", "localStorage.key", "sessionStorage.getItem", "sessionStorage.setItem", "sessionStorage.key", "indexedDB.open", "innerHTML", "insertAdjacentHTML", "eval(", "new Function", "document.write"]) {
    assert.equal(src.includes(banned), false, banned);
  }
});
await ok("every public page loads page-tools.js and has no inline script, handler, or style", () => {
  const root = fileURLToPath(new URL("../public/", import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".html")) files.push(full);
    }
  };
  walk(root);
  assert.ok(files.length >= 11);
  for (const file of files) {
    const html = fs.readFileSync(file, "utf8");
    assert.match(html, /src="\/static\/page-tools\.js"/, file);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, file);
    assert.doesNotMatch(html, /\son[a-z]+=/i, file);
    assert.doesNotMatch(html, /\sstyle=/i, file);
  }
});

console.log(`\nPAGE TOOLS UNIT TESTS PASSED (${pass})`);
