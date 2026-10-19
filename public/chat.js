const $ = (id) => document.getElementById(id);
const chatHistory = [];
const log = $("log"), q = $("q");

function showTab(name) {
  document.querySelectorAll(".tab[data-tab]").forEach((x) => { const on = x.dataset.tab === name; x.classList.toggle("active", on); x.setAttribute("aria-selected", on); });
  ["probe", "chat"].forEach((id) => ($(id).hidden = id !== name));
  document.body.classList.toggle("in-chat", name === "chat");
  $("fpNote").textContent = window.BT.shared ? "Your probe data is shared with the tutor." : "Probe data not shared: the tutor only sees your HTTP headers. Use the Probe tab to share.";
  if (name === "chat") { scrollToEnd(true); if (matchMedia("(pointer: fine)").matches) q.focus(); }
  else window.scrollTo(0, 0);
}
document.querySelectorAll(".tab[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
if (location.hash === "#chat") setTimeout(() => showTab("chat"), 0);

let ME = null;
function loadMe() {
  return fetch("/api/me").then((r) => (r.ok ? r.json() : Promise.reject())).then((m) => {
    ME = m;
    $("me").innerHTML = (m.avatar ? `<img class="av" src="${encodeURI(m.avatar)}" alt=""> ` : "") + `<span class="login">${esc(m.login)}</span>`;
    renderProvider();
  }).catch(() => (location.href = "/"));
}
loadMe();

// ---- Model engine picker: GitHub Copilot (your subscription) or OpenRouter (your credits) ----
function renderProvider(meOverride) {
  const me = meOverride || ME;
  const el = $("provider"); if (!el || !me) return;
  const prov = me.provider || "copilot";
  const or = me.or || { connected: false, models: [], default: "" };
  const opts = `
    <span class="pv-label">Engine</span>
    <button type="button" class="pv-opt${prov === "copilot" ? " on" : ""}" data-prov="copilot" title="Runs on your own GitHub Copilot subscription">Copilot</button>
    <button type="button" class="pv-opt${prov === "openrouter" ? " on" : ""}" data-prov="openrouter" title="Runs on your own OpenRouter credits">OpenRouter</button>`;
  let tail = "";
  if (prov === "openrouter" && or.connected) {
    const list = (or.models || []).map((m) => `<option value="${esc(m.id)}"${m.id === or.model ? " selected" : ""}>${esc(m.label || m.id)}</option>`).join("");
    tail = `
      <select id="pv-model" class="pv-model" aria-label="OpenRouter model">${list}</select>
      <a class="pv-link" href="${esc(or.settingsUrl || "#")}" target="_blank" rel="noopener">Manage / set a spending limit ↗</a>
      <button type="button" id="pv-disc" class="pv-link pv-danger">Disconnect</button>
      <span class="pv-note">Billed to your OpenRouter credits · the default model is free.</span>`;
  } else if (prov === "openrouter" && !or.connected) {
    tail = `<a class="pv-connect" href="/auth/openrouter/login">Connect OpenRouter →</a>`;
  }
  el.innerHTML = opts + tail;

  el.querySelectorAll(".pv-opt").forEach((b) => (b.onclick = () => setProvider(b.dataset.prov)));
  const sel = $("pv-model"); if (sel) sel.onchange = () => setProvider("openrouter", sel.value);
  const disc = $("pv-disc"); if (disc) disc.onclick = disconnectOpenRouter;
}
async function setProvider(provider, model) {
  if (provider === "openrouter" && !(ME.or && ME.or.connected)) { location.href = "/auth/openrouter/login"; return; }
  try {
    const r = await fetch("/api/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Could not switch engine");
    await loadMe();
    banner(provider === "openrouter" ? `Using OpenRouter · ${j.model}` : "Using GitHub Copilot");
  } catch (e) { banner("⚠️ " + e.message, true); }
}
async function disconnectOpenRouter() {
  if (!confirm("Disconnect OpenRouter? The key is dropped from this session. You should also revoke it in OpenRouter settings.")) return;
  const r = await fetch("/api/openrouter/disconnect", { method: "POST" });
  const j = await r.json().catch(() => ({}));
  await loadMe();
  banner("OpenRouter disconnected. Revoke the key at openrouter.ai/settings/keys", false, j.revokeUrl);
}
function banner(text, isErr, link) {
  let b = $("pv-banner");
  if (!b) { b = document.createElement("div"); b.id = "pv-banner"; b.className = "pv-banner"; $("provider").after(b); }
  b.className = "pv-banner" + (isErr ? " err" : "");
  b.innerHTML = esc(text) + (link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">open settings ↗</a>` : "");
  clearTimeout(banner._t); if (!isErr) banner._t = setTimeout(() => { b.remove(); }, 8000);
}
// Surface the OAuth callback outcome (?or=connected|state_error|exchange_error).
(function () {
  const p = new URLSearchParams(location.search).get("or"); if (!p) return;
  if (p === "connected") banner("✅ OpenRouter connected · using a free model");
  else if (p === "state_error") banner("⚠️ OpenRouter sign-in could not be verified (state mismatch). Try again.", true);
  else if (p === "exchange_error") banner("⚠️ OpenRouter did not return a key. Try connecting again.", true);
  history.replaceState(null, "", location.pathname + location.hash);
})();
$("logout").onclick = async () => { await fetch("/auth/logout", { method: "POST" }); sessionStorage.clear(); location.href = "/"; };

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function md(s) { // tiny, escape-first markdown
  let h = esc(s);
  h = h.replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`);
  h = h.replace(/^### (.*)$/gm, "<h4>$1</h4>").replace(/^## (.*)$/gm, "<h3>$1</h3>").replace(/^# (.*)$/gm, "<h3>$1</h3>");
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/^\s*[-*] (.*)$/gm, "• $1");
  return h.replace(/\n/g, "<br>");
}

// Autoscroll only while the reader is at (or near) the bottom; otherwise offer a "Latest" button.
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
let stick = true;
log.addEventListener("scroll", () => { stick = nearBottom(); $("jump").hidden = stick; }, { passive: true });
function scrollToEnd(force) { if (force || stick) { log.scrollTop = log.scrollHeight; stick = true; $("jump").hidden = true; } else $("jump").hidden = false; }
$("jump").onclick = () => scrollToEnd(true);

function add(cls, html, before) {
  const d = document.createElement("div"); d.className = "msg " + cls; d.innerHTML = html;
  before ? log.insertBefore(d, before) : log.appendChild(d); scrollToEnd(); return d;
}

// Auto-growing textarea; Enter sends (Shift+Enter = newline) on devices with a hardware keyboard.
function grow() { q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight, 160) + "px"; }
q.addEventListener("input", grow);
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) { e.preventDefault(); $("form").requestSubmit(); }
});
// Keep the latest message visible when the on-screen keyboard resizes the viewport.
if (window.visualViewport) visualViewport.addEventListener("resize", () => { if (!$("chat").hidden) scrollToEnd(); });

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const message = q.value.trim(); if (!message) return;
  q.value = ""; grow(); add("user", esc(message)); scrollToEnd(true);
  const bot = add("bot", "<span class='muted'>thinking…</span>"); let text = "";
  const btn = $("form").querySelector("button"); btn.disabled = true;
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, fingerprint: window.BT.shared ? window.BT.fingerprint : null, demoResults: JSON.parse(sessionStorage.getItem("bt_demo") || "null"), history: chatHistory }) });
    if (!res.ok || !res.body) { const j = await res.json().catch(() => ({})); throw new Error(j.error || res.statusText); }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "delta") { text += ev.text; bot.innerHTML = md(text); }
        else if (ev.type === "tool") add("tool", "🔧 tutor called " + esc(ev.name), bot);
        else if (ev.type === "error") throw new Error(ev.message);
      }
      scrollToEnd();
    }
    chatHistory.push({ role: "user", text: message }, { role: "assistant", text });
  } catch (err) { bot.innerHTML = "<span class='muted'>⚠️ " + esc(err.message) + "</span>"; }
  finally { btn.disabled = false; scrollToEnd(); }
};
