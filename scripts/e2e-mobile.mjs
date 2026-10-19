// Responsive checks. Usage: node scripts/e2e-mobile.mjs [baseUrl] [--chat] [--shots prefix] [--only=390]
// Gated pages: local = dev bypass login; live = /static/app.html with /api/me mocked (no login needed).
// Needs: npm i --no-save puppeteer-core@23 (run from a dir that has it, e.g. NODE_PATH not used for ESM; copy next to it)
import puppeteer from "puppeteer-core";
const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith("http")) || "http://localhost:8080").replace(/\/$/, "");
const CHAT = args.includes("--chat"), SHOTS = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const only = (args.find((a) => a.startsWith("--only=")) || "").slice(7);
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const VPS = [
  { name: "360x740", width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "390x844", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, ua: IPHONE },
  { name: "768x1024", width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1280x800", width: 1280, height: 800, deviceScaleFactor: 1 },
].filter((v) => !only || v.name.startsWith(only));
const local = BASE.includes("localhost");
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });

async function metrics(p) {
  return p.evaluate(() => {
    const se = document.scrollingElement, iw = innerWidth;
    const wide = [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > iw + 1 || r.left < -1) && getComputedStyle(e).position !== "fixed"; })
      .slice(0, 3).map((e) => e.tagName + (e.id ? "#" + e.id : "") + "." + e.className);
    const small = [...document.querySelectorAll("button, a.btn, summary, .tab, input, textarea")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && e.offsetParent !== null && r.height < 44 && !e.closest(".long"); })
      .map((e) => (e.id || e.className || e.tagName) + ":" + Math.round(e.getBoundingClientRect().height));
    const inputs = [...document.querySelectorAll("input, textarea")].filter((e) => e.offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize));
    return { scrollWidth: se.scrollWidth, innerWidth: iw, ok: se.scrollWidth <= iw, offenders: wide, smallTargets: small, inputFontPx: inputs };
  });
}
const results = [];
for (const vp of VPS) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
  await p.setViewport(vp); if (vp.ua) await p.setUserAgent(vp.ua);
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  results.push({ vp: vp.name, page: "landing", ...(await metrics(p)) });
  if (SHOTS && vp.name === "390x844") await p.screenshot({ path: `${SHOTS}landing.png` });
  await p.goto(BASE + "/gotchas", { waitUntil: "networkidle0" });
  await p.waitForSelector("#gotchas details.card");
  const gcount = await p.$$eval("#gotchas details.card", (d) => d.length);
  results.push({ vp: vp.name, page: "gotchas", items: gcount, ...(await metrics(p)) });
  if (SHOTS && (vp.name === "390x844" || vp.name === "1280x800")) {
    const g = SHOTS.replace(/mobile-$/, "gotchas-") + (vp.name === "390x844" ? "mobile.png" : "desktop.png");
    await p.screenshot({ path: g });
    if (vp.name === "390x844") { await p.click("#expandAll"); await p.screenshot({ path: g.replace("mobile.png", "mobile-expanded.png"), fullPage: true }); }
  }
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  if (local) { await p.click("#devLogin"); await p.waitForNavigation({ waitUntil: "networkidle0" }); }
  else {
    await p.setRequestInterception(true);
    p.on("request", (r) => r.url().endsWith("/api/me") ? r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ login: "preview", provider: "openrouter", or: { connected: true, model: "google/gemma-4-31b-it:free", default: "google/gemma-4-31b-it:free", settingsUrl: "https://openrouter.ai/keys/abc", revokeUrl: "https://openrouter.ai/settings/keys", models: [{ id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B · free" }, { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B · free" }, { id: "openrouter/free", label: "Auto (free models) · free" }] } }) }) : r.continue());
    await p.goto(BASE + "/static/app.html", { waitUntil: "networkidle0" });
  }
  await p.waitForFunction(() => document.querySelector("#svCards .card") && document.querySelector("#fpCards .card"), { timeout: 20000 });
  // expand a long value to make sure expanded content still wraps
  await p.evaluate(() => { const d = document.querySelector("details.long"); if (d) d.open = true; });
  results.push({ vp: vp.name, page: "probe", ...(await metrics(p)) });
  if (SHOTS && vp.name === "390x844") await p.screenshot({ path: `${SHOTS}probe.png` });
  await p.click('[data-tab="share"], #share');
  if (CHAT && vp.name === "390x844") {
    await p.type("#q", "Briefly: what do my user agent and timezone reveal? Two short bullets.");
    await p.click("#form button");
    await p.waitForFunction(() => !document.querySelector("#form button").disabled, { timeout: 150000 });
  } else if (!local || !CHAT) {
    // Render a representative conversation without calling the model
    await p.evaluate(() => {
      const log = document.getElementById("log");
      log.insertAdjacentHTML("beforeend", '<div class="msg user">What does my user agent reveal?</div><div class="msg tool">🔧 tutor called get_browser_fingerprint</div>' +
        '<div class="msg bot"><strong>User agent</strong><br>• <code>' + navigator.userAgent + '</code> reveals browser, version and OS.<br>• Canvas hash <code>84a6e4944b0ea6adc7b5365cce2bc78d84a6e4944b0ea6adc7b5365cce2bc78d</code> is stable across visits.<br><pre>sec-ch-ua: "Chromium";v="155", "Google Chrome";v="155", "Not.A/Brand";v="99" averyveryveryverylongunbrokentokenaveryveryveryverylongunbrokentoken</pre></div>');
      log.scrollTop = log.scrollHeight;
    });
  }
  const m = await metrics(p);
  const comp = await p.evaluate(() => { const r = document.querySelector(".composer").getBoundingClientRect(); return { composerBottom: Math.round(r.bottom), vh: innerHeight }; });
  results.push({ vp: vp.name, page: "chat", ...m, ...comp });
  if (SHOTS && vp.name === "390x844") await p.screenshot({ path: `${SHOTS}chat.png` });
  if (errs.length) results.push({ vp: vp.name, page: "errors", errs });
  await ctx.close();
}
await b.close();
for (const r of results) console.log(JSON.stringify(r));
const bad = results.filter((r) => r.ok === false);
console.log(bad.length ? `OVERFLOW FAILURES: ${bad.length}` : "ALL PAGES: no horizontal overflow");
