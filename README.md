# Browser Tutor — GitHub Copilot SDK PoC

A small, security-focused web app: **sign in with GitHub → see exactly what your own browser exposes to any
website** (HTTP headers *and* JavaScript APIs) → **chat with a [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
agent** that explains each signal, how it is used for tracking and fingerprinting, what a curious or malicious site
could do with it, and how to defend yourself. There are also **live, tap-to-run permission demos** (camera, mic,
geolocation, cookies, cross-site requests) and an **"Agent SDK gotchas"** lesson about safely building agents like this one.

Educational and defensive only. Nothing here attacks anyone; every "demo" runs against *your own* browser and reports
only metadata back to the tutor.

> **Live demo:** https://copilot-sdk.demo.curiosta.com — sign-in is currently limited to invited GitHub accounts
> (`ALLOWED_LOGINS`). The code is model-agnostic and runs on your own GitHub Copilot entitlement.

| Probe & chat | Live demos | SDK gotchas |
|---|---|---|
| ![chat](docs/mobile-chat.png) | ![demos](docs/demo-390.png) | ![gotchas](docs/gotchas-fixed-390.png) |

## What it teaches

- **Passive signals** the server sees with no JavaScript at all: IP, `User-Agent`, `Accept-Language`, `sec-ch-*`, TLS/HTTP facts.
- **Active signals** JavaScript can read: screen, timezone, languages, canvas/WebGL hashes, fonts, media-device counts, permission states.
- **Permissioned capabilities** via the live demos: camera, microphone, geolocation (all local-only; only metadata is reported),
  and **cross-site behaviour** against a genuinely separate "sibling" origin (CORS vs no-CORS reads, and a shared-parent cookie).
- **How to defend**: browser choice/settings, resistFingerprinting, 3rd-party-cookie blocking, GPC, permission hygiene, and the trade-offs.

## Architecture

```
                         ┌──────────────────── AWS ────────────────────┐
Browser ──HTTPS──> CloudFront ──(X-Origin-Verify secret header)──> Lambda Function URL (RESPONSE_STREAM)
  │  probe.js / demos.js: static, reviewed client code only          │   └─ Lambda Web Adapter ─> Node http server (src/server.mjs)
  │  POST /api/chat  (Server-Sent Events stream)                      │        │
  ▼                                                                   │        ▼
 sibling.<domain> ── second CloudFront dist, same Lambda ──┘          │   Copilot SDK client  mode:"empty", useLoggedInUser:false
                                                                      │     per-user session: gitHubToken = the user's OAuth token
 Secrets Manager (client_id, client_secret, session_secret,          │     availableTools:["custom:*"] → only 4 read-only tools
                  origin_verify) ── read at runtime, never in env ────┘     JSON-RPC/stdio ─> bundled copilot-runtime child process
                                                                            └─> GitHub Copilot API (billed to that user's plan)
```

- **Lambda (zip, nodejs22.x) + [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)** runs the plain Node server with response streaming; a **Function URL** gives it HTTPS.
- **CloudFront** adds the custom domain and TLS, forwards viewer facts (bundled into one header to stay within the 10-header limit),
  and injects a secret **`X-Origin-Verify`** header so the origin rejects anyone hitting the Function URL directly (gotcha 9).
- **Secrets Manager** holds *all* secrets as one JSON; **no secret is in Lambda env vars**.
- **Sessions are stateless**: an AES-256-GCM encrypted `HttpOnly` cookie carries the login and the (refreshable) GitHub token,
  so any Lambda instance can serve any user. When a request lands on a cold instance, the browser-held transcript is replayed.

## Security notes

This project is itself a worked example of building an agent safely. The **[`/gotchas`](https://copilot-sdk.demo.curiosta.com/gotchas)**
page (source: [`src/gotchas.mjs`](src/gotchas.mjs)) lists 10 pitfalls of the Copilot SDK with a **status** (Fixed / Mitigated /
Accepted / Needs human) and a pointer to the code that handles each. Highlights:

- **No model-generated JavaScript.** The model only returns text; live demos use a `run_demo` **enum** that maps a demo *name*
  to pre-written, reviewed client code. Markdown is escaped first and can't emit raw HTML or `javascript:` links; CSP is
  `script-src 'self'` with no `unsafe-inline`/`unsafe-eval`.
- **Prompt-injection defence.** Every tool result is wrapped in `<<<BEGIN_UNTRUSTED_DATA>>> … <<<END_UNTRUSTED_DATA>>>` markers,
  length-capped and control-char-stripped, and the system prompt treats anything inside as data, never instructions. Tools are
  read-only. (Reduces, does not eliminate, the risk — see `scripts/injection-tests.mjs`.)
- **Multi-tenant by construction.** Every Copilot client is built through a helper that **throws unless `mode:"empty"`**; each
  session exposes only this app's 4 read-only tools. No shell/file/web/MCP tools exist.
- **Per-user auth, no server-wide fallback.** `useLoggedInUser:false` + a per-session token/`gitHubTokenProvider`. The only
  ambient-credential path is the localhost dev bypass, which **hard-fails at startup under `NODE_ENV=production`**.
- **Token refresh.** The `ghr_` refresh token lives only in the encrypted cookie; the access token is refreshed before expiry;
  refresh failure logs the user out cleanly. Session capped at 7 days.
- **Deny-by-default permissions** and **secret masking** (cookies, tokens, the origin secret never reach the model or logs).

See the page for the full list and the exact files.

## Run locally

```bash
npm ci
cp .env.example .env     # fill GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / SESSION_SECRET
                         # OAuth callback = http://localhost:8080/auth/callback
set -a; . ./.env; set +a
npm start                # http://localhost:8080  (a sibling origin also starts on SIBLING_PORT for the cross-site demos)
```

Or, on localhost only, skip OAuth and use this machine's own Copilot auth chain (env token / `copilot` login / `gh auth`):

```bash
npm run dev              # then open http://localhost:8080 and "Continue without OAuth (dev bypass)"
```

### Tests

```bash
node scripts/unit-tests.mjs        # mode:"empty" assertion + deny-by-default permission handler
node scripts/injection-tests.mjs   # prompt-injection vectors (UA, Referer, cookie name) are neutralised; secret masking
node scripts/e2e-mobile.mjs        # responsive checks at 360/390/768/1280 (needs: npm i --no-save puppeteer-core@23)
```

## Deploy (AWS)

All config is parameterised — nothing in this repo is tied to a specific AWS account or domain.

1. **Create the secret** (one JSON with everything) and export its ARN:
   ```bash
   aws secretsmanager create-secret --name browser-tutor/github-oauth --region "$AWS_REGION" \
     --secret-string "$(jq -n --arg ci "$GITHUB_CLIENT_ID" --arg cs "$GITHUB_CLIENT_SECRET" \
        --arg ss "$(openssl rand -hex 32)" --arg ov "$(openssl rand -hex 32)" \
        '{client_id:$ci, client_secret:$cs, session_secret:$ss, origin_verify:$ov}')"
   export GITHUB_OAUTH_SECRET_ARN=<arn>
   ```
2. **(Optional) custom domain:** deploy `deploy/cert-template.yaml` in **us-east-1** to get the ACM cert(s) for your
   main and sibling domains, then set `DOMAIN_NAME`, `CERTIFICATE_ARN`, `HOSTED_ZONE_ID`, and the `SIBLING_*` / `COOKIE_DOMAIN` vars.
3. **Deploy:**
   ```bash
   set -a; . ./.deploy-secrets; set +a   # gitignored; holds AWS_REGION, GITHUB_OAUTH_SECRET_ARN, domain/cert/zone vars …
   ./deploy/deploy.sh                     # builds dist/ (linux-x64 only) and runs `sam deploy`
   ```
   First deploy has no `BASE_URL` yet; grab the Function URL / site URL from the stack outputs, set `BASE_URL`
   (and your OAuth app's callback), and deploy again.

`deploy/build.sh` produces `dist/browser-tutor.zip` trimmed to the linux-x64 runtime (~184 MB unzipped; Lambda limit 250 MB).
Teardown: `sam delete --stack-name browser-tutor --region "$AWS_REGION"`. See `docs/HOSTING.md` for the cost notes
(designed to sit within a few dollars/month; a `$5/month` budget alert is recommended).

## Project layout

```
src/        server.mjs (routing, OAuth, sessions, origin lockdown, chat SSE), agent.mjs (SDK wiring, tools,
            refresh, sanitation), appsecrets.mjs, serverview.mjs, prompt.mjs, gotchas.mjs, demos.mjs
public/     static UI (index/app/demos/gotchas .html, probe.js, demos.js, chat.js, render.js, style.css)
deploy/     template.yaml (SAM), cert-template.yaml, build.sh, deploy.sh, run.sh
scripts/    unit-tests, injection-tests, e2e-*
docs/       HOSTING.md, RESEARCH.md, screenshots
```

## License

[MIT](LICENSE) © 2026 Manoj Kumar Sahukar. The GitHub Copilot SDK is MIT-licensed; its bundled runtime binary is **not**
committed here (installed via `npm`). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
