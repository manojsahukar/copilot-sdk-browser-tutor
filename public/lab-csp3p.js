// Lesson 9 sub-page controller (runs under the page's own <meta> CSP). It never reads the URL: the mode comes from
// the server-rendered data-mode attribute (a fixed block|allow enum). It tries to load a third-party-style widget's
// script, stylesheet and iframe, records every securitypolicyviolation, and reports a summary to the lab page.
(function () {
  var mode = document.body.getAttribute("data-mode") === "allow" ? "allow" : "block";
  var policy = (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || "";
  var list = document.getElementById("c3-list"), head = document.getElementById("c3-head");
  var violations = [], loaded = { script: false, style: false, frame: false };
  function li(t, cls) { var x = document.createElement("li"); x.textContent = t; if (cls) x.className = cls; list.appendChild(x); }
  function report(done) {
    try {
      parent.postMessage({ type: "csp3p-report", mode: mode, policy: policy, done: !!done,
        violations: violations.map(function (v) { return { directive: v.directive, blocked: v.blocked }; }), loaded: loaded }, location.origin);
    } catch (e) {}
  }
  document.addEventListener("securitypolicyviolation", function (e) {
    var v = { directive: String(e.effectiveDirective || e.violatedDirective || "?"), blocked: String(e.blockedURI || "inline").slice(0, 80) };
    violations.push(v);
    li("✋ blocked by " + v.directive + ": " + v.blocked, "bad");
    report(false);
  });
  function add(el, kind) {
    // A CSP-blocked iframe can still fire "load" (for the browser's error document), so only trust load in allow mode.
    if (mode === "allow") el.addEventListener("load", function () { loaded[kind] = true; li("✔ " + kind + " loaded", "ok"); report(false); });
    (kind === "frame" ? document.body : document.head).appendChild(el);
  }
  var base = mode === "allow"
    // Recommended policy admits the third party. The lab loads SAME-ORIGIN stand-ins so it never contacts giscus.app.
    ? { script: "/lab/static/csp3p-widget.js", style: "/lab/static/csp3p.css", frame: "/lab/strict" }
    // Tight policy forgets the third party: CSP refuses these BEFORE any request is made (nothing reaches giscus.app).
    : { script: "https://giscus.app/client.js", style: "https://giscus.app/default.css", frame: "https://giscus.app/en/widget" };
  var s = document.createElement("script"); s.src = base.script; add(s, "script");
  var l = document.createElement("link"); l.rel = "stylesheet"; l.href = base.style; add(l, "style");
  var f = document.createElement("iframe"); f.src = base.frame; f.title = "third-party frame"; f.className = "c3frame"; add(f, "frame");
  setTimeout(function () {
    head.textContent = violations.length
      ? "Tight policy: " + violations.length + " load(s) refused. Each fired a securitypolicyviolation event."
      : "Recommended policy: script, stylesheet and iframe admitted, zero violations.";
    report(true);
  }, 900);
})();
