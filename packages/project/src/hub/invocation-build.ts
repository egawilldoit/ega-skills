// C2 build: provenance is checked against the actual adopted inputs before an
// I1 release is emitted. This is not publication or a preapproval projection.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@ega-skills/hashing";
import { INVOCATION_REGISTRY_SCHEMA_VERSION, openRegistry } from "@ega-skills/registry";
import { discoverSkillDirs } from "./builder.js";
import { InvocationPolicyError, validateInvocationPolicy, type InvocationPolicy } from "./invocation-policy.js";
import { createInvocationRelease, type InvocationHubRelease } from "./invocation-release.js";
import { adoptedSourcePath } from "./paths.js";
import { digestStagedTree } from "./quarantine.js";
import { buildHubRelease, type HubReleaseBuildResult } from "./release-build.js";
import { createReleaseFtsTable, verifyReleaseCorpus } from "./release-state.js";
import { parseSourcesYaml, sourceConfigDigest } from "./sources-config.js";
import { parseSourcesLockYaml, verifySourcesLock } from "./sources-lock.js";

export interface InvocationHubReleaseBuildResult extends Omit<HubReleaseBuildResult, "release"> {
  readonly release: InvocationHubRelease;
}

/** Build an I1 release from adopted inputs, retaining the normal isolated build boundary. */
export async function buildInvocationHubRelease(hubDir: string, value: InvocationPolicy): Promise<InvocationHubReleaseBuildResult> {
  const policy = validateInvocationPolicy(value);
  const build = await buildHubRelease(hubDir);
  const config = parseSourcesYaml(readFileSync(join(hubDir, "sources.yaml"), "utf8"));
  const lock = parseSourcesLockYaml(readFileSync(join(hubDir, "sources.lock.yaml"), "utf8"));
  verifySourcesLock(config, lock);
  for (const source of policy.payload.sources) {
    const cfg = config.sources[source.source_id];
    const rec = lock.sources[source.source_id];
    const bound = build.release.payload.adopted_sources.find((item) => item.source_id === source.source_id);
    if (cfg === undefined || rec === undefined || bound === undefined || cfg.repository !== source.repository ||
        rec.resolved_commit !== source.resolved_commit || sourceConfigDigest(cfg) !== bound.source_config_digest ||
        rec.resolved_commit !== bound.resolved_commit || rec.selected_skill_tree_digest !== bound.selected_skill_tree_digest ||
        rec.vendored_snapshot_digest !== bound.vendored_snapshot_digest) {
      throw new InvocationPolicyError(`source provenance mismatch: ${source.source_id}`);
    }
    const root = adoptedSourcePath(hubDir, source.source_id);
    const tree = digestStagedTree(root, rec.selection.roots);
    if (tree.treeDigest !== rec.selected_skill_tree_digest || tree.snapshotDigest !== rec.vendored_snapshot_digest) {
      throw new InvocationPolicyError(`source snapshot mismatch: ${source.source_id}`);
    }
    const ids = discoverSkillDirs(root, rec.selection.roots).map((path) => `${cfg.namespace}/${path.split("/").at(-1) as string}`);
    if (new Set(ids).size !== ids.length || source.governed_skill_ids.some((id) => !ids.includes(id))) {
      throw new InvocationPolicyError(`source root mapping mismatch: ${source.source_id}`);
    }
  }
  const release = createInvocationRelease(build.release, policy, build.artifacts);
  const ftsTable = `release_fts_${release.digest.slice("sha256:".length)}`;
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: build.registryHome } });
  try {
    createReleaseFtsTable(registry.db, ftsTable, build.artifacts.searchIndexInput.rows);
    verifyReleaseCorpus(registry.db, ftsTable, build.skills.length);
    registry.db.exec("CREATE TABLE ega_invocation_profile (release_digest TEXT NOT NULL, policy_digest TEXT NOT NULL)");
    registry.db.prepare("INSERT INTO ega_invocation_profile (release_digest, policy_digest) VALUES (?, ?)").run(release.digest, policy.digest);
    registry.db.pragma(`user_version = ${INVOCATION_REGISTRY_SCHEMA_VERSION}`);
  } finally {
    registry.close();
  }
  const sqlite = readFileSync(join(build.registryHome, "registry.sqlite"));
  const releasePackage = { hub_release_digest: release.digest, sqlite_artifact_digest: `sha256:${sha256Hex(sqlite)}`, snapshot_rows: build.skills.length };
  writeFileSync(join(build.registryHome, "hub-release.json"), `${JSON.stringify(release, null, 2)}\n`);
  writeFileSync(join(build.registryHome, "release-package.json"), `${JSON.stringify(releasePackage, null, 2)}\n`);
  writeFileSync(join(build.registryHome, "invocation-policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
  return { ...build, release, releasePackage, ftsTable };
}
