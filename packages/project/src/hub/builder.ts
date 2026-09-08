// 1.1[E] complete Hub builder (EGA-627). Contract C section 1.
//
// Every build starts from a FRESH EMPTY isolated registry: developer
// registry history can never become implicit build input. The builder
// consumes the adopted Hub state read-only:
// contracts → expected catalog → owned validation → provenance verification
// → discovery → duplicate-ID rejection → zero-failure import → exact-catalog
// verification. Release-scoped aliases, token artifacts, SearchIndexInput,
// release FTS, and HubRelease emission belong to 1.1[F]/[G], which consume
// the BuildResult (registryHome + verified catalog).

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSkills, listSkillVersions, openRegistry } from "@ega-skills/registry";
import type { RegistryHandle } from "@ega-skills/registry";
import { HubError } from "./errors.js";
import { parseHubYaml, verifyHubCoverage } from "./hub-config.js";
import { digestStagedTree } from "./quarantine.js";
import { requireCleanJournal } from "./journal.js";
import { parseSourcesLockYaml } from "./sources-lock.js";
import type { SourcesLock } from "./sources-lock.js";
import { parseSourcesYaml } from "./sources-config.js";
import { verifySourcesLock } from "./sources-lock.js";
import { adoptedSourcePath } from "./paths.js";

export interface HubBuildSkill {
  skillId: string;
  versionHash: string;
}

export interface HubBuildSource {
  sourceId: string;
  sourceConfigDigest: string;
  resolvedCommit: string;
  selectedSkillTreeDigest: string;
  vendoredSnapshotDigest: string;
}

export interface HubBuildResult {
  registryHome: string;
  skills: HubBuildSkill[];
  hubId: string;
  adoptedSources: HubBuildSource[];
}

interface ReadStatement {
  all<T>(...params: unknown[]): T[];
}

interface ReadableDb {
  prepare(sql: string): ReadStatement;
}

interface ExpectedRoot {
  namespace: string;
  absPath: string;
}

/** Skill directories (SKILL.md holders) at or under any of `roots`. */
function discoverSkillDirs(baseDir: string, roots: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      throw new HubError("E_LOCK_MISMATCH", `expected Hub path missing: ${rel || baseDir}`);
    }
    // A selected root may itself be a skill directory.
    if (rel.length > 0 && existsSync(join(abs, "SKILL.md")) && !found.includes(rel)) {
      found.push(rel);
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink()) {
        throw new HubError("E_EXTRACTION_POLICY", `symlink forbidden in adopted Hub content: ${rel}/${entry.name}`);
      }
      if (!entry.isDirectory()) continue;
      const childAbs = join(abs, entry.name);
      const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (existsSync(join(childAbs, "SKILL.md")) && !found.includes(childRel)) {
        found.push(childRel);
      }
      walk(childAbs, childRel);
    }
  };
  for (const root of roots) {
    walk(join(baseDir, ...root.split("/")), root);
  }
  return found;
}

function readText(path: string, what: string, code: "E_HUB_SCHEMA" | "E_SOURCE_SCHEMA" | "E_LOCK_MISMATCH"): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new HubError(code, `${what} missing: ${path}`);
  }
}

