// Single source for app secrets. In AWS everything lives in the browser-tutor/github-oauth Secrets Manager JSON
// {client_id, client_secret, session_secret, origin_verify}; nothing secret is in Lambda env vars.
// Locally we fall back to env (SESSION_SECRET, ORIGIN_VERIFY, GITHUB_CLIENT_ID/SECRET).
let cached = null;
export async function appSecrets({ fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const arn = process.env.GITHUB_OAUTH_SECRET_ARN;
  if (arn) {
    const p = (async () => {
      const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
      const sm = new SecretsManagerClient({});
      const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
      const j = JSON.parse(r.SecretString || "{}");
      return { clientId: j.client_id || "", clientSecret: j.client_secret || "", sessionSecret: j.session_secret || "", originVerify: j.origin_verify || "" };
    })();
    if (fresh) return p; // readiness probe: real round-trip, never replaces the app's cached copy
    cached = p.catch((e) => { cached = null; throw e; });
    return cached;
  }
  return {
    clientId: process.env.GITHUB_CLIENT_ID || "", clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    sessionSecret: process.env.SESSION_SECRET || "", originVerify: process.env.ORIGIN_VERIFY || "",
  };
}
export const oauthConfigured = () => !!(process.env.GITHUB_OAUTH_SECRET_ARN || (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET));

// Exchange a refresh token for a fresh access+refresh pair (GitHub expiring OAuth tokens).
export async function refreshGitHubToken(refreshToken) {
  const { clientId, clientSecret } = await appSecrets();
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
  }).then((x) => x.json());
  if (!r.access_token) throw new Error("refresh failed: " + (r.error || "unknown"));
  return { token: r.access_token, refresh: r.refresh_token || refreshToken, expiresIn: r.expires_in || 8 * 3600 };
}
