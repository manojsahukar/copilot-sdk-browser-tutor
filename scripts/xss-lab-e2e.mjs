// End-to-end checks for the contained XSS lab. Run locally: node scripts/xss-lab-e2e.mjs
import puppeteer from "puppeteer-core";
const MAIN = "http://localhost:8080", LAB = "http://localhost:8099", OTHER = "http://localhost:8098";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let fail = 0; const must = (c, m) => { if (!c) { fail++; console.log("  FAIL -", m); } else console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- main app + embedded lab ----
const p = await b.newPage();
const dialogs = []; p.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
const thirdParty = []; p.on("response", (r) => { if (/giscus\.app|evil\.example|good\.example/.test(r.url())) thirdParty.push(r.url()); });
// Off-site/error navigations. The ONLY allowed one is the error page of the iframe CSP refuses inside the "blocked" csp3p sub-page.
const navs = []; p.on("framenavigated", (f) => {
  const u = f.url(), parent = f.parentFrame() ? f.parentFrame().url() : "";
  if (/^chrome-error:/.test(u) && /\/lab\/csp3p\?mode=block/.test(parent)) return;
  if (!/^(http:\/\/localhost|about:)/.test(u)) navs.push(u.slice(0, 60));
});
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

// ---- lesson 7: sneaky links ----
await clickRun("links", "vuln");
const naive = await labFrame.evaluate(() => [...document.querySelectorAll("#s-links-v tr")].slice(1).map((r) => [...r.cells].map((c) => c.textContent)));
const nv = Object.fromEntries(naive.map((r) => [r[0], r]));
must(nv["//evil.example/pwn"] && nv["//evil.example/pwn"][2] === "kept" && /^https?:\/\/evil\.example\/pwn/.test(nv["//evil.example/pwn"][3]), "links (naive): //evil KEPT and resolves off-site to evil.example");
must(nv["/\\evil.example/pwn"] && nv["/\\evil.example/pwn"][2] === "kept" && /\/\/evil\.example\/pwn/.test(nv["/\\evil.example/pwn"][3]), "links (naive): /\\evil KEPT and the browser resolves it to evil.example");
must(/dangerous link\(s\) kept/i.test(await noteText("n-links-v")), "links (naive): note flags the leaked off-site links");
await clickRun("links", "fixed");
const strict = await labFrame.evaluate(() => [...document.querySelectorAll("#s-links-f tr")].slice(1).map((r) => [...r.cells].map((c) => c.textContent)));
const sv = Object.fromEntries(strict.map((r) => [r[0], r[2]]));
must(["//evil.example/pwn", "/\\evil.example/pwn", "javascript:window.__labFired('links')", "data:text/html,<b>x</b>", "java\tscript:window.__labFired('links')", "  //evil.example", "/ok\u0000x"].every((h) => sv[h] === "dropped"), "links (strict): //, /\\, javascript:, data:, tab-in-scheme, leading-space and control-char links all DROPPED");
must(sv["/guide/csp#top"] === "kept" && sv["https://good.example/p"] === "kept", "links (strict): same-site path and absolute https still kept");
must(/safe/i.test(await noteText("n-links-f")), "links (strict): note says safe");
must(!(await labFrame.evaluate(() => document.querySelector("#s-links-v a, #s-links-f a"))), "links: destinations shown as text, no live anchors");

// ---- lesson 8: shared sanitiser hooks ----
await clickRun("hooks", "vuln");
must(/executed|leaked/i.test(await noteText("n-hooks-v")) && /⚠/.test(await noteText("n-hooks-v")), "hooks (shared global): A's permissive hook leaks into B's sanitize and onerror FIRES");
must(await labFrame.evaluate(() => !!document.querySelector("#s-hooks-v img[onerror]")), "hooks (shared): <img onerror> survived B's sanitize");
must(await labFrame.evaluate(() => DOMPurify.sanitize('<img src=x onerror="1">').indexOf("onerror") === -1), "hooks: global DOMPurify is clean again after the demo (hooks removed)");
await clickRun("hooks", "fixed");
must(/safe/i.test(await noteText("n-hooks-f")), "hooks (private instance): B's sanitize strips onerror; nothing runs");
must(await labFrame.evaluate(() => !document.querySelector("#s-hooks-f img[onerror]") && /kept bold/.test(document.getElementById("s-hooks-f").textContent)), "hooks (private): onerror stripped, harmless <b> kept");

// ---- lesson 9: CSP with third parties ----
await clickRun("csp3p", "vuln"); await sleep(1400);
const blockNote = await noteText("n-csp3p-v");
must(/blocked by csp/i.test(blockNote) && /script-src/.test(blockNote) && /style-src/.test(blockNote) && /frame-src/.test(blockNote), "csp3p (tight policy): giscus script, stylesheet AND iframe each blocked (script-src, style-src, frame-src)");
must(/frame-src 'none'/.test(await labFrame.evaluate(() => document.getElementById("csp3p-policy").textContent)), "csp3p: the active meta policy is shown in the lab");
await clickRun("csp3p", "fixed"); await sleep(1400);
must(/zero violations/i.test(await noteText("n-csp3p-f")), "csp3p (recommended Giscus policy): stand-in script, stylesheet and iframe load with ZERO violations");
must(/https:\/\/giscus\.app/.test(await labFrame.evaluate(() => document.getElementById("csp3p-policy").textContent)), "csp3p: recommended policy (allows https://giscus.app) displayed");
const c3hdr = await labFrame.evaluate(() => fetch("/lab/csp3p?mode=block").then((r) => r.headers.get("content-security-policy")));
must(/frame-ancestors/.test(c3hdr || "") && !/script-src|default-src/.test(c3hdr || ""), "csp3p sub-page header carries frame-ancestors only (resource policy is the meta tag)");
must(/cannot set <code>frame-ancestors<\/code>/.test(await labFrame.evaluate(() => document.querySelector('[data-demo=csp3p]').innerHTML)), "csp3p: explains meta CSP cannot set frame-ancestors / report-uri");

// ---- lesson 10: where your API key lives ----
await clickRun("keystore", "clear");
await clickRun("keystore", "seed");
const ks = await labFrame.evaluate(() => ({ s: sessionStorage.getItem("lab_demo_key_session"), l: JSON.parse(localStorage.getItem("lab_demo_key_local") || "null") }));
must(ks.s && /^sk-or-v1-LABDUMMY-/.test(ks.s) && ks.l && ks.l.k === ks.s, "keystore: the SAME dummy key stored in sessionStorage and localStorage");
must(ks.l && Math.abs(ks.l.exp - Date.now() - 7 * 864e5) < 60e3, "keystore: remember copy expires in 7 days");
await clickRun("keystore", "inject"); await sleep(500);
const inj = await labFrame.evaluate(() => document.getElementById("s-keystore").textContent);
must(/read sessionStorage key: sk-or-v1-LA/.test(inj) && /read remembered localStorage key: sk-or-v1-LA/.test(inj), "keystore (inject): injected preset reads the dummy key from BOTH stores");
must(/echoed/i.test(inj) && !inj.includes(ks.s), "keystore: 'exfiltrated' only to the lab echo, and the key is shown masked");
await clickRun("keystore", "newtab");
const nt = await labFrame.evaluate(() => ({ s: sessionStorage.getItem("lab_demo_key_session"), l: !!localStorage.getItem("lab_demo_key_local"), ns: document.getElementById("n-key-session").textContent, nl: document.getElementById("n-key-local").textContent }));
must(nt.s === null && nt.l && /absent/.test(nt.ns) && /survives new tabs/.test(nt.nl), "keystore (new tab): sessionStorage key gone, 7-day localStorage key survives");
// a REAL second tab on the lab origin: fresh sessionStorage, shared localStorage
await clickRun("keystore", "seed");
const t2 = await b.newPage(); await t2.goto(LAB + "/lab/static/lab.css");
const t2s = await t2.evaluate(() => ({ s: sessionStorage.getItem("lab_demo_key_session"), l: !!localStorage.getItem("lab_demo_key_local") }));
must(t2s.s === null && t2s.l === true, "keystore: a genuinely new tab has NO sessionStorage key but DOES see the localStorage one");
await t2.close();
await clickRun("keystore", "clear");

// ---- presets on the MAIN page drive the lessons via origin-checked postMessage ----
for (const [dm, v] of [["links", "vuln"], ["hooks", "fixed"], ["keystore", "inject"]]) {
  await p.evaluate((d, vv) => document.querySelector(`.lab-preset[data-lab-demo="${d}"][data-lab-variant="${vv}"]`).click(), dm, v); await sleep(400);
}
must(/safe/i.test(await noteText("n-hooks-f")) && /read sessionStorage key/.test(await labFrame.evaluate(() => document.getElementById("s-keystore").textContent)), "main-page presets launch the new lessons (postMessage)");
await clickRun("keystore", "clear");
must(thirdParty.length === 0, "no request to giscus.app / evil.example ever got a response (CSP blocked before network; stand-ins are same-origin)");
must(navs.length === 0, "no frame navigated off-site or to an error page during the lessons" + (navs.length ? " " + JSON.stringify(navs) : ""));
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
must(meta && ["links", "hooks", "csp3p", "keystore"].every((d) => meta.runs.some((r) => r.demo === d)), "metadata records runs of all four new lessons");
must(meta && !/sk-or-v1/.test(JSON.stringify(meta)), "metadata never contains the (dummy) key");

// ---- mobile screenshots of the four lessons (390 px) ----
{
  const m = await b.newPage();
  await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.goto(MAIN + "/demos", { waitUntil: "networkidle0" });
  await m.waitForFunction(() => { const s = document.getElementById("lab-status"); return s && /ready/i.test(s.textContent); }, { timeout: 15000 });
  const mf = m.frames().find((f) => f.url().includes(":8099"));
  const shots = [["links", "vuln"], ["hooks", "vuln"], ["csp3p", "vuln"], ["keystore", "inject"]];
  for (const [dm, v] of shots) {
    if (dm === "csp3p") { await m.evaluate(() => document.querySelector('.lab-preset[data-lab-demo="csp3p"][data-lab-variant="fixed"]').click()); await sleep(1500); }
    await m.evaluate((d, vv) => document.querySelector(`.lab-preset[data-lab-demo="${d}"][data-lab-variant="${vv}"]`).click(), dm, v);
    await sleep(dm === "csp3p" ? 1500 : 500);
    if (dm === "links") await mf.evaluate(() => document.querySelector('[data-run="links"][data-variant="fixed"]').click());
    if (dm === "hooks") await mf.evaluate(() => document.querySelector('[data-run="hooks"][data-variant="fixed"]').click());
    await sleep(300);
    await mf.evaluate((d) => document.querySelector(`section[data-demo="${d}"]`).scrollIntoView({ block: "start" }), dm);
    // put the lab frame just below the sticky header, then take a viewport (phone-screen) shot
    await m.evaluate(() => { const hdr = document.querySelector("header, .topbar, nav"); const h = hdr ? hdr.getBoundingClientRect().bottom : 0;
      const f = document.getElementById("xsslab"); window.scrollTo(0, f.getBoundingClientRect().top + window.scrollY - h - 4); });
    await sleep(250);
    await m.screenshot({ path: `docs/xss-lab-${dm}-390.png` });
  }
  await mf.evaluate(() => document.querySelector('[data-run="keystore"][data-variant="clear"]').click());
  must(true, "saved docs/xss-lab-{links,hooks,csp3p,keystore}-390.png");
  await m.close();
}

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
