// Static, reviewed demo implementations. No code ever comes from the model.
// Results are metadata only; they're stashed in sessionStorage so the chat tab can send them to the tutor.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const host = document.getElementById("demos");
  let SIB = null;
  const saveResult = (id, data) => { try { const m = JSON.parse(sessionStorage.getItem("bt_demo") || "{}"); m[id] = { ...data, at: new Date().toISOString() }; sessionStorage.setItem("bt_demo", JSON.stringify(m)); } catch {} };
  const out = (id, html, cls = "") => { const el = document.getElementById("out-" + id); el.innerHTML = html; el.className = "demo-out " + cls; };

  const RUNNERS = {
    async storage_inspector(id) {
      const bytes = (str) => { try { return new Blob([str]).size; } catch { return (str || "").length; } };
      const fmt = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB";
      const mask = (v) => { v = String(v); return v.length <= 2 ? "\u2022\u2022" : v[0] + "\u2022".repeat(Math.min(12, v.length - 2)) + v[v.length - 1] + " (" + v.length + " chars)"; };
      // ----- localStorage (this is where the tutor keeps your chat transcript) -----
      const ls = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); const val = localStorage.getItem(k) || ""; ls.push({ k, size: bytes(k + val), val }); }
      let chatMeta = null, chatPreview = "";
      const chatEntry = ls.find((e) => e.k === "bt_chat");
      if (chatEntry) { try { const o = JSON.parse(chatEntry.val); const msgs = Array.isArray(o.messages) ? o.messages : []; chatMeta = { messages: msgs.length, savedAt: o.savedAt ? new Date(o.savedAt).toLocaleString() : "?", expiresAt: o.expiresAt ? new Date(o.expiresAt).toLocaleString() : "?" }; const first = msgs[0]; if (first) chatPreview = (first.role || "?") + ": " + String(first.text || "").slice(0, 80); } catch {} }
      // ----- sessionStorage -----
      const ss = [];
      for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); const val = sessionStorage.getItem(k) || ""; ss.push({ k, size: bytes(k + val) }); }
      // ----- IndexedDB -----
      let idb = [];
      try { if (indexedDB.databases) idb = (await indexedDB.databases()).map((d) => d.name).filter(Boolean); } catch {}
      // ----- cookies visible to JS (HttpOnly ones like bt_sess are deliberately absent) -----
      const cookies = (document.cookie || "").split(";").map((c) => c.trim()).filter(Boolean).map((c) => { const eq = c.indexOf("="); return { name: eq < 0 ? c : c.slice(0, eq), value: eq < 0 ? "" : c.slice(eq + 1) }; });
      // ----- quota / persistence -----
      let quota = null;
      try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); let persisted = null; try { persisted = await navigator.storage.persisted(); } catch {} quota = { usage: e.usage || 0, quota: e.quota || 0, persisted }; } } catch {}

      // METADATA ONLY to the tutor: names, sizes, counts, quota. Never content, previews or cookie values.
      saveResult(id, {
        localStorageKeys: ls.map((e) => ({ name: e.k, bytes: e.size })),
        chatHistory: chatMeta,
        sessionStorageKeys: ss.map((e) => ({ name: e.k, bytes: e.size })),
        indexedDbDatabases: idb,
        jsVisibleCookieNames: cookies.map((c) => c.name),
        httpOnlyCookiesHiddenFromJs: true,
        quotaBytes: quota && quota.quota, usageBytes: quota && quota.usage, persisted: quota && quota.persisted,
      });

      const cell = (title, inner) => `<div class="stor-cell"><h4>${esc(title)}</h4>${inner}</div>`;
      const lsInner = ls.length ? `<table class="stor-tbl"><tr><th>key</th><th>size</th></tr>${ls.map((e) => `<tr><td>${esc(e.k)}</td><td>${fmt(e.size)}</td></tr>`).join("")}</table>` +
        (chatMeta ? `<p class="kv"><b>bt_chat</b> = your chat transcript: ${chatMeta.messages} messages, saved ${esc(chatMeta.savedAt)}, expires ${esc(chatMeta.expiresAt)}.<br>First entry preview (shown only to you): <code>${esc(chatPreview || "(empty)")}</code></p>` : `<p class="kv muted">No saved chat yet \u2014 send a message in Ask tutor, then re-run.</p>`)
        : `<p class="kv muted">empty</p>`;
      const ssInner = ss.length ? `<table class="stor-tbl"><tr><th>key</th><th>size</th></tr>${ss.map((e) => `<tr><td>${esc(e.k)}</td><td>${fmt(e.size)}</td></tr>`).join("")}</table>` : `<p class="kv muted">empty (per-tab; cleared when this tab closes)</p>`;
      const idbInner = idb.length ? `<ul class="kv">${idb.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : `<p class="kv muted">no databases</p>`;
      const ckInner = cookies.length ? `<table class="stor-tbl"><tr><th>name</th><th>value (masked)</th></tr>${cookies.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(mask(c.value))}</td></tr>`).join("")}</table>` : `<p class="kv muted">none readable by JS</p>`;
      const qInner = quota ? `<p class="kv">Using <b>${fmt(quota.usage)}</b> of ~<b>${fmt(quota.quota)}</b> quota.<br>Durable (persisted): <b>${quota.persisted === null ? "unknown" : quota.persisted}</b></p>` : `<p class="kv muted">Storage estimate not available in this browser.</p>`;

      const el = document.getElementById("out-" + id); el.className = "demo-out ok";
      el.innerHTML =
        `<div class="stor-grid">${cell("localStorage (stays in browser)", lsInner)}${cell("sessionStorage (per tab)", ssInner)}${cell("IndexedDB", idbInner)}${cell("Cookies visible to JS", ckInner)}${cell("Quota & persistence", qInner)}</div>` +
        `<p class="kv"><b>The lesson:</b> your chat is kept in <code>localStorage</code> on <b>${esc(location.hostname)}</b> \u2014 any JavaScript on this origin (or a browser extension) can read it, and one XSS would leak it. The <code>bt_sess</code> session cookie is <b>HttpOnly</b>, so it is missing from the cookie list above on purpose: JS cannot read it. <code>sibling.demo.curiosta.com</code> can\u2019t read this localStorage at all (Web Storage is origin-scoped) even though it does receive the parent-domain demo cookie. Only key names, sizes, counts and quota were shared with the tutor \u2014 never the content.</p>` +
        `<div class="demo-run"><button class="btn secondary" id="clr-${id}">Clear this site\u2019s stored data</button></div>`;
      document.getElementById("clr-" + id).onclick = () => {
        try { localStorage.removeItem("bt_chat"); sessionStorage.removeItem("bt_demo"); } catch {}
        out(id, "Cleared this site\u2019s chat history and demo results from your browser. Re-run to confirm.", "ok");
      };
    },
    async camera(id) {
      out(id, "Requesting camera… (allow the prompt)");
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const t = stream.getVideoTracks()[0], s = t.getSettings();
      const meta = { granted: true, trackLabelPresent: !!t.label, width: s.width, height: s.height, frameRate: s.frameRate, facingMode: s.facingMode || null };
      saveResult(id, meta);
      const v = document.createElement("video"); v.autoplay = v.muted = v.playsInline = true; v.srcObject = stream; v.className = "preview";
      const el = document.getElementById("out-" + id); el.className = "demo-out ok"; el.textContent = ""; el.appendChild(v);
      el.insertAdjacentHTML("beforeend", `<div class="kv">Live preview stays on your device. Site learns: ${s.width}×${s.height} @ ${Math.round(s.frameRate)||"?"}fps, label ${t.label ? "readable" : "hidden"}.</div>`);
      const stop = document.createElement("button"); stop.className = "btn secondary"; stop.textContent = "Stop camera";
      stop.onclick = () => { stream.getTracks().forEach((x) => x.stop()); v.remove(); stop.remove(); el.insertAdjacentHTML("beforeend", "<div class='kv'>Stopped. The camera light is off.</div>"); };
      el.appendChild(stop);
    },
    async microphone(id) {
      out(id, "Requesting microphone… (allow the prompt)");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const t = stream.getAudioTracks()[0], s = t.getSettings();
      saveResult(id, { granted: true, sampleRate: s.sampleRate, channelCount: s.channelCount, echoCancellation: s.echoCancellation });
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const an = ac.createAnalyser(); an.fftSize = 256; ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const el = document.getElementById("out-" + id); el.className = "demo-out ok";
      el.innerHTML = `<div class="kv">Mic live. Site learns: ${s.sampleRate||"?"} Hz, ${s.channelCount||"?"} ch. Audio is analysed locally for this meter only.</div><div class="meter"><span id="mlvl-${id}"></span></div>`;
      const bar = document.getElementById("mlvl-" + id); let on = true;
      (function loop() { if (!on) return; an.getByteFrequencyData(buf); const avg = buf.reduce((a, b) => a + b, 0) / buf.length; bar.style.width = Math.min(100, avg * 1.5) + "%"; requestAnimationFrame(loop); })();
      const stop = document.createElement("button"); stop.className = "btn secondary"; stop.textContent = "Stop mic";
      stop.onclick = () => { on = false; stream.getTracks().forEach((x) => x.stop()); ac.close(); stop.remove(); el.insertAdjacentHTML("beforeend", "<div class='kv'>Stopped.</div>"); };
      el.appendChild(stop);
    },
    async geolocation(id) {
      out(id, "Requesting location… (allow the prompt)");
      const pos = await new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, no, { enableHighAccuracy: true, timeout: 15000 }));
      const c = pos.coords, round = (n) => Math.round(n * 10) / 10; // ~0.1° ≈ 11 km
      saveResult(id, { granted: true, coarseLat: round(c.latitude), coarseLon: round(c.longitude), accuracyMeters: Math.round(c.accuracy) });
      out(id, `<div class="kv"><b>Shown only to you:</b> ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)} (±${Math.round(c.accuracy)} m).<br>` +
        `<b>Sent to tutor (coarse):</b> ${round(c.latitude)}, ${round(c.longitude)}.<br>This is device GPS/Wi-Fi — far more precise than IP, and a VPN won't hide it.</div>`, "ok");
    },
    async cookie_jar(id) {
      if (!SIB) return out(id, "Sibling origin not configured in this environment.", "warn");
      const set = await fetch(SIB + "/s/set-cookie", { credentials: "include" }).then((r) => r.json());
      const seen = await fetch(SIB + "/s/seen", { credentials: "include" }).then((r) => r.json());
      saveResult(id, { cookieSet: set.set, scope: set.scope, siblingSawCookieOnNextRequest: seen.sawDemoCookie });
      out(id, `<div class="kv">Sibling set a dummy cookie (${esc(set.scope)}), id ${esc(set.idMasked)}.<br>` +
        `On the next request the sibling <b>${seen.sawDemoCookie ? "received it back" : "did not receive it"}</b> — that's how cross-site tracking works.</div>` +
        `<button class="btn secondary" id="clr-${id}">Clear demo cookie</button>`, "ok");
      document.getElementById("clr-" + id).onclick = async () => { await fetch(SIB + "/s/clear-cookie", { credentials: "include" }); out(id, "Demo cookie cleared.", "ok"); };
    },
    async cross_site_fetch(id) {
      if (!SIB) return out(id, "Sibling origin not configured in this environment.", "warn");
      let corsReadable = false, corsBody = null, noCorsOpaque = false;
      try { corsBody = await fetch(SIB + "/s/cors", { credentials: "include" }).then((r) => r.json()); corsReadable = true; } catch {}
      try { const r = await fetch(SIB + "/s/nocors", { mode: "no-cors", credentials: "include" }); noCorsOpaque = r.type === "opaque"; } catch {}
      const seen = await fetch(SIB + "/s/seen", { credentials: "include" }).then((r) => r.json()).catch(() => null);
      saveResult(id, { corsResponseReadable: corsReadable, noCorsResponseOpaque: noCorsOpaque, siblingSawRequest: !!seen, siblingSawUA: seen && !!seen.userAgent });
      out(id, `<div class="kv">• <b>CORS endpoint:</b> response ${corsReadable ? "was readable" : "blocked"} — the sibling opted in, so our page could read it.<br>` +
        `• <b>no-CORS endpoint:</b> response ${noCorsOpaque ? "was opaque (unreadable)" : "?"} — but the request still went out.<br>` +
        `• <b>What the sibling saw:</b> ${seen ? `your UA (${esc(String(seen.userAgent||"").slice(0,24))}…), referer, and cross-site cookie=${seen.sawDemoCookie}` : "n/a"}.<br>` +
        `CORS controls READING the reply, not whether the request (with your cookies) is SENT.</div>`, "ok");
    },
  };

  function labCard(d, LAB) {
    if (!LAB) return `<details class="card demo" open><summary><span class="gt-title">${esc(d.title)}</span><span class="badge docs">unavailable here</span></summary><div class="gt-body"><p>${esc(d.what)}</p><p class="muted">The isolated lab origin isn't configured in this environment.</p></div></details>`;
    const presets = [
      ["reflected", "vuln", "Reflected (vuln)"], ["reflected", "fixed", "Reflected (fixed)"],
      ["stored", "vuln", "Stored (vuln)"], ["dom", "vuln", "DOM (vuln)"],
      ["capabilities", "vuln", "What script can do"], ["defences", "x", "Defences"],
      ["prompt", "vuln", "Prompt-inj (naive)"], ["prompt", "fixed", "Prompt-inj (safe)"],
    ].map(([dm, v, l]) => `<button class="lab-preset" data-lab-demo="${dm}" data-lab-variant="${v}">${esc(l)}</button>`).join("");
    return `<details class="card demo" open>
      <summary><span class="gt-title">${esc(d.title)}</span><span class="badge build">contained · own origin</span></summary>
      <div class="gt-body">
        <p>${esc(d.what)}</p>
        <h3>Kept contained here</h3><p>${esc(d.localOnly)}</p>
        <div class="lab-presets">${presets}</div>
        <iframe id="xsslab" class="lab-frame" title="Script injection lab" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerpolicy="origin"></iframe>
        <p class="muted" id="lab-status">loading the isolated lab…</p>
        <details class="raw"><summary>How to defend (real world)</summary><p>${esc(d.revoke)}</p></details>
      </div>
    </details>`;
  }

  function setupLab(LAB) {
    const frame = document.getElementById("xsslab"); if (!frame) return;
    const labOrigin = new URL(LAB).origin;
    let token = null, ready = false;
    const results = { runs: [] };
    const status = (t) => { const el = document.getElementById("lab-status"); if (el) el.textContent = t; };
    frame.src = LAB + "/lab";
    // fetch a short-lived login token to unlock the custom box (requires being signed in)
    fetch("/api/lab").then((r) => (r.ok ? r.json() : null)).then((j) => { token = j && j.token; if (ready && token) frame.contentWindow.postMessage({ type: "bt-lab-init", token }, labOrigin); }).catch(() => {});
    window.addEventListener("message", (e) => {
      if (e.origin !== labOrigin) return;                       // only trust the lab origin
      const d = e.data || {};
      if (d.type === "bt-lab-ready") { ready = true; status("Lab ready. Use the buttons above, the controls inside the lab, or (signed in) the custom box."); if (token) frame.contentWindow.postMessage({ type: "bt-lab-init", token }, labOrigin); }
      else if (d.type === "bt-lab-result") {
        const last = { demo: d.demo, variant: d.variant, executed: !!d.executed, blocked: !!d.blocked, defence: d.defence || null };
        results.runs = results.runs.concat([last]).slice(-20); results.last = last;
        saveResult("xss_lab", results);                         // metadata only → the tutor
      } else if (d.type === "csp-blocked") { results.cspBlocked = true; saveResult("xss_lab", results); }
    });
    document.querySelectorAll(".lab-preset").forEach((b) => (b.onclick = () => frame.contentWindow.postMessage({ type: "bt-lab-run", demo: b.dataset.labDemo, variant: b.dataset.labVariant }, labOrigin)));
  }

  async function run(id, btn) {
    btn.disabled = true; const prev = btn.textContent; btn.textContent = "Running…";
    try { await RUNNERS[id](id); btn.textContent = "Run again"; }
    catch (e) {
      const msg = e && e.name === "NotAllowedError" ? "You denied the permission (or it's blocked). That's the safe choice — here's what you avoided sharing."
        : e && e.name === "NotFoundError" ? "No such device on this machine." : (e && e.message) || String(e);
      out(id, esc(msg), "warn"); btn.textContent = prev;
      saveResult(id, { granted: false, error: e && e.name || "error" });
    } finally { btn.disabled = false; }
  }

  let LAB = null;
  fetch("/api/demos").then((r) => r.json()).then(({ demos, sibling, lab }) => {
    SIB = sibling; LAB = lab;
    document.getElementById("siteNote").textContent = sibling ? "Cross-site demos talk to the sibling origin " + sibling + "." : "Sibling origin not configured here; cross-site demos are disabled.";
    const wide = matchMedia("(min-width: 900px)").matches;
    host.innerHTML = demos.map((d, i) => d.id === "xss_lab" ? labCard(d, LAB) : `
      <details class="card demo"${wide || i === 0 ? " open" : ""}>
        <summary><span class="gt-title">${esc(d.title)}</span>${d.needsPermission ? '<span class="badge docs">asks permission</span>' : '<span class="badge build">no prompt</span>'}</summary>
        <div class="gt-body">
          <p>${esc(d.what)}</p>
          <h3>What a site learns</h3><p>${esc(d.siteLearns)}</p>
          <h3>Kept private here</h3><p>${esc(d.localOnly)}</p>
          ${d.teaches ? `<h3>How storage works here</h3><p>${esc(d.teaches)}</p>` : ""}
          <div class="demo-run"><button class="btn" data-run="${esc(d.id)}">Run</button></div>
          <div class="demo-out" id="out-${esc(d.id)}"></div>
          <details class="raw"><summary>How to revoke</summary><p>${esc(d.revoke)}</p></details>
        </div>
      </details>`).join("");
    host.querySelectorAll("[data-run]").forEach((b) => (b.onclick = () => run(b.dataset.run, b)));
    if (LAB) setupLab(LAB);
  });
})();
