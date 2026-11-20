// Headless E2E for read-only WebMCP tools on every public page.
// Needs the dev server (DEV_AUTH_BYPASS=1). Run: node scripts/page-tools-e2e.mjs [baseUrl]
// Checks registration, a real executeTool call, CSP, and that cookies, keys, and chat text never come back.
import puppeteer from "puppeteer-core";
const BASE = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080").replace(/\/$/, "");
let fail = 0;
const must = (cond, msg) => { if (!cond) { fail++; console.log("  FAIL -", msg); } else console.log("  ok -", msg); };
const SECRET = /CHATSECRET999|SECRETKEY999|COOKIESECRET999/;

function watch(p) {
  const bad = [];
  p.on("console", (e) => { if (e.type() === "error" || /content security|refused to/i.test(e.text())) bad.push(e.type() + ": " + e.text()); });
  p.on("pageerror", (e) => bad.push("pageerror: " + (e.message || e)));
  return bad;
}
async function prep(p) {
  await p.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "")));
    try { localStorage.setItem("bt_chat", JSON.stringify({ messages: [{ text: "CHATSECRET999" }] })); } catch (e) {}
    try { sessionStorage.setItem("btw_or_key", "sk-or-v1-SECRETKEY999"); } catch (e) {}
  });
}
async function ready(p) {
  await p.waitForFunction(() => window.__btwPageWebMCP && window.__btwPageWebMCP.status === "registered", { timeout: 15000 });
}
async function exec(p, name, input) {
  return p.evaluate(async (name, input) => {
    const tools = await document.modelContext.getTools();
    const t = tools.find((x) => x.name === name);
    if (!t) return { missing: name, names: tools.map((x) => x.name) };
    const ann = t.annotations || {};
    const raw = await document.modelContext.executeTool(t, input);
    const result = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      result, readOnly: ann.readOnlyHint, consequential: ann.consequentialHint,
      output: !!(window.__btwPageTools || []).find((x) => x.name === name && x.outputSchema),
      csp: window.__csp || [],
      note: (document.getElementById("page-tools-status") || {}).textContent || "",
    };
  }, name, input);
}

console.log("WebMCP on — every public page");
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--enable-features=WebMCP,WebMCPTesting"] });

{
  const p = await b.newPage(); const bad = watch(p); await prep(p);
  await p.goto(BASE + "/", { waitUntil: "networkidle0" }); await ready(p);
  const r = await exec(p, "get_site_guide", {});
  const blob = JSON.stringify(r);
  must(r.result && r.result.ok && r.result.pages.some((x) => x.path === "/gotchas"), "landing guide lists the public pages");
  must(r.readOnly === true && r.consequential === false && r.output === true, "landing tool is read-only with an output schema");
  must(/read-only tools/.test(r.note), "landing shows a status line only because WebMCP is on");
  must(!SECRET.test(blob) && r.csp.length === 0 && bad.length === 0, "landing leaks nothing and breaks no CSP " + (bad[0] || r.csp[0] || ""));
  await p.close();
}

{
  const p = await b.newPage(); const bad = watch(p); await prep(p);
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.waitForSelector("#devLogin", { visible: true, timeout: 10000 });
  await Promise.all([p.waitForNavigation({ waitUntil: "networkidle0" }), p.click("#devLogin")]);
  await p.waitForFunction(() => window.BT && window.BT.fingerprint && document.getElementById("sv") && document.getElementById("sv").textContent.trim().startsWith("{"), { timeout: 15000 });
  await ready(p);
  await p.evaluate(() => { document.cookie = "leak=COOKIESECRET999"; });
  const reveal = await exec(p, "get_browser_reveal", {});
  const conn = await exec(p, "get_connection_reveal", {});
  const blob = JSON.stringify({ reveal, conn });
  must(reveal.result.ok && reveal.result.reveal.userAgent && reveal.result.reveal.pagePath === "/", "probe tool returns the browser reveal already on the page");
  must(conn.result.ok && conn.result.connection && conn.result.connection.headers, "connection tool returns the panel already on the page");
  must(reveal.readOnly === true && conn.consequential === false, "probe tools stay read-only and not consequential");
  must(!SECRET.test(blob), "probe tools do not return the cookie, the key, or the saved chat");
  must((reveal.csp || []).length === 0 && bad.filter((x) => !/Failed to load resource/.test(x)).length === 0, "probe page CSP stays clean " + (bad[0] || ""));
  await p.close();
}

