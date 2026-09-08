// Contract C public build orchestration.  `buildHub` proves the catalog in a
// fresh registry; this module completes the release artifacts before handing
// any result to publication code.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@ega-skills/hashing";
import { openRegistry } from "@ega-skills/registry";
import { buildHub, type HubBuildResult } from "./builder.js";
import {
  createReleaseFtsTable,
  deriveAliasMap,
  deriveSearchIndexInput,
  deriveSkillSourceProvenance,
  deriveTokenArtifact,
  skillSourceProvenanceDigest,
  verifyReleaseCorpus,
} from "./release-state.js";
import {
  createHubRelease,
  createReleasePackage,
  type HubRelease,
  type ReleaseArtifacts,
  type ReleasePackage,
} from "./release.js";

export interface HubReleaseBuildResult extends HubBuildResult {
  readonly artifacts: ReleaseArtifacts;
  readonly release: HubRelease;
  readonly releasePackage: ReleasePackage;
  readonly ftsTable: string;
  readonly artifactPaths: Readonly<Record<string, string>>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Run every local Contract C build step and emit a self-contained artifact
 * directory.  The SQLite digest is calculated only after the release-specific
 * corpus has been created, and remains outside HubRelease semantic identity.
 */
export async function buildHubRelease(hubDir: string): Promise<HubReleaseBuildResult> {
  const build = await buildHub(hubDir);
  const artifacts: ReleaseArtifacts = {
    aliasMap: deriveAliasMap(build),
    searchIndexInput: deriveSearchIndexInput(build),
    tokenArtifact: deriveTokenArtifact(build),
  };
  const release = createHubRelease(build, artifacts);
  const sourceProvenance = deriveSkillSourceProvenance(build);
  const ftsTable = `release_fts_${release.digest.slice("sha256:".length)}`;
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: build.registryHome } });
  try {
    createReleaseFtsTable(registry.db, ftsTable, artifacts.searchIndexInput.rows);
    verifyReleaseCorpus(registry.db, ftsTable, build.skills.length);
    registry.db.exec(
      "CREATE TABLE ega_release_skill_sources (skill_id TEXT PRIMARY KEY NOT NULL, source_id TEXT)",
    );
    const sourceInsert = registry.db.prepare(
      "INSERT INTO ega_release_skill_sources (skill_id, source_id) VALUES (?, ?)",
    );
    for (const row of sourceProvenance) sourceInsert.run(row.skill_id, row.source_id);
    registry.db.exec(
      "CREATE TABLE ega_release_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
    );
    const metadata = registry.db.prepare("INSERT INTO ega_release_metadata (key, value) VALUES (?, ?)");
    metadata.run("hub_release_digest", release.digest);
    metadata.run("search_index_input_digest", release.payload.search_index_input_digest);
    metadata.run("token_artifact_digest", release.payload.token_artifact_digest);
    metadata.run("alias_map_digest", release.payload.alias_map_digest);
    metadata.run("skill_source_map_digest", skillSourceProvenanceDigest(sourceProvenance));
    metadata.run("fts_table", ftsTable);
  } finally {
    registry.close();
  }
  const sqlitePath = join(build.registryHome, "registry.sqlite");
  const sqliteArtifactDigest = `sha256:${sha256Hex(readFileSync(sqlitePath))}`;
  const releasePackage = createReleasePackage(release, sqliteArtifactDigest, build.skills.length);
  const artifactPaths = {
    aliasMap: join(build.registryHome, "alias-map.json"),
    searchIndexInput: join(build.registryHome, "search-index-input.json"),
    tokenArtifact: join(build.registryHome, "token-artifact.json"),
    release: join(build.registryHome, "hub-release.json"),
    releasePackage: join(build.registryHome, "release-package.json"),
  } as const;
  writeJson(artifactPaths.aliasMap, artifacts.aliasMap);
  writeJson(artifactPaths.searchIndexInput, artifacts.searchIndexInput);
  writeJson(artifactPaths.tokenArtifact, artifacts.tokenArtifact);
  writeJson(artifactPaths.release, release);
  writeJson(artifactPaths.releasePackage, releasePackage);
  return { ...build, artifactPaths, artifacts, ftsTable, release, releasePackage };
}
