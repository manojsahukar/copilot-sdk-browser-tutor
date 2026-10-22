// Client for the contained XSS lab. Deliberately uses unsafe sinks in the "vulnerable"
// variants; the "fixed" variants show the safe pattern. SECURITY: this file NEVER reads a
// payload from location.search / location.hash / location.pathname — payloads come only from
// in-page buttons (when framed by the main app) or postMessage from the main origin.
(function () {
  var MAIN = window.BT_MAIN_ORIGIN || "";
  var framed = window.top !== window.self;
  var gate = document.getElementById("gate"), lab = document.getElementById("lab");
  var token = null;
  var fired = {};                      // tag -> true when an injected handler ran
  window.__labResults = fired;
  window.__labFired = function (tag) { fired[tag] = true; };

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function note(id, txt, cls) { var el = document.getElementById(id); if (el) { el.textContent = txt; el.className = "note " + (cls || ""); } }
  function report(meta) { try { parent.postMessage(Object.assign({ type: "bt-lab-result", at: Date.now() }, meta), MAIN || "*"); } catch (e) {} }
  function exfil(data) { return fetch("/lab/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ captured: data }) }).then(function (r) { return r.json(); }); }

  // --- curated, harmless payloads (defined here, never taken from the URL) ---
  var P = {
    reflected: '<img src=x onerror="window.__labFired(\'reflected\')">',
    stored: '<img src=x onerror="window.__labFired(\'stored\')">',
    dom: '<img src=x onerror="window.__labFired(\'dom\')">',
    capabilities: '<img src=x onerror="window.__cap()">',
    promptModel: "Here's a tip for you:\n\n<script>window.__labFired('prompt-script')<\/script>\n\n<img src=x onerror=\"window.__labFired('prompt-img')\">\n\n[totally safe link](javascript:window.__labFired('prompt-link'))\n\n**Bold** advice and a list:\n\n- first\n- second\n\n| col | val |\n|---|---|\n| a | 1 |",
  };

  function afterInject(tag, noteId, demo, variant) {
    setTimeout(function () {
      var exec = !!fired[tag];
      note(noteId, exec ? "⚠ Script executed — the injected onerror handler ran in this page." : "No script ran.", exec ? "bad" : "ok");
      report({ demo: demo, variant: variant, executed: exec, blocked: false, defence: null });
    }, 60);
  }

  // ---- demos ----
  function runReflected(variant) {
    fired.reflected = false;
    if (variant === "vuln") { document.getElementById("s-reflected-v").innerHTML = "You searched for: " + P.reflected; afterInject("reflected", "n-reflected-v", "reflected", "vuln"); }
    else { document.getElementById("s-reflected-f").textContent = "You searched for: " + P.reflected; note("n-reflected-f", "Safe: the payload is shown as literal text (textContent), so nothing executes.", "ok"); report({ demo: "reflected", variant: "fixed", executed: false, blocked: true, defence: "textContent" }); }
  }
  function renderGuestbook() {
    var list = JSON.parse(localStorage.getItem("lab_guestbook") || "[]");
    var v = document.getElementById("s-stored-v"), f = document.getElementById("s-stored-f");
    v.innerHTML = list.map(function (e) { return "<div class=gb>" + e + "</div>"; }).join("");   // VULNERABLE
    f.textContent = ""; list.forEach(function (e) { var d = document.createElement("div"); d.className = "gb"; d.textContent = e; f.appendChild(d); }); // SAFE
    return list.length;
  }
  function runStored(variant) {
    if (variant === "clear") { localStorage.removeItem("lab_guestbook"); renderGuestbook(); note("n-stored-v", "Guestbook cleared.", "ok"); note("n-stored-f", "", ""); return; }
    fired.stored = false;
    var list = JSON.parse(localStorage.getItem("lab_guestbook") || "[]");
    list.push(P.stored); localStorage.setItem("lab_guestbook", JSON.stringify(list.slice(-10)));
    renderGuestbook();
    if (variant === "vuln") afterInject("stored", "n-stored-v", "stored", "vuln");
    else { note("n-stored-f", "Safe: the same stored entry is rendered with textContent, so it never executes.", "ok"); report({ demo: "stored", variant: "fixed", executed: false, blocked: true, defence: "textContent" }); }
  }
  function runDom(variant) {
    fired.dom = false;
    var fakeLocationValue = P.dom;                 // a SIMULATED location value — the real URL is never read
    var jsLink = "javascript:window.__labFired('dom-link')";
    if (variant === "vuln") {
      document.getElementById("s-dom-v").innerHTML = fakeLocationValue + ' <a href="' + jsLink + '">a javascript: link</a>';
      afterInject("dom", "n-dom-v", "dom", "vuln");
    } else {
      var sink = document.getElementById("s-dom-f"); sink.textContent = fakeLocationValue + " ";
      var a = document.createElement("a"); a.textContent = "a javascript: link";
      a.href = /^https?:/i.test(jsLink) ? jsLink : "#";    // scheme validation
      if (a.getAttribute("href") === "#") a.title = "blocked non-http(s) scheme";
      sink.appendChild(a);
      note("n-dom-f", "Safe: value escaped via textContent and the link's scheme validated (javascript: rejected).", "ok");
      report({ demo: "dom", variant: "fixed", executed: false, blocked: true, defence: "escape + scheme check" });
    }
  }
  window.__cap = function () {
    var ul = document.getElementById("caplist"); ul.innerHTML = "";
    function li(t) { var x = document.createElement("li"); x.textContent = t; ul.appendChild(x); }
    var ck = document.cookie || "(none)";
    li("Read JS-visible cookies: " + ck + "  (the HttpOnly lab cookie is NOT here)");
    var ls = []; for (var i = 0; i < localStorage.length; i++) ls.push(localStorage.key(i));
    li("Read localStorage keys: " + (ls.join(", ") || "(none)"));
    // fake login (phishing) — harmless, scoped to a container
    document.getElementById("cap-login").innerHTML = '<form id=fakelogin class=fakelogin><b>Session expired — please sign in</b>' +
      '<input placeholder="username" autocomplete=off><input placeholder="password" type=password autocomplete=off><button>Sign in</button><div class=mini id=fakecap></div></form>';
    li("Rewrote a page region into a fake login form (phishing).");
    var keys = 0, form = document.getElementById("fakelogin");
    form.addEventListener("keydown", function () { keys++; document.getElementById("fakecap").textContent = "keystrokes captured (dummy): " + keys; });
    form.addEventListener("submit", function (e) { e.preventDefault(); document.getElementById("fakecap").textContent = "captured dummy credentials (not stored, not sent anywhere real)"; });
    li("Installed a keystroke logger on the fake form.");
    exfil(ck).then(function (r) { li("Exfiltrated the cookie to the lab echo endpoint; it echoed back: " + r.echoed); });
    fired.capabilities = true;
    report({ demo: "capabilities", variant: "vuln", executed: true, blocked: false, defence: null });
  };
  function runCapabilities() { fired.capabilities = false; document.getElementById("s-cap").innerHTML = "Profile card: " + P.capabilities; note("", "", ""); }
  function resetCap() { document.getElementById("caplist").innerHTML = ""; document.getElementById("cap-login").innerHTML = ""; document.getElementById("s-cap").innerHTML = ""; }

  function runDefences() {
    // HttpOnly
    var hasJs = /lab_dummy_js/.test(document.cookie), hasSecret = /lab_secret_httponly/.test(document.cookie);
    note("n-httponly", "document.cookie JS-visible dummy present: " + hasJs + " · HttpOnly secret cookie present to JS: " + hasSecret + " (HttpOnly hides it).", hasSecret ? "bad" : "ok");
    // DOMPurify
    fired["purify-FAIL"] = false;
    var hostile = '<img src=x onerror="window.__labFired(\'purify-FAIL\')"> <b>kept bold</b> <a href="javascript:alert(1)">link</a>';
    document.getElementById("s-purify").innerHTML = window.DOMPurify ? DOMPurify.sanitize(hostile) : esc(hostile);
    setTimeout(function () { note("n-purify", fired["purify-FAIL"] ? "Unexpected: payload ran." : "Sanitised: <img>/onerror and javascript: link stripped; <b> kept. Nothing ran.", fired["purify-FAIL"] ? "bad" : "ok"); }, 60);
    // Trusted Types
    note("n-tt", window.trustedTypes ? "Trusted Types IS supported here: assigning a raw string to innerHTML can be forced to throw via a CSP require-trusted-types-for directive." : "Trusted Types is not supported in this browser.", "ok");
    // Strict-CSP sub-frame
    var sf = document.getElementById("strictframe");
    try { sf.contentWindow.postMessage({ type: "inject", payload: P.reflected }, location.origin); } catch (e) {}
    report({ demo: "defences", variant: "x", executed: false, blocked: true, defence: "CSP + HttpOnly + DOMPurify + Trusted Types" });
  }

  function runPrompt(variant) {
    fired["prompt-img"] = false; fired["prompt-script"] = false; fired["prompt-link"] = false;
    if (variant === "vuln") {
      document.getElementById("s-prompt-v").innerHTML = P.promptModel; // naive — onerror fires (inline <script> won't, per spec)
      setTimeout(function () { var exec = fired["prompt-img"] || fired["prompt-script"]; note("n-prompt-v", exec ? "⚠ Hostile model output executed (onerror fired) via naive innerHTML." : "No script ran.", exec ? "bad" : "ok"); report({ demo: "prompt", variant: "vuln", executed: !!exec, blocked: false, defence: null }); }, 60);
    } else {
      var html = window.marked ? marked.parse(P.promptModel) : esc(P.promptModel);
      if (window.DOMPurify) {
        DOMPurify.addHook && DOMPurify.addHook("afterSanitizeAttributes", function (n) { if (n.tagName === "A") { var h = n.getAttribute("href") || ""; if (!/^https?:\/\//i.test(h)) n.removeAttribute("href"); } });
        html = DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "script", "style", "iframe"] });
      }
      document.getElementById("s-prompt-f").innerHTML = html;
      setTimeout(function () { note("n-prompt-f", "Neutralised: rendered through the same marked + DOMPurify pipeline the real app uses. No script, no img/onerror, no javascript: links.", "ok"); report({ demo: "prompt", variant: "fixed", executed: false, blocked: true, defence: "marked + DOMPurify" }); }, 60);
    }
  }

  function runCustom() {
    var payload = (document.getElementById("custom-input").value || "").slice(0, 200);
    fetch("/lab/run-custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token, payload: payload }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { note("n-custom", res.j.error || "blocked", "bad"); return; }
        fired.custom = false;
        document.getElementById("s-custom").innerHTML = res.j.payload;   // vulnerable sink
        setTimeout(function () { note("n-custom", fired.custom ? "⚠ Your payload executed." : "Rendered. (If it had an onerror/img it would run here.)", fired.custom ? "bad" : "ok"); report({ demo: "custom", variant: "vuln", executed: !!fired.custom, blocked: false, defence: null }); }, 60);
      });
  }

  // ---- lesson 7: sneaky links (naive relative-link check vs strict safeHref) ----
  var LINK_SAMPLES = [
    { href: "//evil.example/pwn", about: "protocol-relative //" },
    { href: "/\\evil.example/pwn", about: "backslash //" },
    { href: "javascript:window.__labFired('links')", about: "javascript: scheme" },
    { href: "data:text/html,<b>x</b>", about: "data: document" },
    { href: "java\tscript:window.__labFired('links')", about: "tab inside scheme" },
    { href: "  //evil.example", about: "leading spaces" },
    { href: "/ok\u0000x", about: "control char" },
    { href: "/guide/csp#top", about: "same-site root path" },
    { href: "https://good.example/p", about: "absolute https" }
  ];
  // The OLD, naive rule the widget used to ship: keep anything that is absolute http(s) OR starts with "/".
  function naiveKeep(h) { return /^https?:\/\//i.test(h) || /^\//.test(h); }
  // The strict filter (same logic as the shipped widget's safeHref).
  function strictKeep(h) {
    h = String(h == null ? "" : h);
    if (!h || /[\u0000-\u0020\u007f-\u009f\u2028\u2029\\]/.test(h)) return false;
    if (/^\/(?![\/\\])/.test(h)) return true;
    if (!/^https?:\/\/[^\/\\]/i.test(h)) return false;
    try { var u = new URL(h); return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname; } catch (e) { return false; }
  }
  var LAB_PAGE = location.origin + "/lab/guide";   // a fixed "current page" for resolving; the real URL is never read
  function resolveWhere(h) {
    try { var u = new URL(h, LAB_PAGE); var off = u.origin !== location.origin; var scheme = u.protocol.replace(":", ""); return { url: u.href, off: off, scheme: scheme }; }
    catch (e) { return { url: "(does not resolve to a URL)", off: false, scheme: "" }; }
  }
  function runLinks(variant) {
    var keep = variant === "fixed" ? strictKeep : naiveKeep;
    var sink = document.getElementById(variant === "fixed" ? "s-links-f" : "s-links-v");
    var leaked = 0;
    var rows = LINK_SAMPLES.map(function (s0) {
      var kept = keep(s0.href), w = resolveWhere(s0.href);
      // Dangerous = kept AND either a script/document scheme, or it LOOKED relative but resolves off-site.
      var danger = kept && ((w.scheme && w.scheme !== "http" && w.scheme !== "https") || (w.off && !/^https?:\/\//i.test(s0.href)));
      if (danger) leaked++;
      var td = document.createElement("tr");
      [s0.href, s0.about, kept ? "kept" : "dropped", kept ? w.url : "—"].forEach(function (c, i) {
        var cell = document.createElement("td"); cell.textContent = c;
        if (i === 2) cell.className = kept ? (danger ? "bad" : "ok") : "ok";
        td.appendChild(cell);
      });
      return td;
    });
    sink.textContent = "";
    var tbl = document.createElement("table"); tbl.className = "linktbl";
    var hd = document.createElement("tr"); ["link", "what", keep === strictKeep ? "strict" : "naive", "would navigate to"].forEach(function (h) { var th = document.createElement("th"); th.textContent = h; hd.appendChild(th); }); tbl.appendChild(hd);
    rows.forEach(function (r) { tbl.appendChild(r); }); sink.appendChild(tbl);
    if (variant === "fixed") { note("n-links-f", leaked === 0 ? "Safe: every off-site and non-http(s) link lost its href. Only same-site paths and absolute http(s) URLs survive." : "Unexpected: a dangerous link survived.", leaked === 0 ? "ok" : "bad"); report({ demo: "links", variant: "fixed", executed: false, blocked: true, defence: "safeHref" }); }
    else { note("n-links-v", leaked + " dangerous link(s) kept: the naive 'starts with /' rule lets //evil and /\\evil through — they resolve OFF this site.", leaked ? "bad" : "ok"); report({ demo: "links", variant: "vuln", executed: false, blocked: false, defence: null }); }
  }

  // ---- lesson 8: shared sanitiser hooks leaking between two scripts ----
  var HOOK_HOSTILE = '<img src=x onerror="window.__labFired(\'hooks\')"> <b>kept bold</b>';
  function whenFired(tag, maxMs, cb) { var t0 = Date.now(); (function poll() { if (fired[tag] || Date.now() - t0 >= maxMs) return cb(!!fired[tag]); setTimeout(poll, 50); })(); }
  function galleryHook(node, data) { if (data.attrName === "onerror") data.forceKeepAttr = true; }
  function runHooks(variant) {
    fired.hooks = false;
    var sinkId = variant === "fixed" ? "s-hooks-f" : "s-hooks-v", noteId = variant === "fixed" ? "n-hooks-f" : "n-hooks-v";
    if (!window.DOMPurify) { note(noteId, "DOMPurify not loaded.", "bad"); return; }
    if (variant === "vuln") {
      // Script A (a gallery with "fallback image" handlers) adds a PERMISSIVE hook to the SHARED global DOMPurify.
      DOMPurify.addHook("uponSanitizeAttribute", galleryHook);
      try {
        // Script B (a chat box) just wants safe text; it sanitises a hostile reply on the SAME global, inheriting A's hooks.
        document.getElementById(sinkId).innerHTML = DOMPurify.sanitize(HOOK_HOSTILE);
      } finally {
        DOMPurify.removeAllHooks();   // clean up so the rest of the lab is unaffected (A forgetting this IS the bug)
      }
      // onerror fires only after the broken image load fails (a network round-trip on a CDN), so poll rather than guess a delay.
      whenFired("hooks", 2000, function (ran) { note(noteId, ran ? "⚠ Script B's output executed — Script A's permissive hook leaked into the shared DOMPurify, keeping <img onerror>." : "No script ran.", ran ? "bad" : "ok"); report({ demo: "hooks", variant: "vuln", executed: ran, blocked: false, defence: null }); });
    } else {
      // Fixed: Script A sanitises on its OWN private instance; Script B's global sanitize is untouched.
      var dpA = DOMPurify(window);
      dpA.addHook("uponSanitizeAttribute", galleryHook);            // the SAME permissive hook, on A's private instance
      dpA.sanitize('<img src="/lab/static/none.png">');             // A does its permissive thing, privately
      document.getElementById(sinkId).innerHTML = DOMPurify.sanitize(HOOK_HOSTILE);  // B on the clean global
      // give a (wrongly) kept onerror the same time to fire before declaring it safe
      setTimeout(function () { note(noteId, fired.hooks ? "Unexpected: payload ran." : "Safe: Script A used a private DOMPurify(window) instance, so Script B's global sanitize still stripped onerror (the image stays, inert).", fired.hooks ? "bad" : "ok"); report({ demo: "hooks", variant: "fixed", executed: false, blocked: true, defence: "private DOMPurify instance" }); }, 1200);
    }
  }

  // ---- lesson 9: CSP with third parties (two sub-frames with their own meta CSP) ----
  function runCsp3p(variant) {
    var allow = variant === "fixed";
    var frame = document.getElementById(allow ? "csp3p-allow" : "csp3p-block");
    note(allow ? "n-csp3p-f" : "n-csp3p-v", "Loading…", "");
    frame.src = "/lab/csp3p?mode=" + (allow ? "allow" : "block") + "&t=" + Date.now();
  }

  // ---- lesson 10: where your API key lives (DUMMY key; sessionStorage vs 7-day localStorage) ----
  var K_SESS = "lab_demo_key_session", K_LOCAL = "lab_demo_key_local";
  function maskKey(k) { k = String(k || ""); return k ? k.slice(0, 11) + "\u2026" + k.slice(-4) + " (" + k.length + " chars)" : "(absent)"; }
  function readLocalKey() { try { var o = JSON.parse(localStorage.getItem(K_LOCAL) || "null"); return o && o.exp > Date.now() ? o : null; } catch (e) { return null; } }
  function keyStatus() {
    var sk = sessionStorage.getItem(K_SESS), lo = readLocalKey();
    note("n-key-session", "sessionStorage[" + K_SESS + "] = " + maskKey(sk) + (sk ? " \u2014 lives only in THIS tab; gone when it closes." : " \u2014 nothing stored (or the tab was closed)."), sk ? "bad" : "ok");
    note("n-key-local", lo ? ("localStorage[" + K_LOCAL + "] = " + maskKey(lo.k) + " \u2014 survives new tabs; expires " + new Date(lo.exp).toISOString().slice(0, 10) + ".") : ("localStorage[" + K_LOCAL + "] = (absent/expired)"), lo ? "bad" : "ok");
  }
  function runKeystore(variant) {
    if (variant === "clear") { sessionStorage.removeItem(K_SESS); localStorage.removeItem(K_LOCAL); document.getElementById("s-keystore").textContent = ""; keyStatus(); return; }
    if (variant === "seed") {
      var key = "sk-or-v1-LABDUMMY-" + Math.random().toString(36).slice(2, 10);   // DUMMY, never a real key
      sessionStorage.setItem(K_SESS, key);
      localStorage.setItem(K_LOCAL, JSON.stringify({ k: key, exp: Date.now() + 7 * 24 * 3600e3 }));
      document.getElementById("s-keystore").textContent = "Stored the SAME dummy key two ways. Now fire the injected script, or simulate closing the tab.";
      keyStatus(); return;
    }
    if (variant === "newtab") {
      // A new tab gets a fresh (empty) sessionStorage but shares localStorage. Simulate by dropping the tab key only.
      sessionStorage.removeItem(K_SESS);
      document.getElementById("s-keystore").textContent = "Simulated a new tab: sessionStorage is empty here, but the 7-day localStorage copy is still readable.";
      keyStatus(); return;
    }
    // inject: a curated payload reads BOTH stores (neither is HttpOnly) and 'exfiltrates' the dummy values to the echo.
    if (!sessionStorage.getItem(K_SESS) && !readLocalKey()) runKeystore("seed");
    fired.keystore = true;
    var sk = sessionStorage.getItem(K_SESS), lo = readLocalKey();
    var ul = document.getElementById("s-keystore"); ul.textContent = "";
    function line(t) { var d = document.createElement("div"); d.textContent = t; ul.appendChild(d); }
    line("Injected script read sessionStorage key: " + maskKey(sk));
    line("Injected script read remembered localStorage key: " + maskKey(lo && lo.k));
    exfil("dummy-key " + maskKey(sk || (lo && lo.k))).then(function (r) { line("'Exfiltrated' the dummy key to the lab echo endpoint; it echoed: " + r.echoed); });
    keyStatus();
    note("n-key-session", "⚠ Any same-origin script read it — sessionStorage is NOT HttpOnly.", "bad");
    report({ demo: "keystore", variant: "inject", executed: true, blocked: false, defence: null });
  }

  function run(demo, variant) {
    if (demo === "reflected") runReflected(variant);
    else if (demo === "stored") runStored(variant);
    else if (demo === "stored-clear") runStored("clear");
    else if (demo === "dom") runDom(variant);
    else if (demo === "capabilities") runCapabilities();
    else if (demo === "cap-reset") resetCap();
    else if (demo === "defences") runDefences();
    else if (demo === "prompt") runPrompt(variant);
    else if (demo === "links") runLinks(variant);
    else if (demo === "hooks") runHooks(variant);
    else if (demo === "csp3p") runCsp3p(variant);
    else if (demo === "keystore") runKeystore(variant);
  }

  function enableCustom() { document.getElementById("custom-input").disabled = false; document.getElementById("custom-input").placeholder = "e.g. <img src=x onerror=...>"; document.getElementById("custom-run").disabled = false; }

  // ---- wiring (only when framed by the main app) ----
  if (!framed) { gate.hidden = false; lab.hidden = true; return; }
  gate.hidden = true; lab.hidden = false;
  var hostEl = document.getElementById("labhost"); if (hostEl) hostEl.textContent = location.host;
  // seed dummy localStorage (clearly labelled)
  try { if (!localStorage.getItem("lab_dummy")) localStorage.setItem("lab_dummy", JSON.stringify({ note: "dummy lab data", id: "LAB-" + Math.random().toString(36).slice(2, 8) })); } catch (e) {}

  document.querySelectorAll("[data-run]").forEach(function (b) { b.addEventListener("click", function () { run(b.getAttribute("data-run"), b.getAttribute("data-variant")); }); });
  document.getElementById("custom-run").addEventListener("click", runCustom);

  window.addEventListener("message", function (e) {
    var d = e.data || {};
    // messages from our own strict-CSP sub-frame (same lab origin) report the CSP block
    if (e.origin === location.origin && d.type === "csp-blocked") { note("n-csp", "Blocked by CSP \u2014 the strict sub-page raised securitypolicyviolation (" + (d.directive || "script-src") + "). The same payload that fired above is inert here.", "ok"); return; }
    if (e.origin === location.origin && d.type === "csp3p-report") {
      var pol = document.getElementById("csp3p-policy"); if (pol && d.policy) pol.textContent = "meta CSP (" + d.mode + "):\n" + d.policy;
      if (d.mode === "allow") {
        var dirs = (d.violations || []).map(function (v) { return v.directive; });
        note("n-csp3p-f", dirs.length ? ("Unexpected violations: " + dirs.join(", ")) : "Allowed: script, stylesheet and iframe loaded with ZERO violations because the policy lists the third party.", dirs.length ? "bad" : "ok");
        if (d.done) { fired["csp3p-allow"] = dirs.length === 0; report({ demo: "csp3p", variant: "fixed", executed: false, blocked: false, defence: "CSP allowlist (script/style/frame-src)" }); }
      } else {
        var blocked = {}; (d.violations || []).forEach(function (v) { blocked[v.directive] = true; });
        var names = Object.keys(blocked);
        note("n-csp3p-v", names.length ? ("Blocked by CSP: " + names.join(", ") + ". Each load fired a securitypolicyviolation and no request ever reached giscus.app.") : "Loading…", "ok");
        if (d.done) { fired["csp3p-block"] = names.length > 0; report({ demo: "csp3p", variant: "vuln", executed: false, blocked: true, defence: "CSP blocks un-allowlisted third parties" }); }
      }
      return;
    }
    if (e.origin !== MAIN) return;                         // strict origin check for control messages from the app
    if (d.type === "bt-lab-init" && typeof d.token === "string") { token = d.token; enableCustom(); }
    else if (d.type === "bt-lab-run") {
      var dm = String(d.demo || ""); run(dm, String(d.variant || "vuln"));
      var sec = /^[a-z0-9]+$/.test(dm) && document.querySelector('section[data-demo="' + dm + '"]');
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: "start" });
    }
  });
  // tell the parent we're ready so it can hand us a login token
  try { parent.postMessage({ type: "bt-lab-ready" }, MAIN || "*"); } catch (e) {}
})();
