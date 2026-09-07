import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createEnvelope, sha256Hex } from "../../packages/hashing/dist/index.js";
import { createHostedMcpHandler, createHostedRuntime } from "../../packages/mcp/dist/hosted.js";
import { createHostedOAuthVerifier } from "../../packages/mcp/dist/hosted-auth.js";
import {
  createHubRelease,
  createProjectContextArtifact,
  createReleasePackage,
  createReleaseFtsTable,
  deriveAliasMap,
  deriveSearchIndexInput,
  deriveTokenArtifact,
  hashNormalizedConfig,
  parseProjectConfig,
} from "../../packages/project/dist/index.js";
import {
  getCurrentVersionHash,
  importSkills,
  openRegistry,
} from "../../packages/registry/dist/index.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const RELEASE_CONTRACTS = {
  build_contract: "C1",
  hashing: 1,
  hub_contract: "A1",
  importer_build: 1,
  router: 1,
  schema: "v1.0.1",
  search: 1,
  token_estimator: "ega-o200k-v1",
  update_contract: "B1",
};

const roots = new Set();
test.after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixture(mixed = false) {
  const root = await mkdtemp(join(tmpdir(), "ega-hosted-runtime-"));
  roots.add(root);
  const home = join(root, "release");
  const source = join(root, "source");
  await mkdir(join(source, "alpha"), { recursive: true });
  await writeFile(
    join(source, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha hosted skill\n---\n\n# Alpha\n\nHosted guidance.\n",
  );
  if (mixed) {
    await mkdir(join(source, "beta"), { recursive: true });
    await writeFile(
      join(source, "beta", "SKILL.md"),
      "---\nname: beta\ndescription: Beta hosted skill\n---\n\n# Beta\n\nBeta guidance.\n",
    );
    await writeFile(join(source, "beta", "ega.yaml"), "schema_version: 1\ndomains: [engineering]\ntriggers: [beta hosted]\n");
  }
  await writeFile(join(source, "alpha", "ega.yaml"), "schema_version: 1\ndomains: [engineering]\ntriggers: [alpha hosted]\n");
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  try {
    const summary = await importSkills(registry, { path: source, namespace: "ega" });
    assert.equal(summary.failed, 0);
    const skillIds = mixed ? ["ega/alpha", "ega/beta"] : ["ega/alpha"];
    const versions = Object.fromEntries(skillIds.map((skillId) => [skillId, getCurrentVersionHash(registry.db, skillId)]));
    const skillId = "ega/alpha";
    const versionHash = versions[skillId];
    const build = {
      registryHome: home,
      skills: skillIds.map((id) => ({ skillId: id, versionHash: versions[id] })),
      hubId: "personal",
      adoptedSources: mixed ? [
        { sourceId: "source-a", sourceConfigDigest: `sha256:${"a".repeat(64)}`, resolvedCommit: "a".repeat(40), selectedSkillTreeDigest: `sha256:${"b".repeat(64)}`, vendoredSnapshotDigest: `sha256:${"c".repeat(64)}` },
        { sourceId: "source-b", sourceConfigDigest: `sha256:${"d".repeat(64)}`, resolvedCommit: "e".repeat(40), selectedSkillTreeDigest: `sha256:${"f".repeat(64)}`, vendoredSnapshotDigest: `sha256:${"0".repeat(64)}` },
      ] : [],
      skillSourceIds: mixed ? { "ega/alpha": "source-a", "ega/beta": "source-b" } : { "ega/alpha": null },
    };
    const artifacts = {
      aliasMap: deriveAliasMap(build),
      searchIndexInput: deriveSearchIndexInput(build),
      tokenArtifact: deriveTokenArtifact(build),
    };
    const release = createHubRelease(build, artifacts);
    const ftsTable = `release_fts_${release.digest.slice("sha256:".length)}`;
    createReleaseFtsTable(registry.db, ftsTable, artifacts.searchIndexInput.rows);
    registry.db.exec("CREATE TABLE ega_release_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    const metadata = registry.db.prepare("INSERT INTO ega_release_metadata (key, value) VALUES (?, ?)");
    metadata.run("alias_map_digest", release.payload.alias_map_digest);
    metadata.run("fts_table", ftsTable);
    metadata.run("hub_release_digest", release.digest);
    metadata.run("search_index_input_digest", release.payload.search_index_input_digest);
    metadata.run("token_artifact_digest", release.payload.token_artifact_digest);
    const sqliteArtifactDigest = `sha256:${sha256Hex(await readFile(join(home, "registry.sqlite")))}`;
    return {
      home,
      release,
      artifacts,
      releasePackage: createReleasePackage(release, sqliteArtifactDigest, skillIds.length),
      ftsTable,
      skillSourceIds: build.skillSourceIds,
      skillIds,
      versions,
      skillId,
      versionHash,
      sqliteArtifactDigest,
    };
  } finally {
    registry.close();
  }
}

function auth() {
  return async () => true;
}

function snapshot(value, release = value.release) {
  return {
    release,
    registryHome: value.home,
    sqliteArtifactDigest: value.sqliteArtifactDigest,
    releasePackage: value.releasePackage,
    artifacts: value.artifacts,
    ftsTable: value.ftsTable,
    skillSourceIds: value.skillSourceIds,
  };
}

function contextFor(value, contextId) {
  const config = parseProjectConfig("schema_version: 1\nrouting:\n  max_skills: 1\n");
  const lock = Object.freeze({
    lockfile_version: 1,
    token_estimator: "ega-o200k-v1",
    generated_from: Object.freeze({ config_hash: hashNormalizedConfig(config) }),
    skills: Object.freeze({
      [value.skillId]: Object.freeze({ name: "alpha", version_hash: value.versionHash }),
    }),
  });
  return {
    contextId,
    config,
    lock,
    context: createProjectContextArtifact({
      workspace_id: "workspace-test",
      project_id: "project-test",
      config,
      lock,
      release: value.release,
    }),
  };
}

function oauth() {
  return {
    issuer: "https://auth.example.test",
    resource: "https://mcp.example.test",
    authorizationEndpoint: "https://auth.example.test/oauth/authorize",
    tokenEndpoint: "https://auth.example.test/oauth/token",
    jwksUri: "https://auth.example.test/.well-known/jwks.json",
    scopesSupported: ["mcp"],
  };
}

function modernEnvelope() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "hosted-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function request(body, headers = {}) {
  return new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      host: "mcp.example.test",
      "mcp-method": body.method,
      ...(body.params?.name ? { "mcp-name": body.params.name } : {}),
      origin: "https://client.example.test",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("hosted runtime verifies a release and exposes the exact four personal tools", async () => {
  const value = await fixture();
  const runtime = createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    authorize: auth(),
  });
  assert.deepEqual(runtime.toolNames, ["resolve", "search", "inspect", "get_content"]);

  const search = await runtime.call("search", { query: "hosted" });
  assert.equal(search.isError, false);
  assert.equal(search.structuredContent.effective_release_digest, value.release.digest);
  assert.equal(search.structuredContent.project_context, "NONE");
  assert.equal(search.structuredContent.fingerprint_status, "NONE");
  assert.equal(search.structuredContent.results[0].skill_id, value.skillId);

  const resolved = await runtime.call("resolve", { task: "hosted" });
  assert.equal(resolved.isError, false);
  assert.equal(resolved.structuredContent.project_context, "NONE");
  assert.equal(resolved.structuredContent.fingerprint_status, "NONE");
  assert.equal(resolved.structuredContent.project_fingerprint.project_path, null);
  assert.equal(resolved.structuredContent.project_fingerprint.package_root, null);
  assert.equal(resolved.structuredContent.project_fingerprint.workspace_root, null);

  const inspected = await runtime.call("inspect", {
    skill_id: value.skillId,
    release_digest: value.release.digest,
  });
  assert.equal(inspected.isError, false);
  assert.equal(inspected.structuredContent.version_hash, value.versionHash);
  assert.equal(inspected.structuredContent.effective_release_digest, value.release.digest);

  const content = await runtime.call("get_content", {
    skill_id: value.skillId,
    version_hash: value.versionHash,
    level: "L2",
    max_tokens: 10000,
    release_digest: value.release.digest,
  });
  assert.equal(content.isError, false);
  assert.match(content.structuredContent.content, /Hosted guidance/);
});

