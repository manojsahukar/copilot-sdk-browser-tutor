// Observability data for the tutor's agent. READ-ONLY toward AWS: CloudWatch GetMetricData, Logs Insights
// StartQuery/GetQueryResults, DynamoDB Query (+ PutItem only for the tutor's own minimised telemetry).
// Everything the model can ask for is in a fixed catalogue: it picks ids/enums, never namespaces, dimensions or queries.
import crypto from "node:crypto";
import { maskLog } from "./scrub.mjs";

const REGION = process.env.AWS_REGION || "ap-south-1";
const FN_NAME = process.env.METRICS_FUNCTION_NAME || "browser-tutor";
const LOG_GROUP = process.env.METRICS_LOG_GROUP || "/aws/lambda/browser-tutor";
const DIST = { main: process.env.CF_DIST_MAIN || "", sibling: process.env.CF_DIST_SIBLING || "", lab: process.env.CF_DIST_LAB || "" };
const TABLE = process.env.METRICS_TABLE || "";
const CW_ENABLED = process.env.METRICS_CLOUDWATCH !== "0";

export const AGGS = ["avg", "p50", "p95", "p99", "max", "min", "sum", "count"];
export const RANGES = ["1h", "6h", "24h", "3d", "7d", "30d"];
export const INTERVALS = ["auto", "1m", "5m", "15m", "1h", "3h", "6h", "1d"];
export const GROUPS = ["none", "engine", "model", "error_type", "connection", "device", "distribution", "endpoint"];
// Endpoints probed every 5 min by the scheduled pinger (deploy/pinger): public URLs through DNS + TLS + CloudFront.
export const ENDPOINTS = { main: "main /healthz", ready: "main /readyz (deep)", sibling: "sibling /healthz", lab: "xss-lab /healthz" };
export const ENDPOINT_IDS = Object.keys(ENDPOINTS);
const RANGE_MS = { "1h": 3600e3, "6h": 6 * 3600e3, "24h": 86400e3, "3d": 3 * 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3 };
const INT_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "1h": 3600e3, "3h": 3 * 3600e3, "6h": 6 * 3600e3, "1d": 86400e3 };
const AUTO_INT = { "1h": "1m", "6h": "5m", "24h": "15m", "3d": "1h", "7d": "1h", "30d": "6h" };
export const MAX_POINTS = 500;

const PCT = ["avg", "p50", "p95", "p99", "max", "min"];
// src: "cw" = CloudWatch (site-wide infrastructure), "turn" = per-turn app telemetry, "web" = visitor browser metrics.
const cw = (label, unit, ns, name, aggs, dims, extra = {}) => ({ src: "cw", label, unit, ns, name, aggs, dims, groups: dims === "cf" ? ["distribution"] : [], ...extra });
export const METRICS = {
  // ---- infrastructure (first-class) ----
  lambda_invocations: cw("Lambda invocations", "count", "AWS/Lambda", "Invocations", ["sum"], "fn"),
  lambda_duration_ms: cw("Lambda duration", "ms", "AWS/Lambda", "Duration", ["p50", "p95", "p99", "avg", "max"], "fn"),
  lambda_errors: cw("Lambda errors", "count", "AWS/Lambda", "Errors", ["sum"], "fn"),
  lambda_throttles: cw("Lambda throttles", "count", "AWS/Lambda", "Throttles", ["sum"], "fn"),
  lambda_concurrency: cw("Lambda concurrent executions", "count", "AWS/Lambda", "ConcurrentExecutions", ["max", "avg"], "fn"),
  cf_requests: cw("CloudFront requests", "count", "AWS/CloudFront", "Requests", ["sum"], "cf"),
  cf_4xx_rate: cw("CloudFront 4xx rate", "%", "AWS/CloudFront", "4xxErrorRate", ["avg", "max"], "cf"),
  cf_5xx_rate: cw("CloudFront 5xx rate", "%", "AWS/CloudFront", "5xxErrorRate", ["avg", "max"], "cf"),
  cf_bytes_down: cw("CloudFront bytes downloaded", "bytes", "AWS/CloudFront", "BytesDownloaded", ["sum"], "cf"),
  // derived: 100 - 5xxErrorRate (CloudFront has months of history, so availability is real before the pinger accrues any)
  cf_availability_pct: cw("Availability (derived: 100 − CloudFront 5xx %)", "%", "AWS/CloudFront", "5xxErrorRate", ["min", "avg"], "cf", { transform: "100-", statFor: { min: "max", avg: "avg" } }),
  // ---- health probes (scheduled pinger, every 5 min) ----
  uptime_pct: { src: "health", field: "st", label: "Uptime (probe)", unit: "%", aggs: ["avg", "min"], groups: ["endpoint"] },
  probe_latency_ms: { src: "health", field: "ms", label: "Probe response time", unit: "ms", aggs: PCT, groups: ["endpoint"] },
  cert_days: { src: "health", field: "cert", label: "TLS cert days left", unit: "days", aggs: ["min"], groups: ["endpoint"] },
  // ---- app telemetry per chat turn (secondary; no content, no PII) ----
  reply_latency_ms: { src: "turn", field: "ms", label: "Reply latency", unit: "ms", aggs: PCT, groups: ["engine", "model", "error_type"] },
  ttft_ms: { src: "turn", field: "ttft", label: "Time to first token", unit: "ms", aggs: PCT, groups: ["engine", "model"] },
  tool_calls: { src: "turn", field: "tools", label: "Tool calls per turn", unit: "count", aggs: ["sum", "avg", "max"], groups: ["engine", "model"] },
  retries_429: { src: "turn", field: "retries", label: "429 retries", unit: "count", aggs: ["sum", "avg", "max"], groups: ["engine", "model"] },
  turn_errors: { src: "turn", field: "err1", label: "Failed turns", unit: "count", aggs: ["sum", "avg"], groups: ["engine", "model", "error_type"] },
  turns: { src: "turn", field: "one", label: "Chat turns", unit: "count", aggs: ["count", "sum"], groups: ["engine", "model", "error_type"] },
  tokens_in: { src: "turn", field: "tin", label: "Input tokens", unit: "tokens", aggs: ["sum", "avg", "max"], groups: ["engine", "model"] },
  tokens_out: { src: "turn", field: "tout", label: "Output tokens", unit: "tokens", aggs: ["sum", "avg", "max"], groups: ["engine", "model"] },
  // ---- visitor browser metrics (aggregates, rounded; secondary) ----
  web_ttfb_ms: { src: "web", field: "ttfb", label: "Page TTFB", unit: "ms", aggs: PCT, groups: ["connection", "device"] },
  web_lcp_ms: { src: "web", field: "lcp", label: "Largest Contentful Paint", unit: "ms", aggs: PCT, groups: ["connection", "device"] },
  web_cls: { src: "web", field: "cls", label: "Cumulative Layout Shift", unit: "score", aggs: PCT, groups: ["connection", "device"] },
  web_load_ms: { src: "web", field: "load", label: "Page load", unit: "ms", aggs: PCT, groups: ["connection", "device"] },
  web_heap_mb: { src: "web", field: "heap", label: "JS heap used", unit: "MB", aggs: PCT, groups: ["connection", "device"] },
  web_rtt_ms: { src: "web", field: "rtt", label: "Network RTT (browser est.)", unit: "ms", aggs: PCT, groups: ["connection", "device"] },
};
export const METRIC_IDS = Object.keys(METRICS);
const GROUP_FIELD = { engine: "engine", model: "model", error_type: "err", connection: "conn", device: "dev" };

