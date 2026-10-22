# Third-party notices

This project depends on, and gratefully uses, the following third-party software.
Their license files are not vendored here; install dependencies to obtain them.

| Package | License | Notes |
|---|---|---|
| [`@github/copilot-sdk`](https://github.com/github/copilot-sdk) | MIT | Pins `@github/copilot-sdk-<platform>` runtime packages (a bundled native CLI, ~150 MB). The runtime binary is **not** committed to this repo; it is downloaded by `npm install`. |
| [`@aws-sdk/client-secrets-manager`](https://github.com/aws/aws-sdk-js-v3) | Apache-2.0 | Reads app secrets from AWS Secrets Manager at runtime. |
| [`marked`](https://github.com/markedjs/marked) | MIT | Vendored (self-hosted) at `public/vendor/marked.min.js` and served from `/static`; parses the tutor's Markdown in the browser. |
| [`DOMPurify`](https://github.com/cure53/DOMPurify) | Apache-2.0 OR MPL-2.0 | Vendored (self-hosted) v3.4.17 (npm `dompurify@3.4.17`, `dist/purify.min.js`, sha256 `cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31`) at `public/vendor/purify.min.js` and served from `/static`; sanitizes the rendered Markdown so model output cannot inject HTML/scripts. |
| [Apache ECharts](https://github.com/apache/echarts) (+ [ZRender](https://github.com/ecomfe/zrender)) | Apache-2.0 (ZRender: BSD-3-Clause) | Custom tree-shaken build vendored at `public/vendor/echarts.custom.min.js` (built by `scripts/build-echarts.sh`), lazy-loaded from `/static` to draw the observability widgets. Contains no `eval`/`new Function`. |
| [`@aws-sdk/client-cloudwatch`, `client-cloudwatch-logs`, `client-dynamodb`](https://github.com/aws/aws-sdk-js-v3) | Apache-2.0 | Read-only metrics (GetMetricData), allowlisted Logs Insights queries, telemetry/health table. |

Dev-only (not shipped to Lambda):

| Package | License |
|---|---|
| [`puppeteer-core`](https://github.com/puppeteer/puppeteer) | Apache-2.0 |

AWS infrastructure pieces referenced by the templates (Lambda Web Adapter layer, CloudFront managed
policies) are AWS-provided and governed by the AWS Customer Agreement.
