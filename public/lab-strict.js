// Runs on the strict-CSP sub-page (script-src 'self', no inline). It tries to inject a payload
// via innerHTML; the inline onerror handler is blocked by CSP and a securitypolicyviolation fires.
(function () {
  var blocked = false;
  document.addEventListener("securitypolicyviolation", function (ev) {
    blocked = true;
    var n = document.getElementById("n-strict");
    n.textContent = "Blocked by CSP — securitypolicyviolation: violated " + ev.violatedDirective + " (" + (ev.blockedURI || "inline") + ").";
    n.className = "note ok";
    try { parent.postMessage({ type: "csp-blocked", blocked: true, directive: ev.violatedDirective }, "*"); } catch (e) {}
  });
  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin) return;     // only our own shell may drive this page
    var d = e.data || {};
    if (d.type === "inject") {
      document.getElementById("s-strict").innerHTML = "Injected: " + String(d.payload || "");
      setTimeout(function () {
        if (!blocked) { var n = document.getElementById("n-strict"); n.textContent = "Payload inert (no inline execution allowed)."; n.className = "note ok"; }
      }, 80);
    }
  });
})();
