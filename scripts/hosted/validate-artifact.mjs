#!/usr/bin/env node
// Deterministic pre-deployment validation for a proposed immutable
// HubRelease artifact directory.
//
// Calls the EXISTING release verification code
// (`loadHostedReleaseSnapshot`): SQLite digest verification, SQLite
// integrity check, HubRelease verification, manifest/version identity,
// alias/search/token projection checks, and blob existence checks. Nothing
// is weakened and nothing is regenerated.
//
// Usage:
//   node scripts/hosted/validate-artifact.mjs <artifact-dir>
//   EGA_HOSTED_ARTIFACT_DIR=<dir> node scripts/hosted/validate-artifact.mjs
//
// Exit 0: the complete release passed verification (deployment candidate).
// Exit 1: missing/corrupt/incomplete artifact (sanitized reason only).
import { createHostedRuntimeFromEnv, loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";

const artifactDir = process.argv[2] ?? process.env.EGA_HOSTED_ARTIFACT_DIR;
if (!artifactDir) {
  process.stderr.write("validate-artifact: an artifact directory argument or EGA_HOSTED_ARTIFACT_DIR is required\n");
  process.exit(1);
}

try {
  const snapshot = loadHostedReleaseSnapshot(artifactDir);
  const skills = Object.keys(snapshot.release.payload.skill_versions).length;
  process.stdout.write(
    `validate-artifact: OK digest=${snapshot.releaseDigest} hub=${snapshot.release.payload.hub_id} skills=${skills} fts=${snapshot.ftsTable}\n`,
  );
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "E_SNAPSHOT_INVALID";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`validate-artifact: FAIL code=${code} reason=${message}\n`);
  process.exit(1);
}

// Optional readiness probe: when authorization configuration is also present
// in env, verify the FULL startup (/readyz semantics), not just the snapshot.
// Artifact validation above determines the exit code; this line is advisory.
if (process.env.EGA_HOSTED_AUTHZ_JSON !== undefined || process.env.EGA_HOSTED_AUTHZ_FILE !== undefined) {
  try {
    createHostedRuntimeFromEnv({ ...process.env, EGA_HOSTED_ARTIFACT_DIR: artifactDir });
    process.stdout.write("readiness: READY\n");
  } catch (error) {
    process.stdout.write(`readiness: NOT-READY (${error instanceof Error ? error.message : String(error)})\n`);
  }
} else {
  process.stdout.write("readiness: NOT-CHECKED (no EGA_HOSTED_AUTHZ_JSON or EGA_HOSTED_AUTHZ_FILE in env)\n");
}
