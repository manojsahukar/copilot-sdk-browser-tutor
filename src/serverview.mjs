// Everything the server learns from a single HTTP request — no JavaScript needed.
// Behind CloudFront: the viewer's own headers arrive bundled in x-bt-viewer-headers (set by a CloudFront Function,
// because origin request policies are capped at 10 named headers), and edge facts arrive as CloudFront-Viewer-* headers.
const HIDE = new Set(["cookie", "authorization", "x-amz-security-token", "x-origin-verify", "x-api-key", "api-key", "proxy-authorization"]);
const INFRA = /^(x-amzn-|x-amz-|x-forwarded-|via$|x-bt-|cloudfront-|forwarded$)/;
const trust = () => process.env.TRUST_PROXY === "1";

function parseViewerAddress(v) { // "203.0.113.7:51234" or "2001:db8::1:51234"
  if (!v) return null; const i = v.lastIndexOf(":");
  return i > 0 ? { ip: v.slice(0, i), port: Number(v.slice(i + 1)) } : { ip: v, port: null };
}

export function serverView(req) {
  const raw = req.headers;
  let viewer = null;
  if (trust() && raw["x-bt-viewer-headers"]) {
    try { viewer = JSON.parse(decodeURIComponent(String(raw["x-bt-viewer-headers"]))); } catch { viewer = null; }
  }
  const src = viewer || raw;
  const headers = {}, infrastructure = {};
  for (const [k, v] of Object.entries(src)) {
    const key = k.toLowerCase();
    if (HIDE.has(key)) headers[key] = key === "x-origin-verify" ? "[hidden: CloudFront origin secret]" : key === "cookie" ? "[hidden: your session cookie]" : "[hidden]";
    else if (viewer && /^cloudfront-/.test(key)) continue; // added by the CDN, shown under infrastructure
    else if (!viewer && INFRA.test(key)) infrastructure[key] = v;
    else headers[key] = v;
  }
  if (raw.cookie) headers.cookie = "[hidden: your session cookie]";
  for (const [k, v] of Object.entries(raw)) if (/^cloudfront-/.test(k)) infrastructure[k] = v;

  const cf = trust() ? parseViewerAddress(raw["cloudfront-viewer-address"]) : null;
  const fwd = String(raw["x-forwarded-for"] || "").split(",")[0].trim();
  const sock = req.socket;
  return {
    clientIp: cf?.ip || (trust() && fwd) || sock.remoteAddress,
    clientPort: cf?.port ?? sock.remotePort,
    httpVersion: (trust() && raw["cloudfront-viewer-http-version"]) || req.httpVersion,
    method: req.method,
    tls: (trust() && raw["cloudfront-viewer-tls"]) ? { viewerTls: raw["cloudfront-viewer-tls"], note: "protocol:cipher negotiated between your browser and the CDN edge" }
      : sock.encrypted ? { protocol: sock.getProtocol?.(), cipher: sock.getCipher?.()?.name } : null,
    approxLocation: trust() && raw["cloudfront-viewer-country"] ? { country: raw["cloudfront-viewer-country"], city: raw["cloudfront-viewer-city"], asn: raw["cloudfront-viewer-asn"], note: "IP-based, approximate" } : undefined,
    headers,
    infrastructure: Object.keys(infrastructure).length ? infrastructure : undefined,
    receivedAt: new Date().toISOString(),
    note: "Headers are sent automatically by your browser on every request; the site sees them even with JavaScript disabled.",
  };
}
