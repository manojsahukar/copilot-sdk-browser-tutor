// Renders nested probe/server data as collapsible cards of label/value rows (stack on phones).
(function () {
  const LONG = 90;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const label = (k) => esc(String(k).replace(/([a-z])([A-Z])/g, "$1 $2"));
  function fmt(v) {
    if (v === null || v === undefined) return '<span class="muted">—</span>';
    if (typeof v === "boolean") return `<span class="pill ${v ? "on" : "off"}">${v}</span>`;
    let s = Array.isArray(v) && v.every((x) => typeof x !== "object") ? v.join(", ")
      : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (s === "") return '<span class="muted">(empty)</span>';
    if (s.length <= LONG) return `<span class="v">${esc(s)}</span>`;
    return `<details class="long"><summary><span class="v">${esc(s.slice(0, LONG))}…</span><span class="more">Show all</span></summary><span class="v">${esc(s)}</span></details>`;
  }
  function rows(obj, prefix, depth) {
    let h = "";
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix} › ${label(k)}` : label(k);
      if (v && typeof v === "object" && !Array.isArray(v) && depth < 2 && Object.keys(v).length) h += rows(v, key, depth + 1);
      else h += `<div class="row"><dt>${key}</dt><dd>${fmt(v)}</dd></div>`;
    }
    return h;
  }
  window.renderCards = function (el, data, opts = {}) {
    const wide = matchMedia("(min-width: 900px)").matches;
    const parts = [];
    let i = 0, flat = {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const open = wide || i < (opts.openFirst ?? 2);
        parts.push(`<details class="card"${open ? " open" : ""}><summary>${label(k)}</summary><dl>${rows(v, "", 0)}</dl></details>`);
        i++;
      } else flat[k] = v;
    }
    if (Object.keys(flat).length) parts.unshift(`<details class="card" open><summary>${esc(opts.title || "Overview")}</summary><dl>${rows(flat, "", 0)}</dl></details>`);
    el.innerHTML = parts.join("");
  };
})();
