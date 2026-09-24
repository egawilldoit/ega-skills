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
  const hubDir = mkdtempSync(join(tmpdir(), "ega-hosted-deny-"));
  for (const name of ["alpha", "beta"]) {
    const skillDir = join(hubDir, "owned", "ega", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} hosted skill.\n---\n\nUse ${name} when needed.\n`);
    writeFileSync(join(skillDir, "ega.yaml"), `schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - ${name}\n`);
  }
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: hosted-deny\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
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

function bodyOf(response) {
  const result = response.result;
  const structured = result?.structuredContent;
  const text = JSON.stringify(result ?? response);
  return { result, structured, text };
}

test("hosted resolve removes emergency-denied skills from every payload field", async () => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  const handler = createHostedMcpHandler(snapshot, {
    allowedOrigins: ["http://localhost"],
    verifyBearer: async () => ({ subject: "user-1", scopes: ["ega:read"] }),
    authorize: async () => true,
    deniedSkills: new Set(["ega/alpha"]),
  });

  const searched = await rpc(handler, 1, "tools/call", { name: "search", arguments: { query: "alpha", limit: 20 } });
  assert.notEqual(searched.result.isError, true);
  assert.doesNotMatch(JSON.stringify(searched.result), /ega\/alpha/);

  const resolved = await rpc(handler, 2, "tools/call", { name: "resolve", arguments: { task: "alpha" } });
  const { structured, text } = bodyOf(resolved);
  assert.notEqual(resolved.result.isError, true, text);
  assert.deepEqual(structured.result.selected, []);
  for (const field of ["selected", "candidates", "rejected", "explicit"]) {
    assert.ok(
      structured.result[field].every((entry) => entry.id !== "ega/alpha"),
      `denied skill leaked through resolve.${field}`,
    );
  }
  assert.doesNotMatch(text, /ega\/alpha/, "denied skill leaked through the resolve payload");

  const allowCase = await rpc(handler, 3, "tools/call", { name: "resolve", arguments: { task: "beta" } });
  assert.notEqual(allowCase.result.isError, true);
  assert.match(JSON.stringify(allowCase.result), /ega\/beta/);
});

test("hosted resolve removes authorization-denied skills from every payload field", async () => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  const handler = createHostedMcpHandler(snapshot, {
    allowedOrigins: ["http://localhost"],
    verifyBearer: async () => ({ subject: "user-1", scopes: ["ega:read"] }),
    authorize: async (_principal, _tool, skillId) => skillId !== "ega/alpha",
  });

  const resolved = await rpc(handler, 1, "tools/call", { name: "resolve", arguments: { task: "alpha" } });
  const { structured, text } = bodyOf(resolved);
  assert.notEqual(resolved.result.isError, true, text);
  assert.doesNotMatch(text, /ega\/alpha/, "denied skill leaked through the resolve payload");
  assert.deepEqual(structured.result.selected, []);
});

test("hosted explicit skill requests cannot bypass a deny", async () => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  const handler = createHostedMcpHandler(snapshot, {
    allowedOrigins: ["http://localhost"],
    verifyBearer: async () => ({ subject: "user-1", scopes: ["ega:read"] }),
    authorize: async (_principal, _tool, skillId) => skillId !== "ega/alpha",
    deniedSkills: new Set(["ega/alpha"]),
  });

  const resolved = await rpc(handler, 1, "tools/call", {
    name: "resolve",
    arguments: { task: "alpha", explicit_skills: ["ega/alpha"] },
  });
  assert.equal(resolved.result.isError, true, JSON.stringify(resolved.result));
  assert.doesNotMatch(JSON.stringify(resolved.result.structuredContent ?? {}), /"selected":\[/);

  const content = await rpc(handler, 2, "tools/call", {
    name: "get_content",
    arguments: {
      skill_id: "ega/alpha",
      version_hash: build.skills.find((skill) => skill.skillId === "ega/alpha").versionHash,
      level: "L2",
      max_tokens: 1000,
      release_digest: snapshot.releaseDigest,
    },
  });
  assert.equal(content.result.isError, true);
  assert.doesNotMatch(JSON.stringify(content.result), /Use alpha when needed/);
});
