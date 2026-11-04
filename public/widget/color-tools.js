/* Color picker demo tools for /widget/ (Browser Tutor). Plain JS, no dependencies, CSP-safe (no inline code).
 * ONE tool definition is used by two callers:
 *   1. the chat widget (data-tools="page" reads window.btwPageTools and sends them to OpenRouter as "tools")
 *   2. an outside browser assistant through WebMCP (document.modelContext.registerTool, feature-detected;
 *      navigator.modelContext is used only as a fallback for older Chromium builds that still had it)
 * Safety: the tools change only the color swatch on this page. Input is checked against a strict hex pattern
 * or a fixed list of color names. Nothing the model sends is ever evaluated or inserted as HTML. */
(function () {
  "use strict";
  var G = typeof window !== "undefined" ? window : globalThis;
  var HAS_DOM = typeof document !== "undefined" && !!document.getElementById;
  var DEFAULT = "#1f6feb";
  // Fixed list of CSS color names the tools accept, with their hex value (so the native <input type=color> can show them).
  var NAMED = { black: "#000000", white: "#ffffff", gray: "#808080", silver: "#c0c0c0", red: "#ff0000", maroon: "#800000",
    orange: "#ffa500", gold: "#ffd700", yellow: "#ffff00", olive: "#808000", lime: "#00ff00", green: "#008000", teal: "#008080",
    cyan: "#00ffff", skyblue: "#87ceeb", blue: "#0000ff", navy: "#000080", indigo: "#4b0082", purple: "#800080",
    violet: "#ee82ee", magenta: "#ff00ff", pink: "#ffc0cb", hotpink: "#ff69b4", coral: "#ff7f50", tomato: "#ff6347",
    salmon: "#fa8072", brown: "#a52a2a", chocolate: "#d2691e", tan: "#d2b48c", beige: "#f5f5dc", rebeccapurple: "#663399" };
  var HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  // Returns { hex, name } or { error }. Never throws.
  function parseColor(v) {
    if (typeof v !== "string") return { error: "color must be a string." };
    var s = v.trim().toLowerCase();
    if (s.length > 32) return { error: "color is too long." };
    if (HEX_RE.test(s)) {
      if (s.length === 4) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
      return { hex: s, name: null };
    }
    if (Object.prototype.hasOwnProperty.call(NAMED, s)) return { hex: NAMED[s], name: s };
    return { error: "Not a valid color. Use a hex value like #ff8800 or one of the allowed color names.", allowedNames: Object.keys(NAMED) };
  }

  var TOOL_SPECS = [
    { name: "set_color", title: "Set the color", readOnly: false,
      description: "Set the color of the example swatch on this page. Give a hex value such as #ff8800 or #f80, or a common CSS color name such as teal.",
      inputSchema: { type: "object", additionalProperties: false, required: ["color"],
        properties: { color: { type: "string", maxLength: 32, description: "Hex (#rgb or #rrggbb) or a CSS color name, for example coral." } } } },
    { name: "get_color", title: "Read the color", readOnly: true,
      description: "Read the current color of the example swatch. Changes nothing.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "reset_color", title: "Reset the color", readOnly: false,
      description: "Put the example swatch back to its starting color.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  ];

  function checkInput(spec, input) {
    if (input == null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) return { error: "Input must be a JSON object." };
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) if (!Object.prototype.hasOwnProperty.call(spec.inputSchema.properties, keys[i])) return { error: "Unknown input field: " + String(keys[i]).slice(0, 40) };
    var req = spec.inputSchema.required || [];
    for (var j = 0; j < req.length; j++) if (!Object.prototype.hasOwnProperty.call(input, req[j])) return { error: "Missing input field: " + req[j] };
    return { value: input };
  }
  function describe(st) { return { color: st.hex, name: st.name, isDefault: st.hex === DEFAULT }; }
  // Pure: returns { state, result }. Bad input leaves the state as it was.
  function runTool(state, name, input) {
    var spec = null;
    for (var i = 0; i < TOOL_SPECS.length; i++) if (TOOL_SPECS[i].name === name) spec = TOOL_SPECS[i];
    if (!spec) return { state: state, result: { ok: false, error: "Unknown tool." } };
    var chk = checkInput(spec, input);
    if (chk.error) return { state: state, result: { ok: false, error: chk.error } };
    if (name === "get_color") return { state: state, result: { ok: true, message: "The color is " + state.hex + ".", swatch: describe(state) } };
    if (name === "reset_color") { var r = { hex: DEFAULT, name: null }; return { state: r, result: { ok: true, message: "The color is back to " + DEFAULT + ".", swatch: describe(r) } }; }
    var c = parseColor(chk.value.color);
    if (c.error) { var e = { ok: false, error: c.error }; if (c.allowedNames) e.allowedNames = c.allowedNames; return { state: state, result: e }; }
    var ns = { hex: c.hex, name: c.name };
    return { state: ns, result: { ok: true, message: "The color is now " + (c.name ? c.name + " (" + c.hex + ")" : c.hex) + ".", swatch: describe(ns) } };
  }
  function createController(onChange) {
    var st = { hex: DEFAULT, name: null };
    return { getState: function () { return { hex: st.hex, name: st.name }; },
      call: function (name, input, source) {
        var r = runTool(st, name, input);
        if (r.result.ok && r.state !== st) { st = r.state; if (onChange) onChange(st, { name: name, source: source, result: r.result }); }
        else if (r.result.ok && onChange && name === "get_color") onChange(st, { name: name, source: source, result: r.result, readOnly: true });
        return r.result;
      } };
  }
  // WebMCP tool shape: { name, title, description, inputSchema, annotations, execute(input) -> Promise }.
  function toolList(ctl, source) {
    return TOOL_SPECS.map(function (s) {
      return { name: s.name, title: s.title, description: s.description, inputSchema: JSON.parse(JSON.stringify(s.inputSchema)),
        annotations: { readOnlyHint: s.readOnly },
        execute: function (input) { return Promise.resolve(ctl.call(s.name, input, source)); } };
    });
  }
  // Current spec + Chrome docs: document.modelContext. navigator.modelContext is a fallback for older builds only.
  function findModelContext(doc, nav) {
    var mc = doc && doc.modelContext;
    if (mc && typeof mc.registerTool === "function") return mc;
    mc = nav && nav.modelContext;
    if (mc && typeof mc.registerTool === "function") return mc;
    return null;
  }
  function registerWebMCP(doc, ctl, nav) {
    var mc = findModelContext(doc, nav);
    if (!mc) return Promise.resolve({ status: "unavailable", names: [], errors: [] });
    var ac = typeof AbortController === "function" ? new AbortController() : null, names = [], errors = [];
    var jobs = toolList(ctl, "WebMCP agent").map(function (t) {
      try {
        return Promise.resolve(mc.registerTool(t, ac ? { signal: ac.signal } : {}))
          .then(function () { names.push(t.name); }, function (e) { errors.push(t.name + ": " + ((e && e.name) || "Error")); });
      } catch (e) { errors.push(t.name + ": " + ((e && e.name) || "Error")); return Promise.resolve(); }
    });
    return Promise.all(jobs).then(function () {
      return { status: !names.length ? "failed" : errors.length ? "partial" : "registered", names: names, errors: errors, abort: function () { if (ac) ac.abort(); } };
    });
  }

  G.__btwColor = { DEFAULT: DEFAULT, NAMED: NAMED, TOOL_SPECS: TOOL_SPECS, parseColor: parseColor, runTool: runTool,
    createController: createController, toolList: toolList, findModelContext: findModelContext, registerWebMCP: registerWebMCP };
  if (!HAS_DOM) return;

  // ============================== browser only ==============================
  function boot() {
    var host = document.getElementById("color-demo");
    if (!host) return;
    var sw = host.querySelector(".cp-swatch"), cap = host.querySelector(".cp-caption"), log = host.querySelector(".cp-log"),
      input = host.querySelector(".cp-input"), status = document.getElementById("webmcp-status");
    function paint(st, ev) {
      sw.style.backgroundColor = st.hex;            // CSSOM, allowed under style-src 'self'
      if (input) input.value = st.hex;
      host.setAttribute("data-color", st.hex);
      cap.textContent = "Color: " + (st.name ? st.name + " (" + st.hex + ")" : st.hex);
      if (ev && log) {
        var li = document.createElement("li");
        li.textContent = ev.source + " called " + ev.name + ". " + ev.result.message;
        log.insertBefore(li, log.firstChild);
        while (log.children.length > 5) log.removeChild(log.lastChild);
      }
    }
    var ctl = createController(paint);
    paint(ctl.getState());
    if (input) input.addEventListener("input", function () { ctl.call("set_color", { color: input.value }, "You"); });
    var rb = host.querySelector("button[data-tool=reset_color]");
    if (rb) rb.addEventListener("click", function () { ctl.call("reset_color", {}, "You"); });
    G.btwPageTools = toolList(ctl, "Chat widget");
    G.__btwColorUI = { controller: ctl };
    G.__btwColorWebMCP = { status: "pending" };
    registerWebMCP(document, ctl, G.navigator).then(function (r) {
      G.__btwColorWebMCP = r;
      if (status && r.status !== "unavailable") {
        status.textContent = r.status === "failed" ? "WebMCP is in this browser, but the tools could not be registered (" + r.errors.join(", ") + ")."
          : "WebMCP is on in this browser. This page registered " + r.names.length + " tools: " + r.names.join(", ") + ". An outside assistant can call them now.";
        status.className = "callout" + (r.status === "failed" ? "" : " wm-on");
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
