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
    if (location.hash && !location.hash.startsWith("#AML.")) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  });

  const atlasLead = document.getElementById("atlas-lead");
  const atlasCounts = document.getElementById("atlas-counts");
  const atlasApp = document.getElementById("atlas-applicable");
  const atlasNa = document.getElementById("atlas-na");
  fetch("/api/atlas").then((r) => r.json()).then((evalData) => {
    const m = evalData.meta || {};
    const applicable = evalData.applicable || [];
    const na = evalData.notApplicable || [];
    atlasLead.innerHTML =
      "This section maps Browser Tutor to <a href=\"" + esc(m.siteUrl || "https://atlas.mitre.org/") + "\" rel=\"noopener\" target=\"_blank\">MITRE ATLAS</a> " +
      "(" + esc(m.fullName || "Adversarial Threat Landscape for Artificial-Intelligence Systems") + "). " +
      "Content version <strong>" + esc(m.version || "") + "</strong> " +
      "(modified " + esc(m.modifiedDate || "") + ", data format " + esc(m.formatVersion || "") + "). " +
      "Technique identifiers and official names come from the official ATLAS data release " +
      "<a href=\"" + esc(m.yamlUrl || "") + "\" rel=\"noopener\" target=\"_blank\">ATLAS-" + esc(m.version || "") + ".yaml</a> " +
      "in <a href=\"" + esc(m.dataRepoUrl || "") + "\" rel=\"noopener\" target=\"_blank\">mitre-atlas/atlas-data</a>. " +
      "This is a defensive mapping. It does not include exploit steps. Evaluation date " + esc(m.evaluatedOn || "") + " (Asia/Calcutta).";
    const stCount = {};
    applicable.forEach((a) => { stCount[a.status] = (stCount[a.status] || 0) + 1; });
    atlasCounts.hidden = false;
    atlasCounts.textContent =
      applicable.length + " applicable techniques. " +
      na.length + " listed as not applicable. " +
      "Statuses: " +
      (stCount.fixed || 0) + " fixed, " +
      (stCount.mitigated || 0) + " mitigated, " +
      (stCount.accepted || 0) + " accepted, " +
      (stCount["needs-human"] || 0) + " needs human.";
    const wide = matchMedia("(min-width: 900px)").matches;
    atlasApp.innerHTML = applicable.map((a, i) => {
      const st = STATUS[a.status] || { t: a.status || "", c: "" };
      const gotchaLinks = (a.gotchaIds || []).map((id) =>
        `<a class="atlas-gotcha" href="#${esc(id)}">${esc(id)}</a>`
      ).join(" ");
      return `
      <li id="${esc(a.id)}"><details class="card"${wide || location.hash === "#" + a.id ? " open" : ""}>
        <summary><span class="gt-num">${i + 1}</span>
          <span class="gt-title"><code class="atlas-id">${esc(a.id)}</code> ${esc(a.name)}</span>
          <span class="status ${st.c}">${esc(st.t)}</span>
          <span class="badge docs">ATLAS</span></summary>
        <div class="gt-body">
          <h3>Tactic</h3>
          <p><code>${esc(a.tacticId)}</code> ${esc(a.tacticName)} · <a href="${esc(a.sourceUrl)}" rel="noopener" target="_blank">ATLAS technique page</a></p>
          <h3>How it applies here</h3><p>${esc(a.apply)}</p>
          <h3>Existing control</h3><p>${esc(a.control)}</p>
          <h3>Status</h3><p class="gt-fix"><span class="status ${st.c}">${esc(st.t)}</span> ${esc(a.residual)}</p>
          ${gotchaLinks ? `<h3>Related gotchas</h3><p class="atlas-gotcha-row">${gotchaLinks}</p>` : ""}
        </div></details></li>`;
    }).join("");
    atlasNa.innerHTML = na.map((a) =>
      `<li><code class="atlas-id">${esc(a.id)}</code> <a href="${esc(a.sourceUrl)}" rel="noopener" target="_blank">${esc(a.name)}</a>. ${esc(a.reason)}</li>`
    ).join("");
    if (location.hash && location.hash.startsWith("#AML.")) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView();
    }
  }).catch(() => {
    atlasLead.textContent = "The ATLAS evaluation failed to load.";
    atlasApp.innerHTML = "";
    atlasNa.innerHTML = "";
  });

  const btn = document.getElementById("expandAll");
  btn.onclick = () => {
    const all = document.querySelectorAll(".gotchas details");
    const open = [...all].some((d) => !d.open);
    all.forEach((d) => (d.open = open));
    btn.textContent = open ? "Collapse all" : "Expand all";
  };
})();
