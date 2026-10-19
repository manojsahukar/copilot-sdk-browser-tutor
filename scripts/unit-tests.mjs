// Fast, offline assertions for the security-critical invariants. Run: node scripts/unit-tests.mjs
import assert from "node:assert/strict";
import { clientOptions, permissionDecision, ALLOWED_TOOLS } from "../src/agent.mjs";

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ok -", name); };

console.log("gotcha 3: mode must be empty");
ok("empty mode is accepted", () => assert.equal(clientOptions({ mode: "empty", baseDirectory: "/tmp/x" }).mode, "empty"));
ok("copilot-cli mode is rejected", () => assert.throws(() => clientOptions({ mode: "copilot-cli" }), /only "empty" is allowed/));
ok("default/undefined mode is rejected", () => assert.throws(() => clientOptions({ baseDirectory: "/tmp/x" })));

console.log("gotcha 7: permission handler denies by default");
for (const t of ["get_browser_fingerprint", "get_request_headers", "get_gotchas", "run_demo"])
  ok(`allows custom tool ${t}`, () => assert.equal(permissionDecision({ kind: "custom-tool", toolName: t }).kind, "approve-once"));
ok("rejects unknown custom tool", () => assert.equal(permissionDecision({ kind: "custom-tool", toolName: "exec_shell" }).kind, "reject"));
ok("rejects shell kind", () => assert.equal(permissionDecision({ kind: "shell", toolName: "bash" }).kind, "reject"));
ok("rejects write kind", () => assert.equal(permissionDecision({ kind: "write", toolName: "write_file" }).kind, "reject"));
ok("rejects empty request", () => assert.equal(permissionDecision(undefined).kind, "reject"));
ok("allowlist has exactly 4 tools", () => assert.equal(ALLOWED_TOOLS.size, 4));

console.log(`\nALL UNIT TESTS PASSED (${pass})`);