test("hosted scope fails closed and never accepts a local project path", async () => {
  const value = await fixture();
  const runtime = createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    authorize: auth(),
  });
  const missingScope = await runtime.call("inspect", { skill_id: value.skillId });
  assert.equal(missingScope.isError, true);
  assert.equal(missingScope.structuredContent.error.code, "E_SCOPE_REQUIRED");
  const projectPath = await runtime.call("search", { query: "hosted", project_path: value.home });
  assert.equal(projectPath.isError, true);
  assert.equal(projectPath.structuredContent.error.code, "E_MCP_INPUT_INVALID");
  const wrongRelease = await runtime.call("inspect", {
    skill_id: value.skillId,
    release_digest: `sha256:${"f".repeat(64)}`,
  });
  assert.equal(wrongRelease.isError, true);
  assert.equal(wrongRelease.structuredContent.error.code, "E_RELEASE_NOT_FOUND");
  const missingContext = await runtime.call("search", { query: "hosted", context_id: "ctx-missing" });
  assert.equal(missingContext.structuredContent.error.code, "E_CONTEXT_NOT_FOUND");
});

test("hosted context selection binds exact lock/release and revocation has no fallback", async () => {
  const value = await fixture();
  const binding = contextFor(value, "ctx-main");
  let revoked = false;
  const runtime = createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    contexts: [binding],
    isContextRevoked: () => revoked,
    authorize: auth(),
  });
  const search = await runtime.call("search", { query: "hosted", context_id: binding.contextId });
  assert.equal(search.isError, false);
  assert.equal(search.structuredContent.project_context, binding.contextId);
  assert.equal(search.structuredContent.fingerprint_status, "MISSING");
  assert.deepEqual(search.structuredContent.results.map((row) => row.version_hash), [value.versionHash]);

  const resolved = await runtime.call("resolve", { task: "hosted", context_id: binding.contextId });
  assert.equal(resolved.isError, false);
  assert.equal(resolved.structuredContent.lock_status, "LOCKED");
  assert.equal(resolved.structuredContent.max_skills, 1);
  assert.equal(resolved.structuredContent.project_context, binding.contextId);

  const mismatch = await runtime.call("search", {
    query: "hosted",
    context_id: binding.contextId,
    release_digest: `sha256:${"f".repeat(64)}`,
  });
  assert.equal(mismatch.structuredContent.error.code, "E_CONTEXT_RELEASE_MISMATCH");
  revoked = true;
  const denied = await runtime.call("search", { query: "hosted", context_id: binding.contextId });
  assert.equal(denied.structuredContent.error.code, "E_CONTEXT_REVOKED");
});

