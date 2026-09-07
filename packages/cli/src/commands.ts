// EGA-570 thin CLI commands over the registry APIs.
//
// import: ega-skills import <path> --namespace <namespace> (REQUIRED surface).
// list/inspect: local read-only conveniences reusing registry reads; they
// define no new V1 behavior and never mutate state. Hub build/check/update
// expose the frozen Hub adoption surface. init (EGA-583) writes the frozen
// SPEC-005 §5.1.5 rule 3 project config and touches no registry state.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  RegistryError,
  importSkills,
  listSkillAliases,
  listSkillVersions,
  listVersionSources,
  openRegistry,
  resolveRegistryHome,
  type ImportSummary,
  type RegistryHandle,
} from "@ega-skills/registry";
import { resolveSkills, type ResolutionResult } from "@ega-skills/router";
import {
  discoverConfig,
  parseProjectConfig,
  refreshLock,
  serializeLockfile,
  validateLockfile,
  applyUpdatePlan,
  buildHub,
  buildHubRelease,
  checkForUpdates,
  extractSelectedRoots,
  fetchExactCommit,
  fetchRefTip,
  parseSourcesLockYaml,
  parseSourcesYaml,
  verifySourcesLock,
  type ProjectLockV1,
  type RefreshLockDiff,
  type UpdatePlanDocument,
} from "@ega-skills/project";
import { parse as parseYaml } from "yaml";
import { validatePortableSkillName } from "@ega-skills/schema";

export type { ImportSummary };

export interface HubCommandOptions {
  readonly hub?: string;
}

export interface HubCheckCommandOptions extends HubCommandOptions {
  readonly sourceId: string;
  readonly output?: string;
}

export interface HubUpdateCommandOptions extends HubCommandOptions {
  readonly plan: string;
}

function hubFile(hubDir: string, name: string): string {
  return join(hubDir, name);
}

function readHubContracts(hub: string) {
  const hubDir = resolve(hub);
  const config = parseSourcesYaml(readFileSync(hubFile(hubDir, "sources.yaml"), "utf8"));
  const lock = parseSourcesLockYaml(readFileSync(hubFile(hubDir, "sources.lock.yaml"), "utf8"));
  verifySourcesLock(config, lock);
  return { config, hubDir, lock };
}

/** Run the complete Contract C build through the public CLI API. */
export async function runHubBuild(options: HubCommandOptions = {}) {
  return buildHubRelease(resolve(options.hub ?? "."));
}

/** Read-only Contract B check. The existing Hub build supplies the adopted
 * SkillVersion map without allowing ambient developer registry history in. */
export async function runHubCheck(options: HubCheckCommandOptions) {
  const { config, hubDir, lock } = readHubContracts(options.hub ?? ".");
  const source = config.sources[options.sourceId];
  const adopted = lock.sources[options.sourceId];
  if (!source || !adopted) throw new Error(`Unknown adopted Hub source: ${options.sourceId}`);
  const build = await buildHub(hubDir);
  const prefix = `${source.namespace}/`;
  const versions: Record<string, string> = {};
  for (const skill of build.skills) {
    if (skill.skillId.startsWith(prefix)) versions[skill.skillId] = skill.versionHash;
  }
  const workDir = mkdtempSync(join(tmpdir(), "ega-cli-hub-check-"));
  try {
    const result = await checkForUpdates({
      adopted: {
        commit: adopted.resolved_commit,
        snapshotDigest: adopted.vendored_snapshot_digest,
        treeDigest: adopted.selected_skill_tree_digest,
        versions,
      },
      config: source,
      sourceId: options.sourceId,
      workDir,
    });
    if (options.output) writeFileSync(resolve(options.output), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
}

/** Exact-commit Contract B apply. The target is fetched from the approved
 * plan and never re-resolved from the moving source ref. */
export async function runHubUpdate(options: HubUpdateCommandOptions) {
  const { config, hubDir, lock } = readHubContracts(options.hub ?? ".");
  const plan = JSON.parse(readFileSync(resolve(options.plan), "utf8")) as UpdatePlanDocument;
  const source = config.sources[plan.payload?.source_id];
  const adopted = lock.sources[plan.payload?.source_id];
  if (!source || !adopted) throw new Error(`Unknown adopted Hub source in plan: ${plan.payload?.source_id ?? ""}`);
  const workspace = mkdtempSync(join(tmpdir(), "ega-cli-hub-update-"));
  const fetched = join(workspace, "fetched");
  const stage = join(workspace, "stage");
  mkdirSync(stage, { recursive: true });
  try {
    fetchExactCommit(source.repository, plan.payload.target_commit, fetched);
    extractSelectedRoots(fetched, source.selection.roots, source.provenanceFiles, stage);
    // Await before cleanup: applyUpdatePlan reads the extracted stage after
    // its first asynchronous prospective-build validation.
    return await applyUpdatePlan({ hubDir, plan, stageDir: stage });
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
}

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

export interface ValidateOptions {
  readonly path: string;
}

export interface ValidateFailure {
  readonly path: string;
  readonly error: string;
}

export interface ValidateResult {
  readonly path: string;
  readonly valid: boolean;
  readonly checked: number;
  readonly failures: readonly ValidateFailure[];
}

/**
 * Validate skill packages without writing to the target or the developer
 * registry.  The existing importer owns the complete package validation
 * pipeline; its only writes are directed to this disposable registry.
 */
export async function runValidate(options: ValidateOptions): Promise<ValidateResult> {
  const target = resolve(options.path);
  const validationHome = mkdtempSync(join(tmpdir(), "ega-skill-validate-"));
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: validationHome }, userHome: tmpdir() });
  try {
    const summary = await importSkills(registry, { path: target, namespace: "validation" });
    return {
      checked: summary.imported + summary.unchanged + summary.failed,
      failures: summary.failures,
      path: target,
      valid: summary.failed === 0,
    };
  } finally {
    registry.close();
    rmSync(validationHome, { force: true, recursive: true });
  }
}