{
  const p = await b.newPage(); const bad = watch(p); await prep(p);
  await p.goto(BASE + "/gotchas", { waitUntil: "networkidle0" }); await ready(p);
  const sum = await exec(p, "get_atlas_summary", {});
  const one = await exec(p, "lookup_atlas_technique", { id: "AML.T0051", query: "prompt injection" });
  const gotcha = await exec(p, "lookup_gotcha", { id: "llm-js-xss", query: "" });
  const blob = JSON.stringify({ sum, one, gotcha });
  must(sum.result.ok && sum.result.meta.version === "2026.10" && sum.result.counts.applicable > 0, "ATLAS summary reports the 2026.10 evaluation");
  must(one.result.ok && one.result.technique.id === "AML.T0051" && /Prompt Injection/.test(one.result.technique.name), "technique lookup returns the public defensive note");
  must(!one.result.technique.exploit && gotcha.result.ok && gotcha.result.gotcha.id === "llm-js-xss", "gotcha lookup returns the public lesson");
  must(!SECRET.test(blob) && sum.csp.length === 0 && bad.length === 0, "gotchas page leaks nothing " + (bad[0] || ""));
  await p.close();
}

{
  const p = await b.newPage(); const bad = watch(p); await prep(p);
  await p.goto(BASE + "/architecture", { waitUntil: "networkidle0" }); await ready(p);
  const r = await exec(p, "get_architecture_guide", { section: "req" });
  must(r.result.ok && r.result.sections.length === 1 && r.result.sections[0].id === "req", "architecture guide returns the request-flow section");
  must(!SECRET.test(JSON.stringify(r)) && r.csp.length === 0 && bad.length === 0, "architecture page leaks nothing " + (bad[0] || ""));
  await p.close();
}

{
  const p = await b.newPage(); const bad = watch(p); await prep(p);
  await p.goto(BASE + "/demos", { waitUntil: "networkidle0" });
  await p.waitForSelector("#out-storage_inspector", { timeout: 15000 });
  await p.evaluate(() => { document.getElementById("out-storage_inspector").textContent = "preview CHATSECRET999 sk-or-v1-SECRETKEY999"; });
  await ready(p);
  const cat = await exec(p, "get_demo_catalog", { id: "storage_inspector" });
  const state = await exec(p, "read_demo_state", { id: "storage_inspector" });
  const blob = JSON.stringify({ cat, state });
  must(cat.result.ok && cat.result.demos[0].id === "storage_inspector" && cat.result.demos[0].needsPermission === false, "demo catalog returns the public demo");
  must(state.result.ok && state.result.demos[0].hasResult === true && state.result.demos[0].onPage === true, "demo state sees that a result is on screen");
  must(!SECRET.test(blob), "demo state does not return the on-screen text or any stored secret");
  must(cat.csp.length === 0 && bad.length === 0, "demos page CSP stays clean " + (bad[0] || ""));
  await p.close();
}

for (const [url, heading] of [["/widget/", "color"], ["/widget/storage.html", "OpenRouter key"], ["/widget/xss.html", "XSS"], ["/widget/openrouter.html", "pays"], ["/widget/privacy.html", "Privacy"], ["/widget/webmcp.html", "browser assistants"], ["/widget/chrome-eval.html", "quality check"]]) {
  const p = await b.newPage(); const bad = watch(p); await prep(p);
  await p.goto(BASE + url, { waitUntil: "networkidle0" }); await ready(p);
  const r = await exec(p, "get_page_guide", {});
  const blob = JSON.stringify(r);
  must(r.result && r.result.ok && r.result.page.headings.some((h) => h.toLowerCase().includes(heading.toLowerCase())), url + " guide lists a heading (" + heading + ")");
  must(r.readOnly === true && r.consequential === false, url + " guide is read-only");
  must(!SECRET.test(blob) && (r.csp || []).length === 0 && bad.filter((x) => !/Failed to load resource/.test(x)).length === 0, url + " leaks nothing and breaks no CSP " + (bad[0] || ""));
  await p.close();
}
await b.close();

console.log("WebMCP off — the page still works and adds no status line");
const plain = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
{
  const p = await plain.newPage(); const bad = watch(p); await prep(p);
  await p.goto(BASE + "/gotchas", { waitUntil: "networkidle0" });
  await p.waitForFunction(() => window.__btwPageWebMCP && window.__btwPageWebMCP.status === "unavailable", { timeout: 15000 });
  const s = await p.evaluate(() => ({ note: !!document.getElementById("page-tools-status"), h1: document.querySelector("h1").textContent, csp: window.__csp || [] }));
  must(!s.note && /gotchas/i.test(s.h1), "without WebMCP the gotchas page is unchanged");
  must(s.csp.length === 0 && bad.length === 0, "without WebMCP there is still no CSP error " + (bad[0] || ""));
  await p.close();
}
await plain.close();
console.log(fail ? `\n${fail} FAILED` : "\nPAGE TOOLS E2E PASSED");
process.exit(fail ? 1 : 0);
