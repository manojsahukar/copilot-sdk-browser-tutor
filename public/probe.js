// Collects what an ordinary web page can read from the browser — WITHOUT triggering any permission prompt.
// Read-only and transparent: results are rendered to the user first; nothing is sent until they click "Share".
const safe = async (fn) => { try { return await fn(); } catch (e) { return { error: String(e && e.message || e) }; } };

// SHA-256 where available (secure contexts), else FNV-1a 32-bit
async function hash(str) {
  if (window.crypto && crypto.subtle) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }
  let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return "fnv1a:" + (h >>> 0).toString(16);
}

async function canvasFp() {
  const c = document.createElement("canvas"); c.width = 280; c.height = 60; const g = c.getContext("2d");
  g.textBaseline = "top"; g.font = "16px Arial"; g.fillStyle = "#f60"; g.fillRect(100, 1, 62, 20);
  g.fillStyle = "#069"; g.fillText("Browser Tutor 🕵️ <canvas> 1.0", 2, 15);
  g.fillStyle = "rgba(102,204,0,0.7)"; g.fillText("Browser Tutor 🕵️ <canvas> 1.0", 4, 17);
  g.globalCompositeOperation = "multiply"; g.fillStyle = "rgb(255,0,255)"; g.beginPath(); g.arc(50, 50, 30, 0, Math.PI * 2); g.fill();
  const url = c.toDataURL();
  return { hash: await hash(url), dataUrlLength: url.length, explanation: "Same drawing renders slightly differently per GPU/driver/OS/fonts → stable ID." };
}

async function webglFp() {
  const c = document.createElement("canvas"); const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
  if (!gl) return { supported: false };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const params = ["MAX_TEXTURE_SIZE", "MAX_RENDERBUFFER_SIZE", "MAX_VERTEX_ATTRIBS", "MAX_VIEWPORT_DIMS", "ALIASED_LINE_WIDTH_RANGE", "MAX_COMBINED_TEXTURE_IMAGE_UNITS"]
    .map(p => [p, String(gl.getParameter(gl[p]))]);
  const exts = gl.getSupportedExtensions() || [];
  return {
    supported: true,
    vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
    unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    version: gl.getParameter(gl.VERSION), shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    extensionCount: exts.length, paramsHash: await hash(JSON.stringify(params) + exts.join()),
  };
}

function fontsFp() {
  const test = ["Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "Comic Sans MS", "Impact", "Tahoma", "Trebuchet MS",
    "Segoe UI", "Calibri", "Cambria", "Consolas", "Menlo", "Monaco", "SF Pro Text", "Helvetica Neue", "Ubuntu", "DejaVu Sans", "Liberation Sans",
    "Noto Sans", "Roboto", "Cantarell", "Fira Code", "Source Code Pro", "Lucida Grande", "Gill Sans", "Futura", "Palatino", "Garamond", "Nirmala UI", "Mangal", "MS Gothic", "SimSun"];
  const span = document.createElement("span"); span.style.cssText = "position:absolute;left:-9999px;font-size:72px"; span.textContent = "mmmmmmmmmlli1WQ@#";
  document.body.appendChild(span); const base = {};
  for (const b of ["monospace", "serif", "sans-serif"]) { span.style.fontFamily = b; base[b] = span.offsetWidth + "x" + span.offsetHeight; }
  const found = test.filter(f => ["monospace", "serif", "sans-serif"].some(b => { span.style.fontFamily = `'${f}',${b}`; return span.offsetWidth + "x" + span.offsetHeight !== base[b]; }));
  span.remove();
  return { tested: test.length, detected: found, detectedCount: found.length, method: "text-width measurement against fallback fonts (no permission needed)" };
}

