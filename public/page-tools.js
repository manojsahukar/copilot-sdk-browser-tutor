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
    { path: "/", title: "Browser probe and tutor", summary: "Sign in to see what this browser reveals, then ask the tutor." },
    { path: "/gotchas", title: "Agent SDK gotchas", summary: "Lessons from this build, plus a MITRE ATLAS evaluation." },
    { path: "/architecture", title: "Architecture", summary: "How a request, sign-in, and the agent tools fit together." },
    { path: "/demos", title: "Live demos", summary: "Permission and storage demos that run only when you tap." },
    { path: "/widget/", title: "Chat widget docs", summary: "A client-side chat widget, including the color tool demo." },
    { path: "/widget/storage.html", title: "Where keys live", summary: "Where the widget keeps an OpenRouter key in this browser." },
    { path: "/widget/xss.html", title: "Script injection risk", summary: "Why a key in the page is exposed if a script is injected." },
    { path: "/widget/openrouter.html", title: "Who pays", summary: "The visitor's own OpenRouter account pays for model calls." },
    { path: "/widget/privacy.html", title: "Privacy", summary: "What leaves the browser when you chat from the widget." },
    { path: "/widget/webmcp.html", title: "Page tools for browser assistants", summary: "How this site offers tools to an assistant in the browser, and how the tutor limits its own tools." }
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
  var ATLAS_STATUS = ["fixed", "mitigated", "accepted", "needs-human", "not-applicable"];
  var EMPTY = { type: "object", additionalProperties: false, properties: {} };
  var BOTH_NOTE = "You gave a code and words. id wins if you give both.";

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
  function typeLabel(t) {
    if (t === "string") return "text";
    if (t === "number") return "a number";
    if (t === "integer") return "a whole number";
    if (t === "boolean") return "true or false";
    if (t === "array") return "a list";
    if (t === "object") return "an object";
    return "";
  }
  function valueMatchesType(v, t) {
    if (t === "string") return typeof v === "string";
    if (t === "number") return typeof v === "number" && Number.isFinite(v);
    if (t === "integer") return typeof v === "number" && Number.isFinite(v) && Math.floor(v) === v;
    if (t === "boolean") return typeof v === "boolean";
    if (t === "array") return Array.isArray(v);
    if (t === "object") return v !== null && typeof v === "object" && !Array.isArray(v);
    return true;
  }
  function typeError(name, schema, value) {
    if (!schema || typeof schema !== "object") return "";
    var types = [];
    if (typeof schema.type === "string") types.push(schema.type);
    else if (Array.isArray(schema.type)) {
      for (var i = 0; i < schema.type.length; i++) if (typeof schema.type[i] === "string") types.push(schema.type[i]);
    }
    if (!types.length && Array.isArray(schema.oneOf)) {
      for (var j = 0; j < schema.oneOf.length; j++) {
        var branch = schema.oneOf[j];
        if (branch && typeof branch.type === "string") types.push(branch.type);
      }
    }
    if (!types.length) return "";
    for (var k = 0; k < types.length; k++) if (valueMatchesType(value, types[k])) return "";
    var labels = [];
    for (var n = 0; n < types.length; n++) {
      var label = typeLabel(types[n]);
      if (label && labels.indexOf(label) < 0) labels.push(label);
    }
    return name + " must be " + (labels.join(" or ") || "the right type");
  }
  function checkInput(schema, input) {
    if (input == null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) return { error: "Input must be an object." };
    var props = schema && schema.properties || {};
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) if (!Object.prototype.hasOwnProperty.call(props, keys[i])) return { error: "Unknown input field: " + String(keys[i]).slice(0, 40) };
    var req = schema && schema.required || [];
    for (var j = 0; j < req.length; j++) if (!Object.prototype.hasOwnProperty.call(input, req[j])) return { error: "Missing input field: " + req[j] };
    for (var k = 0; k < keys.length; k++) {
      var err = typeError(String(keys[k]).slice(0, 40), props[keys[k]], input[keys[k]]);
      if (err) return { error: err };
    }
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
  function summarizeAtlas(data, input) {
    if (!data || !data.meta) return { ok: false, error: "The ATLAS evaluation is not available." };
    var status = field(input, "status");
    if (status && ATLAS_STATUS.indexOf(status) < 0) return { ok: false, error: "Unknown status. Use fixed, mitigated, accepted, needs-human, or not-applicable." };
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
    var meta = { name: data.meta.fullName, version: data.meta.version, modified: data.meta.modifiedDate, evaluatedOn: data.meta.evaluatedOn };
    var notApplicable = na.map(function (t) { return { id: t.id, name: t.name }; });
    if (status === "not-applicable") {
      return {
        ok: true, status: status,
        message: "MITRE ATLAS lists " + notApplicable.length + " techniques that do not apply to this site.",
        meta: meta, counts: counts, applicable: [], notApplicable: notApplicable
      };
    }
    if (status) {
      var filtered = [];
      for (var f = 0; f < rows.length; f++) if (rows[f].status === status) filtered.push(rows[f]);
      return {
        ok: true, status: status,
        message: "MITRE ATLAS lists " + filtered.length + " techniques marked " + status + ".",
        meta: meta, counts: counts, applicable: filtered, notApplicable: []
      };
    }
    return {
      ok: true,
      message: "MITRE ATLAS " + (data.meta.version || "") + " lists " + app.length + " techniques that apply to this site.",
      meta: meta, counts: counts, applicable: rows, notApplicable: notApplicable
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
  function withBothNote(result, id, query) {
    if (id && query) result.note = BOTH_NOTE;
    return result;
  }
  function lookupAtlas(data, input) {
    if (!data || typeof data !== "object") return { ok: false, error: "The ATLAS evaluation is not available." };
    var id = field(input, "id"), query = field(input, "query").toLowerCase();
    var app = Array.isArray(data.applicable) ? data.applicable : [];
    var na = Array.isArray(data.notApplicable) ? data.notApplicable : [];
    if (id) {
      if (!/^AML\.T[0-9]{4}(?:\.[0-9]{3})?$/.test(id)) return withBothNote({ ok: false, error: "Technique code should look like AML.T0051." }, id, query);
      for (var i = 0; i < app.length; i++) if (app[i].id === id) return withBothNote({ ok: true, message: app[i].id + " " + app[i].name + ".", technique: techniqueView(app[i], true) }, id, query);
      for (var n = 0; n < na.length; n++) if (na[n].id === id) return withBothNote({ ok: true, message: na[n].id + " does not apply to this site.", technique: techniqueView(na[n], false) }, id, query);
      return withBothNote({ ok: false, error: "No technique matches that code." }, id, query);
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
      if (!/^[a-z0-9-]{1,64}$/.test(id)) return withBothNote({ ok: false, error: "Gotcha code should be short words joined by hyphens, such as llm-js-xss." }, id, query);
      for (var i = 0; i < items.length; i++) if (String(items[i].id) === id) return withBothNote({ ok: true, message: items[i].title + ".", gotcha: gotchaView(items[i]) }, id, query);
      return withBothNote({ ok: false, error: "No gotcha matches that code." }, id, query);
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
  function pageEl(doc, id) {
    return doc && typeof doc.getElementById === "function" ? doc.getElementById(id) : null;
  }
  function demosStillLoading(doc) {
    if (!pageEl(doc, "demos")) return false;
    if (pageEl(doc, "out-storage_inspector") || pageEl(doc, "xsslab") || pageEl(doc, "demo-xss_lab")) return false;
    return true;
  }
  function demoPresence(doc, id) {
    var outEl = pageEl(doc, "out-" + id);
    if (outEl) {
      var text = outEl.textContent ? String(outEl.textContent).trim() : "";
      return { onPage: true, hasResult: text.length > 0 };
    }
    if (id === "xss_lab" && (pageEl(doc, "xsslab") || pageEl(doc, "demo-xss_lab"))) return { onPage: true, hasResult: false };
    return { onPage: false, hasResult: false };
  }
  function demoState(doc, input) {
    var id = field(input, "id");
    if (id && DEMO_IDS.indexOf(id) < 0) return { ok: false, error: "Unknown demo code.", allowedIds: DEMO_IDS.slice() };
    var loading = demosStillLoading(doc);
    var rows = [];
    for (var i = 0; i < DEMOS.length; i++) {
      if (id && DEMOS[i].id !== id) continue;
      var seen = loading ? { onPage: "still loading", hasResult: false } : demoPresence(doc, DEMOS[i].id);
      rows.push({ id: DEMOS[i].id, title: DEMOS[i].title, needsPermission: DEMOS[i].needsPermission, onPage: seen.onPage, hasResult: seen.hasResult });
    }
    if (loading) return { ok: true, loading: true, message: "The demo list is still loading.", demos: rows };
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
  function landingGuide() {
    return {
      ok: true,
      message: "This is the signed-out home page. Sign in to see what this browser reveals.",
      signedIn: false,
      signInNeeded: true,
      links: [
        { path: "/auth/login", summary: "Sign in with GitHub to see what this browser reveals and to ask the tutor." },
        { path: "/demos", summary: "Live permission demos. You can open these before you sign in." },
        { path: "/gotchas", summary: "Lessons from this build. You can open these before you sign in." },
        { path: "/architecture", summary: "How the app is built. You can open this before you sign in." },
        { path: "/widget/webmcp.html", summary: "How page tools work. You can open this before you sign in." }
      ]
    };
  }

  var PAGE_SCHEMA = outSchema({
    page: { type: "object", additionalProperties: false, required: ["title", "path", "headings", "links"], properties: {
      title: { type: "string" }, path: { type: "string" },
      headings: { type: "array", items: { type: "string" } }, links: { type: "array", items: { type: "string" } }
    } }
  });
  var LINK_SCHEMA = { type: "object", additionalProperties: false, required: ["path", "summary"], properties: { path: { type: "string" }, summary: { type: "string" } } };
  var SPECS = {
    site: { name: "get_site_guide", title: "Site guide", untrusted: false,
      description: "List the public pages on this site and what each one is for. It returns the path, the title, and a short summary for each page. This only reads a fixed list. It does not read cookies, keys, or saved chat. You can call it again.",
      inputSchema: EMPTY, outputSchema: outSchema({ pages: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "title", "summary"], properties: { path: { type: "string" }, title: { type: "string" }, summary: { type: "string" } } } } }) },
    landing: { name: "get_landing_guide", title: "Signed-out home page", untrusted: false,
      description: "Describe the signed-out home page. Sign-in is needed before this site can show what the browser reveals. It returns the public links on this page. It does not read cookies, keys, or the browser probe. You can call it again.",
      inputSchema: EMPTY, outputSchema: outSchema({ signedIn: { type: "boolean" }, signInNeeded: { type: "boolean" }, links: { type: "array", items: LINK_SCHEMA } }) },
    browser: { name: "get_browser_reveal", title: "What the browser reveals", untrusted: true,
      description: "Read what this page already shows about the browser, such as language, screen, and graphics. It returns the public probe already shown on the page. This changes nothing. It does not read cookies, keys, or saved chat. You can call it again.",
      inputSchema: EMPTY, outputSchema: outSchema({ reveal: { type: "object", description: "The public probe already on the page." } }) },
    connection: { name: "get_connection_reveal", title: "What the connection reveals", untrusted: true,
      description: "Read what this page already shows about the connection, with cookie values hidden. It returns that connection panel. This changes nothing. It does not read saved chat or keys. You can call it again.",
      inputSchema: EMPTY, outputSchema: outSchema({ connection: { type: "object", description: "The connection panel, with secrets hidden." } }) },
    atlas: { name: "get_atlas_summary", title: "ATLAS summary", untrusted: false,
      description: "Summarize the MITRE ATLAS (Adversarial Threat Landscape for Artificial-Intelligence Systems) evaluation on this page. You can give a status to keep one group. The groups are fixed, mitigated, accepted, needs-human, and not-applicable. Omit status to list every technique. It returns the version, the counts, and the matching techniques. This only reads the public evaluation. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        status: { type: "string", description: "One group, or omit it to list every technique. The sample uses mitigated. not-applicable means the techniques that do not apply to this site.", examples: ["mitigated"], enum: ATLAS_STATUS.slice() }
      } },
      outputSchema: outSchema({ status: { type: "string" }, meta: { type: "object" }, counts: { type: "object" }, applicable: { type: "array" }, notApplicable: { type: "array" } }) },
    atlasOne: { name: "lookup_atlas_technique", title: "Look up an ATLAS technique", untrusted: false,
      description: "Look up one MITRE ATLAS (Adversarial Threat Landscape for Artificial-Intelligence Systems) technique by its code, such as AML.T0051, or by words in its name. id wins if you give both. It returns the public note for one technique, or a short list when several names match. It does not include attack steps. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", maxLength: 20, description: "Technique code such as AML.T0051. id wins if you give both.", examples: ["AML.T0051"], pattern: "^AML\\.T[0-9]{4}(?:\\.[0-9]{3})?$" },
        query: { type: "string", maxLength: 80, description: "Words from the technique name, such as prompt injection. id wins if you give both.", examples: ["prompt injection"] }
      } },
      outputSchema: outSchema({ note: { type: "string", description: "Set when both a code and words were given. The code is used." }, technique: { type: "object" }, matches: { type: "array" } }) },
    gotcha: { name: "lookup_gotcha", title: "Look up a gotcha", untrusted: false,
      description: "Look up one Agent SDK gotcha by its code, such as llm-js-xss, or by words in its title. id wins if you give both. It returns the public lesson for one gotcha, or a short list when several titles match. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", maxLength: 64, description: "Gotcha code such as llm-js-xss. id wins if you give both.", examples: ["llm-js-xss"], pattern: "^[a-z0-9-]{1,64}$" },
        query: { type: "string", maxLength: 80, description: "Words from the gotcha title. id wins if you give both.", examples: ["prompt injection"] }
      } },
      outputSchema: outSchema({ note: { type: "string", description: "Set when both a code and words were given. The code is used." }, gotcha: { type: "object" }, matches: { type: "array" } }) },
    arch: { name: "get_architecture_guide", title: "Architecture guide", untrusted: false,
      description: "Read a short guide to the architecture diagrams on this page. Pass a section code such as req, auth, loop, or trust. Omit it to get all four. It returns the title and summary of each diagram. This changes nothing. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        section: { type: "string", description: "Diagram code. req, auth, loop, or trust. Omit it to get all four. The manual sample uses req.", examples: ["req"], enum: ARCH_IDS.slice() }
      } },
      outputSchema: outSchema({ sections: { type: "array" } }) },
    catalog: { name: "get_demo_catalog", title: "Demo catalog", untrusted: false,
      description: "List the live demos and whether each one asks for a permission. Omit the demo code to list all of them. It returns the title, the permission flag, and a short summary. This reads a fixed list and does not run a demo. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", description: "One demo code, or omit it to list them all. The manual sample uses storage_inspector.", examples: ["storage_inspector"], enum: DEMO_IDS.slice() }
      } },
      outputSchema: outSchema({ demos: { type: "array" }, allowedIds: { type: "array", items: { type: "string" } } }) },
    state: { name: "read_demo_state", title: "Demo state", untrusted: false,
      description: "Report which demos are on this page and whether each one has a result on screen. Omit the demo code to report all of them. It returns that state and does not return the text on screen. You can call it again.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", description: "One demo code, or omit it to report them all. The manual sample uses storage_inspector.", examples: ["storage_inspector"], enum: DEMO_IDS.slice() }
      } },
      outputSchema: outSchema({ loading: { type: "boolean" }, demos: { type: "array" }, allowedIds: { type: "array", items: { type: "string" } } }) },
    page: { name: "get_page_guide", title: "Page guide", untrusted: true,
      description: "Read the title, headings, and same-site links on this docs page. It returns those headings and links. This changes nothing. It does not read keys, cookies, or saved chat. You can call it again.",
      inputSchema: EMPTY, outputSchema: PAGE_SCHEMA }
  };

  function markersFrom(doc) {
    return {
      probe: !!(doc && doc.getElementById && doc.getElementById("fp")),
      landing: !!(doc && doc.getElementById && doc.getElementById("dev") && !doc.getElementById("fp")),
      gotchas: !!(doc && doc.getElementById && doc.getElementById("atlas")),
      architecture: !!(doc && doc.getElementById && doc.getElementById("req")),
      demos: !!(doc && doc.getElementById && doc.getElementById("demos")),
      widget: !!(doc && doc.querySelector && doc.querySelector("nav.site"))
    };
  }
  function specList(markers) {
    var m = markers || {};
    var list = [SPECS.site];
    if (m.landing) list.push(SPECS.landing);
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
      get_landing_guide: function () { return landingGuide(); },
      get_browser_reveal: function () { return browserReveal(fp()); },
      get_connection_reveal: function () { return connectionReveal(conn()); },
      get_atlas_summary: function (input) {
        return cached("/api/atlas").then(function (data) { return summarizeAtlas(data, input); }, function () { return { ok: false, error: "The ATLAS evaluation could not be loaded. Reload the page and try again." }; });
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

  function toolChangesPage(name, ann) {
    if (name === "set_color_form") return true;
    if (name === "find_site_page") return false;
    if (ann && ann.readOnlyHint === false) return true;
    if (ann && ann.readOnlyHint === true) return false;
    var specs = G.__btwColor && G.__btwColor.TOOL_SPECS;
    if (specs) {
      for (var i = 0; i < specs.length; i++) if (specs[i].name === name) return !specs[i].readOnly;
    }
    return false;
  }
  function searchPages(query) {
    var q = cap(String(query || ""), 80).toLowerCase();
    if (!q) return [];
    var words = q.split(/\s+/).filter(Boolean);
    var hits = [];
    for (var i = 0; i < SITE_PAGES.length; i++) {
      var p = SITE_PAGES[i];
      var hay = (p.title + " " + p.summary + " " + p.path).toLowerCase();
      var match = true;
      for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) < 0) { match = false; break; }
      if (match) hits.push({ path: p.path, title: p.title, summary: p.summary });
    }
    return hits;
  }
  function fillResults(host, pages, query) {
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!query) { host.textContent = "Type a word from a page title or summary."; return; }
    if (!pages.length) { host.textContent = "No public page matches those words."; return; }
    var intro = document.createElement("span");
    intro.textContent = pages.length === 1 ? "1 page matches." : pages.length + " pages match.";
    host.appendChild(intro);
    var list = document.createElement("ul");
    for (var i = 0; i < pages.length; i++) {
      var item = document.createElement("li");
      var link = document.createElement("a");
      link.href = pages[i].path;
      link.textContent = pages[i].title;
      item.appendChild(link);
      var note = document.createElement("span");
      note.textContent = " " + pages[i].summary;
      item.appendChild(note);
      list.appendChild(item);
    }
    host.appendChild(list);
  }
  function replyToAgent(event, value) {
    if (!event || !event.agentInvoked || typeof event.respondWith !== "function") return;
    try { event.respondWith(Promise.resolve(value)); } catch (e) {}
  }
  function bindSiteFind(doc) {
    var form = doc.getElementById ? doc.getElementById("site-find") : null;
    if (!form || form.getAttribute("data-bound") === "1") return;
    form.setAttribute("data-bound", "1");
    form.addEventListener("submit", function (event) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      var input = form.querySelector ? form.querySelector("input[name=q]") : null;
      var host = doc.getElementById("site-find-results");
      var query = input ? String(input.value || "") : "";
      var pages = searchPages(query);
      if (host) fillResults(host, pages, cap(query, 80));
      replyToAgent(event, {
        ok: true,
        message: pages.length ? "Matching public pages." : (cap(query, 80) ? "No public page matches those words." : "Type a word from a page title or summary."),
        pages: pages
      });
    });
  }
  function namesToList(pageNames, colorNames) {
    var list = [], seen = Object.create(null);
    function add(name, changes) {
      if (!name || seen[name]) return;
      seen[name] = 1;
      list.push({ name: name, changesPage: !!changes });
    }
    var i;
    for (i = 0; i < (colorNames || []).length; i++) add(colorNames[i], toolChangesPage(colorNames[i], null));
    for (i = 0; i < (pageNames || []).length; i++) add(pageNames[i], false);
    return list;
  }
  function statusLine(list) {
    var read = [], change = [], seen = Object.create(null);
    for (var i = 0; i < (list || []).length; i++) {
      var name = String(list[i] && list[i].name || "");
      if (!name || seen[name]) continue;
      seen[name] = 1;
      if (list[i].changesPage) change.push(name);
      else read.push(name);
    }
    if (!read.length && !change.length) return "WebMCP is in this browser, but the tools could not be registered.";
    var parts = [];
    if (read.length === 1) parts.push("A browser assistant can use 1 read-only tool on this page: " + read[0] + ".");
    else if (read.length) parts.push("A browser assistant can use " + read.length + " read-only tools on this page: " + read.join(", ") + ".");
    if (change.length === 1) parts.push("1 tool changes the page: " + change[0] + ".");
    else if (change.length) parts.push(change.length + " tools change the page: " + change.join(", ") + ".");
    parts.push("They do not read cookies, keys, or saved chat.");
    return parts.join(" ");
  }

  G.__btwPage = {
    SITE_PAGES: SITE_PAGES, DEMOS: DEMOS, ARCH: ARCH, SPECS: SPECS, hints: hints,
    scrub: scrub, safePath: safePath, siteGuide: siteGuide, browserReveal: browserReveal, connectionReveal: connectionReveal,
    summarizeAtlas: summarizeAtlas, lookupAtlas: lookupAtlas, lookupGotcha: lookupGotcha, architectureGuide: architectureGuide,
    demoCatalog: demoCatalog, demoState: demoState, readPage: readPage, pageGuide: pageGuide, landingGuide: landingGuide,
    markersFrom: markersFrom, specList: specList, createTools: createTools, findModelContext: findModelContext, registerWebMCP: registerWebMCP,
    statusLine: statusLine, searchPages: searchPages, ATLAS_STATUS: ATLAS_STATUS
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
  function whenColorSettled() {
    return new Promise(function (resolve) {
      var tries = 0;
      (function tick() {
        var c = G.__btwColorWebMCP;
        if (c && c.status === "pending" && tries < 80) { tries++; setTimeout(tick, 25); return; }
        resolve();
      })();
    });
  }
  function collectRegistered(doc, nav) {
    var mc = findModelContext(doc, nav);
    if (!mc || typeof mc.getTools !== "function") return Promise.resolve(null);
    return Promise.resolve().then(function () { return mc.getTools(); }).then(function (tools) {
      if (!Array.isArray(tools)) return null;
      var list = [];
      for (var i = 0; i < tools.length; i++) {
        var t = tools[i];
        if (!t || !t.name) continue;
        list.push({ name: t.name, changesPage: toolChangesPage(t.name, t.annotations || null) });
      }
      return list;
    }, function () { return null; });
  }
  function noteFrom(list, reg) {
    if (!list || !list.length) {
      var color = G.__btwColorWebMCP;
      list = namesToList(reg && reg.names, color && color.status !== "pending" ? color.names : []);
    }
    return statusLine(list);
  }
  function updateNote() {
    var reg = G.__btwPageWebMCP;
    if (!reg || reg.status === "unavailable" || reg.status === "pending") return Promise.resolve();
    return whenColorSettled().then(function () {
      return collectRegistered(document, G.navigator);
    }).then(function (list) {
      placeNote(document, noteFrom(list, reg));
    });
  }
  G.__btwPage.updateNote = updateNote;
  function boot() {
    if (G.__btwPageBooted) return;
    G.__btwPageBooted = true;
    bindSiteFind(document);
    var markers = markersFrom(document);
    var tools = createTools(markers, { doc: document });
    G.__btwPageTools = tools;
    if (document.querySelector('script[data-tools="page"]') && Array.isArray(G.btwPageTools)) {
      var have = Object.create(null);
      for (var i = 0; i < G.btwPageTools.length; i++) have[G.btwPageTools[i].name] = 1;
      for (var j = 0; j < tools.length; j++) if (!have[tools[j].name]) G.btwPageTools.push(tools[j]);
    }
    registerWebMCP(document, tools, G.navigator).then(function (r) {
      if (r.status === "unavailable") { G.__btwPageWebMCP = r; return; }
      G.__btwPageWebMCP = { status: "pending", names: r.names, errors: r.errors };
      return whenColorSettled().then(function () {
        return collectRegistered(document, G.navigator);
      }).then(function (list) {
        placeNote(document, noteFrom(list, r));
        G.__btwPageWebMCP = r;
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