export function plan(range, interval, nSeries = 1) {
  const span = RANGE_MS[range];
  let iv = interval && interval !== "auto" ? interval : AUTO_INT[range];
  const order = ["1m", "5m", "15m", "1h", "3h", "6h", "1d"]; const notes = []; const asked = iv;
  while ((span / INT_MS[iv]) * nSeries > MAX_POINTS && order.indexOf(iv) < order.length - 1) iv = order[order.indexOf(iv) + 1];
  if (interval && interval !== "auto" && iv !== asked) notes.push(`interval coarsened ${asked}→${iv} to stay ≤${MAX_POINTS} points`);
  const step = INT_MS[iv];
  const to = Math.ceil(Date.now() / step) * step, from = to - Math.ceil(span / step) * step;
  const buckets = []; for (let t = from; t < to; t += step) buckets.push(t);
  return { from, to, step, interval: iv, buckets, notes };
}

// ---------- user identity for telemetry: pseudonymous HMAC, never the login ----------
let UH_KEY = null;
export function setUserKey(k) { UH_KEY = k; }
export function userHash(login) { return crypto.createHmac("sha256", UH_KEY || "dev").update("uh:" + String(login).toLowerCase()).digest("hex").slice(0, 24); }

// ---------- telemetry store: DynamoDB (on-demand + 30-day TTL) or in-memory (local/tests) ----------
const TTL_S = 30 * 86400;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const NUM = ["t", "ms", "ttft", "tools", "retries", "ok", "tin", "tout", "ttfb", "dcl", "load", "lcp", "cls", "heap", "rtt"];
const STR = ["engine", "model", "err", "conn", "dev"];
function clean(kind, r) {
  const o = { kind, t: Math.round(r.t || Date.now()) };
  if (kind === "health") { for (const [k, v] of Object.entries(r)) if (/^(main|ready|sibling|lab)_(st|ms|code|cert)$/.test(k) && typeof v === "number" && Number.isFinite(v)) o[k] = v; return o; }
  for (const k of NUM) if (k !== "t" && typeof r[k] === "number" && Number.isFinite(r[k])) o[k] = Math.round(r[k] * (k === "cls" ? 1000 : 1)) / (k === "cls" ? 1000 : 1);
  for (const k of STR) if (typeof r[k] === "string" && r[k]) o[k] = r[k].replace(/[^A-Za-z0-9._:/-]/g, "").slice(0, 60);
  return o;
}
export function memoryStore() {
  const rows = [];
  return {
    kind: "memory",
    async put(kind, uh, rec) { rows.push({ uh, ...clean(kind, rec) }); },
    async query(kind, uh, from, to) { return rows.filter((r) => r.kind === kind && r.t >= from && r.t < to && (uh == null || r.uh === uh)).map(({ uh: _u, ...r }) => r); },
    _rows: rows,
  };
}
function dynamoStore(table) {
  let ddb;
  const client = async () => { if (!ddb) { const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb"); ddb = new DynamoDBClient({ region: REGION }); } return ddb; };
  const marshal = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => [k, typeof v === "number" ? { N: String(v) } : { S: String(v) }]));
  const unmarshal = (it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, v.N != null ? Number(v.N) : v.S]));
  async function q(pk, lo, hi, cap) {
    const { QueryCommand } = await import("@aws-sdk/client-dynamodb"); const c = await client(); const out = []; let start;
    do {
      const r = await c.send(new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :p AND sk BETWEEN :a AND :b", ExpressionAttributeValues: { ":p": { S: pk }, ":a": { S: lo }, ":b": { S: hi } }, ExclusiveStartKey: start, Limit: 1000 }));
      for (const it of r.Items || []) { const o = unmarshal(it); delete o.pk; delete o.sk; delete o.ttl; delete o.uh; out.push(o); }
      start = r.LastEvaluatedKey;
    } while (start && out.length < cap);
    return out;
  }
  return {
    kind: "dynamodb",
    async put(kind, uh, rec) {
      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb"); const c = await client();
      const o = clean(kind, rec); const rnd = crypto.randomBytes(3).toString("hex"); const ttl = Math.floor(o.t / 1000) + TTL_S;
      // two items: the user's own partition (pseudonymous uh) and a site-wide day partition WITHOUT any user id
      await Promise.all([
        c.send(new PutItemCommand({ TableName: table, Item: marshal({ pk: `u#${uh}`, sk: `${kind}#${o.t}#${rnd}`, ttl, ...o }) })),
        c.send(new PutItemCommand({ TableName: table, Item: marshal({ pk: `d#${kind}#${day(o.t)}`, sk: `${o.t}#${rnd}`, ttl, ...o }) })),
      ]);
    },
    async query(kind, uh, from, to) {
      if (uh != null) return q(`u#${uh}`, `${kind}#${from}`, `${kind}#${to}`, 5000);
      const days = []; for (let t = from - (from % 86400e3); t < to; t += 86400e3) days.push(day(t));
      const parts = await Promise.all(days.map((d) => q(`d#${kind}#${d}`, String(from), String(to), 3000)));
      return parts.flat();
    },
  };
}
export let store = TABLE ? dynamoStore(TABLE) : memoryStore();
export function setStore(s) { store = s; }