export interface InitSkillOptions {
  readonly name: string;
}

export interface InitSkillResult {
  readonly path: string;
  readonly files: readonly ["SKILL.md", "ega.yaml"];
  readonly created: true;
}

/** Create the canonical two-file authoring scaffold. */
export async function runInitSkill(options: InitSkillOptions): Promise<InitSkillResult> {
  const name = validatePortableSkillName(options.name, { field: "name" });
  const skillDir = resolve(name);
  if (existsSync(skillDir)) throw new Error(`Refusing to overwrite existing path: ${skillDir}`);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: Describe what this skill does and when to use it.\n---\n\n# ${name}\n\nDescribe the skill instructions here.\n`);
  writeFileSync(join(skillDir, "ega.yaml"), "schema_version: 1\n");
  return { created: true, files: ["SKILL.md", "ega.yaml"], path: skillDir };
}

export interface LockCommandOptions {
  /** Project directory; relative paths resolve against the current working directory. */
  readonly project?: string;
  /** Regenerate an existing lock (and report the diff) instead of creating. */
  readonly refresh?: boolean;
  readonly env: Record<string, string | undefined>;
}

export interface LockCommandResult {
  /** Absolute path of the written `.egaskills.lock`. */
  readonly path: string;
  /** True for initial creation, false for --refresh. */
  readonly created: boolean;
  /** Deterministic eligible-catalog diff vs the previous lock (all-added on create). */
  readonly diff: RefreshLockDiff;
  /** Number of pinned skills in the written lock. */
  readonly skills: number;
}

/**
 * Rejects symlink/junction lock paths (SPEC-005 §5.1.14 rule 4, same
 * convention as readControlFileText): a lock symlink is NEVER followed for
 * reading and NEVER overwritten through — refresh must not become a write
 * primitive into another file. A missing path is fine (fresh create).
 */
function refuseSymlinkLock(lockFile: string): void {
  let stat: Stats | null = null;
  try {
    stat = lstatSync(lockFile);
  } catch {
    return;
  }
  if (stat !== null && stat.isSymbolicLink()) {
    throw new Error(`Lock file ${lockFile} is a symlink/junction and is REJECTED rather than followed (SPEC-005 §5.1.14 rule 4)`);
  }
}

/**
 * Complete descriptor write: `write` may transfer fewer bytes than requested
 * (disk-full, rlimit, signal), so loop on the byte offset until the whole
 * buffer lands. Operates on UTF-8 bytes (never string slices) so multibyte
 * characters cannot split.
 */
function writeAllSync(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let written = 0;
  while (written < bytes.length) {
    const count = writeSync(fd, bytes.subarray(written));
    if (count <= 0) {
      throw new Error(`Short write while persisting lock file (${written}/${bytes.length} bytes)`);
    }
    written += count;
  }
}