test("authorization and emergency deny are checked before content delivery", async () => {
  const value = await fixture();
  const runtime = createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    authorize: async () => false,
  });
  const deniedAuth = await runtime.call("search", { query: "hosted" });
  assert.equal(deniedAuth.structuredContent.error.code, "E_AUTH_UNAUTHORIZED");

  const emergency = createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    authorize: auth(),
    denyPolicy: { releaseDigests: [value.release.digest] },
  });
  const deniedContent = await emergency.call("get_content", {
    skill_id: value.skillId,
    version_hash: value.versionHash,
    level: "L2",
    max_tokens: 10000,
    release_digest: value.release.digest,
  });
  assert.equal(deniedContent.structuredContent.error.code, "E_CONTENT_DENIED");

  let deny = undefined;
  const mutableEmergency = createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    authorize: auth(),
    denyPolicy: () => deny,
  });
  const initiallyAllowed = await mutableEmergency.call("search", { query: "hosted" });
  assert.equal(initiallyAllowed.isError, false);
  deny = { releaseDigests: [value.release.digest] };
  const deniedAfterReload = await mutableEmergency.call("search", { query: "hosted" });
  assert.equal(deniedAfterReload.structuredContent.error.code, "E_CONTENT_DENIED");
});

test("startup integrity requires SkillVersion source provenance when hosted", async () => {
  const value = await fixture(true);
  const incomplete = snapshot(value);
  delete incomplete.skillSourceIds;
  assert.throws(
    () => createHostedRuntime({
      releases: [incomplete],
      stableReleaseDigest: value.release.digest,
      authorize: auth(),
      denyPolicy: { sourceIds: ["source-b"] },
    }),
    (error) => error?.code === "E_STARTUP_INTEGRITY" && /source provenance/.test(error.message),
  );
});

