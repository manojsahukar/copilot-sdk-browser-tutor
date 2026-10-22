// Scheduled availability pinger (EventBridge rule, every 5 min). Probes the PUBLIC URLs through DNS + TLS +
// CloudFront exactly like a visitor, checks TLS cert expiry, and writes ONE site-wide row (no user data) to the
// metrics table. IAM: dynamodb:PutItem on that table only. No alarms/notifications (they'd cost money).
import tls from "node:tls";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb"; // bundled in the nodejs22.x runtime

const ddb = new DynamoDBClient({});
const TABLE = process.env.METRICS_TABLE;
const T = JSON.parse(process.env.TARGETS || "{}"); // {main:"https://…/healthz", ready:"https://…/readyz", sibling:…, lab:…}
const SLOW_MS = 3000;

async function probe(url) {
  const t = Date.now(); const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "browser-tutor-pinger/1" }, redirect: "manual" });
    const body = await r.text(); const ms = Date.now() - t;
    let st = r.status >= 200 && r.status < 300 ? 1 : 0;
    if (st && url.endsWith("/readyz")) { try { const j = JSON.parse(body); st = j.status === "ok" ? 1 : j.status === "degraded" ? 0.5 : 0; } catch { st = 0; } }
    if (st === 1 && ms > SLOW_MS) st = 0.5;
    return { st, ms, code: r.status };
  } catch { return { st: 0, ms: Date.now() - t, code: 0 }; } finally { clearTimeout(to); }
}
function certDays(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 5000 }, () => {
      const c = s.getPeerCertificate(); s.end(); resolve(c && c.valid_to ? Math.floor((new Date(c.valid_to) - Date.now()) / 86400e3) : -1);
    });
    s.on("error", () => resolve(-1)); s.on("timeout", () => { s.destroy(); resolve(-1); });
  });
}

export const handler = async () => {
  const now = Date.now(); const item = { t: now };
  const entries = Object.entries(T);
  const results = await Promise.all(entries.map(([, url]) => probe(url)));
  const hosts = [...new Set(entries.map(([, u]) => new URL(u).host))];
  const days = Object.fromEntries(await Promise.all(hosts.map(async (h) => [h, await certDays(h)])));
  entries.forEach(([name, url], i) => { const r = results[i]; item[`${name}_st`] = r.st; item[`${name}_ms`] = r.ms; item[`${name}_code`] = r.code; item[`${name}_cert`] = days[new URL(url).host]; });
  const day = new Date(now).toISOString().slice(0, 10); const rnd = Math.random().toString(16).slice(2, 8);
  const Item = { pk: { S: `d#health#${day}` }, sk: { S: `${now}#${rnd}` }, kind: { S: "health" }, ttl: { N: String(Math.floor(now / 1000) + 35 * 86400) } };
  for (const [k, v] of Object.entries(item)) Item[k] = { N: String(v) };
  await ddb.send(new PutItemCommand({ TableName: TABLE, Item }));
  console.log(JSON.stringify({ bt: "probe", ...item }));
  return { ok: true };
};
