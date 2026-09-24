// Semantic parity across protocol eras — Agent B task B7.
//
// ONE deterministic fixture, ONE built artifact, two SDK sessions (2025-era
// stdio and 2026-07-28 stdio). Wire envelopes differ by design (the 2025 codec
// wraps `structuredContent` under `.result`; the 2026 codec does not), but the
// PRODUCT results must be identical: skill ID, version hash, search hits,
// resolve result, inspect identity, get_content bytes, structured error code,
// and release identity.

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildEraArtifact, COMPANION_BODY, COMPANION_PATH, SKILL_BODY, SKILL_CORE, SKILL_ID } from "./helpers/era-fixture.mjs";
import {
  createStdioTransport,
  EraClient,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  productResult,
} from "./helpers/sdk-era-client.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "bin", "ega-mcp.mjs");

async function connectEra(t, era, artifactDir) {
  const transport = createStdioTransport({
    bin: BIN,
    cwd: REPO_ROOT,
    env: { ...process.env, EGA_SKILLS_HOME: artifactDir },
  });
  const client = new EraClient({
    supportedProtocolVersions: [era === "modern" ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION],
  });
  await client.connect(transport);
  if (era === "modern") await client.negotiateModernOnly();
  else await client.initializeLegacy();
  t.after(async () => {
    await client.close().catch(() => {});
    transport.child.kill();
  });
  return { client, transport };
}

async function call(client, name, args) {
  return client.request({ method: "tools/call", params: { name, arguments: args } });
}

function errorEnvelope(result) {
  const product = productResult(result);
  return {
    isError: result.isError === true,
    code: product?.error?.code,
  };
}

async function snapshotEra(client, artifactDir, versionHash) {
  const base = { project_path: artifactDir };

  const search = productResult(await call(client, "search", { query: "alpha", ...base }));
  const resolve = productResult(await call(client, "resolve", {
    task: "alpha",
    explicit_skills: [SKILL_ID],
    ...base,
  }));
  const inspect = productResult(await call(client, "inspect", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    ...base,
  }));
  const l2 = productResult(await call(client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L2",
    max_tokens: 4000,
    ...base,
  }));
  const l1 = productResult(await call(client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L1",
    max_tokens: 4000,
    ...base,
  }));
  const companion = productResult(await call(client, "get_content", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    level: "L2",
    max_tokens: 4000,
    file_path: COMPANION_PATH,
    ...base,
  }));

  const errors = {};
  const errorCases = {
    unknown_skill: { name: "inspect", arguments: { skill_id: "ega/ghost", ...base } },
    wrong_version_hash: {
      name: "get_content",
      arguments: {
        skill_id: SKILL_ID,
        version_hash: `sha256:${"ee".repeat(32)}`,
        level: "L2",
        max_tokens: 4000,
        ...base,
      },
    },
    unknown_file: {
      name: "get_content",
      arguments: {
        skill_id: SKILL_ID,
        version_hash: versionHash,
        level: "L2",
        max_tokens: 4000,
        file_path: "references/ghost.md",
        ...base,
      },
    },
    forbidden_file: {
      name: "get_content",
      arguments: {
        skill_id: SKILL_ID,
        version_hash: versionHash,
        level: "L2",
        max_tokens: 4000,
        file_path: "SKILL.md",
        ...base,
      },
    },
    traversal_file: {
      name: "get_content",
      arguments: {
        skill_id: SKILL_ID,
        version_hash: versionHash,
        level: "L2",
        max_tokens: 4000,
        file_path: "../hub-release.json",
        ...base,
      },
    },
    token_budget: {
      name: "get_content",
      arguments: {
        skill_id: SKILL_ID,
        version_hash: versionHash,
        level: "L2",
        max_tokens: 1,
        ...base,
      },
    },
    missing_project: { name: "search", arguments: { query: "alpha", project_path: "/definitely/not/here" } },
  };
  for (const [label, args] of Object.entries(errorCases)) {
    errors[label] = errorEnvelope(await call(client, args.name, args.arguments));
  }

  return { search, resolve, inspect, l2, l1, companion, errors };
}

function withoutVolatileResolveFields(resolve) {
  const { resolution_id: _resolutionId, ...stable } = resolve;
  return stable;
}

