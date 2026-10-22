const $ = (id) => document.getElementById(id);
const log = $("log"), q = $("q"), chipRow = $("chips");

// ---------- local persistence (this is the live example the storage_inspector demo inspects) ----------
const HIST_KEY = "bt_chat";           // transcript + latest chips, kept in THIS origin's localStorage
const HIST_TTL = 7 * 24 * 3600e3;      // 7 days, mirrored into an explicit expiry field for the lesson
let chatHistory = [];
let lastChips = [];
function saveHistory() {
  try {
    const now = Date.now();
    localStorage.setItem(HIST_KEY, JSON.stringify({ savedAt: now, expiresAt: now + HIST_TTL, messages: chatHistory.slice(-40), chips: lastChips }));
  } catch {}
}
function loadHistory() {
  try {
    const raw = localStorage.getItem(HIST_KEY); if (!raw) return;
    const o = JSON.parse(raw);
    if (o && o.expiresAt && Date.now() > o.expiresAt) { localStorage.removeItem(HIST_KEY); return; }
    if (o && Array.isArray(o.messages)) { chatHistory = o.messages; lastChips = Array.isArray(o.chips) ? o.chips : []; }
  } catch {}
}
function clearSiteData() { try { localStorage.removeItem(HIST_KEY); sessionStorage.removeItem("bt_demo"); } catch {} if (window.BTW) BTW.clear(); chatHistory = []; lastChips = []; }

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------- safe Markdown: vendored marked + DOMPurify, no raw HTML, links forced safe ----------
const MD = (() => {
  if (!window.marked || !window.DOMPurify) return (s) => esc(s).replace(/\n/g, "<br>");
  marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
  const DP = window.DOMPurify;
  DP.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      if (!/^https?:\/\//i.test(href)) node.removeAttribute("href");
      else { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer nofollow"); }
    }
  });
  const CFG = {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "b", "i", "del", "code", "pre", "blockquote", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "h5", "h6", "a", "hr", "span", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "target", "rel"],
    FORBID_TAGS: ["img", "script", "style", "iframe", "svg", "math", "form", "input"],
    ALLOW_DATA_ATTR: false,
  };
  return (s) => {
    let html = marked.parse(String(s || ""));
    html = DP.sanitize(html, CFG);
    // Wrap tables so they scroll horizontally on mobile instead of overflowing the page.
    return html.replace(/<table>/g, '<div class="tbl-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  };
})();

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tab[data-tab]").forEach((x) => { const on = x.dataset.tab === name; x.classList.toggle("active", on); x.setAttribute("aria-selected", on); });
  ["probe", "chat", "health", "metrics"].forEach((id) => ($(id).hidden = id !== name));
  document.body.classList.toggle("in-chat", name === "chat");
  if (name === "chat") { scrollToEnd(true); refreshChips(); if (matchMedia("(pointer: fine)").matches) q.focus(); }
  else window.scrollTo(0, 0);
  if (name === "health") BTW.openHealth();
  if (name === "metrics") BTW.openMetrics();
}
document.querySelectorAll(".tab[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
{ const h = location.hash.slice(1); if (["chat", "health", "metrics"].includes(h)) setTimeout(() => showTab(h), 0); }
document.querySelectorAll("[data-refresh]").forEach((b) => (b.onclick = () => BTW.refreshBoard(b.dataset.refresh)));
document.querySelectorAll("[data-ask]").forEach((b) => (b.onclick = () => { showTab("chat"); send(b.dataset.ask); }));

// ---------- identity + model engine ----------
let ME = null;
function loadMe() {
  return fetch("/api/me").then((r) => (r.ok ? r.json() : Promise.reject())).then((m) => {
    ME = m;
    if (window.BTW && !loadMe.inited) { loadMe.inited = true; BTW.init(m.login); restoreWidgets(); }
    $("me").innerHTML = (m.avatar ? `<img class="av" src="${encodeURI(m.avatar)}" alt=""> ` : "") + `<span class="login">${esc(m.login)}</span>`;
    renderEngine();
  }).catch(() => (location.href = "/"));
}

function engineLabel(me) {
  const prov = (me && me.provider) || "copilot";
  if (prov !== "openrouter") return "Copilot";
  const or = me.or || {};
  const model = (or.models || []).find((x) => x.id === or.model);
  const short = model ? model.label : (or.model || "model");
  return "OpenRouter · " + short;
}
function renderEngine(meOverride) {
  const me = meOverride || ME; if (!me) return;
  $("engineChipText").textContent = engineLabel(me);
  const prov = me.provider || "copilot";
  const or = me.or || { connected: false, models: [], model: "" };
  let body = `
    <div class="eng-row" role="group" aria-label="Engine">
      <button type="button" class="eng-opt${prov === "copilot" ? " on" : ""}" data-prov="copilot">GitHub Copilot<small>Your Copilot subscription</small></button>
      <button type="button" class="eng-opt${prov === "openrouter" ? " on" : ""}" data-prov="openrouter">OpenRouter<small>Your OpenRouter credits</small></button>
    </div>`;
  if (prov === "openrouter" && or.connected) {
    const opts = (or.models || []).map((m) => `<option value="${esc(m.id)}"${m.id === or.model ? " selected" : ""}>${esc(m.label || m.id)}${m.free ? " · free" : ""}</option>`).join("");
    const cur = (or.models || []).find((x) => x.id === or.model);
    const note = cur && cur.note ? cur.note : "";
    body += `
      <label class="eng-field"><span>Model</span>
        <select id="pv-model" class="eng-select" aria-label="OpenRouter model">${opts}</select></label>
      <p class="eng-note">${esc(note)}</p>
      <p class="eng-note">Free models cost nothing but share a rate-limited pool. <b>Auto</b> may route to paid models and bill your OpenRouter credits.</p>
      <div class="eng-actions">
        <a class="eng-link" href="${esc(or.settingsUrl || "#")}" target="_blank" rel="noopener noreferrer">Manage / spending limit ↗</a>
        <button type="button" id="pv-disc" class="eng-link danger">Disconnect</button>
      </div>
      <p class="eng-note muted">Billed to your OpenRouter credits. Your probe data is only shared if you tapped “Share with tutor”.</p>`;
  } else if (prov === "openrouter") {
    body += `<a class="eng-connect" href="/auth/openrouter/login">Connect OpenRouter →</a>`;
  } else {
    body += `<p class="eng-note muted">Runs on your own GitHub Copilot entitlement. Switch to OpenRouter to use your own credits instead.</p>`;
  }
  $("sheetBody").innerHTML = body;
  $("sheetBody").querySelectorAll(".eng-opt").forEach((b) => (b.onclick = () => setProvider(b.dataset.prov)));
  const sel = $("pv-model"); if (sel) sel.onchange = () => setProvider("openrouter", sel.value);
  const disc = $("pv-disc"); if (disc) disc.onclick = disconnectOpenRouter;
}
async function setProvider(provider, model) {
  if (provider === "openrouter" && !(ME && ME.or && ME.or.connected)) { location.href = "/auth/openrouter/login"; return; }
  try {
    const r = await fetch("/api/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Could not switch engine");
    await loadMe();
    toast(provider === "openrouter" ? `Using OpenRouter · ${j.model}` : "Using GitHub Copilot");
  } catch (e) { toast("⚠️ " + e.message, true); }
}
async function disconnectOpenRouter() {
  if (!confirm("Disconnect OpenRouter? The key is dropped from this session. You should also revoke it in OpenRouter settings.")) return;
  const r = await fetch("/api/openrouter/disconnect", { method: "POST" });
  const j = await r.json().catch(() => ({}));
  await loadMe();
  toast("OpenRouter disconnected. Revoke the key at openrouter.ai/settings/keys", false, j.revokeUrl);
}

// ---------- engine bottom sheet ----------
const sheet = $("engineSheet"), backdrop = $("sheetBackdrop");
let lastFocus = null;
function openSheet() {
  renderEngine(); lastFocus = document.activeElement;
  backdrop.hidden = false; sheet.hidden = false;
  $("engineChip").setAttribute("aria-expanded", "true");
  const f = sheet.querySelector("button, select, a"); if (f) f.focus();
  document.addEventListener("keydown", onSheetKey);
}
function closeSheet() {
  backdrop.hidden = true; sheet.hidden = true;
  $("engineChip").setAttribute("aria-expanded", "false");
  document.removeEventListener("keydown", onSheetKey);
  if (lastFocus) lastFocus.focus();
}
function onSheetKey(e) { if (e.key === "Escape") closeSheet(); }
$("engineChip").onclick = openSheet;
$("sheetClose").onclick = closeSheet;
backdrop.onclick = closeSheet;

// ---------- toast ----------
function toast(text, isErr, link) {
  const t = $("toast"); t.hidden = false; t.className = "toast" + (isErr ? " err" : "");
  t.innerHTML = esc(text) + (link ? ` <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">settings ↗</a>` : "");
  clearTimeout(toast._t); if (!isErr) toast._t = setTimeout(() => { t.hidden = true; }, 7000);
}
// OAuth callback outcome (?or=connected|state_error|exchange_error)
(function () {
  const p = new URLSearchParams(location.search).get("or"); if (!p) return;
  if (p === "connected") toast("✅ OpenRouter connected");
  else if (p === "state_error") toast("⚠️ OpenRouter sign-in could not be verified (state mismatch). Try again.", true);
  else if (p === "exchange_error") toast("⚠️ OpenRouter did not return a key. Try connecting again.", true);
  history.replaceState(null, "", location.pathname + location.hash);
})();
$("logout").onclick = async () => { await fetch("/auth/logout", { method: "POST" }); clearSiteData(); sessionStorage.clear(); location.href = "/"; };

// ---------- suggestion chips (starter + follow-up) ----------
const DEMO_CHIP = {
  storage_inspector: "Where is my chat saved?",
  camera: "Teach me camera permissions",
  microphone: "Can a site hear my microphone?",
  geolocation: "How precisely can a site locate me?",
  cookie_jar: "Show me cross-site cookies",
  cross_site_fetch: "What is a cross-site request?",
};
const STARTERS = ["What does my browser reveal?", "How unique am I?", "What are Agent SDK gotchas?"];
const OBS_CHIPS = ["Is the site up?", "Plot my reply latency over time", "Show errors last 24h", "Lambda p95 duration last 24h", "When was the last outage?"];
function demosRun() { try { return Object.keys(JSON.parse(sessionStorage.getItem("bt_demo") || "{}")); } catch { return []; } }
function curatedChips() {
  const run = new Set(demosRun());
  const notRun = Object.keys(DEMO_CHIP).filter((d) => !run.has(d)).map((d) => DEMO_CHIP[d]);
  const out = [];
  const obs = OBS_CHIPS.slice((chatHistory.length / 2) % OBS_CHIPS.length).concat(OBS_CHIPS).slice(0, 3); // rotate
  for (const c of [...obs, ...notRun.slice(0, 2), ...STARTERS]) if (!out.includes(c)) out.push(c);
  return out.slice(0, 6);
}
function renderChips(items) {
  chipRow.innerHTML = "";
  (items || []).forEach((textRaw) => {
    const text = String(textRaw).slice(0, 80);
    const wrap = document.createElement("div"); wrap.className = "chip-wrap"; wrap.setAttribute("role", "listitem");
    const b = document.createElement("button"); b.type = "button"; b.className = "chip";
    b.textContent = text;                                   // textContent only — never innerHTML
    b.setAttribute("aria-label", "Ask: " + text);
    b.onclick = () => send(text);
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "chip-edit";
    edit.setAttribute("aria-label", "Edit: " + text); edit.textContent = "✎";
    edit.onclick = (e) => { e.stopPropagation(); q.value = text; grow(); q.focus(); };
    wrap.append(b, edit); chipRow.appendChild(wrap);
  });
  chipRow.hidden = !(items && items.length);
}
function refreshChips() {
  if (chatHistory.length) renderChips(lastChips && lastChips.length ? lastChips : curatedChips());
  else renderChips(curatedChips());
}

// ---------- scrolling ----------
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
let stick = true;
log.addEventListener("scroll", () => { stick = nearBottom(); $("jump").hidden = stick; }, { passive: true });
function scrollToEnd(force) { if (force || stick) { log.scrollTop = log.scrollHeight; stick = true; $("jump").hidden = true; } else $("jump").hidden = false; }
$("jump").onclick = () => scrollToEnd(true);

// ---------- message rendering ----------
function addUser(text) {
  const d = document.createElement("div"); d.className = "msg user"; d.textContent = text;
  log.appendChild(d); scrollToEnd(true); return d;
}
function addBot() {
  const d = document.createElement("div"); d.className = "msg bot";
  d.innerHTML = `<div class="tools" hidden><button class="tools-toggle" type="button" aria-expanded="false"></button><div class="tools-list" hidden></div></div><div class="content"><span class="muted">thinking…</span></div><div class="widgets"></div>`;
  log.appendChild(d); scrollToEnd();
  const toggle = d.querySelector(".tools-toggle"), list = d.querySelector(".tools-list");
  toggle.onclick = () => { const open = list.hidden; list.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); };
  return d;
}
function addTool(bot, name) {
  const tools = bot.querySelector(".tools"), toggle = bot.querySelector(".tools-toggle"), list = bot.querySelector(".tools-list");
  tools.hidden = false;
  const item = document.createElement("div"); item.className = "tool-item"; item.textContent = "🔧 " + name; list.appendChild(item);
  const n = list.children.length; toggle.textContent = `🔧 used ${n} tool${n > 1 ? "s" : ""} ▾`;
}
function restoreHistory() {
  if (!chatHistory.length) return;
  for (const m of chatHistory) {
    if (m.role === "user") addUser(m.text);
    else { const b = addBot(); b.querySelector(".content").innerHTML = MD(m.text); b._w = Array.isArray(m.w) ? m.w : []; }
  }
  scrollToEnd(true);
}
// Widget cards are re-attached once we know the login (widget specs are stored per login; data is fetched fresh).
function restoreWidgets() {
  const seen = new Set();
  log.querySelectorAll(".msg.bot").forEach((b) => (b._w || []).forEach((id) => { if (!seen.has(id) && BTW.latest(id)) { seen.add(id); BTW.attach(id, b.querySelector(".widgets")); } }));
}

