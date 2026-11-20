// Offline tests for the read-only WebMCP tools on every public page.
// Covers schemas, inspector sample input, OpenRouter sanitising, secret scrubbing, and CSP shape of the HTML.
// Run: node scripts/page-tools-unit.mjs
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { ATLAS_EVAL } from "../src/atlas.mjs";
import { GOTCHAS } from "../src/gotchas.mjs";
import { FIND_PAGE_TOOL, SET_COLOR_FORM_TOOL, llmsTxt, publicPages, robotsTxt, searchPublicPages, sitemapXml, webmcpManifest, webmcpTools } from "../src/publicmeta.mjs";

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
  assert.deepEqual(names({ landing: true }), ["get_site_guide", "get_landing_guide"]);
  assert.deepEqual(names({ probe: true }), ["get_site_guide", "get_browser_reveal", "get_connection_reveal"]);
  assert.deepEqual(names({ gotchas: true }), ["get_site_guide", "get_atlas_summary", "lookup_atlas_technique", "lookup_gotcha"]);
  assert.deepEqual(names({ architecture: true }), ["get_site_guide", "get_architecture_guide"]);
  assert.deepEqual(names({ demos: true }), ["get_site_guide", "get_demo_catalog", "read_demo_state"]);
  assert.deepEqual(names({ widget: true }), ["get_site_guide", "get_page_guide"]);
});
await ok("each tool description says what it returns, and schemas have examples but no default", () => {
  function noDefault(node, at) {
    if (!node || typeof node !== "object") return;
    assert.equal(Object.prototype.hasOwnProperty.call(node, "default"), false, at);
    for (const k of Object.keys(node)) noDefault(node[k], at + "." + k);
  }
  for (const spec of ALL) {
    assert.match(spec.description, /It returns/);
    noDefault(spec.inputSchema, spec.name);
  }
  assert.equal(P.SPECS.catalog.inputSchema.properties.id.examples[0], "storage_inspector");
  assert.equal(P.SPECS.arch.inputSchema.properties.section.examples[0], "req");
  assert.deepEqual(plain(P.SPECS.atlas.inputSchema.properties.status.enum), plain(P.ATLAS_STATUS));
  assert.match(P.SPECS.atlasOne.description, /id wins if you give both/);
  assert.match(P.SPECS.gotcha.description, /id wins if you give both/);
  assert.match(P.SITE_PAGES.find((p) => p.path === "/").summary, /Sign in to see what this browser reveals/);
});
await ok("inspector samples succeed for lookup, architecture, and demos", () => {
  const atlasIn = inspectorTemplate(P.SPECS.atlasOne.inputSchema);
  assert.equal(atlasIn.id, "AML.T0051");
  const hit = P.lookupAtlas(ATLAS_EVAL, atlasIn);
  assert.equal(hit.ok, true);
  assert.match(hit.technique.name, /Prompt Injection/);
  assert.equal(hit.technique.id, "AML.T0051");
  assert.match(hit.note, /id wins if you give both/);
  const gotchaIn = inspectorTemplate(P.SPECS.gotcha.inputSchema);
  const g = P.lookupGotcha(GOTCHAS, gotchaIn);
  assert.equal(g.ok, true);
  assert.equal(g.gotcha.id, "llm-js-xss");
  assert.match(g.note, /id wins if you give both/);
  const arch = P.architectureGuide(inspectorTemplate(P.SPECS.arch.inputSchema));
  assert.equal(arch.sections[0].id, "req");
  assert.equal(P.architectureGuide({}).sections.length, 4);
  const demo = P.demoCatalog(inspectorTemplate(P.SPECS.catalog.inputSchema));
  assert.equal(demo.demos[0].id, "storage_inspector");
  assert.equal(P.demoCatalog({}).demos.length, 7);
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
  assert.equal(s.status, undefined);
  assert.ok(s.counts.mitigated > 0);
});
await ok("atlas summary status filter shrinks the result", () => {
  const all = P.summarizeAtlas(ATLAS_EVAL, {});
  const fixed = P.summarizeAtlas(ATLAS_EVAL, { status: "fixed" });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.status, "fixed");
  assert.ok(fixed.applicable.length > 0);
  assert.ok(fixed.applicable.every((row) => row.status === "fixed"));
  assert.equal(fixed.notApplicable.length, 0);
  assert.ok(JSON.stringify(fixed).length < JSON.stringify(all).length);
  const na = P.summarizeAtlas(ATLAS_EVAL, { status: "not-applicable" });
  assert.equal(na.applicable.length, 0);
  assert.equal(na.notApplicable.length, ATLAS_EVAL.notApplicable.length);
  assert.match(P.summarizeAtlas(ATLAS_EVAL, { status: "nope" }).error, /not-applicable/);
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
  assert.equal(good.note, undefined);
  const both = await gotcha.execute({ id: "llm-js-xss", query: "prompt injection" });
  assert.equal(both.ok, true);
  assert.match(both.note, /id wins if you give both/);
  const typed = await tools.find((t) => t.name === "lookup_atlas_technique").execute({ id: 5 });
  assert.equal(typed.ok, false);
  assert.match(typed.error, /id must be text/);
  const statusType = await tools.find((t) => t.name === "get_atlas_summary").execute({ status: 5 });
  assert.match(statusType.error, /status must be text/);
  const statusOk = await tools.find((t) => t.name === "get_atlas_summary").execute({ status: "mitigated" });
  assert.equal(statusOk.ok, true);
  assert.ok(statusOk.applicable.every((row) => row.status === "mitigated"));
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
  const loading = { getElementById: (id) => id === "demos" ? { textContent: "loading…" } : null };
  const pending = P.demoState(loading, {});
  assert.equal(pending.loading, true);
  assert.match(pending.message, /still loading/);
  assert.ok(pending.demos.length === 7 && pending.demos.every((d) => d.onPage === "still loading"));
  const lab = { getElementById: (id) => id === "xsslab" || id === "demo-xss_lab" || id === "demos" ? { textContent: "" } : null };
  const labState = P.demoState(lab, { id: "xss_lab" });
  assert.equal(labState.demos[0].onPage, true);
  assert.equal(labState.demos[0].hasResult, false);
  const cardOnly = { getElementById: (id) => id === "demo-xss_lab" ? { id: "demo-xss_lab" } : null };
  assert.equal(P.demoState(cardOnly, { id: "xss_lab" }).demos[0].onPage, true);
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
  const home = result.pages.find((p) => p.path === "/");
  assert.match(home.summary, /Sign in/);
});
await ok("type checks reject the wrong kind of value, and the landing guide stays read-only", async () => {
  const tools = P.createTools({ demos: true, architecture: true, landing: true });
  const demo = await tools.find((t) => t.name === "get_demo_catalog").execute({ id: 5 });
  assert.match(demo.error, /id must be text/);
  const omitted = await tools.find((t) => t.name === "get_demo_catalog").execute({});
  assert.equal(omitted.demos.length, 7);
  const section = await tools.find((t) => t.name === "get_architecture_guide").execute({ section: true });
  assert.equal(section.error, "section must be text");
  const all = await tools.find((t) => t.name === "get_architecture_guide").execute({});
  assert.equal(all.sections.length, 4);
  const landing = await tools.find((t) => t.name === "get_landing_guide").execute({});
  assert.equal(landing.ok, true);
  assert.equal(landing.signedIn, false);
  assert.equal(landing.signInNeeded, true);
  assert.ok(landing.links.some((l) => l.path === "/auth/login"));
});
await ok("the page note uses the singular for one tool and names tools that change the page", () => {
  const one = P.statusLine([{ name: "get_site_guide", changesPage: false }]);
  assert.match(one, /1 read-only tool on this page: get_site_guide/);
  assert.doesNotMatch(one, /1 read-only tools/);
  const widget = P.statusLine([
    { name: "set_color", changesPage: true },
    { name: "get_color", changesPage: false },
    { name: "reset_color", changesPage: true },
    { name: "get_site_guide", changesPage: false },
    { name: "get_page_guide", changesPage: false },
  ]);
  assert.match(widget, /3 read-only tools on this page: get_color, get_site_guide, get_page_guide/);
  assert.match(widget, /2 tools change the page: set_color, reset_color/);
});