test("B7 legacy vs modern product results are identical for one deterministic artifact", async (t) => {
  const fixture = await buildEraArtifact();
  t.after(() => {
    rmSync(fixture.hubDir, { recursive: true, force: true });
    rmSync(fixture.artifactDir, { recursive: true, force: true });
  });
  const { versionHash, releaseDigest, artifactPaths } = fixture;
  assert.equal(versionHash, fixture.release.payload.skill_versions[SKILL_ID]);

  const legacy = await connectEra(t, "legacy", fixture.artifactDir);
  const modern = await connectEra(t, "modern", fixture.artifactDir);

  const legacyProducts = await snapshotEra(legacy.client, fixture.artifactDir, versionHash);
  const modernProducts = await snapshotEra(modern.client, fixture.artifactDir, versionHash);

  // Skill ID + version hash are identical and bound to the release artifact.
  for (const products of [legacyProducts, modernProducts]) {
    assert.equal(products.search.results[0].skill_id, SKILL_ID);
    assert.equal(products.search.results[0].version_hash, versionHash);
    assert.equal(products.inspect.skill_id, SKILL_ID);
    assert.equal(products.inspect.version_hash, versionHash);
    assert.equal(products.l2.version_hash, versionHash);
    assert.equal(products.l1.version_hash, versionHash);
  }

  // Search hits: exact product equality.
  assert.deepEqual(modernProducts.search, legacyProducts.search, "search hits must match");

  // Resolve: identical apart from the per-call UUID resolution id.
  assert.match(legacyProducts.resolve.resolution_id, /^[0-9a-f-]{36}$/);
  assert.match(modernProducts.resolve.resolution_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    withoutVolatileResolveFields(modernProducts.resolve),
    withoutVolatileResolveFields(legacyProducts.resolve),
    "resolve results must match",
  );

  // Inspect identity and metadata: exact product equality.
  assert.deepEqual(modernProducts.inspect, legacyProducts.inspect, "inspect identity must match");

  // get_content bytes: exact equality with each other and with the fixture.
  assert.equal(modernProducts.l2.content, legacyProducts.l2.content);
  assert.equal(modernProducts.l2.content, SKILL_BODY);
  assert.equal(modernProducts.l1.content, legacyProducts.l1.content);
  assert.equal(modernProducts.l1.content, SKILL_CORE);
  assert.equal(modernProducts.companion.content, legacyProducts.companion.content);
  assert.equal(modernProducts.companion.content, COMPANION_BODY);
  assert.deepEqual(
    readFileSync(join(fixture.hubDir, "owned", "ega", "alpha", "SKILL.md"), "utf8"),
    modernProducts.l2.content,
  );

  // Structured error codes: identical per case, all frozen codes.
  for (const label of Object.keys(legacyProducts.errors)) {
    assert.deepEqual(
      modernProducts.errors[label],
      legacyProducts.errors[label],
      `error parity for ${label}`,
    );
  }
  assert.equal(legacyProducts.errors.unknown_skill.code, "E_SKILL_NOT_FOUND");
  assert.equal(legacyProducts.errors.wrong_version_hash.code, "E_VERSION_NOT_FOUND");
  assert.equal(legacyProducts.errors.unknown_file.code, "E_CONTENT_FILE_UNKNOWN");
  assert.equal(legacyProducts.errors.forbidden_file.code, "E_CONTENT_FILE_FORBIDDEN");
  assert.equal(legacyProducts.errors.traversal_file.code, "E_CONTENT_FILE_UNKNOWN");
  assert.equal(legacyProducts.errors.token_budget.code, "E_CONTENT_TOKEN_BUDGET");
  assert.equal(legacyProducts.errors.missing_project.code, "E_PROJECT_NOT_FOUND");

  // Release identity: both eras serve from the same verified artifact, and
  // the artifact release digest is intact on disk.
  const releaseFile = JSON.parse(readFileSync(artifactPaths.release, "utf8"));
  assert.equal(releaseFile.digest, releaseDigest);
  assert.equal(releaseFile.payload.skill_versions[SKILL_ID], versionHash);
  assert.equal(releaseFile.payload.skill_versions[SKILL_ID], modernProducts.inspect.version_hash);
});

test("B7 tampered content is rejected identically in both eras (E_CACHE_HASH_MISMATCH)", async (t) => {
  const fixture = await buildEraArtifact();
  t.after(() => {
    rmSync(fixture.hubDir, { recursive: true, force: true });
    rmSync(fixture.artifactDir, { recursive: true, force: true });
  });
  const { versionHash, artifactDir } = fixture;
  const inspectProbe = await connectEra(t, "legacy", artifactDir);
  const inspect = productResult(await call(inspectProbe.client, "inspect", {
    skill_id: SKILL_ID,
    version_hash: versionHash,
    project_path: artifactDir,
  }));
  const l2Entry = inspect.manifest.files.find((file) => file.role === "skill-body");
  assert.ok(l2Entry, "fixture has an L2 manifest entry");
  const digest = l2Entry.blob_hash.slice("sha256:".length);
  const blobPath = join(artifactDir, "cache", "sha256", digest.slice(0, 2), digest.slice(2));
  const original = readFileSync(blobPath);
  writeFileSync(blobPath, Buffer.from("tampered bytes that do not match the manifest hash"));
  try {
    const legacy = await connectEra(t, "legacy", artifactDir);
    const legacyEnvelope = errorEnvelope(await call(legacy.client, "get_content", {
      skill_id: SKILL_ID,
      version_hash: versionHash,
      level: "L2",
      max_tokens: 4000,
      project_path: artifactDir,
    }));
    const modern = await connectEra(t, "modern", artifactDir);
    const modernEnvelope = errorEnvelope(await call(modern.client, "get_content", {
      skill_id: SKILL_ID,
      version_hash: versionHash,
      level: "L2",
      max_tokens: 4000,
      project_path: artifactDir,
    }));
    assert.deepEqual(modernEnvelope, legacyEnvelope);
    assert.deepEqual(legacyEnvelope, { isError: true, code: "E_CACHE_HASH_MISMATCH" });
  } finally {
    writeFileSync(blobPath, original);
  }
});
