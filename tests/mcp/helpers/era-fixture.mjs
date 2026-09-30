// Deterministic era fixture shared by the protocol-era suites (Agent B).
//
// One canonical Hub with one owned skill (`ega/alpha`) carrying L1, L2 and a
// TEXT companion file. Content is fixed so version hashes, search hits and
// exact bytes are reproducible across the legacy and modern protocol eras.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHubRelease } from "../../../packages/project/dist/index.js";

export const SKILL_ID = "ega/alpha";
export const SKILL_BODY =
  "---\nname: alpha\ndescription: Alpha parity skill.\n---\n\n# alpha\n\nAlpha deterministic body marker ERA-BODY-2.0.\n";
export const SKILL_CORE = "# alpha core\n\nAlpha deterministic core marker ERA-CORE-2.0.\n";
export const COMPANION_PATH = "references/notes.md";
export const COMPANION_BODY = "# notes\n\nCompanion marker ERA-COMPANION-2.0.\n";

const HUB_YAML =
  "schema_version: 1\nhub:\n  id: era-parity\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n";
const SOURCES_YAML = "schema_version: 1\nsources: {}\n";
const EGA_YAML =
  "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - alpha build\naliases:\n  - alpha-alias\n";

/** Writes the deterministic Hub to a fresh temp directory. */
export function writeEraHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-era-hub-"));
  const skillDir = join(hubDir, "owned", "ega", "alpha");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY);
  writeFileSync(join(skillDir, "SKILL.core.md"), SKILL_CORE);
  writeFileSync(join(skillDir, "ega.yaml"), EGA_YAML);
  writeFileSync(join(skillDir, COMPANION_PATH), COMPANION_BODY);
  writeFileSync(join(hubDir, "hub.yaml"), HUB_YAML);
  writeFileSync(join(hubDir, "sources.yaml"), SOURCES_YAML);
  writeFileSync(join(hubDir, "sources.lock.yaml"), SOURCES_YAML);
  return hubDir;
}

/**
 * Builds the deterministic release. Returns the artifact directory (read-only
 * registry home), the parsed HubRelease, and the fixture identity. The caller
 * owns cleanup of `hubDir` and `artifactDir`.
 */
export async function buildEraArtifact() {
  const hubDir = writeEraHub();
  const build = await buildHubRelease(hubDir);
  const release = JSON.parse(readFileSync(build.artifactPaths.release, "utf8"));
  return {
    hubDir,
    artifactDir: build.registryHome,
    artifactPaths: build.artifactPaths,
    release,
    releaseDigest: release.digest,
    versionHash: release.payload.skill_versions[SKILL_ID],
  };
}
