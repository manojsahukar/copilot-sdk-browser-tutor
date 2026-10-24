/* Manual quality check for Chrome's built-in on-device AI. Uses the widget's own helpers (window.__btw, loaded with
 * data-no-ui="1") so the prompt, budget, retry and streaming code is exactly what the chat widget runs.
 * Same-origin only: reads /widget/site-index.json, the doc pages and /static/chrome-eval-data.json. No other network. */
(function () {
  "use strict";
  var B = window.__btw, $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var Q = [], INDEX = null, PAGES = {}, CARDS = [], results = [], runCtl = null, running = false, STATE = "unknown";

  function setStatus(t) { $("ev-status").textContent = t; }
  function chromeVer() { var m = /Chrome\/(\d+)\.[\d.]+/.exec(navigator.userAgent); return m ? "Chrome " + m[0].slice(7) : "not Chrome"; }

  async function checkEnv() {
    var has = B && B.chromeCapable();
    $("ev-ua").textContent = chromeVer();
    $("ev-support").textContent = has ? "available in this browser (LanguageModel found)" : "not found: open this page in desktop Chrome 148 or newer";
    STATE = has ? await B.chromeAvailability() : "unavailable";
    var label = { available: "ready (model is on this device)", downloadable: "not downloaded yet", downloading: "download in progress or paused",
      unavailable: "unavailable on this device/browser", unknown: "checking…" };
    $("ev-state").textContent = label[STATE] || STATE;
    var need = STATE === "downloadable" || STATE === "downloading";
    $("ev-warn").hidden = !need; $("ev-dl").hidden = !need;
    $("ev-dl").textContent = STATE === "downloading" ? "Continue download" : "Download on-device model";
    syncButtons();
  }
  function syncButtons() {
    var ok = STATE === "available" && Q.length > 0;
    $("ev-runall").disabled = !ok || running; $("ev-stop").disabled = !running;
    CARDS.forEach(function (c) { c.run.disabled = !ok || running; });
  }
  function progress(f) {
    var pct = Math.round(f * 100);
    $("ev-bar").hidden = $("ev-pct").hidden = false;
    $("ev-fill").style.width = pct + "%"; $("ev-bar").setAttribute("aria-valuenow", String(pct)); $("ev-bar").setAttribute("aria-valuetext", pct + " percent");
    $("ev-pct").textContent = "Downloading the on-device model… " + pct + "%";
  }
  async function download() {
    $("ev-dl").disabled = true; progress(0);
    try { await B.chromeDownload(window.LanguageModel, progress); }
    catch (e) { setStatus("Download problem: " + B.redact(String(e && e.message || e))); }
    $("ev-dl").disabled = false; $("ev-bar").hidden = $("ev-pct").hidden = true;
    await checkEnv();
  }

  // The page text the widget would see for a visitor reading that page: the <article>, minus nav/script/style.
  async function pageFor(path) {
    if (PAGES[path]) return PAGES[path];
    var r = await fetch(path, { credentials: "omit" }); var html = await r.text();
    var doc = new DOMParser().parseFromString(html, "text/html");      // inert: scripts in the fetched doc never run
    var art = doc.querySelector("article") || doc.body;
    art.querySelectorAll("script,style,noscript,nav,footer,aside").forEach(function (n) { n.remove(); });
    PAGES[path] = { url: path, title: doc.title || "Tutor Docs", text: B.cleanText(art.textContent || "", 20000) };
    return PAGES[path];
  }

  function buildCard(q, i) {
    var card = el("article", "ev-card"); card.setAttribute("aria-label", "Question " + q.id);
    var h = el("h3", null, q.id + ". " + q.q); card.appendChild(h);
    card.appendChild(el("div", "ev-meta", "Visitor is reading: " + q.page + (q.trap ? "  ·  trap question (the docs do not contain the answer)" : "")));
    var run = el("button", "ev-q-run", "Run this question"); run.type = "button"; card.appendChild(run);
    var meta = el("div", "ev-meta", "Not run yet."); meta.setAttribute("role", "status"); card.appendChild(meta);
    var ans = el("div", "ev-ans", ""); ans.setAttribute("role", "group"); ans.setAttribute("aria-label", "On-device answer to question " + q.id); card.appendChild(ans);
    card.appendChild(el("div", "ev-facts-h", "Key facts a good answer should contain"));
    var ul = el("ul", "ev-facts"); q.facts.forEach(function (f) { ul.appendChild(el("li", null, f)); }); card.appendChild(ul);
    var fs = el("fieldset", "ev-mark"); fs.appendChild(el("legend", null, "Your verdict for question " + q.id));
    ["pass", "fail"].forEach(function (v) {
      var lab = el("label"), inp = document.createElement("input"); inp.type = "radio"; inp.name = "mark" + q.id; inp.value = v;
      inp.addEventListener("change", function () { results[i].mark = v; card.className = "ev-card " + v; summarize(); });
      lab.appendChild(inp); lab.appendChild(document.createTextNode(v === "pass" ? "Pass" : "Fail")); fs.appendChild(lab);
    });
    card.appendChild(fs);
    var notes = el("input", "ev-notes"); notes.type = "text"; notes.maxLength = 300; notes.setAttribute("aria-label", "Optional note for question " + q.id); notes.placeholder = "Optional note (what was wrong?)";
    notes.addEventListener("input", function () { results[i].note = notes.value; }); card.appendChild(notes);
    run.addEventListener("click", function () { runSome([i]); });
    return { card: card, run: run, meta: meta, ans: ans };
  }

  async function runOne(i, signal) {
    var q = Q[i], c = CARDS[i], r = results[i]; c.ans.textContent = ""; c.meta.textContent = "Running…";
    var t0 = performance.now();
    try {
      var page = await pageFor(q.page);
      var hits = INDEX ? B.bm25Search(INDEX, q.q + " " + page.title, 2) : [];
      var res = await B.chromeRun({ siteName: "Tutor Docs", persona: "", page: page, retrieved: hits, history: [], question: q.q, signal: signal,
        onDelta: function (t) { c.ans.textContent = t; } });
      r.answer = res.text; r.level = res.level; r.ms = Math.round(performance.now() - t0); r.error = "";
      c.meta.textContent = "Done in " + (r.ms / 1000).toFixed(1) + " s · prompt budget level " + res.level + " (0 = full, 2 = smallest) · context used " + res.used + "+" + res.need + " of " + (res.window || "?") + " tokens · sources: " + hits.map(function (h) { return h.chunk.heading; }).join("; ");
    } catch (e) {
      r.ms = Math.round(performance.now() - t0);
      if (e && e.name === "AbortError") { r.answer = e.partial || ""; r.error = "stopped"; c.ans.textContent = r.answer + "\n(stopped)"; c.meta.textContent = "Stopped."; }
      else { r.error = B.redact(String(e && (e.name + ": " + e.message) || e)); c.meta.textContent = "Error: " + r.error; }
    }
  }
  async function runSome(idx) {
    if (running) return;
    running = true; runCtl = new AbortController(); syncButtons();
    for (var k = 0; k < idx.length && !runCtl.signal.aborted; k++) {
      setStatus("Running " + (k + 1) + " of " + idx.length + "…"); await runOne(idx[k], runCtl.signal);
    }
    setStatus(runCtl.signal.aborted ? "Stopped" : "Finished"); running = false; runCtl = null; syncButtons();
  }

  function counts() {
    var p = 0, f = 0; results.forEach(function (r) { if (r.mark === "pass") p++; else if (r.mark === "fail") f++; });
    return { p: p, f: f, u: results.length - p - f };
  }
  function summarize() { var c = counts(); $("ev-summary").textContent = c.p + " pass · " + c.f + " fail · " + c.u + " unrated (of " + results.length + ")"; }
  function exportText() {
    var c = counts(), L = [];
    L.push("Chrome on-device quality check — Tutor Docs (English only)");
    L.push("Date: " + new Date().toISOString());
    L.push("Browser: " + chromeVer() + " · model status: " + STATE);
    L.push("Prompt budget levels (page chars / snippet chars / snippets / history turns): " + B.CH_LEVELS.map(function (l) { return l.page + "/" + l.snip + "/" + l.nsnip + "/" + l.turns; }).join("  "));
    L.push("RESULT: " + c.p + " pass, " + c.f + " fail, " + c.u + " unrated of " + results.length);
    L.push("");
    results.forEach(function (r, i) {
      var a = (r.answer || "").replace(/\s+/g, " ").trim(); if (a.length > 700) a = a.slice(0, 700) + "…";
      L.push("#" + Q[i].id + " " + (r.mark ? r.mark.toUpperCase() : "UNRATED") + (r.ms ? " (" + (r.ms / 1000).toFixed(1) + "s, level " + r.level + ")" : "") + " — " + Q[i].q);
      L.push("   answer: " + (a || "(none)") + (r.error ? "  [" + r.error + "]" : ""));
      if (r.note) L.push("   note: " + r.note);
    });
    $("ev-text").value = L.join("\n"); return $("ev-text").value;
  }

  async function init() {
    $("ev-recheck").addEventListener("click", checkEnv);
    $("ev-dl").addEventListener("click", download);
    $("ev-runall").addEventListener("click", function () { runSome(Q.map(function (_, i) { return i; })); });
    $("ev-stop").addEventListener("click", function () { if (runCtl) runCtl.abort(); });
    $("ev-export").addEventListener("click", exportText);
    $("ev-copy").addEventListener("click", async function () {
      var t = exportText();
      try { await navigator.clipboard.writeText(t); setStatus("Copied results to the clipboard."); }
      catch (e) { $("ev-text").select(); setStatus("Select-all done: press Ctrl/Cmd+C to copy."); }
    });
    try {
      var d = await (await fetch("/static/chrome-eval-data.json", { credentials: "omit" })).json(); Q = d.questions || [];
      var ix = await (await fetch("/widget/site-index.json", { credentials: "omit" })).json(); INDEX = B.bm25Index(Array.isArray(ix) ? ix : ix.chunks || []);
    } catch (e) { setStatus("Could not load the question set."); }
    results = Q.map(function () { return { mark: "", note: "", answer: "", error: "", ms: 0, level: 0 }; });
    var list = $("ev-list"); Q.forEach(function (q, i) { var c = buildCard(q, i); CARDS.push(c); list.appendChild(c.card); });
    summarize(); await checkEnv();
  }
  init();
  window.__chromeEval = { runSome: runSome, exportText: exportText, state: function () { return STATE; }, results: function () { return results; } };
})();