console.log("CSP and source limits");
await ok("the lab card is detectable and the sandbox comment explains the cross-origin frame", () => {
  const src = fs.readFileSync(new URL("../public/demos.js", import.meta.url), "utf8");
  assert.match(src, /id="demo-xss_lab"/);
  assert.match(src, /id="xsslab"/);
  assert.match(src, /This frame is cross-origin/);
  assert.match(src, /allow-same-origin so the lab page can use its own storage/);
  assert.match(src, /Do not remove allow-scripts or allow-same-origin/);
});
await ok("signed-out /api/lab returns a null token before the sign-in gate", () => {
  const src = fs.readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  const lab = src.indexOf('p === "/api/lab"');
  const gate = src.indexOf("requiresAuth(p)");
  assert.ok(lab > 0 && gate > lab);
  assert.equal(src.split('p === "/api/lab"').length - 1, 1);
  const signedOut = src.slice(lab, src.indexOf("signLabToken", lab));
  assert.match(signedOut, /!sess/);
  assert.match(signedOut, /token:\s*null/);
  assert.match(src, /if \(!sess && requiresAuth\(p\)\) return send\(res, 401, \{ error: "sign in first" \}\)/);
  assert.ok(src.indexOf('p === "/robots.txt"') < gate);
  assert.ok(src.indexOf('p === "/sitemap.xml"') < gate);
  assert.ok(src.indexOf('p === "/llms.txt"') < gate);
  assert.ok(src.indexOf('p === "/.well-known/webmcp"') < gate);
  assert.ok(src.indexOf('p === "/search"') < gate);
});
await ok("the page-tools guide matches the tools and says Chrome 156 drops outputSchema", () => {
  const html = fs.readFileSync(new URL("../public/widget/webmcp.html", import.meta.url), "utf8");
  assert.match(html, /get_landing_guide/);
  assert.match(html, /needs-human, and not-applicable/);
  assert.match(html, /id wins/);
  assert.match(html, /Chrome 156 does not pass <code>outputSchema<\/code> on/);
  assert.match(html, /#1f6feb/);
  assert.match(html, /#3366ff is only a sample/);
  assert.match(html, /color field description is short/);
  assert.match(html, /allowed names/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /\sstyle=/i);
});
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
    const metaCsp = html.match(/Content-Security-Policy" content="([^"]+)"/);
    if (metaCsp) {
      assert.doesNotMatch(metaCsp[1], /unsafe-inline/, file);
      assert.match(metaCsp[1], /script-src 'self'/, file);
    }
    assert.match(html, /rel="webmcp" href="\/\.well-known\/webmcp"/, file);
    assert.match(html, /<form\b[^>]*\btoolname="find_site_page"[^>]*>/, file);
    assert.match(html, new RegExp('tooldescription="' + FIND_PAGE_TOOL.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"'), file);
    assert.match(html, new RegExp('toolaction="' + FIND_PAGE_TOOL.toolaction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"'), file);
    assert.match(html, /<label\b[^>]*\bfor="site-find-q"/, file);
    assert.match(html, /<input\b[^>]*\bname="q"[^>]*\btoolparamdescription="/, file);
    const qDesc = FIND_PAGE_TOOL.inputSchema.properties.q.description;
    assert.ok(html.includes('toolparamdescription="' + qDesc + '"'), file);
  }
});

console.log("Public discovery files");
const PUBLIC_PATHS = ["/", "/gotchas", "/architecture", "/demos", "/widget/", "/widget/webmcp.html", "/widget/storage.html", "/widget/xss.html", "/widget/openrouter.html", "/widget/privacy.html"];
await ok("sitemap and llms.txt come from the public page list and the real tool registrations", () => {
  const pages = publicPages();
  assert.deepEqual(pages.map((p) => p.path), PUBLIC_PATHS);
  assert.equal(pages.some((p) => /chrome-eval/i.test(p.path)), false);
  const map = sitemapXml();
  assert.match(map, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.equal(map.match(/<loc>/g).length, PUBLIC_PATHS.length);
  for (const p of PUBLIC_PATHS) assert.ok(map.includes("https://copilot-sdk.demo.curiosta.com" + (p === "/" ? "/" : p)), p);
  assert.equal(map.includes("chrome-eval"), false);
  const robots = robotsTxt();
  assert.match(robots, /Allow: \/\nDisallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/copilot-sdk\.demo\.curiosta\.com\/sitemap\.xml/);
  const llms = llmsTxt();
  assert.match(llms, /^# Browser Tutor\n\n> This site shows what your browser tells a website/);
  for (const p of PUBLIC_PATHS) assert.ok(llms.includes("https://copilot-sdk.demo.curiosta.com" + (p === "/" ? "/" : p)), p);
  const tools = webmcpTools();
  assert.ok(tools.length >= 14);
  for (const t of tools) {
    assert.match(t.line, /\w/);
    assert.ok(llms.includes(t.name), t.name);
    assert.ok(llms.includes(t.line), t.name);
  }
  for (const name of ["get_site_guide", "get_landing_guide", "set_color", "get_color", "reset_color", "lookup_gotcha"]) assert.ok(tools.some((t) => t.name === name), name);
  assert.match(llms, /\/\.well-known\/webmcp/);
  assert.match(llms, /find_site_page/);
  assert.match(llms, /set_color_form/);
  const manifest = webmcpManifest();
  assert.equal(manifest.name, "Browser Tutor");
  assert.match(manifest.description, /what your browser tells a website/);
  assert.equal(manifest.url, "https://copilot-sdk.demo.curiosta.com/");
  assert.match(manifest.version, /\d/);
  assert.match(manifest.spec, /not a formal standard/);
  assert.deepEqual(manifest.pages.map((p) => p.path), PUBLIC_PATHS);
  const listed = new Map();
  for (const page of manifest.pages) {
    assert.equal(page.url, "https://copilot-sdk.demo.curiosta.com" + (page.path === "/" ? "/" : page.path));
    assert.ok(page.tools.some((t) => t.name === "find_site_page" && t.source === "declarative" && t.annotations.readOnlyHint === true && t.annotations.changesPage === false), page.path);
    for (const tool of page.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
      assert.equal(tool.annotations.changesPage, !tool.annotations.readOnlyHint);
      listed.set(tool.name, tool);
    }
  }
  for (const tool of tools) {
    const row = listed.get(tool.name);
    assert.ok(row, tool.name);
    assert.equal(row.description.length > tool.line.length - 1, true, tool.name);
    assert.ok(row.description.startsWith(tool.line.replace(/\.$/, "")) || row.description.includes(tool.line.replace(/\.$/, "")), tool.name);
  }
  for (const spec of Object.values(P.SPECS)) {
    const row = listed.get(spec.name);
    assert.equal(row.description, spec.description, spec.name);
    assert.equal(JSON.stringify(row.inputSchema), JSON.stringify(spec.inputSchema), spec.name);
    assert.equal(row.annotations.changesPage, false, spec.name);
  }
  const color = load("../public/widget/color-tools.js").__btwColor;
  for (const spec of color.TOOL_SPECS) {
    const row = listed.get(spec.name);
    assert.equal(row.description, spec.description, spec.name);
    assert.equal(JSON.stringify(row.inputSchema), JSON.stringify(spec.inputSchema), spec.name);
    assert.equal(row.annotations.changesPage, !spec.readOnly, spec.name);
  }
  const colorForm = listed.get("set_color_form");
  assert.equal(colorForm.description, SET_COLOR_FORM_TOOL.description);
  assert.equal(colorForm.annotations.changesPage, true);
  assert.equal(manifest.pages.find((p) => p.path === "/widget/").tools.some((t) => t.name === "set_color_form"), true);
  assert.equal(manifest.pages.filter((p) => p.path !== "/widget/").every((p) => !p.tools.some((t) => t.name === "set_color")), true);
  assert.equal(JSON.stringify(searchPublicPages("privacy").map((p) => p.path)), JSON.stringify(["/widget/privacy.html"]));
  assert.equal(JSON.stringify(searchPublicPages("")), "[]");
  assert.equal(P.searchPages("color").some((p) => p.path === "/widget/"), true);
  const widgetHtml = fs.readFileSync(new URL("../public/widget/index.html", import.meta.url), "utf8");
  assert.match(widgetHtml, /toolname="set_color_form"/);
  assert.match(widgetHtml, /agentinvoked/);
  assert.match(widgetHtml, /data-confirm=/);
  assert.match(widgetHtml, /data-requires-confirmation=/);
  assert.match(widgetHtml, /data-human-in-the-loop="set_color reset_color"/);
  assert.match(widgetHtml, /<label\b[^>]*\bfor="color-text"/);
  assert.match(widgetHtml, /<input\b[^>]*\bname="color"/);
  assert.match(widgetHtml, /<label\b[^>]*\bfor="color-picker"/);
  assert.match(widgetHtml, /<input\b[^>]*\bclass="cp-input"[^>]*\bname="picked"/);
  assert.match(fs.readFileSync(new URL("../public/widget.js", import.meta.url), "utf8"), /rem\.name = "remember"/);
  assert.match(fs.readFileSync(new URL("../public/chrome-eval.js", import.meta.url), "utf8"), /window\.ai/);
  assert.doesNotMatch(fs.readFileSync(new URL("../public/chrome-eval.js", import.meta.url), "utf8"), /window\.ai\s*=/);
  const serverSrc = fs.readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(serverSrc, /unsafe-inline/);
  assert.match(serverSrc, /script-src 'self'/);
});

await ok("missing paths are 404, protected routes stay 401, and discovery files need no auth", async () => {
  const port = 18765;
  const base = `http://127.0.0.1:${port}`;
  const root = fileURLToPath(new URL("..", import.meta.url));
  let log = "";
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HOST: "127.0.0.1",
      PORT: String(port),
      BASE_URL: base,
      NODE_ENV: "test",
      SESSION_SECRET: "unit-test-session-secret-0123456789abcdef",
      DEV_AUTH_BYPASS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const stop = () => { if (!child.killed) child.kill("SIGTERM"); };
  try {
    const deadline = Date.now() + 8000;
    let up = false;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error("server exited\n" + log);
      try {
        const health = await fetch(base + "/healthz");
        if (health.status === 200) { up = true; break; }
      } catch { /* still starting */ }
      await new Promise((r) => setTimeout(r, 40));
    }
    if (!up) throw new Error("server did not listen\n" + log);
    const headersOf = (res) => {
      assert.match(res.headers.get("content-security-policy") || "", /default-src/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("referrer-policy"), "same-origin");
    };
    const missing = await fetch(base + "/this-page-does-not-exist");
    headersOf(missing);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type") || "", /^text\/plain/);
    const missingBody = await missing.text();
    assert.ok(missingBody.length < 80, missingBody);
    assert.match(missingBody, /^Not found\s*$/);
    const typo = await fetch(base + "/robot.txt");
    assert.equal(typo.status, 404);
    assert.match(await typo.text(), /^Not found\s*$/);
    const unknownApi = await fetch(base + "/api/not-a-real-route");
    assert.equal(unknownApi.status, 404);
    const me = await fetch(base + "/api/me");
    headersOf(me);
    assert.equal(me.status, 401);
    assert.deepEqual(await me.json(), { error: "sign in first" });
    const chat = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}" });
    assert.equal(chat.status, 401);
    assert.deepEqual(await chat.json(), { error: "sign in first" });
    const lab = await fetch(base + "/api/lab");
    headersOf(lab);
    assert.equal(lab.status, 200);
    assert.deepEqual(await lab.json(), { token: null });
    const robots = await fetch(base + "/robots.txt");
    headersOf(robots);
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get("content-type") || "", /^text\/plain/);
    assert.equal(await robots.text(), robotsTxt());
    const sitemap = await fetch(base + "/sitemap.xml");
    headersOf(sitemap);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get("content-type") || "", /^application\/xml/);
    assert.equal(await sitemap.text(), sitemapXml());
    const llms = await fetch(base + "/llms.txt");
    headersOf(llms);
    assert.equal(llms.status, 200);
    assert.match(llms.headers.get("content-type") || "", /^text\/plain/);
    assert.equal(await llms.text(), llmsTxt());
    const manifestRes = await fetch(base + "/.well-known/webmcp");
    headersOf(manifestRes);
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers.get("content-type") || "", /^application\/json/);
    assert.doesNotMatch(manifestRes.headers.get("content-security-policy") || "", /unsafe-inline/);
    assert.match(manifestRes.headers.get("content-security-policy") || "", /script-src 'self'/);
    const manifestBody = await manifestRes.json();
    assert.deepEqual(manifestBody, webmcpManifest());
    const manifestNames = new Set(manifestBody.pages.flatMap((p) => p.tools.map((t) => t.name)));
    for (const tool of webmcpTools()) assert.ok(manifestNames.has(tool.name), tool.name);
    assert.ok(manifestNames.has("find_site_page"));
    assert.ok(manifestNames.has("set_color_form"));
    const search = await fetch(base + "/search?q=privacy");
    headersOf(search);
    assert.equal(search.status, 200);
    assert.match(search.headers.get("content-type") || "", /^application\/json/);
    assert.equal(JSON.stringify(await search.json()), JSON.stringify({ query: "privacy", pages: searchPublicPages("privacy") }));
    const home = await fetch(base + "/");
    headersOf(home);
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /toolname="find_site_page"/);
    assert.match(homeHtml, /tooldescription="/);
    assert.match(homeHtml, /toolaction="/);
    assert.doesNotMatch(home.headers.get("content-security-policy") || "", /unsafe-inline/);
    const login = await fetch(base + "/auth/dev", { method: "POST", headers: { Origin: base } });
    assert.equal(login.status, 200);
    const setCookie = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")];
    const cookie = (setCookie.find((c) => c && c.startsWith("bt_sess=")) || "").split(";")[0];
    assert.match(cookie, /^bt_sess=/);
    const signedMissing = await fetch(base + "/still-not-a-page", { headers: { cookie } });
    assert.equal(signedMissing.status, 404);
    assert.match(await signedMissing.text(), /^Not found\s*$/);
    const signedMe = await fetch(base + "/api/me", { headers: { cookie } });
    assert.equal(signedMe.status, 200);
    const gotchas = await fetch(base + "/api/gotchas");
    assert.equal(gotchas.status, 200);
  } finally {
    stop();
  }
});

console.log(`\nPAGE TOOLS UNIT TESTS PASSED (${pass})`);
