// Dashboard widgets: agent-editable, schema-validated specs rendered with static code.
// The model never sends code, library config, URLs or data: the server validates the spec and fetches the numbers;
// this file maps the CLEAN spec onto an ECharts option (or plain DOM for tiles/tables) using textContent only.
(function () {
  "use strict";
  const KEY = "bt_widgets", TTL = 7 * 24 * 3600e3, MAX_WIDGETS = 16, MAX_VERSIONS = 10;
  const PALETTE = ["#58a6ff", "#f78166", "#3fb950", "#d29922", "#bc8cff", "#ff7b72", "#79c0ff", "#56d364"];
  const ECHARTS_SRC = "/static/vendor/echarts.custom.min.js?v=5.6.0";
  let login = null;
  let state = { widgets: {} }; // id -> { versions: [spec], pinned, board, data }
  const cards = new Map();     // id -> Set<card element>

  // ---------- persistence (per login, capped, expiring) ----------
  function load(l) {
    login = l; state = { widgets: {} };
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || "null");
      if (o && o.login === l && o.expiresAt > Date.now() && o.widgets && typeof o.widgets === "object") state.widgets = o.widgets;
      else if (o && o.login !== l) localStorage.removeItem(KEY); // another account's widgets are never shown
    } catch {}
  }
  function save() {
    if (!login) return;
    const ids = Object.keys(state.widgets);
    if (ids.length > MAX_WIDGETS) ids.sort((a, b) => (state.widgets[a].at || 0) - (state.widgets[b].at || 0)).slice(0, ids.length - MAX_WIDGETS)
      .forEach((id) => { if (!state.widgets[id].pinned && state.widgets[id].board !== "health") delete state.widgets[id]; });
    const widgets = {};
    for (const [id, w] of Object.entries(state.widgets)) widgets[id] = { versions: w.versions.slice(-MAX_VERSIONS), pinned: !!w.pinned, board: w.board || "chat", at: w.at || 0 };
    try { localStorage.setItem(KEY, JSON.stringify({ login, savedAt: Date.now(), expiresAt: Date.now() + TTL, widgets })); } catch {}
  }
  const latest = (id) => { const w = state.widgets[id]; return w ? w.versions[w.versions.length - 1] : null; };

  // ---------- lazy chart library ----------
  let ecP = null;
  function echartsReady() {
    if (window.echarts) return Promise.resolve(window.echarts);
    return (ecP ??= new Promise((ok, fail) => { const s = document.createElement("script"); s.src = ECHARTS_SRC; s.onload = () => ok(window.echarts); s.onerror = () => { ecP = null; fail(new Error("chart library failed to load")); }; document.head.appendChild(s); }));
  }

  // ---------- pure: clean spec + data -> ECharts option (exported for tests) ----------
  const fmtUnit = (u) => (u === "count" ? "" : u);
  function toOption(spec, data) {
    const colors = spec.series.map((s, i) => s.color || PALETTE[i % PALETTE.length]);
    const base = { animationDuration: 300, color: [...colors, ...PALETTE], textStyle: { color: "#c9d1d9", fontSize: 11 }, backgroundColor: "transparent" };
    const series = data.series || [];
    if (spec.type === "pie") {
      return { ...base, tooltip: { trigger: "item", renderMode: "richText" }, legend: { bottom: 0, textStyle: { color: "#c9d1d9" }, type: "scroll" },
        series: [{ type: "pie", radius: ["35%", "65%"], center: ["50%", "45%"], label: { color: "#c9d1d9" }, data: series.map((x) => ({ name: x.name, value: x.total == null ? 0 : x.total })) }] };
    }
    const right = series.some((x) => x.axis === "right");
    const ax = spec.axes || {};
    const unitL = (series.find((x) => x.axis !== "right") || {}).unit, unitR = (series.find((x) => x.axis === "right") || {}).unit;
    // Percent axes never exceed 100; with an SLO, keep the SLO line in view near the data (sparse data must not blow the scale up).
    const leftVals = series.filter((x) => x.axis !== "right").flatMap((x) => (x.points || []).map((p) => p[1])).filter((v) => typeof v === "number");
    let yMin = ax.y_min, yMax = ax.y_max;
    if (unitL === "%" && yMax == null && leftVals.every((v) => v <= 100)) yMax = 100;
    if (unitL === "%" && spec.slo != null && yMin == null) yMin = Math.max(0, Math.floor(Math.min(spec.slo, ...leftVals) - 1));
    const yAxis = [{ type: "value", name: ax.y_label || fmtUnit(unitL) || "", min: yMin, max: yMax, nameTextStyle: { color: "#8b949e" }, splitLine: { lineStyle: { color: "#21262d" } }, axisLabel: { color: "#8b949e" }, scale: yMin == null }];
    if (right) yAxis.push({ type: "value", name: ax.right_label || fmtUnit(unitR) || "", nameTextStyle: { color: "#8b949e" }, splitLine: { show: false }, axisLabel: { color: "#8b949e" }, scale: true });
    const kind = spec.type === "bar" || spec.type === "stacked" ? "bar" : "line";
    const out = series.map((x, i) => ({
      type: kind, name: x.name, yAxisIndex: right && x.axis === "right" ? 1 : 0, data: x.points, showSymbol: x.points.filter((p) => p[1] != null).length < 30,
      connectNulls: false, smooth: false, ...(spec.type === "area" ? { areaStyle: { opacity: 0.18 } } : {}), ...(spec.type === "stacked" ? { stack: "total" } : {}),
      ...(x.color ? { itemStyle: { color: x.color }, lineStyle: { color: x.color } } : {}),
    }));
    // thresholds / SLO as dashed horizontal markLines on the first series of their axis
    const th = [...(spec.thresholds || [])]; if (spec.slo != null && !th.some((t) => t.value === spec.slo)) th.push({ value: spec.slo, label: `SLO ${spec.slo}%` });
    th.forEach((t) => {
      const idx = Math.max(0, out.findIndex((s) => s.yAxisIndex === (t.axis === "right" && right ? 1 : 0)));
      if (!out[idx]) return;
      out[idx].markLine = out[idx].markLine || { symbol: "none", silent: true, data: [] };
      out[idx].markLine.data.push({ yAxis: t.value, name: t.label || String(t.value), lineStyle: { type: "dashed", color: t.color || "#f85149", width: 1.5 }, label: { formatter: "{b}", color: t.color || "#f85149", position: "insideEndTop" } });
    });
    return { ...base, grid: { left: 44, right: right ? 44 : 14, top: 28, bottom: series.length > 1 ? 44 : 24, containLabel: false },
      tooltip: { trigger: "axis", renderMode: "richText" }, legend: series.length > 1 ? { bottom: 0, type: "scroll", textStyle: { color: "#c9d1d9" } } : undefined,
      xAxis: { type: "time", min: data.from, max: data.to, axisLabel: { color: "#8b949e", hideOverlap: true }, axisLine: { lineStyle: { color: "#30363d" } } }, yAxis, series: out };
  }

  // ---------- DOM helpers (textContent only) ----------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const fmt = (v, unit) => {
    if (v == null) return "—";
    if (unit === "bytes") return v >= 1e9 ? (v / 1e9).toFixed(2) + " GB" : v >= 1e6 ? (v / 1e6).toFixed(1) + " MB" : v >= 1e3 ? (v / 1e3).toFixed(1) + " KB" : Math.round(v) + " B";
    const n = Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
    return n + (unit && unit !== "count" ? (unit === "%" ? "%" : " " + unit) : "");
  };
  const ago = (t) => { if (!t) return "never"; const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + "s ago" : s < 5400 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago"; };
  const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function renderStat(body, spec, data) {
    const wrap = el("div", "w-stats");
    for (const x of data.series || []) {
      const box = el("div", "w-stat");
      const breach = (spec.thresholds || []).some((t) => x.total != null && x.total >= t.value);
      box.append(el("div", "w-stat-v" + (breach ? " bad" : ""), fmt(x.total, x.unit)), el("div", "w-stat-l", `${x.name} · ${x.agg}`));
      wrap.append(box);
    }
    body.append(wrap);
  }
  function renderTable(body, spec, data) {
    const t = el("table", "w-table"); const head = el("tr"); head.append(el("th", "", "series"), el("th", "", "agg"), el("th", "", "total"), el("th", "", "min"), el("th", "", "max"), el("th", "", "points"));
    t.append(head);
    for (const x of data.series || []) {
      const v = x.points.map((p) => p[1]).filter((y) => y != null);
      const tr = el("tr"); tr.append(el("td", "", x.name), el("td", "", x.agg), el("td", "", fmt(x.total, x.unit)), el("td", "", fmt(v.length ? Math.min(...v) : null, x.unit)), el("td", "", fmt(v.length ? Math.max(...v) : null, x.unit)), el("td", "", v.length));
      t.append(tr);
    }
    const w = el("div", "tbl-wrap"); w.append(t); body.append(w);
  }
  function renderStatus(body, spec, data) {
    const grid = el("div", "w-tiles");
    for (const t of data.tiles || []) {
      const tile = el("div", "w-tile " + t.status);
      const top = el("div", "w-tile-top"); top.append(el("span", "dot " + t.status), el("span", "w-tile-name", t.name));
      tile.append(top, el("div", "w-tile-st", t.status === "unknown" ? "no data" : t.status));
      tile.append(el("div", "w-tile-meta", `${t.ms != null ? t.ms + " ms" : "—"} · HTTP ${t.code || "—"} · ${ago(t.checked_at)}`));
      if (t.cert_days != null) tile.append(el("div", "w-tile-meta" + (t.cert_days <= 21 ? " warn" : ""), `TLS cert: ${t.cert_days} days left`));
      grid.append(tile);
    }
    body.append(grid);
    const d = Object.entries(data.derived || {}).filter(([, v]) => v.pct_1h != null);
    if (d.length) body.append(el("div", "w-sub", "CloudFront last hour (derived from 5xx): " + d.map(([k, v]) => `${k} ${fmt(v.pct_1h, "%")} of ${v.requests_1h} req`).join(" · ")));
  }
  function renderUptime(body, spec, data) {
    const t = el("table", "w-table"); const head = el("tr"); head.append(el("th", "", "endpoint"));
    data.windows.forEach((w) => head.append(el("th", "", w.window))); t.append(head);
    const ids = (data.windows[0] || { endpoints: [] }).endpoints.map((e) => e.id);
    ids.forEach((id, i) => {
      const tr = el("tr"); tr.append(el("td", "", data.windows[0].endpoints[i].name));
      data.windows.forEach((w) => {
        const e = w.endpoints[i]; const td = el("td", e.pct == null ? "muted" : e.pct >= data.slo ? "ok" : "bad");
        td.textContent = e.pct == null ? "—" : fmt(e.pct, "%");
        if (e.pct != null) td.append(el("small", "", ` budget ${e.budget_remaining_pct}%${e.thin ? " · thin" : ""}`));
        tr.append(td);
      });
      t.append(tr);
    });
    for (const k of ["main", "sibling", "lab"]) {
      if (!data.windows.some((w) => w.derived && w.derived[k] && w.derived[k].pct != null)) continue;
      const tr = el("tr", "derived"); tr.append(el("td", "", `CloudFront ${k} (derived)`));
      data.windows.forEach((w) => { const v = w.derived && w.derived[k]; const td = el("td", v && v.pct != null ? (v.pct >= data.slo ? "ok" : "bad") : "muted", v && v.pct != null ? fmt(v.pct, "%") : "—"); if (v && v.requests != null) td.append(el("small", "", ` ${v.requests.toLocaleString()} req`)); tr.append(td); });
      t.append(tr);
    }
    const w = el("div", "tbl-wrap"); w.append(t); body.append(el("div", "w-sub", `SLO ${data.slo}% · error budget = allowed downtime left in the window`), w);
  }
  function renderIncidents(body, spec, data) {
    if (!data.items.length) { body.append(el("div", "w-empty", "No incidents in this range.")); return; }
    const ul = el("ul", "w-incidents");
    for (const x of data.items) {
      const li = el("li", x.source === "probe" ? "probe" : "derived");
      li.append(el("div", "w-inc-h", `${when(x.start)} · ${x.minutes} min${x.ongoing ? " · ONGOING" : ""}`), el("div", "w-inc-b", `${x.endpoint} — ${x.detail}${x.source === "derived" ? " (derived)" : ""}`));
      ul.append(li);
    }
    body.append(ul);
  }

  async function drawChart(body, spec, data) {
    const box = el("div", "w-chart"); body.append(box);
    if (!(data.series || []).some((x) => x.points && x.points.some((p) => p[1] != null)) && spec.type !== "pie") { box.remove(); body.append(el("div", "w-empty", "No data points in this range yet.")); return; }
    const ec = await echartsReady();
    const chart = ec.init(box, null, { renderer: "canvas" });
    chart.setOption(toOption(spec, data));
    const ro = new ResizeObserver(() => chart.resize()); ro.observe(box);
    box._chart = chart; box._ro = ro;
  }

  // ---------- cards ----------
  function disposeCard(card) { card.querySelectorAll(".w-chart").forEach((c) => { try { c._ro && c._ro.disconnect(); c._chart && c._chart.dispose(); } catch {} }); }
  async function paint(card, id, data) {
    const w = state.widgets[id]; const spec = latest(id); if (!spec) return;
    disposeCard(card); card.textContent = "";
    card.dataset.version = String(w.versions.length);
    const head = el("div", "w-head");
    head.append(el("div", "w-title", spec.title));
    const meta = el("div", "w-meta");
    meta.append(el("span", "w-badge", `v${w.versions.length}`));
    if (spec.example_data) meta.append(el("span", "w-badge example", "EXAMPLE DATA"));
    meta.append(el("span", "w-badge", (data && data.scope === "site") || ["status", "uptime", "incidents"].includes(spec.type) ? "site" : spec.scope === "site" ? "site" : "you"));
    head.append(meta);
    const tools = el("div", "w-tools");
    const btn = (txt, label, fn, dis) => { const b = el("button", "w-btn", txt); b.type = "button"; b.setAttribute("aria-label", label); b.title = label; if (dis) b.disabled = true; b.onclick = fn; tools.append(b); return b; };
    btn("↶", "Undo last change", () => undo(id), w.versions.length < 2);
    btn("⟳", "Refresh data", () => refresh(id));
    btn(w.pinned ? "📌" : "📍", w.pinned ? "Unpin from Metrics" : "Pin to Metrics", () => { w.pinned = !w.pinned; save(); rerender(id); renderBoards(); });
    if (w.board !== "health") btn("✕", "Remove widget", () => remove(id));
    head.append(tools);
    card.append(head);
    const body = el("div", "w-body"); card.append(body);
    if (!data) { body.append(el("div", "w-empty", "loading…")); return; }
    if (data.error) { body.append(el("div", "w-empty err", "⚠️ " + data.error)); return; }
    try {
      if (data.kind === "status") renderStatus(body, spec, data);
      else if (data.kind === "uptime") renderUptime(body, spec, data);
      else if (data.kind === "incidents") renderIncidents(body, spec, data);
      else if (spec.type === "table") renderTable(body, spec, data);
      else if (spec.type === "stat") renderStat(body, spec, data);
      else await drawChart(body, spec, data);
    } catch (e) { body.append(el("div", "w-empty err", "⚠️ " + (e.message || "render failed"))); }
    const notes = (data.notes || []).slice(0, 3);
    if (notes.length) { const n = el("ul", "w-notes"); notes.forEach((x) => n.append(el("li", "", x))); card.append(n); }
    const foot = el("div", "w-foot", `${spec.range ? spec.range + " · " : ""}${data.interval ? data.interval + " buckets · " : ""}updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    card.append(foot);
  }
  function makeCard(id) {
    const card = el("div", "wcard"); card.dataset.widget = id; card.setAttribute("role", "figure");
    if (!cards.has(id)) cards.set(id, new Set()); cards.get(id).add(card);
    return card;
  }
  function rerender(id) {
    const w = state.widgets[id]; if (!w) return;
    for (const c of cards.get(id) || []) { if (!c.isConnected) { cards.get(id).delete(c); continue; } c.setAttribute("aria-label", "Chart: " + latest(id).title); paint(c, id, w.data); }
  }
  async function fetchData(spec) {
    const r = await fetch("/api/metrics/widget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j.error ? j.error + (j.details ? ": " + j.details.join("; ") : "") : "metrics unavailable" };
    return j.data;
  }
  async function refresh(id) { const w = state.widgets[id]; if (!w) return; w.data = await fetchData(latest(id)); rerender(id); }
  function undo(id) { const w = state.widgets[id]; if (!w || w.versions.length < 2) return; w.versions.pop(); w.at = Date.now(); save(); w.data = null; rerender(id); refresh(id); }
  function remove(id) { for (const c of cards.get(id) || []) { disposeCard(c); c.remove(); } cards.delete(id); delete state.widgets[id]; save(); renderBoards(); }
  function flash(id) { for (const c of cards.get(id) || []) { c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash"); } }
  function visibleIn(id, root) { return [...(cards.get(id) || [])].find((c) => c.isConnected && root.contains(c)); }

  // SSE widget event from the agent: render a new card in the bot message, or update every existing card in place.
  function apply(ev, botEl) {
    const spec = ev.spec; if (!spec || !spec.widget_id) return null;
    const id = spec.widget_id; let w = state.widgets[id]; const existed = !!w;
    if (!w) w = state.widgets[id] = { versions: [], pinned: false, board: "chat" };
    const prev = w.versions[w.versions.length - 1];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(spec)) w.versions.push(spec);
    w.versions = w.versions.slice(-MAX_VERSIONS); w.data = ev.data; w.at = Date.now(); save();
    const log = document.getElementById("log");
    const inChat = log && visibleIn(id, log);
    if (!existed || !inChat) { const c = makeCard(id); botEl.querySelector(".widgets").append(c); }
    rerender(id); renderBoards(); flash(id);
    if (existed && inChat) {
      const link = el("button", "w-updated", `↻ Updated “${spec.title}” → v${w.versions.length} (tap to view)`); link.type = "button";
      link.onclick = () => { inChat.scrollIntoView({ behavior: "smooth", block: "center" }); flash(id); };
      botEl.querySelector(".widgets").append(link);
    }
    return { id, op: existed ? "update" : "render" };
  }
  // Re-attach a card for a restored chat message (fresh data is fetched; specs only are stored).
  function attach(id, container) { if (!state.widgets[id]) return; const c = makeCard(id); container.append(c); paint(c, id, state.widgets[id].data); if (!state.widgets[id].data && !state.widgets[id]._loading) { state.widgets[id]._loading = true; refresh(id).finally(() => { if (state.widgets[id]) state.widgets[id]._loading = false; }); } }

  // ---------- boards: Health (preset, agent-editable) + Metrics (pinned) ----------
  const S = (metric, agg, extra = {}) => ({ metric, ...(agg ? { agg } : {}), ...extra });
  const HEALTH_PRESETS = [
    { widget_id: "health-status", title: "Endpoint status", type: "status", series: [S("uptime_pct")], range: "24h" },
    { widget_id: "health-uptime", title: "Uptime vs SLO", type: "uptime", series: [S("uptime_pct")], range: "30d", slo: 99.5 },
    { widget_id: "health-latency", title: "Response time (probe p95)", type: "line", series: [S("probe_latency_ms", "p95")], group_by: "endpoint", range: "24h", thresholds: [{ value: 1000, label: "1 s" }] },
    { widget_id: "health-availability", title: "Availability (CloudFront-derived)", type: "line", series: [S("cf_availability_pct", "min")], group_by: "distribution", range: "7d", slo: 99.5, axes: { y_min: 90, y_max: 100 } },
    { widget_id: "health-incidents", title: "Incident timeline", type: "incidents", series: [S("uptime_pct")], range: "7d" },
  ];
  const METRIC_PRESETS = [
    { label: "Lambda p95 vs invocations", spec: { widget_id: "lambda-duration", title: "Lambda duration p95 vs invocations", type: "line", series: [S("lambda_duration_ms", "p95"), S("lambda_invocations", "sum", { axis: "right" })], range: "24h" } },
    { label: "CloudFront requests by site", spec: { widget_id: "cf-requests", title: "CloudFront requests by distribution", type: "stacked", series: [S("cf_requests", "sum")], group_by: "distribution", range: "7d" } },
    { label: "4xx / 5xx rates", spec: { widget_id: "cf-errors", title: "CloudFront 4xx / 5xx rate", type: "line", series: [S("cf_4xx_rate", "avg"), S("cf_5xx_rate", "avg")], range: "24h", thresholds: [{ value: 5, label: "5%" }] } },
    { label: "Lambda errors & throttles", spec: { widget_id: "lambda-errors", title: "Lambda errors & throttles", type: "bar", series: [S("lambda_errors", "sum"), S("lambda_throttles", "sum")], range: "7d" } },
    { label: "Concurrency", spec: { widget_id: "lambda-concurrency", title: "Lambda concurrent executions (max)", type: "line", series: [S("lambda_concurrency", "max")], range: "24h", thresholds: [{ value: 5, label: "reserved = 5" }] } },
    { label: "My reply latency", spec: { widget_id: "my-latency", title: "My reply latency (p95)", type: "line", series: [S("reply_latency_ms", "p95")], range: "7d", scope: "me" } },
  ];
  function ensure(spec, board, pinned) {
    if (state.widgets[spec.widget_id]) return false;
    state.widgets[spec.widget_id] = { versions: [spec], pinned: !!pinned, board, at: Date.now() }; save(); return true;
  }
  function boardInto(root, ids) {
    for (const c of root.querySelectorAll(".wcard")) { const id = c.dataset.widget; if (!ids.includes(id)) { disposeCard(c); c.remove(); } }
    for (const id of ids) {
      let c = visibleIn(id, root);
      if (!c) { c = makeCard(id); root.append(c); paint(c, id, state.widgets[id].data); if (!state.widgets[id].data) refresh(id); }
      else root.append(c); // keep order
    }
  }
  function renderBoards() {
    const h = document.getElementById("healthBoard"), m = document.getElementById("metricsBoard");
    if (h && !h.closest("[hidden]")) boardInto(h, HEALTH_PRESETS.map((p) => p.widget_id).filter((id) => state.widgets[id]));
    if (m && !m.closest("[hidden]")) {
      const ids = Object.keys(state.widgets).filter((id) => state.widgets[id].pinned);
      boardInto(m, ids);
      const empty = document.getElementById("metricsEmpty"); if (empty) empty.hidden = ids.length > 0;
    }
  }
  function openHealth() { HEALTH_PRESETS.forEach((p) => ensure(p, "health")); renderBoards(); }
  function openMetrics() {
    const row = document.getElementById("metricPresets");
    if (row && !row.childElementCount) METRIC_PRESETS.forEach((p) => {
      const b = el("button", "chip", "+ " + p.label); b.type = "button";
      b.onclick = () => { if (!ensure(p.spec, "metrics", true)) state.widgets[p.spec.widget_id].pinned = true; save(); renderBoards(); const c = visibleIn(p.spec.widget_id, document.getElementById("metricsBoard")); if (c) c.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
      row.append(b);
    });
    renderBoards();
  }
  function refreshBoard(which) {
    const ids = which === "health" ? HEALTH_PRESETS.map((p) => p.widget_id) : Object.keys(state.widgets).filter((id) => state.widgets[id].pinned);
    ids.forEach((id) => state.widgets[id] && refresh(id));
  }

  // ---------- browser performance beacon (aggregates, rounded server-side; once per tab session) ----------
  function beacon() {
    try { if (sessionStorage.getItem("bt_rum")) return; sessionStorage.setItem("bt_rum", "1"); } catch { return; }
    let lcp = null, cls = 0;
    try { new PerformanceObserver((l) => { const e = l.getEntries(); if (e.length) lcp = e[e.length - 1].startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
    setTimeout(() => {
      const nav = performance.getEntriesByType("navigation")[0] || {};
      const c = navigator.connection || {};
      const body = { ttfb: nav.responseStart || null, dcl: nav.domContentLoadedEventEnd || null, load: nav.loadEventEnd || null, lcp, cls: Math.round(cls * 1000) / 1000,
        heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, rtt: typeof c.rtt === "number" ? c.rtt : null,
        conn: c.effectiveType || "unknown", dev: matchMedia("(pointer: coarse)").matches ? "mobile" : "desktop" };
      fetch("/api/metrics/web", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
    }, 4000);
  }

  window.BTW = {
    init(l) { load(l); renderBoards(); beacon(); },
    list: () => Object.keys(state.widgets).map(latest).filter(Boolean),
    apply, attach, openHealth, openMetrics, refreshBoard, toOption, latest,
    clear() { try { localStorage.removeItem(KEY); } catch {} state = { widgets: {} }; },
    _state: () => state,
  };
})();
