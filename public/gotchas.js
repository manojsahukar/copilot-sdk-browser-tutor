(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LBL = { build: "seen in this build", docs: "from the docs", unverified: "unverified" };
  const STATUS = {
    fixed: { t: "Fixed", c: "st-fixed" },
    mitigated: { t: "Mitigated", c: "st-mitigated" },
    accepted: { t: "Accepted", c: "st-accepted" },
    "needs-human": { t: "Needs human", c: "st-needs" },
  };
  const list = document.getElementById("gotchas");
  fetch("/api/gotchas").then((r) => r.json()).then((items) => {
    const wide = matchMedia("(min-width: 900px)").matches;
    list.innerHTML = items.map((g, i) => {
      const st = STATUS[g.status] || { t: g.status || "", c: "" };
      return `
      <li id="${esc(g.id)}"><details class="card"${wide || i === 0 || location.hash === "#" + g.id ? " open" : ""}>
        <summary><span class="gt-num">${i + 1}</span><span class="gt-title">${esc(g.title)}</span>
          <span class="status ${st.c}">${esc(st.t)}</span>
          <span class="badge ${esc(g.verified)}">${esc(LBL[g.verified] || g.verified)}</span></summary>
        <div class="gt-body">
          <h3>What it is</h3><p>${esc(g.what)}</p>
          <h3>Why it's dangerous or costly</h3><p>${esc(g.risk)}</p>
          <h3>What this app does</h3><p>${esc(g.app)}</p>
          ${g.fix ? `<h3>How we fixed it</h3><p class="gt-fix"><span class="status ${st.c}">${esc(st.t)}</span> ${esc(g.fix)}</p>` : ""}
          ${g.sources.length ? `<h3>Sources</h3><ul class="src">${g.sources.map((s) => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.label)}</a></li>`).join("")}</ul>` : ""}
        </div></details></li>`;
    }).join("");
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  });
  const btn = document.getElementById("expandAll");
  btn.onclick = () => { const all = list.querySelectorAll("details"); const open = [...all].some((d) => !d.open); all.forEach((d) => (d.open = open)); btn.textContent = open ? "Collapse all" : "Expand all"; };
})();
