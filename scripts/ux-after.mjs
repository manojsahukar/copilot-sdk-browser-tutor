import puppeteer from "puppeteer-core";
const BASE = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080").replace(/\/$/, "");
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const VPS = [
  { name: "360x740", width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "390x844", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "412x915", width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true },
  { name: "desktop-1280x800", width: 1280, height: 800, deviceScaleFactor: 1 },
];
const overflow = (p) => p.evaluate(() => { const se = document.scrollingElement; return { ok: se.scrollWidth <= innerWidth + 1, sw: se.scrollWidth, iw: innerWidth }; });
const results = [];
for (const vp of VPS) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
  await p.setViewport(vp);
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.click("#devLogin"); await p.waitForNavigation({ waitUntil: "networkidle0" });
  await p.waitForFunction(() => document.querySelector("#fpCards .card"), { timeout: 20000 });
  // Chat tab
  await p.evaluate(() => document.querySelector('.tab[data-tab="chat"]').click());
  await p.waitForSelector("#chips .chip", { timeout: 8000 });
  const chipCount = await p.$$eval("#chips .chip", (c) => c.length);
  const engineChip = await p.$("#engineChip") ? true : false;
  // 70% rule while typing
  await p.evaluate(() => { const q = document.getElementById("q"); q.focus(); q.value = "test"; q.dispatchEvent(new Event("input")); });
  const ratio = await p.evaluate(() => document.getElementById("log").clientHeight / innerHeight);
  await p.evaluate(() => { const q = document.getElementById("q"); q.value = ""; q.dispatchEvent(new Event("input")); });
  const ov1 = await overflow(p);
  await p.screenshot({ path: `docs/ux-after-${vp.name}.png` });
  // Open engine sheet
  await p.click("#engineChip"); await p.waitForSelector("#engineSheet:not([hidden]) .eng-opt", { timeout: 4000 });
  if (vp.name === "390x844") await p.screenshot({ path: `docs/ux-after-sheet-390x844.png` });
  const sheetOpts = await p.$$eval("#engineSheet .eng-opt", (e) => e.length);
  await p.evaluate(() => document.getElementById("sheetClose").click());
  results.push({ vp: vp.name, chipCount, engineChip, logRatio: +ratio.toFixed(2), sheetOpts, overflow: ov1.ok, errs });
  await ctx.close();
}

// storage_inspector demo on /demos (desktop ctx)
{
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
  await p.setViewport({ name: "390", width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.click("#devLogin"); await p.waitForNavigation({ waitUntil: "networkidle0" });
  // seed a fake chat history so the demo has something to inspect
  await p.goto(BASE + "/static/app.html", { waitUntil: "networkidle0" });
  await p.evaluate(() => localStorage.setItem("bt_chat", JSON.stringify({ savedAt: Date.now(), expiresAt: Date.now() + 6048e5, messages: [{ role: "user", text: "hello there tutor" }, { role: "assistant", text: "hi!" }], chips: ["a", "b"] })));
  await p.goto(BASE + "/demos", { waitUntil: "networkidle0" });
  await p.waitForSelector('[data-run="storage_inspector"]', { timeout: 8000 });
  await p.click('[data-run="storage_inspector"]');
  await p.waitForSelector("#out-storage_inspector .stor-grid", { timeout: 8000 });
  const saved = await p.evaluate(() => JSON.parse(sessionStorage.getItem("bt_demo") || "{}").storage_inspector);
  const ov = await overflow(p);
  await p.screenshot({ path: "docs/ux-after-storage-390x844.png", fullPage: true });
  results.push({ demo: "storage_inspector", savedKeys: Object.keys(saved || {}), chatMeta: saved && saved.chatHistory, cookieNames: saved && saved.jsVisibleCookieNames, leaksContent: JSON.stringify(saved || {}).includes("hello there tutor"), overflow: ov.ok });
  await ctx.close();
}
await b.close();
console.log(JSON.stringify(results, null, 2));