test("startup integrity loads the emergency deny policy before readiness", async () => {
  const value = await fixture();
  assert.throws(
    () => createHostedRuntime({
      releases: [snapshot(value)],
      stableReleaseDigest: value.release.digest,
      authorize: auth(),
      denyPolicy: () => {
        throw new Error("deny store unavailable");
      },
    }),
    (error) => error?.code === "E_STARTUP_INTEGRITY" && /deny policy/.test(error.message),
  );
});

test("hosted authorization and deny policy are enforced for every concrete result", async () => {
  const value = await fixture(true);
  const runtime = createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    authorize: async ({ skillId }) => skillId !== "ega/beta",
    denyPolicy: { sourceIds: ["source-b"] },
  });
  const search = await runtime.call("search", { query: "hosted" });
  assert.equal(search.isError, false);
  assert.deepEqual(search.structuredContent.results.map((row) => row.skill_id), ["ega/alpha"]);
  assert.doesNotMatch(search.content[0].text, /beta/);

  const resolved = await runtime.call("resolve", { task: "hosted" });
  assert.equal(resolved.isError, false);
  for (const field of ["explicit", "selected", "candidates", "rejected"]) {
    assert.ok(!(resolved.structuredContent[field] ?? []).some((row) => row.id === "ega/beta"));
  }
  const inspected = await runtime.call("inspect", {
    skill_id: "ega/beta",
    version_hash: value.versions["ega/beta"],
    release_digest: value.release.digest,
  });
  assert.equal(inspected.structuredContent.error.code, "E_CONTENT_DENIED");
});

test("startup integrity fails closed when a release catalog does not match SQLite", async () => {
  const value = await fixture();
  const badRelease = createEnvelope({
    object_type: value.release.object_type,
    schema_version: value.release.schema_version,
    payload: { ...value.release.payload, skill_versions: {} },
  });
  assert.throws(
    () => createHostedRuntime({
      releases: [snapshot(value, badRelease)],
      stableReleaseDigest: badRelease.digest,
      authorize: auth(),
    }),
    (error) => error?.code === "E_STARTUP_INTEGRITY",
  );
});

test("startup integrity binds the exact SQLite artifact digest", async () => {
  const value = await fixture();
  assert.throws(
    () => createHostedRuntime({
      releases: [{ ...snapshot(value), sqliteArtifactDigest: `sha256:${"0".repeat(64)}` }],
      stableReleaseDigest: value.release.digest,
      authorize: auth(),
    }),
    (error) => error?.code === "E_STARTUP_INTEGRITY",
  );
});

