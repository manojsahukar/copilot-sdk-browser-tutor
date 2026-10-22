// Shared masking for anything that leaves the server towards the model or the browser (tokens, keys, PII-ish values).
export const scrubTokens = (s) => String(s).replace(/gh[opsur]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-or-[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}/g, "[redacted]");
// Stronger mask for log rows: tokens + e-mail addresses + IPv4/IPv6 + long hex/base64 blobs (session ids, signatures).
export function maskLog(s) {
  return scrubTokens(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "[ip]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[blob]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .slice(0, 400);
}
