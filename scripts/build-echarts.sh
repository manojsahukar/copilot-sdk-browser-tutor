#!/usr/bin/env bash
# Rebuild the vendored chart library. Pinned: echarts 5.6.0 (Apache-2.0), esbuild 0.24.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"
cd "$T" && npm init -y >/dev/null && npm i --no-audit --no-fund echarts@5.6.0 esbuild@0.24 >/dev/null
cp "$ROOT/scripts/echarts-entry.mjs" entry.mjs
npx esbuild entry.mjs --bundle --minify --format=iife --target=es2019 --legal-comments=none --banner:js="/*! Apache ECharts 5.6.0 (Apache-2.0) + ZRender (BSD-3-Clause), custom build. Licenses: /static/vendor/echarts.LICENSE.txt */" --outfile="$ROOT/public/vendor/echarts.custom.min.js"
{ cat node_modules/echarts/LICENSE; echo; echo "==== echarts NOTICE ===="; cat node_modules/echarts/NOTICE; echo; echo "==== zrender LICENSE ===="; cat node_modules/zrender/LICENSE; } > "$ROOT/public/vendor/echarts.LICENSE.txt"
if grep -E "new Function|[^a-zA-Z_.]eval\(" "$ROOT/public/vendor/echarts.custom.min.js"; then echo "eval found!"; exit 1; fi
ls -la "$ROOT/public/vendor/echarts.custom.min.js"; gzip -9c "$ROOT/public/vendor/echarts.custom.min.js" | wc -c