test("hosted HTTP enforces transport gates and exposes only the four tools", async () => {
  const value = await fixture();
  const seenAuth = [];
  const runtime = createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    authorize: async (request) => {
      seenAuth.push(request.authInfo);
      return true;
    },
  });
  const handler = createHostedMcpHandler(runtime, {
    verifier: {
      verifyAccessToken: async (token) => ({
        token,
        clientId: "test-client",
        scopes: ["mcp"],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    },
    oauth: oauth(),
    allowedHosts: ["mcp.example.test"],
    allowedOrigins: ["https://client.example.test"],
    requiredScopes: ["mcp"],
  });
  try {
    const discovery = await handler.fetch(new Request("https://mcp.example.test/.well-known/oauth-protected-resource", {
      headers: { host: "mcp.example.test" },
    }));
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json()).authorization_servers, ["https://auth.example.test"]);

    const readiness = await handler.fetch(new Request("https://mcp.example.test/readyz", {
      headers: { host: "mcp.example.test" },
    }));
    assert.equal(readiness.status, 200);
    assert.equal((await readiness.json()).status, "ready");

    const noAuth = await handler.fetch(request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernEnvelope() } }));
    assert.equal(noAuth.status, 401);

    const badHost = await handler.fetch(request(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernEnvelope() } },
      { host: "evil.example.test", authorization: "Bearer valid" },
    ));
    assert.equal(badHost.status, 403);

    const badOrigin = await handler.fetch(request(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernEnvelope() } },
      { origin: "https://evil.example.test", authorization: "Bearer valid" },
    ));
    assert.equal(badOrigin.status, 403);

    const insecure = await handler.fetch(new Request("http://mcp.example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernEnvelope() } }),
    }));
    assert.equal(insecure.status, 403);

    const noOrigin = await handler.fetch(new Request("https://mcp.example.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
        host: "mcp.example.test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernEnvelope() } }),
    }));
    assert.equal(noOrigin.status, 403);

    const listed = await handler.fetch(request(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernEnvelope() } },
      { authorization: "Bearer valid" },
    ));
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.deepEqual(listedBody.result.tools.map((tool) => tool.name), ["resolve", "search", "inspect", "get_content"]);

    const called = await handler.fetch(request(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { _meta: modernEnvelope(), name: "search", arguments: { query: "hosted" } },
      },
      { authorization: "Bearer valid" },
    ));
    assert.equal(called.status, 200);
    const calledBody = await called.json();
    assert.equal(calledBody.result.structuredContent.effective_release_digest, value.release.digest);
    assert.equal(seenAuth.at(-1).clientId, "test-client");

    const constrained = createHostedMcpHandler(runtime, {
      verifier: {
        verifyAccessToken: async (token) => ({
          token,
          clientId: "test-client",
          scopes: ["mcp"],
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        }),
      },
      oauth: oauth(),
      allowedHosts: ["mcp.example.test"],
      allowedOrigins: ["https://client.example.test"],
      maxContentBytes: 1,
    });
    try {
      const oversizedContent = await constrained.fetch(request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          _meta: modernEnvelope(),
          name: "get_content",
          arguments: {
            skill_id: value.skillId,
            version_hash: value.versionHash,
            level: "L2",
            max_tokens: 10000,
            release_digest: value.release.digest,
          },
        },
      }, { authorization: "Bearer valid" }));
      assert.equal(oversizedContent.status, 413);
      assert.equal((await oversizedContent.json()).error.code, "E_CONTENT_LIMIT");
    } finally {
      await constrained.close();
    }
  } finally {
    await handler.close();
  }
});

test("hosted HTTP applies request, response, timeout, concurrency, and connection limits independently", async () => {
  const value = await fixture();
  const make = (limits = {}) => createHostedMcpHandler(createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    authorize: auth(),
  }), {
    verifier: { verifyAccessToken: async () => ({ token: "t", clientId: "c", scopes: ["mcp"], expiresAt: Math.floor(Date.now() / 1000) + 60 }) },
    oauth: oauth(),
    allowedHosts: ["mcp.example.test"],
    allowedOrigins: ["https://client.example.test"],
    ...limits,
  });
  const tooSmallRequest = make({ maxRequestBytes: 1 });
  try {
    const response = await tooSmallRequest.fetch(request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernEnvelope() } }, { authorization: "Bearer valid" }));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "E_REQUEST_LIMIT");
  } finally {
    await tooSmallRequest.close();
  }

  const tooSmallResponse = make({ maxResponseBytes: 1 });
  try {
    const response = await tooSmallResponse.fetch(request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernEnvelope() } }, { authorization: "Bearer valid" }));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "E_REQUEST_LIMIT");
  } finally {
    await tooSmallResponse.close();
  }

  // The SDK calls the runtime authorization seam during tool execution.
  let toolAborted = false;
  const timeoutHandler = createHostedMcpHandler(createHostedRuntime({
    releases: [snapshot(value)],
    stableReleaseDigest: value.release.digest,
    authorize: async ({ signal }) => {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25);
        signal?.addEventListener("abort", () => {
          toolAborted = true;
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return true;
    },
  }), {
    verifier: { verifyAccessToken: async () => ({ token: "t", clientId: "c", scopes: ["mcp"], expiresAt: Math.floor(Date.now() / 1000) + 60 }) },
    oauth: oauth(), allowedHosts: ["mcp.example.test"], allowedOrigins: ["https://client.example.test"], toolTimeoutMs: 5,
  });
  try {
    const timed = await timeoutHandler.fetch(request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernEnvelope(), name: "search", arguments: { query: "hosted" } } }, { authorization: "Bearer valid" }));
    assert.equal(timed.status, 200);
    assert.equal((await timed.json()).result.structuredContent.error.code, "E_REQUEST_LIMIT");
    assert.equal(toolAborted, true);
  } finally {
    await timeoutHandler.close();
  }

  const concurrentHandler = createHostedMcpHandler(createHostedRuntime({
    releases: [snapshot(value)], stableReleaseDigest: value.release.digest,
    authorize: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return true; },
  }), {
    verifier: { verifyAccessToken: async () => ({ token: "t", clientId: "c", scopes: ["mcp"], expiresAt: Math.floor(Date.now() / 1000) + 60 }) },
    oauth: oauth(), allowedHosts: ["mcp.example.test"], allowedOrigins: ["https://client.example.test"], maxConcurrentRequests: 1,
  });
  try {
    const calls = [1, 2].map((id) => concurrentHandler.fetch(request({ jsonrpc: "2.0", id, method: "tools/call", params: { _meta: modernEnvelope(), name: "search", arguments: { query: "hosted" } } }, { authorization: "Bearer valid" })));
    const results = await Promise.all(calls);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 429]);
    for (const response of results) if (response.status === 429) assert.equal((await response.json()).error.code, "E_REQUEST_LIMIT");
  } finally {
    await concurrentHandler.close();
  }

  let connectionCount = 0;
  const limited = make({ maxConcurrentRequests: 32, maxConnections: 1, getActiveConnections: () => connectionCount });
  try {
    connectionCount = 1;
    const rejected = await limited.fetch(request({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: modernEnvelope() } }, { authorization: "Bearer valid" }));
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).error.code, "E_REQUEST_LIMIT");
  } finally {
    await limited.close();
  }
});

