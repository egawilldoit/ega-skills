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

function makeHub(name, skill) {
  const hubDir = mkdtempSync(join(tmpdir(), `ega-hosted-${name}-`));
  const skillDir = join(hubDir, "owned", "ega", skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill} skill for release ${name}.\n---\n\nUse ${skill} from ${name}.\n`);
  writeFileSync(join(skillDir, "ega.yaml"), `schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - ${skill}\n`);
  writeFileSync(join(hubDir, "hub.yaml"), `schema_version: 1\nhub:\n  id: ${name}\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n`);
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

const r1 = await buildHubRelease(makeHub("release-one", "alpha"));
const r2 = await buildHubRelease(makeHub("release-two", "beta"));
const s1 = loadHostedReleaseSnapshot(r1.registryHome);
const s2 = loadHostedReleaseSnapshot(r2.registryHome);
const betaHash = r2.skills.find((skill) => skill.skillId === "ega/beta").versionHash;

async function rpc(handler, name, args) {
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.match(/data: (.+)/)?.[1];
  return JSON.parse(data ?? text).result;
}

function makeHandler(overrides = {}) {
  return createHostedMcpHandler(s1, {
    verifyBearer: async () => ({ subject: "user-a", scopes: ["ega:read"] }),
    authorize: async () => true,
    resolveContext: async (contextId) => {
      if (contextId !== "ctx-r2") throw new Error("unknown context");
      return s2;
    },
    ...overrides,
  });
}

test("conflicting context and release digest fail closed for all four tools", async () => {
  const handler = makeHandler();
  const conflicting = { context_id: "ctx-r2", release_digest: s1.releaseDigest };

  const searched = await rpc(handler, "search", { query: "beta", ...conflicting });
  assert.equal(searched.isError, true, JSON.stringify(searched));
  assert.doesNotMatch(JSON.stringify(searched), /Use beta from release-two/);

  const resolved = await rpc(handler, "resolve", { task: "beta", ...conflicting });
  assert.equal(resolved.isError, true, JSON.stringify(resolved));

  const inspected = await rpc(handler, "inspect", { skill_id: "ega/beta", ...conflicting });
  assert.equal(inspected.isError, true, JSON.stringify(inspected));

  const content = await rpc(handler, "get_content", {
    skill_id: "ega/beta",
    version_hash: betaHash,
    level: "L2",
    max_tokens: 1000,
    ...conflicting,
  });
  assert.equal(content.isError, true, JSON.stringify(content));
  assert.doesNotMatch(JSON.stringify(content), /Use beta from release-two/);
});

test("context is resolved exactly once per request", async () => {
  let lookups = 0;
  const handler = makeHandler({
    resolveContext: async (contextId) => {
      lookups += 1;
      if (contextId !== "ctx-r2") throw new Error("unknown context");
      return s2;
    },
  });

  const resolved = await rpc(handler, "resolve", { task: "beta", context_id: "ctx-r2" });
  assert.notEqual(resolved.isError, true, JSON.stringify(resolved));
  assert.equal(lookups, 1, "resolve must not resolve the context twice");

  lookups = 0;
  const searched = await rpc(handler, "search", { query: "beta", context_id: "ctx-r2" });
  assert.notEqual(searched.isError, true, JSON.stringify(searched));
  assert.equal(lookups, 1, "search must not resolve the context twice");
});

test("context requests use the context release for search and resolve", async () => {
  const handler = makeHandler();

  const searched = await rpc(handler, "search", { query: "beta", limit: 20, context_id: "ctx-r2" });
  assert.notEqual(searched.isError, true, JSON.stringify(searched));
  assert.match(JSON.stringify(searched), /ega\/beta/);
  assert.doesNotMatch(JSON.stringify(searched), /ega\/alpha/);
  assert.equal(searched.structuredContent.result.effective_release_digest, s2.releaseDigest);

  const resolved = await rpc(handler, "resolve", { task: "beta", context_id: "ctx-r2" });
  assert.notEqual(resolved.isError, true, JSON.stringify(resolved));
  assert.equal(resolved.structuredContent.result.effective_release_digest, s2.releaseDigest);
});

test("pinned inspect and get_content use the context release, not the startup release", async () => {
  const handler = makeHandler();

  const inspected = await rpc(handler, "inspect", { skill_id: "ega/beta", context_id: "ctx-r2" });
  assert.notEqual(inspected.isError, true, JSON.stringify(inspected));
  assert.match(JSON.stringify(inspected), /ega\/beta/);

  const content = await rpc(handler, "get_content", {
    skill_id: "ega/beta",
    version_hash: betaHash,
    level: "L2",
    max_tokens: 1000,
    context_id: "ctx-r2",
  });
  assert.notEqual(content.isError, true, JSON.stringify(content));
  assert.match(JSON.stringify(content), /Use beta from release-two/);
});

test("an explicit release digest resolves the exact release through the loader", async () => {
  const handler = makeHandler({
    resolveRelease: async (digest) => {
      if (digest === s1.releaseDigest) return s1;
      if (digest === s2.releaseDigest) return s2;
      throw new Error("unknown release");
    },
  });

  const searched = await rpc(handler, "search", { query: "beta", release_digest: s2.releaseDigest });
  assert.notEqual(searched.isError, true, JSON.stringify(searched));
  assert.match(JSON.stringify(searched), /ega\/beta/);
  assert.equal(searched.structuredContent.result.effective_release_digest, s2.releaseDigest);

  const inspected = await rpc(handler, "inspect", { skill_id: "ega/beta", release_digest: s2.releaseDigest });
  assert.notEqual(inspected.isError, true, JSON.stringify(inspected));

  const content = await rpc(handler, "get_content", {
    skill_id: "ega/beta",
    version_hash: betaHash,
    level: "L2",
    max_tokens: 1000,
    release_digest: s2.releaseDigest,
  });
  assert.notEqual(content.isError, true, JSON.stringify(content));
  assert.match(JSON.stringify(content), /Use beta from release-two/);
});

test("an exact-release loader returning a different snapshot fails closed", async () => {
  const handler = makeHandler({
    resolveRelease: async () => s1,
  });
  const searched = await rpc(handler, "search", { query: "beta", release_digest: s2.releaseDigest });
  assert.equal(searched.isError, true, JSON.stringify(searched));
});

test("an unavailable context never falls back to the startup release", async () => {
  const handler = createHostedMcpHandler(s1, {
    verifyBearer: async () => ({ subject: "user-a", scopes: ["ega:read"] }),
    authorize: async () => true,
  });
  const searched = await rpc(handler, "search", { query: "alpha", context_id: "ctx-r2" });
  assert.equal(searched.isError, true, JSON.stringify(searched));
  assert.doesNotMatch(JSON.stringify(searched), /ega\/alpha/);

  const rejecting = makeHandler({
    resolveContext: async () => {
      throw new Error("context revoked");
    },
  });
  const rejected = await rpc(rejecting, "search", { query: "alpha", context_id: "ctx-r2" });
  assert.equal(rejected.isError, true, JSON.stringify(rejected));
  assert.doesNotMatch(JSON.stringify(rejected), /ega\/alpha/);
});

test("unpinned requests still use the stable release exactly once", async () => {
  let stableLookups = 0;
  const handler = makeHandler({
    resolveStableRelease: async () => {
      stableLookups += 1;
      return s1;
    },
  });

  const resolved = await rpc(handler, "resolve", { task: "alpha" });
  assert.notEqual(resolved.isError, true, JSON.stringify(resolved));
  assert.equal(stableLookups, 1);
  assert.equal(resolved.structuredContent.result.effective_release_digest, s1.releaseDigest);

  const searched = await rpc(handler, "search", { query: "alpha" });
  assert.notEqual(searched.isError, true, JSON.stringify(searched));
  assert.equal(stableLookups, 2);
  assert.match(JSON.stringify(searched), /ega\/alpha/);
});
