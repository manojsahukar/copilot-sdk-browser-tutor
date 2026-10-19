# Third-party notices

This project depends on, and gratefully uses, the following third-party software.
Their license files are not vendored here; install dependencies to obtain them.

| Package | License | Notes |
|---|---|---|
| [`@github/copilot-sdk`](https://github.com/github/copilot-sdk) | MIT | Pins `@github/copilot-sdk-<platform>` runtime packages (a bundled native CLI, ~150 MB). The runtime binary is **not** committed to this repo; it is downloaded by `npm install`. |
| [`@aws-sdk/client-secrets-manager`](https://github.com/aws/aws-sdk-js-v3) | Apache-2.0 | Reads app secrets from AWS Secrets Manager at runtime. |

Dev-only (not shipped to Lambda):

| Package | License |
|---|---|
| [`puppeteer-core`](https://github.com/puppeteer/puppeteer) | Apache-2.0 |

AWS infrastructure pieces referenced by the templates (Lambda Web Adapter layer, CloudFront managed
policies) are AWS-provided and governed by the AWS Customer Agreement.
