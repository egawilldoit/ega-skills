/**
 * The committed artifact's own declared facts.
 *
 * Tests used to hardcode `114` — the skill count of whichever catalog happened
 * to be committed when they were written. That is a constant that lies: a
 * routine catalog republish (`catalog-2026-10-06.1` took the release from 114 to
 * 116 skills) broke dozens of tests that were asserting something else
 * entirely, and the real signal was buried in noise.
 *
 * The number is a property of the artifact, so it is read from the artifact.
 * `snapshot_rows` in `release-package.json` is the authoritative count: it is
 * the row count the release package declares, and the registry is asserted
 * against it elsewhere.
 *
 * A test that genuinely wants to pin a literal cardinality should say so
 * explicitly and explain why — "this release has exactly N skills" is a real
 * property of a release, but it belongs with the release's own evidence, not
 * spread across every suite that happens to enumerate it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The real committed release artifact the console reads. */
export const ARTIFACT_DIR = join(REPO_ROOT, "packages", "mcp", "artifact");

function readArtifactJson(name) {
  return JSON.parse(readFileSync(join(ARTIFACT_DIR, name), "utf8"));
}

/**
 * Skills in the committed release, as the release package declares them.
 *
 * Derived, never hardcoded: see the module comment.
 */
export const COMMITTED_SKILL_COUNT = readArtifactJson("release-package.json").snapshot_rows;

/**
 * The committed release's semantic digest, read from the release package.
 *
 * `hub_release_digest` is the identity the console reports and the one an
 * operator compares against `hub-release.json`.
 */
export const COMMITTED_RELEASE_DIGEST = readArtifactJson("release-package.json").hub_release_digest;

/** The physical SQLite snapshot digest, declared by the same package. */
export const COMMITTED_SQLITE_DIGEST = readArtifactJson("release-package.json").sqlite_artifact_digest;