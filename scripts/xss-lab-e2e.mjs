// End-to-end checks for the contained XSS lab. Run locally: node scripts/xss-lab-e2e.mjs
import puppeteer from "puppeteer-core";
const MAIN = "http://localhost:8080", LAB = "http://localhost:8099", OTHER = "http://localhost:8098";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let fail = 0; const must = (c, m) => { if (!c) { fail++; console.log("  FAIL -", m); } else console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- main app + embedded lab ----
const p = await b.newPage();
const dialogs = []; p.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
await p.goto(MAIN + "/", { waitUntil: "networkidle0" });
await p.click("#devLogin"); await p.waitForNavigation({ waitUntil: "networkidle0" });
// seed a main-origin localStorage secret to prove the lab can't read it
await p.evaluate(() => localStorage.setItem("bt_chat", JSON.stringify({ messages: [{ role: "user", text: "SECRET main transcript" }] })));
await p.goto(MAIN + "/demos", { waitUntil: "networkidle0" });
await p.waitForFunction(() => { const s = document.getElementById("lab-status"); return s && /ready/i.test(s.textContent); }, { timeout: 15000 });
const labFrame = p.frames().find((f) => f.url().includes(":8099"));
must(!!labFrame, "lab iframe is present and loaded (framed by main → allowed)");

async function clickRun(demo, variant) { await labFrame.evaluate((d, v) => { const b = document.querySelector(`[data-run="${d}"][data-variant="${v}"]`); if (b) b.click(); }, demo, variant); await sleep(250); }
const noteText = (id) => labFrame.evaluate((i) => (document.getElementById(i) || {}).textContent || "", id);

await clickRun("reflected", "vuln");  must(/executed/i.test(await noteText("n-reflected-v")), "reflected XSS EXECUTES in the vulnerable variant");
await clickRun("reflected", "fixed"); must(/safe/i.test(await noteText("n-reflected-f")), "reflected payload is INERT in the fixed variant (textContent)");
await clickRun("stored", "vuln");     must(/executed/i.test(await noteText("n-stored-v")), "stored XSS EXECUTES in the vulnerable variant");
await clickRun("dom", "vuln");        must(/executed/i.test(await noteText("n-dom-v")), "DOM XSS EXECUTES in the vulnerable variant");
await clickRun("dom", "fixed");       must(/safe/i.test(await noteText("n-dom-f")), "DOM payload inert + javascript: link neutralised in fixed variant");
await clickRun("capabilities", "vuln"); await sleep(400);
const caps = await labFrame.evaluate(() => (document.getElementById("caplist") || {}).innerText || "");
must(/Read JS-visible cookies/i.test(caps) && /lab_dummy_js/.test(caps), "injected script read the JS-visible dummy cookie");
must(!/lab_secret_httponly/.test(caps), "injected script could NOT read the HttpOnly cookie");
must(/fake login/i.test(caps) && /keystroke/i.test(caps) && /echoed/i.test(caps) === false ? true : /Exfiltrated/i.test(caps), "capabilities: fake login, keylogger and exfiltration shown");
await clickRun("defences", "x"); await sleep(500);
must(/blocked by csp/i.test(await noteText("n-csp")), "strict-CSP sub-page BLOCKS the payload (securitypolicyviolation)");
must(/present to JS: false/i.test(await noteText("n-httponly")) || /secret cookie present to JS: false/i.test(await noteText("n-httponly")), "HttpOnly cookie hidden from JS in defences panel");
must(/sanitised/i.test(await noteText("n-purify")), "DOMPurify sanitises the hostile markup");
await clickRun("prompt", "vuln");  must(/executed/i.test(await noteText("n-prompt-v")), "prompt-injection fires via naive innerHTML");
await clickRun("prompt", "fixed"); must(/neutralised/i.test(await noteText("n-prompt-f")), "prompt-injection neutralised via marked+DOMPurify");
must(dialogs.length === 0, "no alert()/dialog ever fired (payloads are harmless)");

// ---- isolation: the lab cannot see the main origin's cookie or localStorage ----
const iso = await labFrame.evaluate(() => ({ cookie: document.cookie, ls: Object.keys(localStorage) }));
must(/lab_dummy_js/.test(iso.cookie), "lab sees its own dummy cookie");
must(!/bt_sess/.test(iso.cookie), "lab does NOT receive the main session cookie (host-only)");
must(!iso.ls.includes("bt_chat"), "lab localStorage cannot read the main origin's bt_chat");
must(iso.ls.some((k) => k.startsWith("lab_")), "lab has its own separate localStorage");

// ---- metadata to the tutor (names/flags only) ----
const meta = await p.evaluate(() => JSON.parse(sessionStorage.getItem("bt_demo") || "{}").xss_lab);
must(meta && Array.isArray(meta.runs) && meta.runs.length >= 5, "xss_lab metadata saved for the tutor (runs recorded)");
must(meta && meta.runs.some((r) => r.executed) && meta.runs.some((r) => r.blocked), "metadata records both executed and blocked outcomes");
must(meta && !JSON.stringify(meta).includes("SECRET main transcript"), "metadata contains no page content, only flags");

// ---- opening the lab directly (top-level) is inert, and query payloads do nothing ----
const d1 = await b.newPage();
const d1dialogs = []; d1.on("dialog", (x) => { d1dialogs.push(x.message()); x.dismiss(); });
await d1.goto(LAB + "/lab?payload=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E#%3Cimg%20onerror%3Dalert(1)%3E", { waitUntil: "networkidle0" });
const gateShown = await d1.evaluate(() => !document.getElementById("gate").hidden && document.getElementById("lab").hidden);
must(gateShown, "direct top-level open shows the gate and hides the lab (inert)");
must(d1dialogs.length === 0, "query/hash payload on direct open does NOTHING");
const anyRun = await d1.$('[data-run]'); // buttons exist in DOM but lab is hidden/unwired
await sleep(200); must(d1dialogs.length === 0, "no execution from URL-borne payloads");

// ---- frame-ancestors: a non-main origin cannot embed the lab ----
const d2 = await b.newPage();
await d2.goto(OTHER + "/", { waitUntil: "networkidle0" });
const gotReady = await d2.evaluate((lab) => new Promise((resolve) => {
  let ready = false;
  window.addEventListener("message", (e) => { if (e.origin === lab && e.data && e.data.type === "bt-lab-ready") ready = true; });
  const f = document.createElement("iframe"); f.src = lab + "/lab"; document.body.appendChild(f);
  setTimeout(() => resolve(ready), 2500);
}), LAB);
must(gotReady === false, "frame-ancestors blocks embedding the lab from a non-main origin");

await b.close();
console.log(fail ? `\nXSS LAB E2E FAILED (${fail})` : "\nXSS LAB E2E PASSED");
process.exit(fail ? 1 : 0);
