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

  function run(demo, variant) {
    if (demo === "reflected") runReflected(variant);
    else if (demo === "stored") runStored(variant);
    else if (demo === "stored-clear") runStored("clear");
    else if (demo === "dom") runDom(variant);
    else if (demo === "capabilities") runCapabilities();
    else if (demo === "cap-reset") resetCap();
    else if (demo === "defences") runDefences();
    else if (demo === "prompt") runPrompt(variant);
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
    if (e.origin !== MAIN) return;                         // strict origin check for control messages from the app
    if (d.type === "bt-lab-init" && typeof d.token === "string") { token = d.token; enableCustom(); }
    else if (d.type === "bt-lab-run") run(String(d.demo || ""), String(d.variant || "vuln"));
  });
  // tell the parent we're ready so it can hand us a login token
  try { parent.postMessage({ type: "bt-lab-ready" }, MAIN || "*"); } catch (e) {}
})();
