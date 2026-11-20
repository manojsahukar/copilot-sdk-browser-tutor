/* Read-only WebMCP tools for the public pages. CSP-safe: no inline code, no HTML insertion.
 * Every tool only returns public lesson text or what the page already shows.
 * They never read cookies, web storage, or saved chat.
 * Chrome WebMCP annotations that round-trip are readOnlyHint, untrustedContentHint,
 * consequentialHint, and debugging. There is no idempotent flag, so each description
 * says the call can be repeated. consequentialHint is false because nothing is changed. */
(function () {
  "use strict";
  var G = typeof window !== "undefined" ? window : globalThis;
  var HAS_DOM = typeof document !== "undefined" && !!document.getElementById && !!document.addEventListener;
  var SECRET_RE = /gh[opsur]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-or-[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}/g;
  var ASSIGN_RE = /(?:bt_sess|btw_or_key|btw_or_key_persist|btw_hf_token|btw_pkce|bt_chat)=[^;\s]+/g;
  var HIDE_KEYS = { cookie: 1, cookies: 1, authorization: 1, "set-cookie": 1, access_token: 1, refresh_token: 1, id_token: 1, client_secret: 1, api_key: 1, apikey: 1, password: 1, secret: 1, token: 1, btw_or_key: 1, btw_or_key_persist: 1, btw_hf_token: 1, bt_sess: 1, bt_chat: 1, btw_pkce: 1 };

  var SITE_PAGES = [
    { path: "/", title: "Browser probe and tutor", summary: "Shows what this browser reveals, then lets you ask the tutor." },
    { path: "/gotchas", title: "Agent SDK gotchas", summary: "Lessons from this build, plus a MITRE ATLAS evaluation." },
    { path: "/architecture", title: "Architecture", summary: "How a request, sign-in, and the agent tools fit together." },
    { path: "/demos", title: "Live demos", summary: "Permission and storage demos that run only when you tap." },
    { path: "/widget/", title: "Chat widget docs", summary: "A client-side chat widget, including the color tool demo." },
    { path: "/widget/storage.html", title: "Where keys live", summary: "Where the widget keeps an OpenRouter key in this browser." },
    { path: "/widget/xss.html", title: "Script injection risk", summary: "Why a key in the page is exposed if a script is injected." },
    { path: "/widget/openrouter.html", title: "Who pays", summary: "The visitor's own OpenRouter account pays for model calls." },
    { path: "/widget/privacy.html", title: "Privacy", summary: "What leaves the browser when you chat from the widget." }
  ];
  var DEMOS = [
    { id: "storage_inspector", title: "What this site stores in your browser", needsPermission: false, summary: "Shows names and sizes of storage on this site. This tool does not read that storage." },
    { id: "xss_lab", title: "Script injection lab", needsPermission: false, summary: "A contained lab on its own origin. Nothing runs until you tap." },
    { id: "camera", title: "Camera access", needsPermission: true, summary: "Asks for the camera and keeps the video on this device." },
    { id: "microphone", title: "Microphone access", needsPermission: true, summary: "Asks for the microphone and shows a level meter on this device." },
    { id: "geolocation", title: "Precise location", needsPermission: true, summary: "Asks for location. The precise point stays on this page." },
    { id: "cookie_jar", title: "Cross-site cookies", needsPermission: false, summary: "Shows a dummy cookie set by a sibling site." },
    { id: "cross_site_fetch", title: "Cross-site requests", needsPermission: false, summary: "Compares a readable cross-site response with an opaque one." }
  ];
  var ARCH = [
    { id: "req", title: "Request flow", summary: "Your browser sends the request to the site edge, then to the app, then to the model." },
    { id: "auth", title: "Sign-in and tokens", summary: "GitHub sign-in stays on the server. The browser never sees the sign-in client secret." },
    { id: "loop", title: "Agent and tools", summary: "The model can ask for a tool. The app allows only a fixed list and refuses every other tool." },
    { id: "trust", title: "Trust boundaries", summary: "The browser, the edge, the app account, and third parties are separate zones." }
  ];
  var DEMO_IDS = DEMOS.map(function (d) { return d.id; });
  var ARCH_IDS = ARCH.map(function (s) { return s.id; });
  var EMPTY = { type: "object", additionalProperties: false, properties: {} };

  function cap(s, n) {
    s = String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) : s;
  }
  function scrub(v, depth) {
    if (depth > 8) return "[truncated]";
    if (typeof v === "string") return cap(v, 2000).replace(SECRET_RE, "[redacted]").replace(ASSIGN_RE, "[hidden]");
    if (v == null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.slice(0, 80).map(function (x) { return scrub(x, depth + 1); });
    var out = {}, keys = Object.keys(v).slice(0, 80);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out[k] = HIDE_KEYS[String(k).toLowerCase()] ? "[hidden]" : scrub(v[k], depth + 1);
    }
    return out;
  }
  function hints(untrusted) {
    return { readOnlyHint: true, consequentialHint: false, untrustedContentHint: !!untrusted, debugging: false };
  }
  function outSchema(extra) {
    var props = {
      ok: { type: "boolean", description: "True when the call worked." },
      message: { type: "string", description: "A short sentence when the call worked." },
      error: { type: "string", description: "A short sentence when the call was refused." }
    };
    var keys = Object.keys(extra || {});
    for (var i = 0; i < keys.length; i++) props[keys[i]] = extra[keys[i]];
    return { type: "object", additionalProperties: false, required: ["ok"], properties: props };
  }
  function checkInput(schema, input) {
    if (input == null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) return { error: "Input must be an object." };
    var props = schema && schema.properties || {};
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) if (!Object.prototype.hasOwnProperty.call(props, keys[i])) return { error: "Unknown input field: " + String(keys[i]).slice(0, 40) };
    var req = schema && schema.required || [];
    for (var j = 0; j < req.length; j++) if (!Object.prototype.hasOwnProperty.call(input, req[j])) return { error: "Missing input field: " + req[j] };
    return { value: input };
  }
  function field(input, key) {
    if (!input || typeof input[key] !== "string") return "";
    return input[key].trim();
  }
  function asTool(spec, run) {
    return {
      name: spec.name, title: spec.title, description: spec.description,
      inputSchema: JSON.parse(JSON.stringify(spec.inputSchema)),
      outputSchema: JSON.parse(JSON.stringify(spec.outputSchema)),
      annotations: hints(spec.untrusted),
      execute: function (input) {
        var chk = checkInput(spec.inputSchema, input);
        if (chk.error) return Promise.resolve({ ok: false, error: chk.error });
        try {
          return Promise.resolve(run(chk.value)).then(function (r) { return scrub(r); }, function () { return { ok: false, error: "The tool failed." }; });
        } catch (e) { return Promise.resolve({ ok: false, error: "The tool failed." }); }
      }
    };
  }

  function siteGuide() {
    return { ok: true, message: "Public pages on this site. Nothing here is a key or a cookie.", pages: SITE_PAGES.map(function (p) { return { path: p.path, title: p.title, summary: p.summary }; }) };
  }
  function pathOnly(url) {
    try { return new URL(String(url || "/"), "http://localhost").pathname || "/"; } catch (e) { return "/"; }
  }
  function browserReveal(fp) {
    if (!fp || typeof fp !== "object") return { ok: false, error: "The browser probe is not ready yet. Wait a moment and try again." };
    var storage = fp.storage && typeof fp.storage === "object" ? {
      cookieEnabled: !!fp.storage.cookieEnabled, localStorage: !!fp.storage.localStorage,
      sessionStorage: !!fp.storage.sessionStorage, indexedDB: !!fp.storage.indexedDB, quota: fp.storage.quota
    } : null;
    var nav = fp.navigation && typeof fp.navigation === "object" ? {
      referrer: fp.navigation.referrer ? "present" : "(none)", historyLength: fp.navigation.historyLength, online: fp.navigation.online
    } : null;
    var reveal = {
      collectedAt: fp.collectedAt, pagePath: pathOnly(fp.pageUrl), userAgent: fp.userAgent, clientHints: fp.clientHints,
      locale: fp.locale, screen: fp.screen, hardware: fp.hardware, storage: storage, privacySignals: fp.privacySignals,
      preferences: fp.preferences,
      canvas: fp.canvas && typeof fp.canvas === "object" ? { hash: fp.canvas.hash, dataUrlLength: fp.canvas.dataUrlLength, explanation: fp.canvas.explanation } : fp.canvas,
      webgl: fp.webgl, fonts: fp.fonts, audio: fp.audio, mediaDevices: fp.mediaDevices, network: fp.network,
      battery: fp.battery, navigation: nav, plugins: fp.plugins, permissions: fp.permissions, apis: fp.apis, summaryHash: fp.summaryHash
    };
    return { ok: true, message: "This is the public browser probe already shown on the page. Cookies, keys, and chat text are not included.", reveal: reveal };
  }
  function connectionReveal(text) {
    var raw = String(text || "").trim();
    if (!raw || raw.charAt(0) !== "{") return { ok: false, error: "The connection panel is not ready yet. Wait a moment and try again." };
    var view;
    try { view = JSON.parse(raw); } catch (e) { return { ok: false, error: "The connection panel could not be read." }; }
    if (!view || typeof view !== "object" || Array.isArray(view)) return { ok: false, error: "The connection panel could not be read." };
    return { ok: true, message: "This is the connection view already shown on the page. Cookie values stay hidden.", connection: view };
  }
  function summarizeAtlas(data) {
    if (!data || !data.meta) return { ok: false, error: "The ATLAS evaluation is not available." };
    var app = Array.isArray(data.applicable) ? data.applicable : [];
    var na = Array.isArray(data.notApplicable) ? data.notApplicable : [];
    var counts = { applicable: app.length, notApplicable: na.length, fixed: 0, mitigated: 0, accepted: 0, needsHuman: 0 };
    var rows = [];
    for (var i = 0; i < app.length; i++) {
      var st = String(app[i].status || "");
      if (st === "fixed") counts.fixed++;
      else if (st === "mitigated") counts.mitigated++;
      else if (st === "accepted") counts.accepted++;
      else if (st === "needs-human") counts.needsHuman++;
      rows.push({ id: app[i].id, name: app[i].name, status: st });
    }
    return {
      ok: true,
      message: "MITRE ATLAS " + (data.meta.version || "") + " lists " + app.length + " techniques that apply to this site.",
      meta: { name: data.meta.fullName, version: data.meta.version, modified: data.meta.modifiedDate, evaluatedOn: data.meta.evaluatedOn },
      counts: counts, applicable: rows, notApplicable: na.map(function (t) { return { id: t.id, name: t.name }; })
    };
  }
  function techniqueView(t, applicable) {
    var view = { id: t.id, name: t.name, sourceUrl: t.sourceUrl, applicable: !!applicable };
    if (applicable) {
      view.tacticId = t.tacticId; view.tacticName = t.tacticName; view.status = t.status;
      view.apply = cap(t.apply, 1500); view.control = cap(t.control, 1500); view.residual = cap(t.residual, 1500);
      view.gotchaIds = Array.isArray(t.gotchaIds) ? t.gotchaIds.slice(0, 20) : [];
    } else view.reason = cap(t.reason, 1500);
    return view;
  }
  function lookupAtlas(data, input) {
    if (!data || typeof data !== "object") return { ok: false, error: "The ATLAS evaluation is not available." };
    var id = field(input, "id"), query = field(input, "query").toLowerCase();
    var app = Array.isArray(data.applicable) ? data.applicable : [];
    var na = Array.isArray(data.notApplicable) ? data.notApplicable : [];
    if (id) {
      if (!/^AML\.T[0-9]{4}(?:\.[0-9]{3})?$/.test(id)) return { ok: false, error: "Technique code should look like AML.T0051." };
      for (var i = 0; i < app.length; i++) if (app[i].id === id) return { ok: true, message: app[i].id + " " + app[i].name + ".", technique: techniqueView(app[i], true) };
      for (var n = 0; n < na.length; n++) if (na[n].id === id) return { ok: true, message: na[n].id + " does not apply to this site.", technique: techniqueView(na[n], false) };
      return { ok: false, error: "No technique matches that code." };
    }
    if (!query) return { ok: false, error: "Give a technique code such as AML.T0051." };
    var hits = [];
    for (var j = 0; j < app.length; j++) if (String(app[j].name || "").toLowerCase().indexOf(query) >= 0) hits.push(techniqueView(app[j], true));
    for (var k = 0; k < na.length; k++) if (String(na[k].name || "").toLowerCase().indexOf(query) >= 0) hits.push(techniqueView(na[k], false));
    if (!hits.length) return { ok: false, error: "No technique matches those words." };
    if (hits.length === 1) return { ok: true, message: hits[0].id + " " + hits[0].name + ".", technique: hits[0] };
    return { ok: true, message: "Several techniques match. Call again with one code.", matches: hits.slice(0, 8) };
  }
  function gotchaView(g) {
    return {
      id: g.id, title: g.title, status: g.status, verified: g.verified,
      what: cap(g.what, 1500), risk: cap(g.risk, 1500), app: cap(g.app, 1500), fix: cap(g.fix || "", 1500)
    };
  }
  function lookupGotcha(items, input) {
    if (!Array.isArray(items)) return { ok: false, error: "The gotchas list is not available." };
    var id = field(input, "id").toLowerCase(), query = field(input, "query").toLowerCase();
    if (id) {
      if (!/^[a-z0-9-]{1,64}$/.test(id)) return { ok: false, error: "Gotcha code should be short words joined by hyphens, such as llm-js-xss." };
      for (var i = 0; i < items.length; i++) if (String(items[i].id) === id) return { ok: true, message: items[i].title + ".", gotcha: gotchaView(items[i]) };
      return { ok: false, error: "No gotcha matches that code." };
    }
    if (!query) return { ok: false, error: "Give a gotcha code such as llm-js-xss." };
    var hits = [];
    for (var j = 0; j < items.length; j++) if (String(items[j].title || "").toLowerCase().indexOf(query) >= 0) hits.push(gotchaView(items[j]));
    if (!hits.length) return { ok: false, error: "No gotcha matches those words." };
    if (hits.length === 1) return { ok: true, message: hits[0].title + ".", gotcha: hits[0] };
    return { ok: true, message: "Several gotchas match. Call again with one code.", matches: hits.slice(0, 8) };
  }
  function architectureGuide(input) {
    var id = field(input, "section");
    var rows = ARCH.filter(function (s) { return !id || s.id === id; });
    if (id && !rows.length) return { ok: false, error: "Unknown section. Use req, auth, loop, or trust." };
    return { ok: true, message: rows.length === 1 ? rows[0].title + "." : "Four diagrams describe this app.", sections: rows.map(function (s) { return { id: s.id, title: s.title, summary: s.summary }; }) };
  }
  function demoCatalog(input) {
    var id = field(input, "id");
    var rows = DEMOS.filter(function (d) { return !id || d.id === id; });
    if (id && !rows.length) return { ok: false, error: "Unknown demo code.", allowedIds: DEMO_IDS.slice() };
    return { ok: true, message: rows.length === 1 ? rows[0].title + "." : "There are " + rows.length + " live demos. None of them run from this tool.", demos: rows.map(function (d) { return { id: d.id, title: d.title, needsPermission: d.needsPermission, summary: d.summary }; }) };
  }
  function demoState(doc, input) {
    var id = field(input, "id");
    if (id && DEMO_IDS.indexOf(id) < 0) return { ok: false, error: "Unknown demo code.", allowedIds: DEMO_IDS.slice() };
    var rows = [];
    for (var i = 0; i < DEMOS.length; i++) {
      if (id && DEMOS[i].id !== id) continue;
      var el = doc && typeof doc.getElementById === "function" ? doc.getElementById("out-" + DEMOS[i].id) : null;
      var text = el && el.textContent ? String(el.textContent).trim() : "";
      rows.push({ id: DEMOS[i].id, title: DEMOS[i].title, needsPermission: DEMOS[i].needsPermission, onPage: !!el, hasResult: text.length > 0 });
    }
    return { ok: true, message: "Demo state is the demo code and whether a result is on screen. Stored text is not included.", demos: rows };
  }
  function safePath(href) {
    if (typeof href !== "string") return "";
    var h = href.trim();
    if (!h || h.charAt(0) !== "/" || h.slice(0, 2) === "//" || h.slice(0, 2) === "/\\" || /[\s\u0000-\u001f]/.test(h)) return "";
    var cut = h.split("#")[0].split("?")[0];
    return cut.length > 120 ? "" : cut;
  }
  function readPage(doc, loc) {
    var h1 = doc.querySelector ? doc.querySelector("h1") : null;
    var titleEl = doc.querySelector ? doc.querySelector("title") : null;
    var title = cap((h1 && h1.textContent) || (titleEl && titleEl.textContent) || "", 160);
    var hs = doc.querySelectorAll ? doc.querySelectorAll("h1, h2, h3") : [];
    var headings = [];
    for (var i = 0; i < hs.length && headings.length < 12; i++) {
      var t = cap(hs[i].textContent || "", 160);
      if (t) headings.push(t);
    }
    var as = doc.querySelectorAll ? doc.querySelectorAll("a[href]") : [];
    var links = [], seen = Object.create(null);
    for (var j = 0; j < as.length && links.length < 20; j++) {
      var p = safePath(as[j].getAttribute ? as[j].getAttribute("href") : "");
      if (p && !seen[p]) { seen[p] = 1; links.push(p); }
    }
    return { title: title, path: (loc && loc.pathname) || "/", headings: headings, links: links };
  }
  function pageGuide(info) {
    info = info || {};
    return {
      ok: true,
      message: "Headings and links from this page. Keys, cookies, and saved chat are not included.",
      page: { title: cap(info.title, 160), path: String(info.path || "/"), headings: (info.headings || []).slice(0, 12), links: (info.links || []).slice(0, 20) }
    };
  }

  var PAGE_SCHEMA = outSchema({
    page: { type: "object", additionalProperties: false, required: ["title", "path", "headings", "links"], properties: {
      title: { type: "string" }, path: { type: "string" },
      headings: { type: "array", items: { type: "string" } }, links: { type: "array", items: { type: "string" } }
    } }
  });
  var SPECS = {
    site: { name: "get_site_guide", title: "Site guide", untrusted: false,
      description: "List the public pages on this site and what each one is for. This only reads a fixed list. It does not read cookies, keys, or saved chat. You can call it again.",
      inputSchema: EMPTY, outputSchema: outSchema({ pages: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "title", "summary"], properties: { path: { type: "string" }, title: { type: "string" }, summary: { type: "string" } } } } }) },
    browser: { name: "get_browser_reveal", title: "What the browser reveals", untrusted: true,
      description: "Read what this page already shows about the browser, such as language, screen, and graphics. This changes nothing. It does not read cookies, keys, or saved chat. You can call it again.",
      inputSchema: EMPTY, outputSchema: outSchema({ reveal: { type: "object", description: "The public probe already on the page." } }) },
    connection: { name: "get_connection_reveal", title: "What the connection reveals", untrusted: true,
      description: "Read what this page already shows about the connection, with cookie values hidden. This changes nothing. It does not read saved chat or keys. You can call it again.",
      inputSchema: EMPTY, outputSchema: outSchema({ connection: { type: "object", description: "The connection panel, with secrets hidden." } }) },
    atlas: { name: "get_atlas_summary", title: "ATLAS summary", untrusted: false,
      description: "Summarize the MITRE ATLAS (Adversarial Threat Landscape for Artificial-Intelligence Systems) evaluation on this page. This only reads the public evaluation. You can call it again.",
      inputSchema: EMPTY, outputSchema: outSchema({ meta: { type: "object" }, counts: { type: "object" }, applicable: { type: "array" }, notApplicable: { type: "array" } }) },
    atlasOne: { name: "lookup_atlas_technique", title: "Look up an ATLAS technique", untrusted: false,
      description: "Look up one MITRE ATLAS (Adversarial Threat Landscape for Artificial-Intelligence Systems) technique by its code, such as AML.T0051, or by words in its name. This returns the public defensive note for this site. It does not include attack steps. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", maxLength: 20, description: "Technique code such as AML.T0051.", default: "AML.T0051", examples: ["AML.T0051"], pattern: "^AML\\.T[0-9]{4}(?:\\.[0-9]{3})?$" },
        query: { type: "string", maxLength: 80, description: "Words from the technique name, such as prompt injection.", examples: ["prompt injection"], default: "prompt injection" }
      } },
      outputSchema: outSchema({ technique: { type: "object" }, matches: { type: "array" } }) },
    gotcha: { name: "lookup_gotcha", title: "Look up a gotcha", untrusted: false,
      description: "Look up one Agent SDK gotcha by its code, such as llm-js-xss, or by words in its title. This reads the public lesson text. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", maxLength: 64, description: "Gotcha code such as llm-js-xss.", default: "llm-js-xss", examples: ["llm-js-xss"], pattern: "^[a-z0-9-]{1,64}$" },
        query: { type: "string", maxLength: 80, description: "Words from the gotcha title.", examples: ["prompt injection"], default: "prompt injection" }
      } },
      outputSchema: outSchema({ gotcha: { type: "object" }, matches: { type: "array" } }) },
    arch: { name: "get_architecture_guide", title: "Architecture guide", untrusted: false,
      description: "Read a short guide to the architecture diagrams on this page. Pass a section code such as req, auth, loop, or trust. This changes nothing. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        section: { type: "string", description: "Diagram code. req, auth, loop, or trust.", default: "req", examples: ["req"], enum: ARCH_IDS.slice() }
      } },
      outputSchema: outSchema({ sections: { type: "array" } }) },
    catalog: { name: "get_demo_catalog", title: "Demo catalog", untrusted: false,
      description: "List the live demos and whether each one asks for a permission. This reads a fixed list and does not run a demo. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", description: "One demo code, or omit it to list them all. The manual sample uses storage_inspector.", default: "storage_inspector", examples: ["storage_inspector"], enum: DEMO_IDS.slice() }
      } },
      outputSchema: outSchema({ demos: { type: "array" }, allowedIds: { type: "array", items: { type: "string" } } }) },
    state: { name: "read_demo_state", title: "Demo state", untrusted: false,
      description: "Report which demos are on this page and whether each one has a result on screen. This does not return stored chat, cookie values, or keys. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", description: "One demo code, or omit it to report them all. The manual sample uses storage_inspector.", default: "storage_inspector", examples: ["storage_inspector"], enum: DEMO_IDS.slice() }
      } },
      outputSchema: outSchema({ demos: { type: "array" }, allowedIds: { type: "array", items: { type: "string" } } }) },
    page: { name: "get_page_guide", title: "Page guide", untrusted: true,
      description: "Read the title, headings, and same-site links on this docs page. This changes nothing. It does not read keys, cookies, or saved chat. You can call it again.",
      inputSchema: EMPTY, outputSchema: PAGE_SCHEMA }
  };

  function markersFrom(doc) {
    return {
      probe: !!(doc && doc.getElementById && doc.getElementById("fp")),
      gotchas: !!(doc && doc.getElementById && doc.getElementById("atlas")),
      architecture: !!(doc && doc.getElementById && doc.getElementById("req")),
      demos: !!(doc && doc.getElementById && doc.getElementById("demos")),
      widget: !!(doc && doc.querySelector && doc.querySelector("nav.site"))
    };
  }
  function specList(markers) {
    var m = markers || {};
    var list = [SPECS.site];
    if (m.probe) list.push(SPECS.browser, SPECS.connection);
    if (m.gotchas) list.push(SPECS.atlas, SPECS.atlasOne, SPECS.gotcha);
    if (m.architecture) list.push(SPECS.arch);
    if (m.demos) list.push(SPECS.catalog, SPECS.state);
    if (m.widget) list.push(SPECS.page);
    return list;
  }
  function createTools(markers, deps) {
    deps = deps || {};
    var doc = deps.doc || null;
    var loc = deps.location || (typeof location !== "undefined" ? location : { pathname: "/" });
    var load = deps.loadJson || function (url) {
      if (typeof fetch !== "function") return Promise.reject(new Error("no fetch"));
      return fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function (r) {
        if (!r.ok) throw new Error("status");
        return r.json();
      });
    };
    var cache = {};
    function cached(url) {
      if (!cache[url]) cache[url] = load(url).catch(function (e) { delete cache[url]; throw e; });
      return cache[url];
    }
    var fp = deps.fingerprint || function () { return G.BT && G.BT.fingerprint; };
    var conn = deps.connectionText || function () {
      var el = doc && doc.getElementById && doc.getElementById("sv");
      return el ? el.textContent : "";
    };
    var runners = {
      get_site_guide: function () { return siteGuide(); },
      get_browser_reveal: function () { return browserReveal(fp()); },
      get_connection_reveal: function () { return connectionReveal(conn()); },
      get_atlas_summary: function () {
        return cached("/api/atlas").then(summarizeAtlas, function () { return { ok: false, error: "The ATLAS evaluation could not be loaded. Reload the page and try again." }; });
      },
      lookup_atlas_technique: function (input) {
        return cached("/api/atlas").then(function (data) { return lookupAtlas(data, input); }, function () { return { ok: false, error: "The ATLAS evaluation could not be loaded. Reload the page and try again." }; });
      },
      lookup_gotcha: function (input) {
        return cached("/api/gotchas").then(function (items) { return lookupGotcha(items, input); }, function () { return { ok: false, error: "The gotchas list could not be loaded. Reload the page and try again." }; });
      },
      get_architecture_guide: function (input) { return architectureGuide(input); },
      get_demo_catalog: function (input) { return demoCatalog(input); },
      read_demo_state: function (input) { return demoState(doc, input); },
      get_page_guide: function () { return pageGuide(readPage(doc || { querySelector: function () { return null; }, querySelectorAll: function () { return []; } }, loc)); }
    };
    return specList(markers).map(function (spec) { return asTool(spec, runners[spec.name]); });
  }

  function findModelContext(doc, nav) {
    var mc = doc && doc.modelContext;
    if (mc && typeof mc.registerTool === "function") return mc;
    mc = nav && nav.modelContext;
    if (mc && typeof mc.registerTool === "function") return mc;
    return null;
  }
  function registerWebMCP(doc, tools, nav) {
    var mc = findModelContext(doc, nav);
    if (!mc) return Promise.resolve({ status: "unavailable", names: [], errors: [] });
    var ac = typeof AbortController === "function" ? new AbortController() : null, names = [], errors = [];
    var jobs = tools.map(function (t) {
      try {
        return Promise.resolve(mc.registerTool(t, ac ? { signal: ac.signal } : {}))
          .then(function () { names.push(t.name); }, function (e) { errors.push(t.name + ": " + ((e && e.name) || "Error")); });
      } catch (e) { errors.push(t.name + ": " + ((e && e.name) || "Error")); return Promise.resolve(); }
    });
    return Promise.all(jobs).then(function () {
      return { status: !names.length ? "failed" : errors.length ? "partial" : "registered", names: names, errors: errors, abort: function () { if (ac) ac.abort(); } };
    });
  }

  G.__btwPage = {
    SITE_PAGES: SITE_PAGES, DEMOS: DEMOS, ARCH: ARCH, SPECS: SPECS, hints: hints,
    scrub: scrub, safePath: safePath, siteGuide: siteGuide, browserReveal: browserReveal, connectionReveal: connectionReveal,
    summarizeAtlas: summarizeAtlas, lookupAtlas: lookupAtlas, lookupGotcha: lookupGotcha, architectureGuide: architectureGuide,
    demoCatalog: demoCatalog, demoState: demoState, readPage: readPage, pageGuide: pageGuide,
    markersFrom: markersFrom, specList: specList, createTools: createTools, findModelContext: findModelContext, registerWebMCP: registerWebMCP
  };
  if (!HAS_DOM) return;

  function placeNote(doc, text) {
    var host = doc.querySelector("main") || doc.querySelector("article") || doc.body;
    if (!host) return;
    var el = doc.getElementById("page-tools-status");
    if (!el) {
      el = doc.createElement("p");
      el.id = "page-tools-status";
      el.className = "muted";
      host.appendChild(el);
    }
    el.hidden = false;
    el.textContent = text;
  }
  function boot() {
    if (G.__btwPageBooted) return;
    G.__btwPageBooted = true;
    var markers = markersFrom(document);
    var tools = createTools(markers, { doc: document });
    G.__btwPageTools = tools;
    if (document.querySelector('script[data-tools="page"]') && Array.isArray(G.btwPageTools)) {
      var have = Object.create(null);
      for (var i = 0; i < G.btwPageTools.length; i++) have[G.btwPageTools[i].name] = 1;
      for (var j = 0; j < tools.length; j++) if (!have[tools[j].name]) G.btwPageTools.push(tools[j]);
    }
    registerWebMCP(document, tools, G.navigator).then(function (r) {
      G.__btwPageWebMCP = r;
      if (r.status === "unavailable") return;
      var text = r.status === "failed"
        ? "WebMCP is in this browser, but the read-only tools could not be registered."
        : "A browser assistant can use " + r.names.length + " read-only tools on this page: " + r.names.join(", ") + ". They do not read cookies, keys, or saved chat.";
      placeNote(document, text);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
