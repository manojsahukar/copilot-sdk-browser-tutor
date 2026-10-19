// Static, reviewed demo implementations. No code ever comes from the model.
// Results are metadata only; they're stashed in sessionStorage so the chat tab can send them to the tutor.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const host = document.getElementById("demos");
  let SIB = null;
  const saveResult = (id, data) => { try { const m = JSON.parse(sessionStorage.getItem("bt_demo") || "{}"); m[id] = { ...data, at: new Date().toISOString() }; sessionStorage.setItem("bt_demo", JSON.stringify(m)); } catch {} };
  const out = (id, html, cls = "") => { const el = document.getElementById("out-" + id); el.innerHTML = html; el.className = "demo-out " + cls; };

  const RUNNERS = {
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

  fetch("/api/demos").then((r) => r.json()).then(({ demos, sibling }) => {
    SIB = sibling;
    document.getElementById("siteNote").textContent = sibling ? "Cross-site demos talk to the sibling origin " + sibling + "." : "Sibling origin not configured here; cross-site demos are disabled.";
    const wide = matchMedia("(min-width: 900px)").matches;
    host.innerHTML = demos.map((d, i) => `
      <details class="card demo"${wide || i === 0 ? " open" : ""}>
        <summary><span class="gt-title">${esc(d.title)}</span>${d.needsPermission ? '<span class="badge docs">asks permission</span>' : '<span class="badge build">no prompt</span>'}</summary>
        <div class="gt-body">
          <p>${esc(d.what)}</p>
          <h3>What a site learns</h3><p>${esc(d.siteLearns)}</p>
          <h3>Kept private here</h3><p>${esc(d.localOnly)}</p>
          <div class="demo-run"><button class="btn" data-run="${esc(d.id)}">Run</button></div>
          <div class="demo-out" id="out-${esc(d.id)}"></div>
          <details class="raw"><summary>How to revoke</summary><p>${esc(d.revoke)}</p></details>
        </div>
      </details>`).join("");
    host.querySelectorAll("[data-run]").forEach((b) => (b.onclick = () => run(b.dataset.run, b)));
  });
})();