// METRICS_READONLY=1: never write (e.g. a local dev server pointed at the production table for screenshots).
const READONLY = process.env.METRICS_READONLY === "1";
export function recordTurn(uh, r) { if (READONLY) return Promise.resolve(); return store.put("turn", uh, r).catch((e) => console.error("[metrics] put failed:", maskLog(e?.message || e))); }
export function recordWeb(uh, r) {
  if (READONLY) return Promise.resolve();
  const conn = ["slow-2g", "2g", "3g", "4g"].includes(r.conn) ? r.conn : "unknown";
  const dev = r.dev === "mobile" ? "mobile" : r.dev === "desktop" ? "desktop" : "unknown";
  const lim = (v, max) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);
  const rec = { t: Date.now(), ttfb: lim(r.ttfb, 120e3), dcl: lim(r.dcl, 300e3), load: lim(r.load, 300e3), lcp: lim(r.lcp, 300e3), cls: lim(r.cls, 50), heap: lim(r.heap, 65536), rtt: lim(r.rtt, 60e3), conn, dev };
  // round to coarse buckets: data minimisation (no exact fingerprint-grade values)
  for (const k of ["ttfb", "dcl", "load", "lcp", "rtt"]) if (rec[k] != null) rec[k] = Math.round(rec[k] / 10) * 10;
  if (rec.heap != null) rec.heap = Math.round(rec.heap);
  return store.put("web", uh, rec);
}

