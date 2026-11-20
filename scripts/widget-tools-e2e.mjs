// Headless E2E for the /widget/ color picker tool-call demo and WebMCP registration.
// Phase 1 (normal Chrome, mocked OpenRouter, no real key): page loads with no console errors / CSP violations,
//   WebMCP note explains how to try it, a chat message triggers tool_calls -> the color changes -> results are
//   sent back -> final reply; the chat shows the tool trace. A widget page WITHOUT data-tools sends no tools key.
// Phase 2 (Chrome with --enable-features=WebMCP,WebMCPTesting): document.modelContext has the page tools; executeTool
//   changes the color; invalid input returns an error and changes nothing.
// Screenshots: docs/widget-tools-chat.png, docs/widget-tools-webmcp.png (also copied to /workspace/).
// Run: node scripts/widget-tools-e2e.mjs [baseUrl]   (default http://localhost:8080)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
const BASE = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080").replace(/\/$/, "");
const PAGE = BASE + "/widget/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const must = (cond, msg) => { if (!cond) { fail++; console.log("  FAIL -", msg); } else console.log("  ok -", msg); };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, http-referer, x-title", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const C_NAMES = ["black", "white", "gray", "silver", "red", "maroon", "orange", "gold", "yellow", "olive", "lime", "green", "teal", "cyan", "skyblue", "blue", "navy", "indigo", "purple", "violet", "magenta", "pink", "hotpink", "coral", "tomato", "salmon", "brown", "chocolate", "tan", "beige", "rebeccapurple"];
const tc = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

function watch(p) {
  const bad = [];
  p.on("console", (e) => { if (e.type() === "error" || /content security|refused to/i.test(e.text())) bad.push(e.type() + ": " + e.text()); });
  p.on("pageerror", (e) => bad.push("pageerror: " + (e.message || e)));
  return bad;
}
async function mockOpenRouter(p, onChat) {
  await p.setRequestInterception(true);
  p.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith("https://openrouter.ai/")) return req.continue();
    if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (u === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(req.postData() || "{}"); const r = onChat(body);
      return req.respond({ status: 200, headers: CORS, contentType: r.type, body: r.body });
    }
    return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: "{}" });
  });
  await p.evaluateOnNewDocument(() => { sessionStorage.setItem("btw_or_key", "sk-or-v1-MOCKKEY0000"); sessionStorage.setItem("btw_provider", "openrouter"); });
}

// ---------------- Phase 1 ----------------
console.log("Phase 1 — normal Chrome (no WebMCP), mocked OpenRouter tool calls");
let b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let p = await b.newPage(); await p.setViewport({ width: 1100, height: 900 });
const bad1 = watch(p); const bodies = [];
await mockOpenRouter(p, (body) => {
  bodies.push(body);
  if (bodies.length === 1) return { type: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [tc("call_a", "set_color", { color: "teal" }), tc("call_b", "set_color", { color: "<img src=x onerror=alert(1)>" })] } }] }) };
  return { type: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done. The color is now teal." } }] }) };
});
await p.goto(PAGE, { waitUntil: "networkidle0" });
await p.waitForFunction(() => !!window.__btwUI && !!window.__btwColorUI, { timeout: 15000 });
const s1 = await p.evaluate(() => ({ color: document.getElementById("color-demo").dataset.color, bg: getComputedStyle(document.querySelector(".cp-swatch")).backgroundColor,
  status: document.getElementById("webmcp-status").textContent, mc: "modelContext" in document, tools: (window.btwPageTools || []).map((t) => t.name), wm: window.__btwColorWebMCP && window.__btwColorWebMCP.status }));
