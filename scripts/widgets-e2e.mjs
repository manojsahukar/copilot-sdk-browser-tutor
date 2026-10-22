// Headless E2E for dashboard widgets under the app's strict CSP (script-src 'self', style-src 'self', no unsafe-eval).
// Needs the local dev server (DEV_AUTH_BYPASS=1) on :8080. Run: node scripts/widgets-e2e.mjs [--agent]
//   default: deterministic update-in-place flow (chat SSE replayed with REAL server-validated spec + data)
//   --agent: additionally drive the REAL agent (render, then edit) and capture before/after screenshots
import puppeteer from "puppeteer-core";
const BASE = "http://localhost:8080";
const AGENT = process.argv.includes("--agent");
let fails = 0; const must = (c, m) => { console.log((c ? "  ok - " : "  FAIL - ") + m); if (!c) fails++; };
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const MOBILE = { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Mobile Safari/537.36" };
const DESKTOP = { viewport: { width: 1366, height: 900, deviceScaleFactor: 1 }, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36" };

async function page(dev) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.emulate(dev);
  const errors = []; p.on("pageerror", (e) => errors.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(401|404)/.test(m.text())) errors.push(m.text()); });
  await p.evaluateOnNewDocument(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample || ""))); });
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.click("#devLogin"); await p.waitForNavigation({ waitUntil: "networkidle0" });
  await p.waitForFunction(() => window.BTW && document.querySelector("#me .login"), { timeout: 15000 });
  return { p, errors, ctx };
}
const csp = (p) => p.evaluate(() => window.__csp.slice());
const cspHeader = async (p) => (await p.goto(BASE + "/static/widgets.js").then(() => null), (await (await fetch(BASE + "/healthz")).headers.get("content-security-policy")));
const tab = async (p, name) => { await p.click(`[data-tab="${name}"]`); await new Promise((r) => setTimeout(r, 200)); };
const waitCards = (p, root, n, charts) => p.waitForFunction((root, n, charts) => {
  const cs = document.querySelectorAll(`#${root} .wcard`); if (cs.length < n) return false;
  if ([...cs].some((c) => c.querySelector(".w-empty") && c.querySelector(".w-empty").textContent === "loading…")) return false;
  return document.querySelectorAll(`#${root} .w-chart canvas`).length >= charts;
}, { timeout: 45000 }, root, n, charts);

