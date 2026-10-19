// Live E2E against the deployed site (no login). Needs: npm i --no-save puppeteer-core@23
import puppeteer from "puppeteer-core";
const D = (process.argv[2] || process.env.SITE_URL || "https://tutor.example.com").replace(/\/$/, "");
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage(); await p.setViewport({ width: 1366, height: 900 });
const errs = []; p.on("pageerror", e => errs.push(e.message));
let t = Date.now(); await p.goto(D + "/", { waitUntil: "networkidle0" });
console.log("landing loaded in", Date.now() - t, "ms; title:", await p.title(), "| dev button hidden:", await p.$eval("#dev", e => e.hidden));
await p.screenshot({ path: "/workspace/browser-tutor/docs/live-landing.png" });
// Probe UI is behind login; the same static page + script is served at /static/app.html, so exercise it there.
await p.setRequestInterception(true);
p.on("request", r => r.url().endsWith("/api/me") ? r.respond({ status: 200, contentType: "application/json", body: '{"login":"test-not-signed-in"}' }) : r.continue());
await p.goto(D + "/static/app.html", { waitUntil: "networkidle0" });
await p.waitForFunction(() => window.BT && window.BT.fingerprint, { timeout: 20000 });
const fp = await p.evaluate(() => window.BT.fingerprint);
console.log("probe sections:", Object.keys(fp).length, "| secureContext SHA-256 canvas hash:", fp.canvas.hash, "| clientHints:", JSON.stringify(fp.clientHints.highEntropy?.fullVersionList?.slice(0,2)));
await new Promise(r => setTimeout(r, 1500));
const sv = JSON.parse(await p.$eval("#sv", e => e.textContent));
console.log("server-view via CloudFront: ip", sv.clientIp, "| http", sv.httpVersion, "| tls", sv.tls?.viewerTls, "| sec-ch-ua present:", !!sv.headers["sec-ch-ua"], "| sec-fetch-mode:", sv.headers["sec-fetch-mode"]);
await p.screenshot({ path: "/workspace/browser-tutor/docs/live-probe.png" });
console.log("page errors:", errs.length ? errs : "none");
// Login click goes to GitHub
await p.goto(D + "/auth/login", { waitUntil: "domcontentloaded" });
console.log("after /auth/login, browser is at:", p.url().slice(0, 120));
await b.close();