async function collect() {
  const n = navigator, mm = (q) => matchMedia(q).matches;
  const fp = { collectedAt: new Date().toISOString(), pageUrl: location.href };
  fp.userAgent = { userAgent: n.userAgent, appVersion: n.appVersion, platform: n.platform, vendor: n.vendor, webdriver: n.webdriver, pdfViewerEnabled: n.pdfViewerEnabled };
  fp.clientHints = await safe(async () => n.userAgentData ? {
    lowEntropy: { brands: n.userAgentData.brands, mobile: n.userAgentData.mobile, platform: n.userAgentData.platform },
    highEntropy: await n.userAgentData.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "fullVersionList", "wow64", "formFactors"]),
  } : { supported: false, note: "UA Client Hints API not available (typical for Firefox/Safari)" });
  const ro = Intl.DateTimeFormat().resolvedOptions();
  fp.locale = { languages: n.languages, language: n.language, timeZone: ro.timeZone, utcOffsetMinutes: -new Date().getTimezoneOffset(), locale: ro.locale, calendar: ro.calendar, numberingSystem: ro.numberingSystem, sampleDate: new Date(0).toLocaleString(), sampleNumber: (1234567.891).toLocaleString() };
  fp.screen = { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    devicePixelRatio: devicePixelRatio, viewport: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], orientation: screen.orientation && screen.orientation.type, isExtended: screen.isExtended };
  fp.hardware = { hardwareConcurrency: n.hardwareConcurrency, deviceMemoryGB: n.deviceMemory ?? "not exposed", maxTouchPoints: n.maxTouchPoints, touchEvents: "ontouchstart" in window, pointerCoarse: mm("(pointer: coarse)"), hover: mm("(hover: hover)") };
  fp.storage = {
    cookieEnabled: n.cookieEnabled,
    localStorage: !!(await safe(() => { localStorage.setItem("_bt", "1"); localStorage.removeItem("_bt"); return true; })) === true,
    sessionStorage: !!window.sessionStorage, indexedDB: !!window.indexedDB,
    quota: await safe(async () => { if (!n.storage || !n.storage.estimate) return "n/a"; const e = await n.storage.estimate(); return { quotaMB: Math.round(e.quota / 1048576), usageKB: Math.round(e.usage / 1024), note: "Unusually small quota can hint at private/incognito mode in some browsers" }; }),
  };
  fp.privacySignals = { doNotTrack: n.doNotTrack ?? window.doNotTrack ?? null, globalPrivacyControl: n.globalPrivacyControl ?? null };
  fp.preferences = { colorScheme: mm("(prefers-color-scheme: dark)") ? "dark" : "light", reducedMotion: mm("(prefers-reduced-motion: reduce)"), contrastMore: mm("(prefers-contrast: more)"), forcedColors: mm("(forced-colors: active)") };
  fp.canvas = await safe(canvasFp);
  fp.webgl = await safe(webglFp);
  fp.fonts = await safe(async () => { await (document.fonts && document.fonts.ready); return fontsFp(); });
  fp.audio = await safe(() => { const C = window.AudioContext || window.webkitAudioContext; if (!C) return "n/a"; const a = new C(); const r = { sampleRate: a.sampleRate, baseLatency: a.baseLatency, maxChannels: a.destination.maxChannelCount }; a.close(); return r; });
  fp.mediaDevices = await safe(async () => {
    if (!n.mediaDevices || !n.mediaDevices.enumerateDevices) return "n/a";
    const d = await n.mediaDevices.enumerateDevices(); const c = {}; d.forEach(x => c[x.kind] = (c[x.kind] || 0) + 1);
    return { counts: c, labelsVisible: d.some(x => x.label), note: "Counts without labels: no permission prompt was shown" };
  });
  fp.network = n.connection ? { effectiveType: n.connection.effectiveType, downlinkMbps: n.connection.downlink, rttMs: n.connection.rtt, saveData: n.connection.saveData, type: n.connection.type } : "Network Information API not available";
  fp.battery = await safe(async () => { if (!n.getBattery) return "Battery API not available"; const b = await n.getBattery(); return { levelPct: Math.round(b.level * 100), charging: b.charging }; });
  fp.navigation = { referrer: document.referrer || "(none)", historyLength: window.history.length, online: n.onLine };
  fp.plugins = { count: n.plugins ? n.plugins.length : 0, names: n.plugins ? Array.from(n.plugins).map(p => p.name) : [], mimeTypes: n.mimeTypes ? n.mimeTypes.length : 0 };
  fp.permissions = await safe(async () => {
    if (!n.permissions) return "n/a"; const out = {};
    for (const name of ["geolocation", "notifications", "camera", "microphone", "clipboard-read", "persistent-storage", "midi"]) {
      out[name] = await n.permissions.query({ name }).then(s => s.state).catch(() => "unsupported");
    }
    return out; // states only: querying never prompts
  });
  fp.apis = { serviceWorker: "serviceWorker" in n, webRTC: "RTCPeerConnection" in window, webGPU: "gpu" in n, bluetooth: "bluetooth" in n, usb: "usb" in n, credentials: "credentials" in n, share: "share" in n };
  fp.summaryHash = await hash(JSON.stringify([fp.userAgent.userAgent, fp.locale.timeZone, fp.locale.languages, fp.screen, fp.hardware, fp.canvas.hash, fp.webgl.unmaskedRenderer, fp.fonts.detected]));
  return fp;
}

window.BT = { fingerprint: null, shared: false };
(async () => {
  const fp = await collect(); window.BT.fingerprint = fp;
  document.getElementById("fp").textContent = JSON.stringify(fp, null, 2);
  renderCards(document.getElementById("fpCards"), fp, { title: "Page", openFirst: 2 });
  fetch("/api/server-view").then(r => r.json()).then(sv => {
    document.getElementById("sv").textContent = JSON.stringify(sv, null, 2);
    renderCards(document.getElementById("svCards"), sv, { title: "Connection", openFirst: 1 });
  });
  document.getElementById("share").onclick = () => {
    window.BT.shared = true;
    sessionStorage.setItem("bt_shared", "1");
    document.getElementById("shareState").textContent = "Shared ✓ — it will be sent with your chat messages (this tab only).";
    document.querySelector('[data-tab="chat"]').click();
  };
  if (sessionStorage.getItem("bt_shared")) { window.BT.shared = true; document.getElementById("shareState").textContent = "Shared ✓"; }
})();