test("hosted HTTP bounds unknown-length request streams before consuming them", async () => {
  const value = await fixture();
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(33));
      if (pulls >= 10) controller.close();
    },
  });
  const handler = createHostedMcpHandler(createHostedRuntime({
    releases: [snapshot(value)], stableReleaseDigest: value.release.digest, authorize: auth(),
  }), {
    verifier: { verifyAccessToken: async () => ({ token: "t", clientId: "c", scopes: ["mcp"], expiresAt: Math.floor(Date.now() / 1000) + 60 }) },
    oauth: oauth(), allowedHosts: ["mcp.example.test"], allowedOrigins: ["https://client.example.test"], maxRequestBytes: 32,
  });
  try {
    const response = await handler.fetch(new Request("https://mcp.example.test/mcp", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", host: "mcp.example.test", origin: "https://client.example.test", authorization: "Bearer valid" },
      body,
      duplex: "half",
    }));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "E_REQUEST_LIMIT");
    assert.ok(pulls < 10, `bounded reader consumed ${pulls} chunks`);
  } finally {
    await handler.close();
  }
});

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

test("hosted OAuth verifier validates issuer, resource, scope, expiry, and RSA signature", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const claims = encodeBase64Url(JSON.stringify({
    iss: "https://auth.example.test",
    aud: "https://mcp.example.test",
    sub: "user-1",
    client_id: "client-1",
    scope: "mcp",
    exp: Math.floor(Date.now() / 1000) + 60,
  }));
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput, "ascii");
  const signature = signer.sign(privateKey).toString("base64url");
  const token = `${signingInput}.${signature}`;
  let jwksReads = 0;
  let revocationChecks = 0;
  const verifier = createHostedOAuthVerifier({
    issuer: "https://auth.example.test",
    resource: "https://mcp.example.test",
    jwksUri: "https://auth.example.test/.well-known/jwks.json",
    requiredScopes: ["mcp"],
    isRevoked: () => {
      revocationChecks += 1;
      return false;
    },
    fetch: async () => {
      jwksReads += 1;
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", use: "sig" }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const authInfo = await verifier.verifyAccessToken(token);
  assert.equal(authInfo.clientId, "client-1");
  assert.deepEqual(authInfo.scopes, ["mcp"]);
  assert.equal(jwksReads, 1);
  assert.equal(revocationChecks, 1);
  const alteredSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  await assert.rejects(
    verifier.verifyAccessToken(`${signingInput}.${alteredSignature}`),
    /signature mismatch/,
  );
  assert.equal(revocationChecks, 1, "invalid signatures must not reach revocation lookup");
});
