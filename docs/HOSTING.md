# Hosting options (ap-south-1, prices from AWS Price List API, effective 2026-10-01)

Runtime needs: Node ≥20.19, spawn a child process (copilot-runtime, ~145 MB RSS measured), writable dir (/tmp ok), ~170 MB code, glibc ≥2.28.

| Option | Fits? | Est. monthly @ PoC traffic | Notes |
|---|---|---|---|
| **Lambda zip + Lambda Web Adapter + Function URL (streaming)** — recommended | Yes (168 MB < 250 MB limit; child processes + /tmp allowed) | **≈ $0** within always-free tier (1M req + 400k GB-s). Without free tier: 500 chat turns × 20 s × 1 GB = 10k GB-s × $0.0000166667 ≈ $0.17, + requests ≈ $0.001, + S3 artifacts ≈ $0.01 | Free HTTPS URL, no idle cost, no public IPv4 fee. Cold start (runtime spawn) unmeasured on Lambda — expect a few seconds. Copilot sessions are per-instance; transcript replay covers it. Reserved concurrency 5 caps spend (theoretical 24/7 max ≈ $216 only if 5 streams run nonstop; per-user rate limit + ALLOWED_LOGINS + a free AWS Budget alert make that unrealistic). |
| EC2 t4g.nano (0.5 GiB) | Tight on RAM | $0.0028/h → $2.04 + public IPv4 $3.65 + 8 GB gp3 ≈ $0.7 → **≈ $6.4** | Needs TLS (Caddy + domain), patching. Use linux-arm64 runtime pkg. |
| EC2 t4g.micro (1 GiB) | Yes | $0.0056/h → $4.09 + IPv4 + EBS → **≈ $8.5** | Simplest stateful option if Lambda cold starts annoy. |
| Lightsail / App Runner | Yes | ≈ $3.5–5+ minimum (not re-verified) | Always-on minimum; no advantage for a PoC. |

## Deployed (2026-10-19)
* `https://copilot-sdk.demo.curiosta.com` → CloudFront (PriceClass_200, caching disabled, all methods, HTTP/2+3, TLS1.2_2021, ACM cert in us-east-1)
  → Lambda Function URL (RESPONSE_STREAM) → Lambda Web Adapter → Node server. Route 53 A/AAAA alias in zone <HOSTED_ZONE_ID>.
* Viewer data: origin request policies allow only 10 named headers (quota hit when probing), so a CloudFront Function bundles all viewer
  headers into `x-bt-viewer-headers`; the policy forwards that plus CloudFront-Viewer-Address/-Http-Version/-TLS/-Country/-City,
  Origin, User-Agent, Accept-Language, Content-Type, all cookies and query strings. Host is not forwarded (Function URL needs its own).
* OAuth app creds: Secrets Manager `browser-tutor/github-oauth`, read at runtime and cached per container; IAM = GetSecretValue on that ARN only.
* Added monthly cost at PoC traffic: CloudFront ≈ $0 (always-free 1 TB / 10M requests / 2M function invocations), ACM $0, Route 53 alias
  queries $0 (zone already existed), Secrets Manager ≈ $0.40/secret + $0.05 per 10k calls ≈ **$0.40**. Lambda ≈ $0 (free tier).
* Note: the Function URL is still publicly reachable directly (AuthType NONE); CloudFront OAC for Lambda would require clients to sign POST bodies.
