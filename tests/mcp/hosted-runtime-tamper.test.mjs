// Runtime tamper acceptance — Agent B task B11 (extensions).
//
// The snapshot-loading tamper matrix (tampered manifest fields, token
// metadata, aliases, extra skills, missing content blobs, FTS rows) is
// retained in tests/mcp/hosted-release-integrity.test.mjs. This suite adds the
// RUNTIME cases for both protocol eras:
//
// - a tampered release manifest (`hub-release.json`) is rejected at startup;
// - a tampered release package identity is rejected at startup;
// - a wrong release digest is refused before any tool work over the wire
//   (legacy and modern), with no skill content in the error payload.

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";
import { buildEraArtifact, SKILL_BODY, SKILL_ID } from "./helpers/era-fixture.mjs";
import { connectHttp, startHosted } from "./helpers/hosted-era-runtime.mjs";
import {
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  productResult,
} from "./helpers/sdk-era-client.mjs";

const WRONG_DIGEST = `sha256:${"0".repeat(64)}`;

/** Hosted error results carry the envelope as text; local ones as structuredContent. */
function errorOf(result) {
  const structured = productResult(result);
  if (structured?.error) return structured.error;
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  try {
    return JSON.parse(text)?.error;
  } catch {
    return undefined;
  }
}

async function connect(t, era, url) {
  const { client, transport } = connectHttp(t, url, {
    supportedProtocolVersions: [era === "modern" ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION],
  });
  await client.connect(transport);
  if (era === "modern") await client.negotiateModernOnly();
  else await client.initializeLegacy();
  return client;
}

test("B11 startup: a tampered release manifest is rejected (no hosted handler)", async (t) => {
  const fixture = await buildEraArtifact();
  t.after(() => {
    rmSync(fixture.hubDir, { recursive: true, force: true });
    rmSync(fixture.artifactDir, { recursive: true, force: true });
  });
  const releasePath = join(fixture.artifactDir, "hub-release.json");
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  release.payload.skill_versions[SKILL_ID] = `sha256:${"ee".repeat(32)}`;
  writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  assert.throws(
    () => loadHostedReleaseSnapshot(fixture.artifactDir),
    (error) => {
      assert.equal(error?.code, "E_SNAPSHOT_INVALID");
      return true;
    },
  );
});

test("B11 startup: a tampered release package identity is rejected (no hosted handler)", async (t) => {
  const fixture = await buildEraArtifact();
  t.after(() => {
    rmSync(fixture.hubDir, { recursive: true, force: true });
    rmSync(fixture.artifactDir, { recursive: true, force: true });
  });
  const packagePath = join(fixture.artifactDir, "release-package.json");
  const releasePackage = JSON.parse(readFileSync(packagePath, "utf8"));
  releasePackage.hub_release_digest = WRONG_DIGEST;
  writeFileSync(packagePath, `${JSON.stringify(releasePackage, null, 2)}\n`);
  assert.throws(
    () => loadHostedReleaseSnapshot(fixture.artifactDir),
    (error) => {
      assert.equal(error?.code, "E_SNAPSHOT_INVALID");
      return true;
    },
  );
});

test("B11 runtime: a wrong release digest is refused for all four tools in both eras", async (t) => {
  const hosted = await startHosted(t);
  const { versionHash, releaseDigest } = hosted.fixture;
  assert.equal(SKILL_BODY.includes("ERA-BODY"), true);

  for (const era of ["legacy", "modern"]) {
    const client = await connect(t, era, hosted.url);
    const calls = {
      search: { name: "search", arguments: { query: "alpha", release_digest: WRONG_DIGEST } },
      resolve: { name: "resolve", arguments: { task: "alpha", release_digest: WRONG_DIGEST } },
      inspect: {
        name: "inspect",
        arguments: { skill_id: SKILL_ID, version_hash: versionHash, release_digest: WRONG_DIGEST },
      },
      get_content: {
        name: "get_content",
        arguments: {
          skill_id: SKILL_ID,
          version_hash: versionHash,
          level: "L2",
          max_tokens: 4000,
          release_digest: WRONG_DIGEST,
        },
      },
    };
    for (const [tool, params] of Object.entries(calls)) {
      const result = await client.request({ method: "tools/call", params });
      assert.equal(result.isError, true, `${era}/${tool}: wrong digest must fail`);
      const error = errorOf(result);
      assert.equal(error?.code, "E_RELEASE_MISMATCH", `${era}/${tool} code`);
      assert.equal(error?.tool, tool);
      const payload = JSON.stringify(result);
      assert.equal(payload.includes(SKILL_BODY.slice(0, 40)), false, `${era}/${tool} leaked content`);
      assert.equal(payload.includes(releaseDigest), false, `${era}/${tool} leaked the real digest`);
    }
    await client.close();
  }
});
