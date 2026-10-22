// LLM-driven visualisation, the safe way: the model sends a SMALL, CONSTRAINED widget spec (never code, never raw
// chart-library config, never data points). The server validates it against WIDGET_SCHEMA, rebuilds it from known
// fields only, and fetches the numbers itself (so the model cannot fabricate data). The browser turns the clean spec
// into an ECharts option with static, reviewed code (public/widgets.js).
import { METRICS, METRIC_IDS, AGGS, RANGES, INTERVALS, GROUPS, ENDPOINT_IDS } from "./metrics.mjs";

const PLAIN = (max) => ({ type: "string", maxLength: max, format: "plain" });
const HEX = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
export const WIDGET_TYPES = ["line", "area", "bar", "stacked", "pie", "table", "stat", "status", "uptime", "incidents"];
const HEALTH_TYPES = ["status", "uptime", "incidents"];

const SERIES = {
  type: "object", additionalProperties: false, required: ["metric"],
  properties: {
    metric: { type: "string", enum: METRIC_IDS },
    agg: { type: "string", enum: AGGS },
    label: PLAIN(40),
    axis: { type: "string", enum: ["left", "right"] },
    color: HEX,
  },
};
export const SPEC_PROPS = {
  widget_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{1,31}$", description: "Stable id, e.g. 'latency-by-model'. Reuse it to edit." },
  title: PLAIN(80),
  type: { type: "string", enum: WIDGET_TYPES },
  series: { type: "array", minItems: 1, maxItems: 4, items: SERIES, description: "1-4 metrics to plot (use axis:'right' for a second unit)." },
  range: { type: "string", enum: RANGES },
  interval: { type: "string", enum: INTERVALS },
  group_by: { type: "string", enum: GROUPS },
  scope: { type: "string", enum: ["me", "site"], description: "App/browser metrics: 'me' = only your turns, 'site' = aggregate of everyone. Infra metrics are always site." },
  filters: {
    type: "object", additionalProperties: false,
    properties: { engine: { type: "string", enum: ["copilot", "openrouter"] }, distribution: { type: "string", enum: ["main", "sibling", "lab"] }, endpoint: { type: "string", enum: ENDPOINT_IDS } },
  },
  axes: {
    type: "object", additionalProperties: false,
    properties: { y_label: PLAIN(30), right_label: PLAIN(30), y_min: { type: "number", minimum: -1e12, maximum: 1e12 }, y_max: { type: "number", minimum: -1e12, maximum: 1e12 } },
  },
  thresholds: {
    type: "array", maxItems: 3,
    items: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "number", minimum: -1e12, maximum: 1e12 }, label: PLAIN(30), color: HEX, axis: { type: "string", enum: ["left", "right"] } } },
  },
  slo: { type: "number", minimum: 90, maximum: 99.999, description: "Availability SLO in % (uptime widgets; also drawn as a threshold line)." },
  example_data: { type: "boolean", description: "true = clearly labelled EXAMPLE data (demo only). Never use to fill in real metrics." },
};
export const WIDGET_SCHEMA = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false, required: ["widget_id", "type", "series", "range"], properties: SPEC_PROPS };
export const CHANGES_SCHEMA = { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(SPEC_PROPS).filter(([k]) => k !== "widget_id")) };