export async function buildHub(hubDir: string): Promise<HubBuildResult> {
  // A Hub with an incomplete mutation is not buildable until recovered.
  requireCleanJournal(hubDir);
  const hub = parseHubYaml(readText(join(hubDir, "hub.yaml"), "hub.yaml", "E_HUB_SCHEMA"));
  const config = parseSourcesYaml(readText(join(hubDir, "sources.yaml"), "sources.yaml", "E_SOURCE_SCHEMA"));
  const adopted = parseSourcesLockYaml(readText(join(hubDir, "sources.lock.yaml"), "sources.lock.yaml", "E_LOCK_MISMATCH"));
  verifyHubCoverage(hub, config);
  verifySourcesLock(config, adopted);
  // Provenance: every adopted tree must still match its lock digests.
  for (const [name, record] of Object.entries(adopted.sources)) {
    const treeDir = adoptedSourcePath(hubDir, name);
    if (!existsSync(treeDir)) {
      throw new HubError("E_LOCK_MISMATCH", `adopted tree missing for ${name}`);
    }
    const fresh = digestStagedTree(treeDir, record.selection.roots);
    if (fresh.treeDigest !== record.selected_skill_tree_digest || fresh.snapshotDigest !== record.vendored_snapshot_digest) {
      throw new HubError("E_TREE_DIGEST", `adopted tree for ${name} no longer matches its lock digests`);
    }
  }
  // Expected catalog: owned skills + vendored skills under selected roots.
  const expected = new Map<string, ExpectedRoot>();
  const claim = (skillId: string, namespace: string, absPath: string): void => {
    const prior = expected.get(skillId);
    if (prior !== undefined && prior.absPath !== absPath) {
      throw new HubError("E_BUILD_ATTESTATION", `duplicate canonical Skill ID ${skillId} from ${prior.absPath} and ${absPath}`);
    }
    expected.set(skillId, { absPath, namespace });
  };
  for (const owned of hub.owned) {
    for (const rel of discoverSkillDirs(hubDir, [owned.path])) {
      const leaf = rel.split("/").pop() as string;
      claim(`${owned.namespace}/${leaf}`, owned.namespace, join(hubDir, ...rel.split("/")));
    }
  }
  for (const [name, record] of Object.entries(adopted.sources)) {
    const source = config.sources[name];
    if (!source) continue;
    const treeDir = adoptedSourcePath(hubDir, name);
    for (const rel of discoverSkillDirs(treeDir, record.selection.roots)) {
      const leaf = rel.split("/").pop() as string;
      claim(`${source.namespace}/${leaf}`, source.namespace, join(treeDir, ...rel.split("/")));
    }
  }
  // Fresh empty isolated registry: developer history cannot leak in. The env
  // is fully explicit so the build never observes ambient registry state.
  const registryHome = mkdtempSync(join(tmpdir(), "ega-hub-build-"));
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: registryHome }, userHome: tmpdir() });
  try {
    const ordered = [...expected.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [, root] of ordered) {
      const summary = await importSkills(registry, { namespace: root.namespace, path: root.absPath });
      if (summary.failed > 0) {
        const first = summary.failures[0];
        throw new HubError("E_BUILD_ATTESTATION", `import failed with zero tolerance: ${first ? first.error : "unknown"}`);
      }
    }
    return verifyCatalog(registryHome, registry, expected, hub.hubId, adopted.sources);
  } finally {
    registry.close();
  }
}

function verifyCatalog(
  registryHome: string,
  registry: RegistryHandle,
  expected: Map<string, ExpectedRoot>,
  hubId: string,
  adoptedSources: SourcesLock["sources"],
): HubBuildResult {
  const db = registry.db as unknown as ReadableDb;
  const actual = new Set(
    db.prepare("SELECT DISTINCT skill_id AS id FROM skill_versions").all<{ id: string }>().map((row) => row.id),
  );
  for (const skillId of expected.keys()) {
    if (!actual.has(skillId)) {
      throw new HubError("E_BUILD_ATTESTATION", `expected skill missing after import: ${skillId}`);
    }
  }
  for (const skillId of actual) {
    if (!expected.has(skillId)) {
      throw new HubError("E_BUILD_ATTESTATION", `unexpected skill after import: ${skillId}`);
    }
  }
  const skills: HubBuildSkill[] = [...expected.keys()]
    .sort()
    .map((skillId) => {
      const rows = listSkillVersions(registry.db, skillId);
      const latest = rows[rows.length - 1];
      if (!latest) {
        throw new HubError("E_BUILD_ATTESTATION", `imported skill has no version: ${skillId}`);
      }
      return { skillId, versionHash: latest.versionHash };
    });
  return {
    adoptedSources: Object.entries(adoptedSources)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([sourceId, record]) => ({
        resolvedCommit: record.resolved_commit,
        selectedSkillTreeDigest: record.selected_skill_tree_digest,
        sourceConfigDigest: record.source_config_digest,
        sourceId,
        vendoredSnapshotDigest: record.vendored_snapshot_digest,
      })),
    hubId,
    registryHome,
    skills,
  };
}