for (const [name, dev] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
  console.log(`\n== ${name} (${dev.viewport.width}x${dev.viewport.height})`);
  const { p, errors, ctx } = await page(dev);
  const hdr = await p.evaluate(() => fetch("/api/me").then((r) => r.headers.get("content-security-policy")));
  must(/script-src 'self';/.test(hdr) && !/unsafe-eval|unsafe-inline/.test(hdr), "app CSP unchanged: script-src 'self', no unsafe-eval / unsafe-inline");
  must(await p.evaluate(() => !window.echarts && ![...document.scripts].some((s) => s.src.includes("echarts"))), "chart library NOT loaded on the probe tab (lazy)");
  // Health board: status tiles, uptime table, latency + availability charts, incidents
  await tab(p, "health"); await waitCards(p, "healthBoard", 5, 1);
  const h = await p.evaluate(() => ({ cards: [...document.querySelectorAll("#healthBoard .wcard")].map((c) => c.dataset.widget), tiles: document.querySelectorAll("#healthBoard .w-tile").length, uptimeRows: document.querySelectorAll("#healthBoard .w-table tr").length, echarts: !!window.echarts, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
  must(h.cards.join() === "health-status,health-uptime,health-latency,health-availability,health-incidents", "health board has status, uptime, latency, availability, incidents widgets");
  must(h.tiles === 4, "4 endpoint status tiles (main, readyz, sibling, xss-lab)");
  must(h.uptimeRows >= 5, "uptime table rendered (24h/7d/30d per endpoint + derived rows)");
  must(h.echarts, "chart library lazy-loaded once a chart widget rendered");
  must(!h.overflow, "no horizontal overflow");
  await p.screenshot({ path: `docs/widgets-health-${name}.png`, fullPage: true });
  // Metrics board: add every preset (line, dual-axis, stacked, bar, threshold)
  await tab(p, "metrics");
  const presets = await p.$$("#metricPresets .chip"); for (const c of presets) await c.click();
  await waitCards(p, "metricsBoard", presets.length, presets.length - 1);
  const m = await p.evaluate(() => ({ n: document.querySelectorAll("#metricsBoard .wcard").length, canvases: document.querySelectorAll("#metricsBoard canvas").length, empty: [...document.querySelectorAll("#metricsBoard .wcard")].filter((c) => !c.querySelector("canvas") && /No data points/.test(c.textContent)).length, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, pinned: Object.values(window.BTW._state().widgets).filter((w) => w.pinned).length }));
  must(m.n === presets.length && m.canvases + m.empty >= presets.length && m.canvases >= presets.length - 1, `metrics board renders ${presets.length} pinned cards (${m.canvases} charts, ${m.empty} honest empty states: per-user history is thin locally)`);
  must(!m.overflow, "no horizontal overflow on metrics board");
  await p.screenshot({ path: `docs/widgets-metrics-${name}.png`, fullPage: true });
  // persistence: specs stored per login, without data
  const store = await p.evaluate(() => JSON.parse(localStorage.getItem("bt_widgets")));
  must(store.login === "dev-local" && Object.keys(store.widgets).length >= 10 && !JSON.stringify(store).includes('"points"'), "widget specs persisted per login in bt_widgets (specs only, no data)");
  const v = await csp(p); must(v.length === 0, "zero CSP violations (" + (v.join("; ") || "none") + ")");
  must(errors.length === 0, "no page errors (" + (errors.join(" | ").slice(0, 200) || "none") + ")");

  if (name === "mobile") {
    console.log("-- update-in-place flow (chat SSE replayed with real server-validated spec + data)");
    await tab(p, "chat");
    const specA = { widget_id: "lambda-p95", title: "Lambda p95 duration", type: "line", series: [{ metric: "lambda_duration_ms", agg: "p95" }], range: "24h" };
    const specB = { ...specA, type: "bar", thresholds: [{ value: 300, label: "300 ms" }] };
    const real = await p.evaluate(async (a, bb) => { const f = (s) => fetch("/api/metrics/widget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: s }) }).then((r) => r.json()); return [await f(a), await f(bb)]; }, specA, specB);
    await p.setRequestInterception(true);
    let turn = 0;
    const onReq = (req) => {
      if (req.url().endsWith("/api/chat") && req.method() === "POST") {
        const r = real[turn]; const op = turn ? "update" : "render"; turn++;
        const sse = [{ type: "tool", name: turn === 1 ? "render_widget" : "update_widget" }, { type: "widget", op, spec: r.spec, data: r.data }, { type: "final", text: turn === 1 ? "Here is Lambda p95 duration over 24h." : "Switched it to bars and added a 300 ms threshold." }, { type: "done" }]
          .map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
        return req.respond({ status: 200, contentType: "text/event-stream", body: sse });
      }
      req.continue();
    };
    p.on("request", onReq);
    const sendMsg = async (t) => { await p.$eval("#q", (el, t) => { el.value = t; }, t); await p.click("#sendBtn"); await p.waitForFunction(() => !document.getElementById("sendBtn").disabled, { timeout: 20000 }); };
    await sendMsg("Plot Lambda p95 duration over 24h");
    await p.waitForFunction(() => document.querySelector('#log .wcard[data-widget="lambda-p95"] canvas'), { timeout: 20000 });
    await p.evaluate(() => { document.querySelector('#log .wcard[data-widget="lambda-p95"]').__mark = "same-node"; });
    await sendMsg("Switch it to bars and add a 300 ms threshold");
    await p.waitForFunction(() => document.querySelector('#log .wcard[data-widget="lambda-p95"]').dataset.version === "2" && document.querySelector('#log .wcard[data-widget="lambda-p95"] canvas'), { timeout: 20000 });
    const u = await p.evaluate(() => ({ cards: document.querySelectorAll('#log .wcard[data-widget="lambda-p95"]').length, same: document.querySelector('#log .wcard[data-widget="lambda-p95"]').__mark === "same-node",
      type: window.BTW.latest("lambda-p95").type, th: (window.BTW.latest("lambda-p95").thresholds || []).length, link: !!document.querySelector("#log .w-updated"), undo: !document.querySelector('#log .wcard[data-widget="lambda-p95"] .w-btn').disabled }));
    must(u.cards === 1, "edit did NOT create a duplicate card");
    must(u.same, "the SAME card node was re-rendered in place");
    must(u.type === "bar" && u.th === 1, "card now shows v2: bar chart + threshold");
    must(u.link && u.undo, "reply links to the updated card; undo enabled");
    await p.click('#log .wcard[data-widget="lambda-p95"] .w-btn');
    await p.waitForFunction(() => document.querySelector('#log .wcard[data-widget="lambda-p95"]').dataset.version === "1", { timeout: 10000 });
    must(await p.evaluate(() => window.BTW.latest("lambda-p95").type === "line"), "undo restores v1 (line)");
    // reload: chat + widget restored from localStorage with fresh data
    p.off("request", onReq); await p.setRequestInterception(false);
    await p.reload({ waitUntil: "networkidle0" }); await tab(p, "chat");
    await p.waitForFunction(() => document.querySelector('#log .wcard[data-widget="lambda-p95"] canvas'), { timeout: 20000 });
    must(true, "after reload the widget is restored in the chat with fresh data");
    const v2 = await csp(p); must(v2.length === 0, "zero CSP violations in chat flow");
  }
  await ctx.close();
}

if (AGENT) {
  console.log("\n== REAL agent: render then edit (mobile)");
  const { p, ctx } = await page(MOBILE);
  await tab(p, "chat");
  const ask = async (t, until) => { await p.$eval("#q", (el, t) => { el.value = t; }, t); await p.click("#sendBtn"); await p.waitForFunction(() => !document.getElementById("sendBtn").disabled, { timeout: 120000 }); if (until) await p.waitForFunction(until, { timeout: 30000 }).catch(() => {}); };
  await ask("Plot my site's Lambda duration p95 together with invocations on the right axis over the last 24h. Use widget_id lambda-health.", () => document.querySelector("#log .wcard canvas"));
  const id = await p.evaluate(() => (document.querySelector("#log .wcard") || {}).dataset?.widget || null);
  must(!!id, "agent rendered a widget (" + id + ")");
  await p.evaluate(() => { const c = document.querySelector("#log .wcard"); if (c) c.scrollIntoView({ block: "start" }); });
  await new Promise((r) => setTimeout(r, 800));
  await p.screenshot({ path: "docs/widgets-agent-before-mobile.png" });
  await ask("Now change that same chart to a bar chart over the last 7 days and add a 1000 ms threshold line.", (wid) => document.querySelector(`#log .wcard[data-widget="${wid}"]`)?.dataset.version >= "2");
  const after = await p.evaluate((wid) => ({ n: document.querySelectorAll(`#log .wcard[data-widget="${wid}"]`).length, v: document.querySelector(`#log .wcard[data-widget="${wid}"]`)?.dataset.version, spec: window.BTW.latest(wid) }), id);
  must(after.n === 1 && Number(after.v) >= 2, `agent edited the widget in place (cards=${after.n}, v${after.v}, type=${after.spec && after.spec.type}, range=${after.spec && after.spec.range})`);
  await p.evaluate((wid) => { const c = document.querySelector(`#log .wcard[data-widget="${wid}"]`); if (c) c.scrollIntoView({ block: "start" }); }, id);
  await new Promise((r) => setTimeout(r, 800));
  await p.screenshot({ path: "docs/widgets-agent-after-mobile.png" });
  await p.evaluate(() => document.getElementById("log").scrollTo(0, 1e9)); await new Promise((r) => setTimeout(r, 300));
  await p.screenshot({ path: "docs/widgets-agent-reply-mobile.png" });
  const v = await csp(p); must(v.length === 0, "zero CSP violations with the real agent");
  await ctx.close();
}
await b.close();
console.log(fails ? `\nWIDGETS E2E FAILED (${fails})` : "\nWIDGETS E2E PASSED");
process.exit(fails ? 1 : 0);