// ---------- composer ----------
function grow() { q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight, 160) + "px"; }
q.addEventListener("input", () => { grow(); chipRow.classList.toggle("dim", q.value.trim().length > 0); });
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) { e.preventDefault(); $("form").requestSubmit(); }
});
if (window.visualViewport) visualViewport.addEventListener("resize", () => { if (!$("chat").hidden) scrollToEnd(); });
$("form").onsubmit = (e) => { e.preventDefault(); const m = q.value.trim(); if (m) send(m); };

let sending = false;
async function send(message) {
  if (sending) return; sending = true;
  q.value = ""; grow(); chipRow.classList.remove("dim");
  renderChips([]);                                   // hide chips while streaming
  const intro = log.querySelector(".intro"); if (intro) intro.remove();
  addUser(message);
  const bot = addBot(); const content = bot.querySelector(".content");
  let text = "", started = false;
  const btn = $("sendBtn"); btn.disabled = true;
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, fingerprint: window.BT.shared ? window.BT.fingerprint : null, demoResults: JSON.parse(sessionStorage.getItem("bt_demo") || "null"), history: chatHistory.map(({ role, text }) => ({ role, text })), widgets: BTW.list() }) });
    if (!res.ok || !res.body) { const j = await res.json().catch(() => ({})); throw new Error(j.error || res.statusText); }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
    let followups = null; const wids = [];
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "delta") { started = true; text += ev.text; content.innerHTML = MD(text); }
        else if (ev.type === "final") { text = ev.text; content.innerHTML = MD(text); }  // authoritative; de-dupes retried deltas
        else if (ev.type === "tool") addTool(bot, ev.name);
        else if (ev.type === "notice") toast(ev.text);
        else if (ev.type === "followups") followups = Array.isArray(ev.items) ? ev.items : null;
        else if (ev.type === "widget") { const r = BTW.apply(ev, bot); if (r && !wids.includes(r.id)) wids.push(r.id); }
        else if (ev.type === "error") { const e = new Error(ev.message); e.canSwitch = ev.canSwitch; throw e; }
      }
      scrollToEnd();
    }
    if (!text.trim()) content.innerHTML = "<span class='muted'>(No answer returned. Try again or switch model.)</span>";
    chatHistory.push({ role: "user", text: message }, { role: "assistant", text, ...(wids.length ? { w: wids } : {}) });
    lastChips = (followups && followups.length) ? followups.slice(0, 4) : curatedChips();
    saveHistory();
    refreshChips();
  } catch (err) {
    content.innerHTML = "<span class='muted'>⚠️ " + esc(err.message) + "</span>";
    if (err.canSwitch) toast("Tap the engine chip (bottom-left) to switch model or engine.", true);
    lastChips = curatedChips();
    refreshChips();
  } finally { btn.disabled = false; sending = false; scrollToEnd(); }
}

// Exposed for the XSS test harness (pure, read-only renderer).
window.__renderMarkdown = MD;

// ---------- boot ----------
loadHistory();
restoreHistory();
refreshChips();
loadMe();
