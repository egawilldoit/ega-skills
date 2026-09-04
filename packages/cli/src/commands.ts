// EGA-570 thin CLI commands over the registry APIs.
//
// import: ega-skills import <path> --namespace <namespace> (REQUIRED surface).
// list/inspect: local read-only conveniences reusing registry reads; they
// define no new V1 behavior and never mutate state. No resolve/lock/update/
// sync/approve surface exists in V1. init (EGA-583) writes the frozen
// SPEC-005 §5.1.5 rule 3 project config and touches no registry state.

import { existsSync, statSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";

import {
  RegistryError,
  importSkills,
  listSkillAliases,
  listSkillVersions,
  listVersionSources,
  openRegistry,
  type ImportSummary,
  type RegistryHandle,
} from "@ega-skills/registry";
import { resolveSkills, type ResolutionResult } from "@ega-skills/router";

export type { ImportSummary };

export interface ResolveCommandOptions {
  readonly project: string;
  readonly task: string;
  readonly explicit?: readonly string[];
  readonly maxSkills?: number;
  readonly maxTokens?: number;
  readonly env: Record<string, string | undefined>;
}

/** Thin resolve command over the router pipeline (EGA-579). */
export async function runResolve(options: ResolveCommandOptions): Promise<ResolutionResult> {
  return resolveSkills({
    task: options.task,
    projectPath: options.project,
    ...(options.explicit !== undefined ? { explicitSkills: options.explicit } : {}),
    ...((options.maxSkills !== undefined || options.maxTokens !== undefined
      ? {
          budget: {
            ...(options.maxSkills !== undefined ? { maxSkills: options.maxSkills } : {}),
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          },
        }
      : {})),
    env: options.env,
  });
}

export interface ListEntry {
  readonly skillId: string;
  readonly currentVersionHash: string;
}

export interface InspectFile {
  readonly path: string;
  readonly role: string;
  readonly blobHash: string;
  readonly byteSize: number;
  readonly contentKind: string;
  readonly tokenCounts: readonly { estimatorId: string; tokenCount: number }[];
}

export interface InspectSource {
  readonly sourceType: string;
  readonly localPath: string | null;
  readonly repository: string | null;
  readonly commitSha: string | null;
  readonly repositoryPath: string | null;
}

export interface InspectVersion {
  readonly versionHash: string;
  readonly l1Status: string;
  readonly l2SizeClass: string;
  readonly trustLevel: string;
  readonly files: readonly InspectFile[];
  readonly sources: readonly InspectSource[];
}

export interface InspectResult {
  readonly skillId: string;
  readonly namespace: string;
  readonly name: string;
  readonly currentVersionHash: string;
  readonly aliases: readonly string[];
  readonly versions: readonly InspectVersion[];
}

// Minimal structural read surface: the CLI needs three SELECTs beyond the
// registry's typed readers and must not gain new dependencies for them.
interface ReadStatement {
  all<T>(...params: unknown[]): T[];
  get<T>(...params: unknown[]): T;
}

interface ReadableDb {
  prepare(sql: string): ReadStatement;
}

function queryAll<T>(registry: RegistryHandle, sql: string, ...params: unknown[]): T[] {
  const db = registry.db as unknown as ReadableDb;
  return db.prepare(sql).all<T>(...params);
}

function queryOne<T>(registry: RegistryHandle, sql: string, ...params: unknown[]): T | undefined {
  const db = registry.db as unknown as ReadableDb;
  return db.prepare(sql).get<T | undefined>(...params);
}

function openCliRegistry(env: Record<string, string | undefined>): RegistryHandle {
  return openRegistry({ env });
}

/** REQUIRED surface: import a skill root or collection, return the summary. */
export async function runImport(
  path: string,
  namespace: string,
  env: Record<string, string | undefined>,
): Promise<ImportSummary> {
  const registry = openCliRegistry(env);
  try {
    return await importSkills(registry, { path, namespace });
  } finally {
    registry.close();
  }
}

/** Convenience: canonical IDs with current versions, lexical order. Read-only. */
export async function runList(
  env: Record<string, string | undefined>,
): Promise<ListEntry[]> {
  const registry = openCliRegistry(env);
  try {
    return queryAll<{ skill_id: string; current_version_hash: string }>(
      registry,
      "SELECT skill_id, current_version_hash FROM skills ORDER BY skill_id ASC",
    ).map((row) => ({ skillId: row.skill_id, currentVersionHash: row.current_version_hash }));
  } finally {
    registry.close();
  }
}

// `ega-skills init` (SPEC-005 §5.1.5 rule 3, EGA-583).
//
// init writes a deterministic, human-readable `.egaskills.yaml` into the
// project directory: schema_version 1, the SAME routing defaults as the
// built-in unlocked defaults, the four empty policy lists, and
// locking.required: true — a committed project explicitly attests LOCKED
// mode. The document is byte-frozen: no timestamps, no environment reads, no
// registry state, and rewriting an overwritten file is always byte-identical.
// `parseProjectConfig` (packages/project) accepts this exact text verbatim.

const INIT_CONFIG_YAML = `schema_version: 1
routing:
  mode: suggest
  max_skills: 3
  max_tokens: 5000
namespaces:
  allow: []
  deny: []
skills:
  prefer: []
  deny: []
locking:
  required: true
`;

export interface InitOptions {
  /** Project directory; relative paths resolve against the current working directory. */
  readonly project: string;
  /** Replace an existing `.egaskills.yaml` instead of refusing (default: false). */
  readonly force?: boolean;
}

export interface InitResult {
  /** Absolute path of the written `.egaskills.yaml`. */
  readonly path: string;
  readonly written: true;
}

/** Writes the frozen init `.egaskills.yaml` (SPEC-005 §5.1.5 rule 3). */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const dir = resolve(options.project);
  let stats: Stats;
  try {
    stats = statSync(dir);
  } catch {
    throw new Error(`Project directory does not exist: ${dir}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }
  const file = join(dir, ".egaskills.yaml");
  if (options.force !== true && existsSync(file)) {
    throw new Error(`Refusing to overwrite: ${file} (pass --force to replace it)`);
  }
  writeFileSync(file, INIT_CONFIG_YAML);
  return { path: file, written: true };
}

/** Convenience: metadata, versions, L1 status, token sizes, provenance. Read-only. */
export async function runInspect(
  skillId: string,
  env: Record<string, string | undefined>,
): Promise<InspectResult> {
  const registry = openCliRegistry(env);
  try {
    const skill = queryOne<{ skill_id: string; namespace: string; name: string; current_version_hash: string }>(
      registry,
      "SELECT skill_id, namespace, name, current_version_hash FROM skills WHERE skill_id = ?",
      skillId,
    );
    if (skill === undefined) {
      throw new RegistryError(
        "E_VERSION_NOT_FOUND",
        `Unknown skill ${JSON.stringify(skillId)}: no current version.`,
      );
    }
    const versions = listSkillVersions(registry.db, skillId).map((version) => {
      const files = queryAll<{
        path: string;
        role: string;
        blob_hash: string;
        byte_size: number;
        content_kind: string;
      }>(
        registry,
        "SELECT path, role, blob_hash, byte_size, content_kind FROM skill_files WHERE skill_id = ? AND version_hash = ? ORDER BY path ASC",
        skillId,
        version.versionHash,
      ).map((file) => ({
        path: file.path,
        role: file.role,
        blobHash: file.blob_hash,
        byteSize: file.byte_size,
        contentKind: file.content_kind,
        tokenCounts: queryAll<{ estimator_id: string; token_count: number }>(
          registry,
          "SELECT estimator_id, token_count FROM token_counts WHERE blob_hash = ? ORDER BY estimator_id ASC",
          file.blob_hash,
        ).map((count) => ({ estimatorId: count.estimator_id, tokenCount: count.token_count })),
      }));
      const sources = listVersionSources(registry.db, skillId, version.versionHash).map(
        (source) => ({
          sourceType: source.sourceType,
          localPath: source.localPath,
          repository: source.repository,
          commitSha: source.commitSha,
          repositoryPath: source.repositoryPath,
        }),
      );
      return {
        versionHash: version.versionHash,
        l1Status: version.l1Status,
        l2SizeClass: version.l2SizeClass,
        trustLevel: version.trustLevel,
        files,
        sources,
      };
    });
    return {
      skillId: skill.skill_id,
      namespace: skill.namespace,
      name: skill.name,
      currentVersionHash: skill.current_version_hash,
      aliases: listSkillAliases(registry.db, skillId),
      versions,
    };
  } finally {
    registry.close();
  }
}
