// Frozen hosted tool error codes and deny-classification ordering.
//
// Two regressions covered here:
// 1. `errorResult` must preserve context-layer codes (McpContextError), not
//    collapse them to E_RUNTIME_UNAVAILABLE.
// 2. Authorization must precede deny classification: an authenticated but
//    unauthorized principal must not be able to tell a denied skill from a
//    nonexistent one (both answer E_UNAUTHORIZED).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHubRelease } from "../../packages/project/dist/index.js";
import { createHostedMcpHandler, loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-hosted-codes-"));
  for (const name of ["alpha", "beta"]) {
    const skillDir = join(hubDir, "owned", "ega", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} hosted skill.\n---\n\nUse ${name} when needed.\n`);
    writeFileSync(join(skillDir, "ega.yaml"), `schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - ${name}\n`);
  }
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: hosted-codes\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

async function rpc(handler, id, method, params = {}, token = "test-token") {
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
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

function errorCode(call) {
  const text = call.result?.content?.find((part) => part.type === "text")?.text;
  assert.equal(typeof text, "string", "error result must carry a text envelope");
  const envelope = JSON.parse(text);
  assert.equal(typeof envelope?.error?.code, "string", "error envelope must carry a string code");
  return envelope.error.code;
}

test("hosted get_content preserves frozen context error codes", async () => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  const versionHash = build.skills.find((skill) => skill.skillId === "ega/alpha").versionHash;
  const handler = createHostedMcpHandler(snapshot, {
    allowedOrigins: ["http://localhost"],
    verifyBearer: async () => ({ subject: "user-1", scopes: ["ega:read"] }),
    authorize: async () => true,
  });

  const base = {
    skill_id: "ega/alpha",
    version_hash: versionHash,
    level: "L2",
    max_tokens: 1000,
    release_digest: snapshot.releaseDigest,
  };

  let id = 0;
  for (const filePath of ["hub-release.json", "../hub-release.json", "references/unknown.md"]) {
    id += 1;
    const call = await rpc(handler, id, "tools/call", { name: "get_content", arguments: { ...base, file_path: filePath } });
    assert.equal(call.result.isError, true, `${filePath} must fail`);
    assert.equal(errorCode(call), "E_CONTENT_FILE_UNKNOWN", `${filePath} must keep the frozen context code`);
  }

  id += 1;
  const valid = await rpc(handler, id, "tools/call", { name: "get_content", arguments: base });
  assert.notEqual(valid.result.isError, true);
  assert.equal(valid.result.structuredContent.result.version_hash, versionHash);
  assert.match(valid.result.structuredContent.result.content, /Use alpha when needed/);
});

test("authorization precedes deny classification for unauthorized principals", async () => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  const versionHash = build.skills.find((skill) => skill.skillId === "ega/alpha").versionHash;
  const handler = createHostedMcpHandler(snapshot, {
    allowedOrigins: ["http://localhost"],
    verifyBearer: async () => ({ subject: "unauthorized-user", scopes: [] }),
    authorize: async () => false,
    deniedSkills: new Set(["ega/alpha"]),
  });

  const denied = await rpc(handler, 1, "tools/call", {
    name: "get_content",
    arguments: { skill_id: "ega/alpha", version_hash: versionHash, level: "L2", max_tokens: 1000, release_digest: snapshot.releaseDigest },
  });
  const nonexistent = await rpc(handler, 2, "tools/call", {
    name: "get_content",
    arguments: { skill_id: "ega/does-not-exist", version_hash: versionHash, level: "L2", max_tokens: 1000, release_digest: snapshot.releaseDigest },
  });

  assert.equal(denied.result.isError, true);
  assert.equal(nonexistent.result.isError, true);
  assert.equal(errorCode(denied), "E_UNAUTHORIZED");
  assert.equal(errorCode(nonexistent), "E_UNAUTHORIZED");
  assert.equal(errorCode(denied), errorCode(nonexistent), "denied and nonexistent skills must be indistinguishable");
  assert.doesNotMatch(JSON.stringify(denied.result), /Use alpha when needed/);
});

test("authorized principals still see deny classification", async () => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  const versionHash = build.skills.find((skill) => skill.skillId === "ega/alpha").versionHash;
  const handler = createHostedMcpHandler(snapshot, {
    allowedOrigins: ["http://localhost"],
    verifyBearer: async () => ({ subject: "authorized-user", scopes: ["ega:read"] }),
    authorize: async () => true,
    deniedSkills: new Set(["ega/alpha"]),
  });

  const denied = await rpc(handler, 1, "tools/call", {
    name: "get_content",
    arguments: { skill_id: "ega/alpha", version_hash: versionHash, level: "L2", max_tokens: 1000, release_digest: snapshot.releaseDigest },
  });
  assert.equal(denied.result.isError, true);
  assert.equal(errorCode(denied), "E_CONTENT_REVOKED");

  const allowed = await rpc(handler, 2, "tools/call", {
    name: "get_content",
    arguments: { skill_id: "ega/beta", version_hash: build.skills.find((skill) => skill.skillId === "ega/beta").versionHash, level: "L2", max_tokens: 1000, release_digest: snapshot.releaseDigest },
  });
  assert.notEqual(allowed.result.isError, true);
  assert.match(allowed.result.structuredContent.result.content, /Use beta when needed/);
});