// ---------- aggregation ----------
function aggregate(vals, agg) {
  const v = vals.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (agg === "count") return vals.length;
  if (!v.length) return null;
  if (agg === "sum") return v.reduce((a, b) => a + b, 0);
  if (agg === "avg") return v.reduce((a, b) => a + b, 0) / v.length;
  if (agg === "max") return Math.max(...v);
  if (agg === "min") return Math.min(...v);
  const p = { p50: 0.5, p95: 0.95, p99: 0.99 }[agg]; const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const fieldVal = (rec, f) => (f === "one" ? 1 : f === "err1" ? (rec.ok === 0 ? 1 : 0) : rec[f]);

async function appSeries(m, s, spec, P, uh) {
  let rows = await store.query(m.src, spec.scope === "site" ? null : uh, P.from, P.to);
  if (spec.filters && spec.filters.engine) rows = rows.filter((r) => r.engine === spec.filters.engine);
  const gf = spec.group_by !== "none" ? GROUP_FIELD[spec.group_by] : null;
  const groups = new Map();
  for (const r of rows) { const g = gf ? (r[gf] || "none") : (s.label || m.label); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
  // cap number of groups (top 6 by sample count, rest folded into "other")
  let entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  if (entries.length > 6) { const rest = entries.slice(5).flatMap((e) => e[1]); entries = [...entries.slice(0, 5), ["other", rest]]; }
  const out = entries.map(([name, rs]) => {
    const byB = new Map();
    for (const r of rs) { const b = P.from + Math.floor((r.t - P.from) / P.step) * P.step; if (!byB.has(b)) byB.set(b, []); byB.get(b).push(fieldVal(r, m.field)); }
    const isCount = m.unit === "count" && ["sum", "count"].includes(s.agg);
    const points = P.buckets.map((b) => [b, byB.has(b) ? r3(aggregate(byB.get(b), s.agg)) : (isCount ? 0 : null)]);
    return { name, points, total: r3(aggregate(rs.map((r) => fieldVal(r, m.field)), s.agg)), n: rs.length };
  });
  return { series: out, samples: rows.length, firstAt: rows.length ? Math.min(...rows.map((r) => r.t)) : null };
}

// ---------- CloudWatch (infrastructure) ----------
let cwRegional, cwGlobal;
async function cwClient(global) {
  const { CloudWatchClient } = await import("@aws-sdk/client-cloudwatch");
  if (global) return (cwGlobal ??= new CloudWatchClient({ region: "us-east-1" })); // CloudFront metrics live in us-east-1
  return (cwRegional ??= new CloudWatchClient({ region: REGION }));
}
const CW_STAT = { sum: "Sum", avg: "Average", max: "Maximum", min: "Minimum", p50: "p50", p95: "p95", p99: "p99", count: "SampleCount" };
const cache = new Map(); // key -> {at, val}; bounds GetMetricData spend when many viewers refresh
async function cached(key, ms, fn) { const c = cache.get(key); if (c && Date.now() - c.at < ms) return c.val; const val = await fn(); cache.set(key, { at: Date.now(), val }); if (cache.size > 300) cache.delete(cache.keys().next().value); return val; }

async function cwSeries(m, s, spec, P) {
  let targets;
  if (m.dims === "fn") targets = [{ name: s.label || m.label, dims: [{ Name: "FunctionName", Value: FN_NAME }], global: false }];
  else {
    const which = spec.group_by === "distribution" ? ["main", "sibling", "lab"] : [(spec.filters && spec.filters.distribution) || "main"];
    targets = which.filter((w) => DIST[w]).map((w) => ({ name: spec.group_by === "distribution" ? w : `${s.label || m.label}${which.length === 1 && w !== "main" ? ` (${w})` : ""}`, dims: [{ Name: "DistributionId", Value: DIST[w] }, { Name: "Region", Value: "Global" }], global: true }));
    if (!targets.length) return { series: [], samples: 0, note: "CloudFront distribution ids are not configured on this server" };
  }
  if (!CW_ENABLED) return { series: [], samples: 0, note: "CloudWatch reads are disabled on this server (METRICS_CLOUDWATCH=0)" };
  const key = JSON.stringify([m.name, s.agg, targets.map((t) => t.dims), P.from, P.to, P.step]);
  return cached(key, 60e3, async () => {
    const { GetMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
    const out = [];
    for (const g of [false, true]) {
      const ts = targets.filter((t) => t.global === g); if (!ts.length) continue;
      const c = await cwClient(g);
      const span = P.to - P.from;
      const stat = CW_STAT[(m.statFor && m.statFor[s.agg]) || s.agg];
      const qs = ts.flatMap((t, i) => [
        { Id: `s${i}`, MetricStat: { Metric: { Namespace: m.ns, MetricName: m.name, Dimensions: t.dims }, Period: Math.round(P.step / 1000), Stat: stat }, ReturnData: true },
        { Id: `t${i}`, MetricStat: { Metric: { Namespace: m.ns, MetricName: m.name, Dimensions: t.dims }, Period: Math.round(span / 1000), Stat: stat }, ReturnData: true },
      ]);
      const tf = (v) => (v == null ? v : m.transform === "100-" ? 100 - v : v);
      const r = await c.send(new GetMetricDataCommand({ StartTime: new Date(P.from), EndTime: new Date(P.to), MetricDataQueries: qs, ScanBy: "TimestampAscending" }));
      const byId = Object.fromEntries((r.MetricDataResults || []).map((x) => [x.Id, x]));
      ts.forEach((t, i) => {
        const x = byId[`s${i}`] || { Timestamps: [], Values: [] }; const map = new Map();
        (x.Timestamps || []).forEach((d, j) => map.set(new Date(d).getTime(), tf(x.Values[j])));
        const zeroFill = ["sum"].includes(s.agg);
        const points = P.buckets.map((b) => [b, map.has(b) ? r3(map.get(b)) : (zeroFill ? 0 : null)]);
        const tot = byId[`t${i}`]; const total = tot && tot.Values && tot.Values.length ? r3(tf(tot.Values[0])) : (zeroFill ? 0 : null);
        out.push({ name: t.name, points, total, n: (x.Values || []).length });
      });
    }
    return { series: out, samples: out.reduce((a, b) => a + b.n, 0) };
  });
}

// ---------- health (pinger rows: one wide row per 5-min run, site-wide, no user data) ----------
const HEALTH_STEP = 5 * 60e3;
const healthRows = (from, to) => store.query("health", null, from, to).then((rows) => rows.sort((a, b) => a.t - b.t));
const upOf = (st) => (st == null ? null : st > 0 ? 100 : 0); // degraded (0.5) still counts as available

async function healthSeries(m, s, spec, P) {
  const rows = await healthRows(P.from, P.to);
  const eps = spec.group_by === "endpoint" ? ENDPOINT_IDS : [(spec.filters && spec.filters.endpoint) || "main"];
  const series = eps.map((e) => {
    const val = (r) => (m.field === "st" ? upOf(r[`${e}_st`]) : r[`${e}_${m.field}`]);
    const byB = new Map(); const all = [];
    for (const r of rows) { const v = val(r); if (v == null) continue; all.push(v); const b = P.from + Math.floor((r.t - P.from) / P.step) * P.step; if (!byB.has(b)) byB.set(b, []); byB.get(b).push(v); }
    return { name: spec.group_by === "endpoint" ? ENDPOINTS[e] : (s.label || `${m.label} · ${ENDPOINTS[e]}`), points: P.buckets.map((b) => [b, byB.has(b) ? r3(aggregate(byB.get(b), s.agg)) : null]), total: r3(aggregate(all, s.agg)), n: all.length };
  });
  return { series, samples: rows.length, firstAt: rows.length ? rows[0].t : null, health: true };
}

// Request-weighted availability per distribution from CloudFront (Requests Sum + 5xxErrorRate Average, hourly).
async function cfAvailability(fromMs, toMs) {
  if (!CW_ENABLED) return {};
  const ids = Object.entries(DIST).filter(([, v]) => v); if (!ids.length) return {};
  const step = toMs - fromMs > 3 * 86400e3 ? 3600 : 900;
  const key = JSON.stringify(["cfavail", fromMs, toMs]);
  return cached(key, 300e3, async () => {
    const { GetMetricDataCommand } = await import("@aws-sdk/client-cloudwatch"); const c = await cwClient(true);
    const dims = (id) => [{ Name: "DistributionId", Value: id }, { Name: "Region", Value: "Global" }];
    const qs = ids.flatMap(([w, id]) => [
      { Id: `r_${w}`, MetricStat: { Metric: { Namespace: "AWS/CloudFront", MetricName: "Requests", Dimensions: dims(id) }, Period: step, Stat: "Sum" } },
      { Id: `e_${w}`, MetricStat: { Metric: { Namespace: "AWS/CloudFront", MetricName: "5xxErrorRate", Dimensions: dims(id) }, Period: step, Stat: "Average" } },
    ]);
    const r = await c.send(new GetMetricDataCommand({ StartTime: new Date(Math.floor(fromMs / 3600e3) * 3600e3), EndTime: new Date(toMs), MetricDataQueries: qs }));
    const by = Object.fromEntries((r.MetricDataResults || []).map((x) => [x.Id, new Map((x.Timestamps || []).map((d, j) => [new Date(d).getTime(), x.Values[j]]))]));
    const out = {};
    for (const [w] of ids) {
      let req = 0, bad = 0, badBuckets = [];
      for (const [t, n] of by[`r_${w}`] || []) { const e = (by[`e_${w}`] && by[`e_${w}`].get(t)) || 0; req += n; bad += (n * e) / 100; if (e >= 5 && n >= 3) badBuckets.push({ t, rate: e, n }); }
      out[w] = { requests: Math.round(req), pct: req ? r3(100 - (100 * bad) / req) : null, bad_buckets: badBuckets.sort((a, b) => a.t - b.t), step_s: step };
    }
    return out;
  });
}

function incidentsFrom(rows, e) {
  const out = []; let cur = null;
  for (const r of rows) {
    const st = r[`${e}_st`]; if (st == null) continue;
    if (st === 0) { if (!cur) cur = { endpoint: ENDPOINTS[e], source: "probe", start: r.t, end: r.t + HEALTH_STEP, checks: 0, codes: new Set() }; cur.end = r.t + HEALTH_STEP; cur.checks++; cur.codes.add(r[`${e}_code`] ?? 0); }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) { cur.ongoing = true; out.push(cur); }
  return out.map((x) => ({ ...x, codes: [...x.codes].map((c) => (c === 0 ? "timeout/network" : String(c))), minutes: Math.round((x.end - x.start) / 60e3) }));
}

async function resolveHealthWidget(spec) {
  const notes = []; const now = Date.now();
  if (spec.type === "status") {
    const rows = await healthRows(now - 3600e3, now + 1);
    const last = rows[rows.length - 1];
    const tiles = ENDPOINT_IDS.map((e) => {
      const recent = rows.filter((r) => r[`${e}_ms`] != null).slice(-12);
      const st = last ? last[`${e}_st`] : null;
      return { id: e, name: ENDPOINTS[e], status: st == null ? "unknown" : st >= 1 ? "up" : st > 0 ? "degraded" : "down", ms: last ? last[`${e}_ms`] ?? null : null, code: last ? last[`${e}_code`] ?? null : null,
        cert_days: last ? last[`${e}_cert`] ?? null : null, checked_at: last ? last.t : null, spark: recent.map((r) => r[`${e}_ms`]) };
    });
    if (!last) notes.push("No probe results in the last hour yet (the pinger runs every 5 min after deploy).");
    else if (now - last.t > 15 * 60e3) notes.push(`Last probe ${Math.round((now - last.t) / 60e3)} min ago: the pinger may be stalled.`);
    const cf = await cfAvailability(now - 3600e3, now).catch(() => ({}));
    return { kind: "status", tiles, derived: Object.fromEntries(Object.entries(cf).map(([w, v]) => [w, { pct_1h: v.pct, requests_1h: v.requests }])), notes, example: false };
  }
  if (spec.type === "uptime") {
    const slo = spec.slo || 99.5; const windows = [];
    const rows30 = await healthRows(now - 30 * 86400e3, now + 1);
    for (const [w, ms] of [["24h", 86400e3], ["7d", 7 * 86400e3], ["30d", 30 * 86400e3]]) {
      const rows = rows30.filter((r) => r.t >= now - ms);
      const eps = ENDPOINT_IDS.map((e) => {
        const v = rows.map((r) => r[`${e}_st`]).filter((x) => x != null);
        const up = v.filter((x) => x > 0).length; const pct = v.length ? r3((100 * up) / v.length) : null;
        const coverage = Math.min(1, (v.length * HEALTH_STEP) / ms);
        const allowedMin = ((100 - slo) / 100) * (ms / 60e3); const downMin = (v.length - up) * 5;
        return { id: e, name: ENDPOINTS[e], pct, checks: v.length, coverage_pct: Math.round(coverage * 100), down_min: downMin, budget_min: r3(allowedMin), budget_remaining_pct: v.length ? Math.round(100 * (1 - downMin / allowedMin)) : null, thin: coverage < 0.5 };
      });
      const cf = await cfAvailability(now - ms, now).catch(() => ({}));
      windows.push({ window: w, endpoints: eps, derived: Object.fromEntries(Object.entries(cf).map(([k, v]) => [k, { pct: v.pct, requests: v.requests }])) });
    }
    const first = rows30[0];
    notes.push(first ? `Probe history since ${new Date(first.t).toISOString().slice(0, 16)}Z; windows with <50% coverage are marked thin.` : "No probe history yet: uptime below uses CloudFront-derived availability (request-weighted 100 − 5xx %).");
    notes.push("Derived availability counts 5xx responses only; it can't see outages where no request reached CloudFront.");
    return { kind: "uptime", slo, windows, notes, example: false };
  }
  // incidents
  const ms = RANGE_MS[spec.range]; const rows = await healthRows(now - ms, now + 1);
  let items = ENDPOINT_IDS.flatMap((e) => incidentsFrom(rows, e));
  const cf = await cfAvailability(now - ms, now).catch(() => ({}));
  for (const [w, v] of Object.entries(cf)) {
    let cur = null; const step = v.step_s * 1000;
    for (const b of v.bad_buckets) {
      if (cur && b.t <= cur.end) { cur.end = b.t + step; cur.peak = Math.max(cur.peak, b.rate); }
      else { if (cur) items.push(cur); cur = { endpoint: `CloudFront ${w}`, source: "derived", start: b.t, end: b.t + step, peak: b.rate }; }
    }
    if (cur) items.push(cur);
  }
  items = items.map((x) => ({ ...x, minutes: Math.round((x.end - x.start) / 60e3), detail: x.source === "probe" ? `${x.checks} failed check(s): ${x.codes.join(", ")}` : `5xx rate peaked at ${r3(x.peak)}%` }))
    .sort((a, b) => b.start - a.start).slice(0, 20);
  if (!rows.length) notes.push("No probe history in this range yet; only CloudFront-derived incidents (buckets with ≥5% 5xx) are shown.");
  if (!items.length) notes.push("No incidents found in this range.");
  return { kind: "incidents", range: spec.range, items, notes, example: false };
}

// One call for the agent: live readiness + latest probe status + uptime windows + last incident.
export async function healthSummary(readinessFn) {
  const [ready, status, uptime, inc] = await Promise.all([
    readinessFn().catch((e) => ({ status: "unknown", error: String(e?.message || e).slice(0, 80) })),
    resolveHealthWidget({ type: "status" }), resolveHealthWidget({ type: "uptime", slo: 99.5 }), resolveHealthWidget({ type: "incidents", range: "30d" }),
  ]);
  return {
    readiness_now: ready,
    latest_probe: status.tiles.map((t) => ({ endpoint: t.name, status: t.status, ms: t.ms, http: t.code, cert_days: t.cert_days, checked_at: t.checked_at ? new Date(t.checked_at).toISOString() : null })),
    uptime: uptime.windows.map((w) => ({ window: w.window, probe: w.endpoints.map((e) => ({ endpoint: e.name, pct: e.pct, checks: e.checks, coverage_pct: e.coverage_pct, budget_remaining_pct: e.budget_remaining_pct })), cloudfront_derived: w.derived })),
    slo: 99.5,
    last_incidents: inc.items.slice(0, 5).map((x) => ({ ...x, start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString() })),
    notes: [...status.notes, ...uptime.notes, ...inc.notes],
  };
}

// ---------- example data (clearly labelled; only when the spec asks for example_data) ----------
function exampleSeries(m, s, spec, P) {
  const names = spec.group_by === "endpoint" ? Object.values(ENDPOINTS) : spec.group_by === "distribution" ? ["main", "sibling", "lab"] : spec.group_by !== "none" ? ["group A", "group B", "group C"] : [s.label || m.label];
  const base = { ms: 2500, "%": m.src === "health" || m.transform ? 99.5 : 1.5, days: 60, count: 12, bytes: 4e6, tokens: 900, score: 0.05, MB: 30 }[m.unit] || 10;
  let seed = [...(m.label + s.agg)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return { series: names.map((name, gi) => {
    const points = P.buckets.map((b, i) => [b, r3(base * (1 + gi * 0.35) * (1 + 0.4 * Math.sin(i / 6 + gi)) * (0.8 + 0.4 * rnd()))]);
    return { name, points, total: r3(aggregate(points.map((p) => p[1]), s.agg === "count" ? "sum" : s.agg)), n: points.length };
  }), samples: P.buckets.length * names.length };
}

// Resolve a VALIDATED spec into data. uh scopes app/browser metrics; infra metrics are site-wide.
export async function resolveData(spec, { uh }) {
  if (["status", "uptime", "incidents"].includes(spec.type) && !spec.example_data) {
    const d = await resolveHealthWidget(spec); return { ...d, scope: "site", samples: 0 };
  }
  const nSeries = spec.group_by === "distribution" ? 3 : spec.group_by === "endpoint" ? 4 : spec.group_by !== "none" ? 6 : spec.series.length;
  const P = plan(spec.range, spec.interval, nSeries);
  const notes = [...P.notes];
  const series = []; let anyReal = 0; let firstAt = null;
  for (const s of spec.series) {
    const m = METRICS[s.metric];
    let r;
    try {
      r = spec.example_data ? exampleSeries(m, s, spec, P) : m.src === "cw" ? await cwSeries(m, s, spec, P) : m.src === "health" ? await healthSeries(m, s, spec, P) : await appSeries(m, s, spec, P, uh);
    } catch (e) { r = { series: [], samples: 0, note: `${m.label}: data source error (${maskLog(e?.name || e?.message || e).slice(0, 80)})` }; }
    if (r.note) notes.push(r.note);
    anyReal += r.samples || 0;
    if (r.firstAt && (!firstAt || r.firstAt < firstAt)) firstAt = r.firstAt;
    for (const x of r.series) series.push({ ...x, metric: s.metric, unit: m.unit, agg: s.agg, axis: s.axis || "left", color: s.color || null, source: m.src });
  }
  // hard cap on points shipped to the browser/model
  let total = series.reduce((a, x) => a + x.points.length, 0);
  if (total > MAX_POINTS) { const keep = Math.max(1, Math.floor(MAX_POINTS / series.length)); for (const x of series) x.points = x.points.slice(-keep); notes.push(`trimmed to the latest ${keep} points per series (cap ${MAX_POINTS})`); }
  const appSrc = spec.series.some((s) => ["turn", "web"].includes(METRICS[s.metric].src));
  const healthSrc = spec.series.some((s) => METRICS[s.metric].src === "health");
  if (!spec.example_data && healthSrc && anyReal < 12) notes.push(anyReal === 0 ? "No probe history in this range yet (the pinger writes every 5 min). For older availability use cf_availability_pct (CloudFront-derived)." : `Thin history: ${anyReal} probe run(s) so far.`);
  if (!spec.example_data && appSrc && anyReal < 5) notes.push(anyReal === 0
    ? "No history recorded yet for this metric in this range. It fills in as you chat (telemetry started with this release)."
    : `Only ${anyReal} sample(s) so far${firstAt ? ` (first at ${new Date(firstAt).toISOString().slice(0, 16)}Z)` : ""}; trends become meaningful as history accrues.`);
  return { example: !!spec.example_data, interval: P.interval, from: P.from, to: P.to, series, samples: anyReal, notes, scope: appSrc ? spec.scope : "site" };
}

// Compact numeric summary for the MODEL (it never needs every point to explain a chart).
export function summarize(data) {
  if (data.kind) { const { kind, ...rest } = data; return { kind, ...JSON.parse(JSON.stringify(rest, (k, v) => (k === "spark" ? undefined : typeof v === "number" && v > 1e12 ? new Date(v).toISOString() : v))) }; }
  return {
    example_data: data.example, interval: data.interval, from: new Date(data.from).toISOString(), to: new Date(data.to).toISOString(), scope: data.scope, notes: data.notes,
    series: data.series.map((x) => {
      const v = x.points.map((p) => p[1]).filter((y) => y != null);
      const peak = x.points.reduce((a, p) => (p[1] != null && (a == null || p[1] > a[1]) ? p : a), null);
      const last6 = x.points.slice(-6).map((p) => p[1]);
      return { name: x.name, metric: x.metric, agg: x.agg, unit: x.unit, total_over_range: x.total, points: x.points.length, non_empty: v.length,
        min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null, peak_at: peak ? new Date(peak[0]).toISOString() : null, last_6_buckets: last6 };
    }),
  };
}

// ---------- Logs Insights: allowlisted, parameterised templates over the tutor's OWN log group ----------
const LOG_RANGES = { "1h": 3600, "6h": 6 * 3600, "24h": 86400, "3d": 3 * 86400, "7d": 7 * 86400 };
const BIN = { "1h": "5m", "6h": "15m", "24h": "1h", "3d": "6h", "7d": "6h" };
export const LOG_TEMPLATES = {
  errors_by_type: { label: "Failed turns by error type", siteRows: true, q: (o) => `filter bt = "turn" and ok = 0${o.me} | stats count(*) as errors by err | sort errors desc | limit 20` },
  error_timeline: { label: "Turns, errors and latency over time", siteRows: true, q: (o) => `filter bt = "turn"${o.me} | stats count(*) as turns, sum(1 - ok) as errors, avg(ms) as avg_ms, pct(ms, 95) as p95_ms, sum(retries) as retries_429 by bin(${o.bin})` },
  rate_limits: { label: "429 / rate-limit events over time", siteRows: true, q: (o) => `filter bt = "turn" and (retries > 0 or err = "rate_limit")${o.me} | stats count(*) as turns_hit, sum(retries) as retries by bin(${o.bin}), engine` },
  slow_turns: { label: "Slowest turns", siteRows: false, q: (o) => `filter bt = "turn" and ms >= ${o.threshold}${o.me} | fields @timestamp, engine, model, ms, ttft, tools, retries, err | sort ms desc | limit ${o.limit}` },
  lambda_reports: { label: "Lambda REPORT lines: duration, memory, cold starts", siteRows: true, siteOnly: true, q: (o) => `filter @type = "REPORT" | stats count(*) as invocations, avg(@duration) as avg_ms, pct(@duration, 95) as p95_ms, max(@maxMemoryUsed / 1048576) as max_mem_mb, sum(ispresent(@initDuration)) as cold_starts by bin(${o.bin})` },
  recent_errors: { label: "Recent error log lines (masked)", siteRows: false, siteOnly: true, adminOnly: true, q: (o) => `filter @message like /\\[chat\\]|\\[refresh\\]|\\[openrouter\\]|\\[metrics\\]|Task timed out|ERROR/ | fields @timestamp, @message | sort @timestamp desc | limit ${o.limit}` },
};
export const LOG_TEMPLATE_IDS = Object.keys(LOG_TEMPLATES);
const THRESHOLDS = [2000, 5000, 10000, 20000, 30000];
let logsClient;
export let logsRunner = async (queryString, startS, endS) => {
  const { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
  logsClient ??= new CloudWatchLogsClient({ region: REGION });
  const { queryId } = await logsClient.send(new StartQueryCommand({ logGroupName: LOG_GROUP, startTime: startS, endTime: endS, queryString, limit: 50 }));
  const deadline = Date.now() + 20000; // time-box: never hold the chat turn for long
  for (;;) {
    await new Promise((r) => setTimeout(r, 900));
    const r = await logsClient.send(new GetQueryResultsCommand({ queryId }));
    if (["Complete", "Failed", "Cancelled", "Timeout"].includes(r.status) || Date.now() > deadline)
      return { status: Date.now() > deadline && r.status === "Running" ? "TimeBoxed" : r.status, results: r.results || [], scanned: r.statistics && r.statistics.bytesScanned };
  }
};
export function setLogsRunner(fn) { logsRunner = fn; }

export async function queryLogs(args, user) {
  const tpl = LOG_TEMPLATES[args.template];
  if (!tpl) return { error: "unknown template", templates: LOG_TEMPLATE_IDS };
  if (tpl.adminOnly && !user.admin) return { error: "This template returns raw (masked) log lines and is limited to the site owner. Try errors_by_type or error_timeline." };
  const range = LOG_RANGES[args.range] ? args.range : "24h";
  // per-user scoping: row-level results are only ever the caller's own turns unless they are the site owner
  let scope = args.scope === "site" ? "site" : "me";
  const notes = [];
  if (scope === "site" && !tpl.siteRows && !user.admin) { scope = "me"; notes.push("row-level results are limited to your own turns"); }
  if (tpl.siteOnly) scope = "site";
  const me = scope === "me" && /^[0-9a-f]{24}$/.test(user.uh) ? ` and uh = "${user.uh}"` : "";
  const threshold = THRESHOLDS.includes(args.threshold_ms) ? args.threshold_ms : 10000;
  const limit = Math.min(50, Math.max(1, Number.isInteger(args.limit) ? args.limit : 20));
  const queryString = tpl.q({ me, bin: BIN[range], threshold, limit });
  const endS = Math.floor(Date.now() / 1000), startS = endS - LOG_RANGES[range];
  const r = await logsRunner(queryString, startS, endS);
  const rows = (r.results || []).slice(0, limit).map((row) => Object.fromEntries(row.filter((f) => f.field !== "@ptr").map((f) => [f.field, maskLog(f.value)])));
  if (!rows.length) notes.push(range === "7d" ? "No matching log events (log retention is 7 days)." : "No matching log events in this range.");
  return { template: args.template, label: tpl.label, range, scope, status: r.status, rows, row_cap: limit, notes, query_shown_for_transparency: queryString.replace(/uh = "[0-9a-f]+"/, 'uh = "<you>"') };
}