must(s1.color === "#1f6feb" && s1.bg === "rgb(31, 111, 235)", "swatch renders the default color");
must(!s1.mc && s1.wm === "unavailable", "no modelContext in normal Chrome -> WebMCP 'unavailable', page still works");
must(/chrome:\/\/flags\/#enable-webmcp-testing/.test(s1.status) && /Chrome 146/.test(s1.status), "WebMCP note explains how to try it (flag + version)");
must(s1.tools.join() === "set_color,get_color,reset_color,get_site_guide,get_page_guide", "window.btwPageTools exposes the color tools and the read-only guides");
await p.click('#color-demo button[data-tool="reset_color"]'); await sleep(100);
must(await p.evaluate(() => /You called reset_color/.test(document.querySelector(".cp-log").textContent)), "Reset button runs reset_color and logs it");
await p.click(".btw-fab"); await sleep(300);
await p.evaluate(() => { document.querySelector(".btw-input").value = "Make the color teal"; window.__btwUI.submit(); });
await p.waitForFunction(() => { const m = [...document.querySelectorAll(".btw-assistant")].pop(); return m && /now teal/.test(m.textContent); }, { timeout: 10000 });
await sleep(200);
const s2 = await p.evaluate(() => ({ color: document.getElementById("color-demo").dataset.color, bg: getComputedStyle(document.querySelector(".cp-swatch")).backgroundColor,
  picker: document.querySelector(".cp-input").value, traces: [...document.querySelectorAll(".btw-tool")].map((t) => t.textContent),
  traceHTML: [...document.querySelectorAll(".btw-tool")].some((t) => t.querySelector("script,img,a")), log: document.querySelector(".cp-log").textContent }));
must(s2.color === "#008080" && s2.bg === "rgb(0, 128, 128)" && s2.picker === "#008080", "model's tool call changed the swatch and the picker to teal");
must(s2.traces.length === 2 && /Tool call: set_color/.test(s2.traces[0]) && /"color":"teal"/.test(s2.traces[0]) && /Result: ok:/.test(s2.traces[0]) && /Result: error: Not a valid color/.test(s2.traces[1]), "chat shows a trace per call (name, arguments, ok / error result)");
must(!s2.traceHTML, "hostile arguments shown as text only (no <img> node)");
must(/Chat widget called set_color/.test(s2.log), "page log credits the chat widget");
must(bodies.length === 2, "two requests: tool round + final answer (got " + bodies.length + ")");
must(bodies.every((x) => Array.isArray(x.tools) && x.tools.length === 5 && x.stream === false), "every request carries the 5 tools, non-streaming");
const colorFn = bodies[0].tools.find((t) => t.function.name === "set_color").function;
must(!JSON.stringify(colorFn).includes("examples") && !JSON.stringify(colorFn).includes("oneOf") && colorFn.outputSchema === undefined, "OpenRouter payload drops inspector keywords and outputSchema");
must(C_NAMES.every((n) => colorFn.parameters.properties.color.description.includes(n)), "OpenRouter color description still lists every allowed name");
must(/page offers tools/.test(bodies[0].messages[0].content), "system prompt includes the tool rule");
const tail = bodies[1].messages.slice(-3);
must(tail[0].role === "assistant" && tail[0].tool_calls.length === 2 && tail[1].tool_call_id === "call_a" && JSON.parse(tail[1].content).ok === true && JSON.parse(tail[2].content).ok === false,
  "second request sends the assistant tool_calls + one role:tool result per call");
await p.screenshot({ path: "docs/widget-tools-chat.png" });
must(bad1.length === 0, "no console errors, page errors or CSP violations " + (bad1[0] || ""));
// tool-incapable model -> friendly message, chart untouched
bodies.length = 0;
await p.close(); p = await b.newPage(); const bad1b = watch(p);
await mockOpenRouter(p, () => ({ type: "application/json", body: JSON.stringify({ error: { code: 404, message: "No endpoints found that support tool use." } }) }));
await p.goto(PAGE, { waitUntil: "networkidle0" }); await p.waitForFunction(() => !!window.__btwUI && !!window.__btwColorUI);
await p.evaluate(() => { document.querySelector(".btw-fab").click(); document.querySelector(".btw-input").value = "Make it red"; window.__btwUI.submit(); });
await p.waitForFunction(() => { const m = [...document.querySelectorAll(".btw-assistant")].pop(); return m && /cannot use the page tools/.test(m.textContent); }, { timeout: 10000 }).then(() => must(true, "tool-incapable model -> friendly error"), () => must(false, "tool-incapable model -> friendly error"));
must(await p.evaluate(() => document.getElementById("color-demo").dataset.color === "#1f6feb"), "color unchanged after the error");
must(bad1b.filter((x) => !/404|Failed to load resource/.test(x)).length === 0, "no unexpected errors on the error path " + (bad1b[0] || ""));
// default-off: another widget page without data-tools streams with no tools key
await p.close(); p = await b.newPage(); const offBodies = [];
await mockOpenRouter(p, (body) => { offBodies.push(body); return { type: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":"Plain answer."}}]}\n\ndata: [DONE]\n\n' }; });
await p.goto(BASE + "/widget/storage.html", { waitUntil: "networkidle0" }); await p.waitForFunction(() => !!window.__btwUI);
const hasAttr = await p.evaluate(() => !!document.querySelector("script[data-tools]"));
await p.evaluate(() => { document.querySelector(".btw-fab").click(); document.querySelector(".btw-input").value = "Where is my key?"; window.__btwUI.submit(); });
await p.waitForFunction(() => { const m = [...document.querySelectorAll(".btw-assistant")].pop(); return m && /Plain answer/.test(m.textContent); }, { timeout: 10000 });
must(!hasAttr && offBodies.length === 1 && !("tools" in offBodies[0]) && offBodies[0].stream === true && !/page offers tools/.test(offBodies[0].messages[0].content),
  "page without data-tools: one streaming request, no tools key, no tool prompt (unchanged)");
await b.close();

// ---------------- Phase 2 ----------------
console.log("Phase 2 — Chrome with WebMCP testing enabled (--enable-features=WebMCPTesting)");
b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--enable-features=WebMCP,WebMCPTesting"] });
p = await b.newPage(); await p.setViewport({ width: 1100, height: 900 }); const bad2 = watch(p);
await p.goto(PAGE, { waitUntil: "networkidle0" });
await p.waitForFunction(() => window.__btwColorWebMCP && window.__btwColorWebMCP.status !== "pending" && window.__btwPageWebMCP && window.__btwPageWebMCP.status !== "pending", { timeout: 15000 }).catch(() => {});
const w = await p.evaluate(async () => {
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
  const parse = (v) => typeof v === "string" ? JSON.parse(v) : v;
  const mc = document.modelContext, out = { has: !!mc, nav: "modelContext" in navigator, status: window.__btwColorWebMCP && window.__btwColorWebMCP.status, pageStatus: window.__btwPageWebMCP && window.__btwPageWebMCP.status };
  if (!mc) return out;
  const tools = await mc.getTools(); out.names = tools.map((t) => t.name).sort();
  const t = tools.find((x) => x.name === "set_color");
  const pageTool = (window.btwPageTools || []).find((x) => x.name === "set_color");
  out.readOnly = (tools.find((x) => x.name === "get_color").annotations || {}).readOnlyHint;
  out.consequential = (tools.find((x) => x.name === "set_color").annotations || {}).consequentialHint;
  out.guideReadOnly = (tools.find((x) => x.name === "get_page_guide").annotations || {}).readOnlyHint;
  out.sample = inspectorTemplate(pageTool.inputSchema);
  out.namesInSchema = pageTool.inputSchema.properties.color.oneOf[1].enum.length;
  out.pageOutput = !!pageTool.outputSchema;
  out.chromeOutput = t.outputSchema ? Object.keys(t.outputSchema) : null;
  out.good = parse(await mc.executeTool(t, { color: "#ff8800" })); out.afterGood = document.getElementById("color-demo").dataset.color;
  out.bad = parse(await mc.executeTool(t, { color: "red; background:url(x)" })); out.afterBad = document.getElementById("color-demo").dataset.color;
  out.get = parse(await mc.executeTool(tools.find((x) => x.name === "get_color"), {}));
  out.templated = parse(await mc.executeTool(t, out.sample)); out.afterTemplate = document.getElementById("color-demo").dataset.color;
  out.guide = parse(await mc.executeTool(tools.find((x) => x.name === "get_page_guide"), {}));
  out.statusText = document.getElementById("webmcp-status").textContent; out.statusCls = document.getElementById("webmcp-status").className;
  out.note = (document.getElementById("page-tools-status") || {}).textContent || "";
  out.log = document.querySelector(".cp-log").textContent;
  return out;
});
must(w.has && !w.nav, "document.modelContext exists (navigator.modelContext does not in this Chrome)");
must(w.status === "registered" && w.pageStatus === "registered", "color tools and page tools both register (" + w.status + " / " + w.pageStatus + ")");
must(JSON.stringify(w.names) === '["get_color","get_page_guide","get_site_guide","reset_color","set_color"]', "getTools() lists the color tools and the read-only guides");
must(w.readOnly === true && w.guideReadOnly === true, "get_color and get_page_guide are annotated readOnlyHint");
must(w.consequential === false, "set_color consequentialHint is false (" + w.consequential + ")");
must(w.namesInSchema === 31 && w.pageOutput === true, "set_color input lists 31 names and the page tool carries outputSchema");
must(JSON.stringify(w.sample) === '{"color":"#3366ff"}', "inspector template for set_color is #3366ff");
must(w.good.ok === true && w.afterGood === "#ff8800", "executeTool(set_color,{color:'#ff8800'}) changes the swatch");
must(w.bad.ok === false && /Not a valid color/.test(w.bad.error) && Array.isArray(w.bad.allowedNames) && w.bad.allowedNames.length === 31 && w.afterBad === "#ff8800", "invalid input returns an error, the name list, and changes nothing");
must(w.get.ok === true && w.get.swatch.color === "#ff8800", "get_color reads the current color");
must(w.templated.ok === true && w.afterTemplate === "#3366ff", "inspector sample input changes the swatch to #3366ff");
must(w.guide.ok === true && /[Kk]eys, cookies/.test(w.guide.message), "get_page_guide runs and says it does not read keys or cookies");
must(/3 read-only tools/.test(w.note) && /2 tools change the page/.test(w.note) && /set_color/.test(w.note) && /reset_color/.test(w.note) && /get_color/.test(w.note) && !/cookie=|sk-or-/.test(w.note), "status line counts every tool and names the ones that change the page");
must(/WebMCP is on/.test(w.statusText) && /wm-on/.test(w.statusCls), "status text says WebMCP is on");
must(/WebMCP agent called set_color/.test(w.log), "page log credits the WebMCP agent");
await p.evaluate(() => document.getElementById("color-demo").scrollIntoView({ block: "start" }));
await p.screenshot({ path: "docs/widget-tools-webmcp.png" });
must(bad2.length === 0, "no console errors with WebMCP on " + (bad2[0] || ""));
// mobile layout check
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await p.goto(PAGE, { waitUntil: "networkidle0" });
const mob = await p.evaluate(() => ({ over: document.documentElement.scrollWidth > document.documentElement.clientWidth, w: document.querySelector("#color-demo .cp-swatch").getBoundingClientRect().width }));
must(!mob.over && mob.w > 250, "390px: no horizontal overflow, swatch fits (" + Math.round(mob.w) + "px)");
await p.evaluate(() => document.getElementById("color-demo").scrollIntoView({ block: "start" }));
await p.screenshot({ path: "docs/widget-tools-mobile.png" });
await b.close();
for (const f of ["widget-tools-chat.png", "widget-tools-webmcp.png", "widget-tools-mobile.png"]) {
  try { fs.copyFileSync("docs/" + f, "/workspace/" + f); } catch (e) { /* artifact directory is optional */ }
}
console.log(fail ? `\n${fail} FAILED` : "\nWIDGET TOOLS E2E PASSED");
process.exit(fail ? 1 : 0);
