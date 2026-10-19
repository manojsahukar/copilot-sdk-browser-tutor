// Verifies the client Markdown pipeline (vendored marked + DOMPurify) neutralises hostile model output.
// Usage: node scripts/markdown-xss.mjs [baseUrl]  (default http://localhost:8080; uses dev-bypass login locally)
import puppeteer from "puppeteer-core";
const BASE = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080").replace(/\/$/, "");
const local = BASE.includes("localhost");
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
const alerts = []; p.on("dialog", (d) => { alerts.push(d.message()); d.dismiss(); });
await p.goto(BASE + "/", { waitUntil: "networkidle0" });
if (local) { await p.click("#devLogin"); await p.waitForNavigation({ waitUntil: "networkidle0" }); }
await p.goto(BASE + "/static/app.html", { waitUntil: "networkidle0" });
await p.waitForFunction(() => typeof window.__renderMarkdown === "function", { timeout: 15000 });

const CASES = [
  "<script>window.__pwned=1;alert('xss')</script>",
  "<img src=x onerror=\"window.__pwned=1;alert('img')\">",
  "[click me](javascript:window.__pwned=1)",
  "[ok](http://example.com)",
  "Normal **bold**, `code`, and a list:\n\n- a\n- b\n\n| h1 | h2 |\n|----|----|\n| 1  | 2  |",
  "<a href=\"javascript:alert(1)\">x</a> and <iframe src=evil></iframe>",
];
const res = await p.evaluate((cases) => {
  const host = document.createElement("div"); document.body.appendChild(host);
  return cases.map((c) => {
    const html = window.__renderMarkdown(c);
    host.innerHTML = html;                       // mount so we inspect the real DOM
    const anchors = [...host.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") }));
    const out = { html, hasScript: /<script/i.test(html) || !!host.querySelector("script"), hasImg: !!host.querySelector("img"),
      hasIframe: !!host.querySelector("iframe"), onerror: /onerror/i.test(html),
      jsHref: anchors.some((a) => /^javascript:/i.test(a.href || "")), anchors,
      hasTable: !!host.querySelector("table"), hasStrong: !!host.querySelector("strong") };
    host.innerHTML = "";
    return out;
  });
}, CASES);

let fail = 0;
const must = (cond, msg) => { if (!cond) { fail++; console.log("  FAIL -", msg); } else console.log("  ok -", msg); };
res.forEach((r, i) => console.log(`case ${i}:`, JSON.stringify({ hasScript: r.hasScript, hasImg: r.hasImg, hasIframe: r.hasIframe, onerror: r.onerror, jsHref: r.jsHref })));
must(res.every((r) => !r.hasScript), "no <script> survives");
must(res.every((r) => !r.hasImg), "no <img> survives (img forbidden)");
must(res.every((r) => !r.hasIframe), "no <iframe> survives");
must(res.every((r) => !r.onerror), "no onerror handler survives");
must(res.every((r) => !r.jsHref), "no javascript: href survives");
const okLink = res[3].anchors[0];
must(okLink && /^http:\/\/example\.com/.test(okLink.href) && okLink.target === "_blank" && /noopener/.test(okLink.rel) && /noreferrer/.test(okLink.rel), "http link kept with target=_blank rel=noopener noreferrer");
must(res[4].hasTable && res[4].hasStrong, "GFM table + bold still render");
must(alerts.length === 0, "no alert() dialog ever fired");
const pwned = await p.evaluate(() => !!window.__pwned);
must(!pwned, "no injected script executed (window.__pwned unset)");

await b.close();
if (fail) { console.log(`\nMARKDOWN XSS TEST FAILED (${fail})`); process.exit(1); }
console.log("\nMARKDOWN XSS TEST PASSED");
