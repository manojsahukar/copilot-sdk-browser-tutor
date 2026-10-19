// Verifies the production auth path: shared runtime in "empty" mode with NO ambient auth,
// and the user's token passed per-session. Token comes from env TEST_USER_TOKEN and is never printed.
import { CopilotClient } from "@github/copilot-sdk";
const token = process.env.TEST_USER_TOKEN;
if (!token) { console.error("set TEST_USER_TOKEN"); process.exit(2); }
console.log("token prefix:", token.slice(0, 4));
const client = new CopilotClient({ mode: "empty", baseDirectory: "/tmp/bt-test-copilot", useLoggedInUser: false, logLevel: "error" });
const t0 = Date.now();
const session = await client.createSession({
  gitHubToken: token, availableTools: ["custom:*"], streaming: true,
  systemMessage: { mode: "replace", content: "You are terse." },
  tools: [{ name: "get_request_headers", description: "Return request headers", parameters: { type: "object", properties: {} }, skipPermission: true,
            handler: async () => ({ "user-agent": "Mozilla/5.0 test", "accept-language": "hi-IN" }) }],
  onPermissionRequest: (r) => r.kind === "custom-tool" ? { kind: "approve-once" } : { kind: "reject" },
});
console.log("session created in", Date.now() - t0, "ms");
let model; session.on("assistant.usage", (e) => { model = e.data.model; });
const r = await session.sendAndWait({ prompt: "Call get_request_headers and tell me the accept-language value in one line." }, 120000);
console.log("model:", model, "| reply:", r?.data?.content);
try { const q = await client.rpc.account.getQuota(); console.log("quota keys:", Object.keys(q || {})); } catch (e) { console.log("quota rpc:", e.message); }
await session.disconnect(); await client.stop();
