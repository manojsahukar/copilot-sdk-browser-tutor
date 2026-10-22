// Headless E2E for the suggestion chips (starter + post-widget edit chips) under the app's strict CSP.
// Needs the local dev server (DEV_AUTH_BYPASS=1) on :8080. Run: node scripts/chips-e2e.mjs
// Checks: widget chips are badged (📊, CSS span, text only), mixed with privacy/XSS chips, ONE scrollable row on mobile,
// a tapped widget chip sends exactly its text, after a widget renders the chips offer edits to it, hostile chip text stays text.
import puppeteer from "puppeteer-core";
const BASE = "http://localhost:8080";
let fails = 0; const must = (c, m) => { console.log((c ? "  ok - " : "  FAIL - ") + m); if (!c) fails++; };
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const MOBILE = { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Mobile Safari/537.36" };
const DESKTOP = { viewport: { width: 1366, height: 900, deviceScaleFactor: 1 }, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36" };
const STARTER_WIDGET = ["Is the site up?", "Plot my reply latency over time", "Show errors last 24h", "Availability last week?", "Why was it slow?"];
const EDITS = ["Switch to bar by model", "Add a 1s threshold line", "Change to last 7 days", "Compare with 429s"];

const chips = (p) => p.evaluate(() => {
  const row = document.getElementById("chips");
  const items = [...row.querySelectorAll(".chip-wrap")].map((w) => ({ text: w.querySelector(".chip-text")?.textContent ?? w.querySelector(".chip").textContent,
    widget: w.classList.contains("chip-widget"), badge: w.querySelector(".chip-badge")?.textContent || "", top: Math.round(w.getBoundingClientRect().top) }));
  return { items, hidden: row.hidden, h: row.getBoundingClientRect().height, sw: row.scrollWidth, cw: row.clientWidth,
    html: row.innerHTML, imgs: row.querySelectorAll("img,script,iframe,svg,a").length, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
});

for (const [name, dev] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
  console.log(`\n== ${name} (${dev.viewport.width}x${dev.viewport.height})`);
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.emulate(dev);
  const errors = []; p.on("pageerror", (e) => errors.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(401|404)/.test(m.text())) errors.push(m.text()); });
  let dialogs = 0; p.on("dialog", async (d) => { dialogs++; await d.dismiss(); });
  await p.evaluateOnNewDocument(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample || ""))); });
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.click("#devLogin"); await p.waitForNavigation({ waitUntil: "networkidle0" });
  await p.waitForFunction(() => window.BTW && document.querySelector("#me .login"), { timeout: 15000 });
  await p.click('[data-tab="chat"]'); await p.waitForFunction(() => document.querySelectorAll("#chips .chip-wrap").length > 0, { timeout: 10000 });

  // ---- starter chips (empty chat, right after sign-in)
  let c = await chips(p);
  const texts = c.items.map((i) => i.text);
  const wid = c.items.filter((i) => i.widget);
  must(!c.hidden && c.items.length >= 6, `starter chips shown (${c.items.length}): ${texts.join(" | ")}`);
  must(wid.length >= 4 && wid.every((i) => i.badge === "📊") && wid.every((i) => STARTER_WIDGET.includes(i.text)), `${wid.length} widget chips badged 📊 (CSS span, label text is clean)`);
  must(STARTER_WIDGET.slice(0, 4).every((t) => texts.includes(t)), "includes 'Is the site up?', 'Plot my reply latency over time', 'Show errors last 24h', 'Availability last week?'");
  must(texts.includes("What does my browser reveal?") && texts.some((t) => /xss/i.test(t)), "still mixed with browser-privacy and XSS chips");
  must(c.items.filter((i) => !i.widget).every((i) => i.badge === ""), "non-widget chips carry no badge");
  if (name === "mobile") {
    must(new Set(c.items.map((i) => i.top)).size === 1 && c.h <= 52, `mobile: ONE row, no extra vertical space (height ${Math.round(c.h)}px)`);
    must(c.sw > c.cw, "mobile: row scrolls horizontally");
  }
  must(!c.pageOverflow, "no horizontal page overflow");
  await p.screenshot({ path: `docs/chips-widgets-${name}.png` });

  // ---- tap a widget chip: it must send exactly its text (badge not included); mock the reply with a real widget + hostile followups
  const real = await p.evaluate(() => fetch("/api/metrics/widget", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec: { widget_id: "site-up", title: "Availability (CloudFront-derived)", type: "line", series: [{ metric: "cf_availability_pct", agg: "min" }], group_by: "distribution", range: "24h", slo: 99.5 } }) }).then((r) => r.json()));
  must(real && real.spec && real.data, "server validated a real widget spec for the mocked reply");
  await p.setRequestInterception(true);
  const sent = [];
  const onReq = (req) => {
    if (req.url().endsWith("/api/chat") && req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}"); sent.push(body.message);
      const evs = sent.length === 1
        ? [{ type: "tool", name: "render_widget" }, { type: "widget", op: "render", spec: real.spec, data: real.data }, { type: "final", text: "Yes, all three sites are up." },
           { type: "followups", items: ["📊 Show it by endpoint for 7 days", "<img src=x onerror=alert(1)>Compare", "How unique am I?"] }, { type: "done" }]
        : [{ type: "final", text: "ok" }, { type: "followups", items: ["What does my browser reveal?"] }, { type: "done" }];
      return req.respond({ status: 200, contentType: "text/event-stream", body: evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
    }
    req.continue();
  };
  p.on("request", onReq);
  const target = await p.evaluateHandle(() => [...document.querySelectorAll("#chips .chip-wrap")].find((w) => w.querySelector(".chip-text")?.textContent === "Is the site up?").querySelector(".chip"));
  if (name === "mobile") await target.tap(); else await target.click();
  await p.waitForFunction(() => document.querySelector('#log .wcard[data-widget="site-up"]') && !document.getElementById("sendBtn").disabled, { timeout: 20000 });
  must(sent[0] === "Is the site up?", `tapped widget chip sent exactly its text (${JSON.stringify(sent[0])})`);

  // ---- after a widget: edit chips for that widget
  await p.waitForFunction(() => document.querySelectorAll("#chips .chip-wrap").length > 0, { timeout: 5000 });
  c = await chips(p);
  const after = c.items.map((i) => i.text);
  must(EDITS.every((t) => after.includes(t)), `after the widget: edit chips offered (${after.join(" | ")})`);
  must(EDITS.every((t) => c.items.find((i) => i.text === t).widget), "edit chips are badged as widget chips");
  must(after[0] === "Show it by endpoint for 7 days", "the model's context-specific edit is kept first, with its 📊 stripped from the text");
  must(c.imgs === 0 && dialogs === 0, `chip row holds text only (no img/script/a; dialogs=${dialogs})`);
  if (name === "mobile") must(new Set(c.items.map((i) => i.top)).size === 1 && c.h <= 52, `mobile: edit chips still ONE row (${Math.round(c.h)}px)`);
  await p.waitForFunction(() => document.querySelector('#log .wcard[data-widget="site-up"] canvas'), { timeout: 15000 }); await new Promise((r) => setTimeout(r, 800));
  const ax = await p.evaluate(() => { const card = document.querySelector('#log .wcard[data-widget="site-up"]'); return { canvas: !!card.querySelector("canvas"), text: card.innerText.slice(0, 200) }; });
  must(ax.canvas, "widget chart drawn in the reply");
  await p.screenshot({ path: `docs/chips-widgets-after-${name}.png` });

  // tapping an edit chip sends its text too
  const edit = await p.evaluateHandle(() => [...document.querySelectorAll("#chips .chip-wrap")].find((w) => w.querySelector(".chip-text")?.textContent === "Add a 1s threshold line").querySelector(".chip"));
  if (name === "mobile") await edit.tap(); else await edit.click();
  await p.waitForFunction(() => !document.getElementById("sendBtn").disabled, { timeout: 20000 });
  must(sent[1] === "Add a 1s threshold line", `edit chip sent exactly its text (${JSON.stringify(sent[1])})`);
  p.off("request", onReq); await p.setRequestInterception(false);

  const v = await p.evaluate(() => window.__csp.slice());
  must(v.length === 0, "zero CSP violations (" + (v.join("; ") || "none") + ")");
  must(errors.length === 0, "no page errors (" + (errors.join(" | ").slice(0, 200) || "none") + ")");
  await ctx.close();
}
await b.close();
console.log(fails ? `\nCHIPS E2E FAILED (${fails})` : "\nCHIPS E2E PASSED");
process.exit(fails ? 1 : 0);