let lockTempCounter = 0;

/**
 * Crash-safe lock persistence (§5.1.10 rule 4): serialize to a temporary
 * sibling and atomically rename over the lock path, so a failed write can
 * never leave a truncated lock behind. The temp file is created EXCLUSIVELY
 * (O_CREAT|O_EXCL, flag "wx"): creation fails when the name already exists
 * and NEVER follows a pre-existing symlink, so a planted tmp-path link
 * cannot redirect the write — collisions retry with a fresh unique name.
 * rename replaces a symlink itself rather than its target, and lock-path
 * symlinks are refused above in any case.
 */
function writeLockAtomically(lockFile: string, text: string): void {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    lockTempCounter += 1;
    // Deterministic first candidate (attack-testable), unique on retry.
    const tempFile =
      attempt === 0 ? `${lockFile}.tmp` : `${lockFile}.tmp-${Date.now()}-${lockTempCounter}`;
    let fd: number;
    try {
      fd = openSync(tempFile, "wx");
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") continue;
      throw error;
    }
    // Any failure below removes the temp file best-effort and rethrows the
    // ORIGINAL error: write/close failures must not leak `.tmp` siblings
    // (repeated leaks would collide with future candidates).
    try {
      try {
        writeAllSync(fd, text);
      } catch (error) {
        try {
          closeSync(fd);
        } catch {
          // The write error takes precedence over a close error here.
        }
        throw error;
      }
      closeSync(fd);
      renameSync(tempFile, lockFile);
    } catch (error) {
      try {
        rmSync(tempFile, { force: true });
      } catch {
        // Best-effort temp cleanup only; the original error propagates.
      }
      throw error;
    }
    return;
  }
  throw new Error(`Could not create a temporary lock file next to ${lockFile} (6 name collisions)`);
}

/**
 * Reads a previous adjacent lock leniently for diff purposes ONLY: the file
 * must be well-formed (self-consistent shape), but its config hash is NOT
 * required to match the current config — a stale lock is exactly what
 * --refresh exists to replace. Returns undefined when no usable previous
 * lock exists (fresh create, missing/corrupt file → all-added diff).
 */
function readPreviousLockForDiff(lockFile: string): ProjectLockV1 | undefined {
  let text: string;
  try {
    text = readFileSync(lockFile, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const embedded = (parsed as Record<string, unknown>).generated_from;
  if (typeof embedded !== "object" || embedded === null || Array.isArray(embedded)) {
    return undefined;
  }
  const embeddedHash = (embedded as Record<string, unknown>).config_hash;
  if (typeof embeddedHash !== "string") {
    return undefined;
  }
  try {
    return validateLockfile(parsed, embeddedHash);
  } catch {
    return undefined;
  }
}

/**
 * Generates the eligible-catalog lock (SPEC-005 §5.1.9–§5.1.10, EGA-616):
 * `lock` creates the initial `.egaskills.lock` adjacent to the discovered
 * config and refuses when one already exists (use --refresh); `lock
 * --refresh` regenerates unconditionally and reports the +/-/~ diff.
 * Generation is fail-closed (refreshLock throws on integrity problems) and
 * the existing lock is written ONLY after a successful generation, so a
 * failed run leaves any previous lock UNCHANGED (§5.1.10 rule 4).
 */
export async function runLock(options: LockCommandOptions): Promise<LockCommandResult> {
  const discovery = discoverConfig(options.project ?? ".");
  if (discovery.configPath === null) {
    throw new Error("No .egaskills.yaml found — run `ega-skills init` first.");
  }
  const lockFile = join(dirname(discovery.configPath), ".egaskills.lock");
  refuseSymlinkLock(lockFile);
  const previous = readPreviousLockForDiff(lockFile);
  if (previous !== undefined && options.refresh !== true) {
    throw new Error(`Lock already exists: ${lockFile} (use --refresh to regenerate it)`);
  }
  const config = parseProjectConfig(readFileSync(discovery.configPath, "utf8"));
  const result = refreshLock(
    { registryHome: resolveRegistryHome(options.env), config },
    previous,
  );
  writeLockAtomically(lockFile, serializeLockfile(result.lock));
  return {
    path: lockFile,
    created: options.refresh !== true,
    diff: result.diff,
    skills: Object.keys(result.lock.skills).length,
  };
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
