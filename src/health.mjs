// Liveness (/healthz) is trivial. Readiness (/readyz) is a DEEP but CHEAP check: every sub-check is cached, so an
// unauthenticated caller can't use it to amplify load or spend, and the output never contains secrets, ARNs or keys.
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { appSecrets } from "./appsecrets.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const memo = new Map();
async function once(key, ttlMs, fn) {
  const c = memo.get(key); if (c && Date.now() - c.at < ttlMs) return { ...c.val, cached: true };
  const t = Date.now(); let val;
  try { val = { ...(await fn()), ms: Date.now() - t }; } catch (e) { val = { ok: false, ms: Date.now() - t, error: String(e?.code || e?.name || "error").slice(0, 40) }; }
  memo.set(key, { at: Date.now(), val }); return { ...val, cached: false };
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), ms))]);

export function certDays(host, timeoutMs = 4000) {
  return withTimeout(new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
      const c = s.getPeerCertificate(); s.end();
      if (!c || !c.valid_to) return reject(new Error("no cert"));
      resolve({ ok: s.authorized !== false, days: Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86400e3) });
    });
    s.on("error", reject);
  }), timeoutMs + 500);
}

let runtimeOkAt = 0; // set by the agent after a session is created successfully in this container
export function markRuntimeOk() { runtimeOkAt = Date.now(); }

export async function readiness({ hosts }) {
  const [secrets, runtime, openrouter, ...hostChecks] = await Promise.all([
    // Secrets Manager reachable (real GetSecretValue, cached 10 min; only ok/latency is reported)
    once("secrets", 600e3, async () => { const s = await withTimeout(appSecrets({ fresh: true }), 4000); return { ok: !!(s && (s.clientId || s.sessionSecret)) }; }),
    // Copilot runtime: binary present + executable (no spawn per check); plus when a session last started OK here
    once("runtime", 600e3, async () => {
      const p = path.join(ROOT, "node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/copilot-runtime");
      fs.accessSync(p, fs.constants.X_OK);
      return { ok: true };
    }),
    // OpenRouter reachable: unauthenticated GET of a tiny endpoint; any HTTP answer (incl. 401) means reachable
    once("openrouter", 120e3, async () => { const r = await withTimeout(fetch("https://openrouter.ai/api/v1/key", { method: "GET" }), 4000); return { ok: r.status < 500, http: r.status }; }),
    ...hosts.map(([name, host]) => once("host:" + host, 3600e3, async () => {
      const a = await withTimeout(dns.lookup(host), 3000);
      const c = await certDays(host);
      return { name, ok: !!a.address && c.ok && c.days > 7, dns: true, cert_days: c.days, cert_warn: c.days <= 21 };
    }).then((r) => ({ name, ...r }))),
  ]);
  runtime.last_session_ok = runtimeOkAt ? new Date(runtimeOkAt).toISOString() : null;
  const checks = { secrets_manager: secrets, copilot_runtime: runtime, openrouter, hosts: hostChecks };
  const critical = [secrets, runtime];
  const status = critical.some((c) => !c.ok) ? "down" : [openrouter, ...hostChecks].some((c) => !c.ok || c.cert_warn) ? "degraded" : "ok";
  return { status, checked_at: new Date().toISOString(), checks };
}
