import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHubRelease } from "../../packages/project/dist/index.js";
import { createHostedMcpHandler, loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-hosted-context-auth-"));
  const skillDir = join(hubDir, "owned", "ega", "alpha");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha hosted skill.\n---\n\nUse alpha.\n");
  writeFileSync(join(skillDir, "ega.yaml"), "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - alpha\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: hosted-context-auth\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

async function rpc(handler, args) {
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inspect", arguments: args } }),
  }));
  assert.equal(response.status, 200);
  return response.text();
}

test("context resolver receives the authenticated principal", async () => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  let observed;
  const handler = createHostedMcpHandler(snapshot, {
    verifyBearer: async () => ({ subject: "user-a", scopes: ["ega:read"] }),
    authorize: async () => true,
    resolveContext: async (contextId, principal) => {
      observed = { contextId, subject: principal?.subject };
      return snapshot;
    },
  });

  await rpc(handler, { skill_id: "ega/alpha", context_id: "ctx-a" });
  assert.deepEqual(observed, { contextId: "ctx-a", subject: "user-a" });
});
