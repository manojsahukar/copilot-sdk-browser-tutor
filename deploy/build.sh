#!/usr/bin/env bash
# Builds dist/browser-tutor.zip for Lambda (linux-x64, Node 22 runtime). Local only; no AWS calls.
set -euo pipefail
cd "$(dirname "$0")/.."
# Regenerate the widget's static site index so the shipped site-index.json is always current.
node scripts/build-site-index.mjs public/widget --base /widget/ --out public/widget/site-index.json
rm -rf dist && mkdir -p dist/pkg
cp -r src public package.json package-lock.json dist/pkg/
cp deploy/run.sh dist/pkg/run.sh
( cd dist/pkg && npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc --no-audit --no-fund >/dev/null )
# keep only the linux-x64 glibc runtime package
find dist/pkg/node_modules/@github -maxdepth 1 -name 'copilot-sdk-*' ! -name 'copilot-sdk-linux-x64' -exec rm -rf {} +
chmod 755 dist/pkg/run.sh
( cd dist/pkg && zip -qr -y ../browser-tutor.zip . )
echo "unzipped: $(du -sh dist/pkg | cut -f1)  zip: $(du -sh dist/browser-tutor.zip | cut -f1)  (Lambda limit 250 MB unzipped)"