const MAX_SPEC_BYTES = 4096;
// Text that ends up in the chart title/labels: no HTML, no URLs or script schemes, no control characters, no Markdown.
const BAD_TEXT = /[<>`]|[\u0000-\u001f\u007f]|https?:|\/\/|www\.|javascript:|data:|vbscript:|file:|\{\{|\$\{/i;

// A tiny draft-07 subset validator (type/enum/pattern/min/max/items/properties/required/additionalProperties:false
// + format:"plain"). Hand-written on purpose: schema validators that compile to `new Function` are fine on the
// server, but this keeps the rule set small and auditable.
export function validateAgainst(schema, v, path = "$", errs = []) {
  const t = schema.type;
  const typeOk = t === "object" ? v && typeof v === "object" && !Array.isArray(v)
    : t === "array" ? Array.isArray(v)
    : t === "number" ? typeof v === "number" && Number.isFinite(v)
    : t === "integer" ? Number.isInteger(v)
    : t === "string" ? typeof v === "string"
    : t === "boolean" ? typeof v === "boolean" : true;
  if (!typeOk) { errs.push(`${path}: expected ${t}`); return errs; }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: must be one of ${schema.enum.slice(0, 12).join(", ")}${schema.enum.length > 12 ? ", …" : ""}`);
  if (t === "string") {
    if (schema.maxLength != null && v.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${path}: bad format`);
    if (schema.format === "plain" && BAD_TEXT.test(v)) errs.push(`${path}: plain text only (no HTML, URLs, scripts or control characters)`);
  }
  if (t === "number" || t === "integer") {
    if (schema.minimum != null && v < schema.minimum) errs.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) errs.push(`${path}: above ${schema.maximum}`);
  }
  if (t === "array") {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems != null && v.length > schema.maxItems) { errs.push(`${path}: at most ${schema.maxItems} item(s)`); return errs; }
    if (schema.items) v.forEach((x, i) => validateAgainst(schema.items, x, `${path}[${i}]`, errs));
  }
  if (t === "object") {
    for (const k of schema.required || []) if (!Object.hasOwn(v, k) || v[k] === undefined) errs.push(`${path}.${k}: required`);
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue; // JSON drops undefined; treat as absent
      // hasOwn: "__proto__"/"constructor" must not resolve to Object.prototype and pass as known keys
      if (!schema.properties || !Object.hasOwn(schema.properties, k)) { if (schema.additionalProperties === false) errs.push(`${path}.${k}: unknown key (not allowed)`); continue; }
      validateAgainst(schema.properties[k], v[k], `${path}.${k}`, errs);
    }
  }
  return errs;
}

// Rebuild from known fields only (strips anything unknown even if a future schema loosens), fill defaults,
// and apply semantic rules the schema can't express.
function rebuild(s) {
  const out = { widget_id: s.widget_id, title: (s.title || "").trim(), type: s.type, range: s.range, interval: s.interval || "auto",
    group_by: s.group_by || "none", scope: s.scope || "me", series: [] };
  for (const x of s.series) {
    const m = METRICS[x.metric];
    const o = { metric: x.metric, agg: x.agg || m.aggs[0] };
    if (x.label) o.label = x.label.trim(); if (x.axis) o.axis = x.axis; if (x.color) o.color = x.color.toLowerCase();
    out.series.push(o);
  }
  if (s.filters) { const f = {}; if (s.filters.engine) f.engine = s.filters.engine; if (s.filters.distribution) f.distribution = s.filters.distribution; if (s.filters.endpoint) f.endpoint = s.filters.endpoint; if (Object.keys(f).length) out.filters = f; }
  if (s.axes) { const a = {}; for (const k of ["y_label", "right_label", "y_min", "y_max"]) if (s.axes[k] !== undefined) a[k] = typeof s.axes[k] === "string" ? s.axes[k].trim() : s.axes[k]; if (Object.keys(a).length) out.axes = a; }
  if (s.thresholds && s.thresholds.length) out.thresholds = s.thresholds.map((t) => { const o = { value: t.value }; if (t.label) o.label = t.label.trim(); if (t.color) o.color = t.color.toLowerCase(); if (t.axis) o.axis = t.axis; return o; });
  if (s.slo !== undefined) out.slo = s.slo;
  if (s.example_data) out.example_data = true;
  if (!out.title) out.title = out.series.map((x) => METRICS[x.metric].label).join(" vs ");
  return out;
}

export function validateSpec(raw) {
  let size = 0; try { size = Buffer.byteLength(JSON.stringify(raw)); } catch { return { ok: false, errors: ["spec is not JSON-serialisable"] }; }
  if (size > MAX_SPEC_BYTES) return { ok: false, errors: [`spec too large (${size} bytes > ${MAX_SPEC_BYTES}); send a small spec, never data points`] };
  const errors = validateAgainst(WIDGET_SCHEMA, raw);
  if (errors.length) return { ok: false, errors: errors.slice(0, 12) };
  const spec = rebuild(raw);
  const sem = [];
  for (const x of spec.series) {
    const m = METRICS[x.metric];
    if (!m.aggs.includes(x.agg)) sem.push(`series ${x.metric}: agg must be one of ${m.aggs.join(", ")}`);
  }
  if (spec.group_by !== "none") {
    if (spec.series.length > 1) sem.push("group_by works with exactly one series");
    const m = METRICS[spec.series[0].metric];
    if (!m.groups.includes(spec.group_by)) sem.push(`group_by '${spec.group_by}' is not available for ${spec.series[0].metric} (allowed: ${["none", ...m.groups].join(", ")})`);
  }
  if (spec.type === "pie" && spec.group_by === "none" && spec.series.length < 2) sem.push("pie needs group_by or 2+ series");
  if (HEALTH_TYPES.includes(spec.type) && METRICS[spec.series[0].metric].src !== "health") sem.push(`type '${spec.type}' is a health widget: use series [{metric:"uptime_pct"}]`);
  if (sem.length) return { ok: false, errors: sem };
  return { ok: true, spec };
}

// update_widget: merge a partial change set into the current spec, then validate the WHOLE result again.
export function mergeChanges(current, changes) {
  const errs = validateAgainst(CHANGES_SCHEMA, changes || {});
  if (errs.length) return { ok: false, errors: errs.slice(0, 12) };
  const next = JSON.parse(JSON.stringify(current));
  for (const [k, v] of Object.entries(changes)) {
    if (k === "filters" || k === "axes") next[k] = { ...(next[k] || {}), ...v };
    else next[k] = v;
  }
  // switching to a group_by with several series: keep the first series (the model can say so)
  return validateSpec(next);
}
