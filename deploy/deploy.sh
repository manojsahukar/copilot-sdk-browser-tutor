#!/usr/bin/env bash
# Deploys Browser Tutor. All secrets live in one Secrets Manager secret; nothing secret goes into Lambda env vars.
#
# One-time: create the secret with your GitHub OAuth app creds, a session secret and an origin-verify secret:
#   aws secretsmanager create-secret --name browser-tutor/github-oauth --region "$AWS_REGION" \
#     --secret-string "$(jq -n --arg ci "$GITHUB_CLIENT_ID" --arg cs "$GITHUB_CLIENT_SECRET" \
#       --arg ss "$(openssl rand -hex 32)" --arg ov "$(openssl rand -hex 32)" \
#       '{client_id:$ci, client_secret:$cs, session_secret:$ss, origin_verify:$ov}')"
#   export GITHUB_OAUTH_SECRET_ARN=<arn printed above>
#
# Later deploys: set -a; . ./.deploy-secrets; set +a; ./deploy/deploy.sh
#   .deploy-secrets (gitignored, mode 600) holds: AWS_REGION, AWS_ACCOUNT_ID, GITHUB_OAUTH_SECRET_ARN, BASE_URL,
#   DOMAIN_NAME, CERTIFICATE_ARN, HOSTED_ZONE_ID, ALLOWED_LOGINS, SIBLING_DOMAIN_NAME, SIBLING_CERTIFICATE_ARN, COOKIE_DOMAIN.
set -euo pipefail
cd "$(dirname "$0")/.."
AWS_REGION="${AWS_REGION:-ap-south-1}"
: "${GITHUB_OAUTH_SECRET_ARN:?set GITHUB_OAUTH_SECRET_ARN (see header; the secret holds client id/secret, session_secret, origin_verify)}"

# Optional guard: only deploy to the intended account.
if [ -n "${AWS_ACCOUNT_ID:-}" ]; then
  test "$(aws sts get-caller-identity --query Account --output text)" = "$AWS_ACCOUNT_ID" || { echo "wrong AWS account"; exit 1; }
fi

# Read origin_verify from the secret so CloudFront and the app share the same value.
ORIGIN_VERIFY="$(aws secretsmanager get-secret-value --secret-id "$GITHUB_OAUTH_SECRET_ARN" --region "$AWS_REGION" \
  --query SecretString --output text | jq -r '.origin_verify // empty')"
: "${ORIGIN_VERIFY:?secret JSON must contain origin_verify (openssl rand -hex 32); also ensure session_secret is set}"

./deploy/build.sh
sam deploy \
  --template-file deploy/template.yaml \
  --stack-name browser-tutor \
  --region "$AWS_REGION" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --tags project=browser-tutor \
  --parameter-overrides \
    GitHubOAuthSecretArn="$GITHUB_OAUTH_SECRET_ARN" \
    OriginVerify="$ORIGIN_VERIFY" \
    ${ORIGIN_VERIFY_ENFORCE:+OriginVerifyEnforce="$ORIGIN_VERIFY_ENFORCE"} \
    ${BASE_URL:+BaseUrl="$BASE_URL"} \
    ${ALLOWED_LOGINS:+AllowedLogins="$ALLOWED_LOGINS"} \
    ${DOMAIN_NAME:+DomainName="$DOMAIN_NAME"} \
    ${CERTIFICATE_ARN:+CertificateArn="$CERTIFICATE_ARN"} \
    ${HOSTED_ZONE_ID:+HostedZoneId="$HOSTED_ZONE_ID"} \
    ${SIBLING_DOMAIN_NAME:+SiblingDomainName="$SIBLING_DOMAIN_NAME"} \
    ${SIBLING_CERTIFICATE_ARN:+SiblingCertificateArn="$SIBLING_CERTIFICATE_ARN"} \
    ${LAB_DOMAIN_NAME:+LabDomainName="$LAB_DOMAIN_NAME"} \
    ${LAB_CERTIFICATE_ARN:+LabCertificateArn="$LAB_CERTIFICATE_ARN"} \
    ${COOKIE_DOMAIN:+CookieDomain="$COOKIE_DOMAIN"}
aws cloudformation describe-stacks --stack-name browser-tutor --region "$AWS_REGION" --query 'Stacks[0].Outputs' --output table
# Teardown: sam delete --stack-name browser-tutor --region "$AWS_REGION"
