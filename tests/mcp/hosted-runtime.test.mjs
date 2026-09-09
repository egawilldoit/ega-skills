import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHubRelease } from "../../packages/project/dist/index.js";
import {
  createHostedMcpHandler,
  loadHostedReleaseSnapshot,
} from "../../packages/mcp/dist/index.js";

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-hosted-hub-"));
  const skillDir = join(hubDir, "owned", "ega", "alpha");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha hosted skill.\n---\n\nUse alpha when needed.\n");
  writeFileSync(join(skillDir, "ega.yaml"), "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - alpha\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: hosted-test\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

async function rpc(handler, id, method, params = {}) {
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: "http://localhost",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.match(/data: (.+)/)?.[1];
  return JSON.parse(data ?? text);
}

test("real HubRelease artifacts are accepted by the hosted MCP runtime", async () => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  const handler = createHostedMcpHandler(snapshot, {
    allowedOrigins: ["http://localhost"],
    verifyBearer: async (token) => {
      assert.equal(token, "test-token");
      return { subject: "user-1", scopes: ["ega:read"] };
    },
    authorize: async (_principal, tool, skillId) => {
      assert.ok(["search", "resolve", "inspect", "get_content"].includes(tool));
      return skillId === undefined || skillId === "ega/alpha";
    },
  });

  const listed = await rpc(handler, 1, "tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["search", "resolve", "inspect", "get_content"]);

  const searched = await rpc(handler, 2, "tools/call", { name: "search", arguments: { query: "alpha", limit: 5 } });
  assert.notEqual(searched.result.isError, true);
  assert.match(JSON.stringify(searched.result), /ega\/alpha/);

  const inspected = await rpc(handler, 3, "tools/call", { name: "inspect", arguments: { skill_id: "ega/alpha", release_digest: snapshot.releaseDigest } });
  assert.notEqual(inspected.result.isError, true);
  assert.match(JSON.stringify(inspected.result), /ega\/alpha/);

  const resolved = await rpc(handler, 4, "tools/call", { name: "resolve", arguments: { task: "alpha" } });
  assert.notEqual(resolved.result.isError, true);

  const content = await rpc(handler, 5, "tools/call", { name: "get_content", arguments: {
    skill_id: "ega/alpha",
    version_hash: build.skills.find((skill) => skill.skillId === "ega/alpha").versionHash,
    level: "L2",
    max_tokens: 1000,
    release_digest: snapshot.releaseDigest,
  } });
  assert.notEqual(content.result.isError, true);
  assert.match(JSON.stringify(content.result), /Use alpha when needed/);
});

test("hosted runtime rejects unauthenticated access before tool execution", async () => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  const handler = createHostedMcpHandler(snapshot, {
    verifyBearer: async () => { throw new Error("unreachable"); },
    authorize: async () => true,
  });
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }));
  assert.equal(response.status, 401);
  assert.match(await response.text(), /E_AUTH_REQUIRED/);
});
