// 1.1[D] exact update application (EGA-626). Contract B sections 5-6.
//
// Applies ONE approved UpdatePlan to the adopted Hub state, exactly as
// described: plan digest, config binding, stale check, exact commit, stage
// digest verification, destination cleanliness, full-Hub validation — then
// the crash-safe swap from journal.ts. Never re-resolves the tracked ref.
// The server (and this function) NEVER mutates the caller's project files;
// it mutates only the Hub directory it owns.

import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, writeSync } from "node:fs";
import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { verifyEnvelope } from "@ega-skills/hashing";
import { HubError } from "./errors.js";
import { COMMIT_RE, SHA256_RE, assertRelativePosix, assertSortedUnique, assertSourceId, isPlainObject } from "./guards.js";
import {
  clearJournal,
  durableRename,
  readJournal,
  recoverIfNeeded,
  removePathDurable,
  requireCleanJournal,
  syncDirectory,
  writeFileAtomic,
  writeFileDurable,
  writeJournal,
} from "./journal.js";
import type { HubJournal } from "./journal.js";
import { digestStagedTree } from "./quarantine.js";
import { parseSourcesLockYaml, type SourceLockRecord } from "./sources-lock.js";
import type { UpdatePlanDocument } from "./planning.js";
import { buildHub } from "./builder.js";
import { parseHubYaml } from "./hub-config.js";
import { adoptedSourcePath } from "./paths.js";

export interface HubLock {
  release(): void;
}

function lockPath(hubDir: string): string {
  return join(hubDir, ".hub.lock");
}

interface HubLockOwner {
  readonly pid: number;
  readonly token: string;
}

let lockGeneration = 0;

function uniqueLockToken(): string {
  lockGeneration += 1;
  const nodeProcess = (globalThis as { process?: { pid?: number } }).process;
  return createHash("sha256")
    .update(new TextEncoder().encode(`${nodeProcess?.pid ?? 0}:${Date.now()}:${lockGeneration}:${Math.random()}`))
    .digest("hex");
}

function readLockOwner(path: string): HubLockOwner | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value) || typeof value["pid"] !== "number" || !Number.isInteger(value["pid"]) || value["pid"] < 1 || typeof value["token"] !== "string" || value["token"].length === 0) {
      return undefined;
    }
    return { pid: value["pid"], token: value["token"] };
  } catch {
    return undefined;
  }
}

function readLockMarker(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

interface LockSnapshot {
  readonly kind: "file" | "directory" | "invalid";
  readonly marker: string | undefined;
  readonly ownerPath: string | undefined;
}

function readLockSnapshot(path: string): LockSnapshot | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (stat.isFile()) return { kind: "file", marker: readLockMarker(path), ownerPath: undefined };
  if (!stat.isDirectory()) return { kind: "invalid", marker: undefined, ownerPath: undefined };
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return { kind: "invalid", marker: undefined, ownerPath: undefined };
  }
  const owners = entries.filter((entry) => entry.name.startsWith("owner."));
  if (owners.length !== 1 || !owners[0]?.isFile()) return { kind: "directory", marker: undefined, ownerPath: undefined };
  const ownerPath = join(path, owners[0].name);
  return { kind: "directory", marker: readLockMarker(ownerPath), ownerPath };
}

function lockOwnerIsAlive(path: string): boolean {
  const snapshot = readLockSnapshot(path);
  const owner = snapshot?.marker;
  if (owner === undefined) return true;
  // Empty or malformed markers fail closed. Numeric markers remain readable
  // for recovery of hubs written by the previous implementation.
  const parsed = readLockOwner(snapshot?.ownerPath ?? path);
  const pid = parsed?.pid ?? (/^\d+$/.test(owner) ? Number(owner) : undefined);
  if (pid === undefined) return true;
  try {
    const nodeProcess = (globalThis as { process?: { kill(pid: number, signal: number): void } }).process;
    if (nodeProcess === undefined) return true;
    nodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

function createLockOwner(path: string): { owner: HubLockOwner; marker: string; ownerPath: string } {
  const nodeProcess = (globalThis as { process?: { pid?: number } }).process;
  const owner: HubLockOwner = {
    pid: typeof nodeProcess?.pid === "number" ? nodeProcess.pid : 0,
    token: uniqueLockToken(),
  };
  mkdirSync(path);
  const ownerPath = join(path, `owner.${owner.token}`);
  const marker = JSON.stringify(owner);
  try {
    const fd = openSync(ownerPath, "wx");
    try {
      writeSync(fd, marker);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(ownerPath, { force: true });
    try { rmdirSync(path); } catch { /* another contender may be recovering it */ }
    throw error;
  }
  return { marker, owner, ownerPath };
}

/** Exclusive Hub mutation lock (create-exclusive; held locks fail closed).
 *
 *  Crash-kill escape hatch (deliberate, documented): this lock is a
 *  best-effort mutual-exclusion aid, NOT the recovery authority — the journal
 *  is. A kill -9 between acquire and release leaves `.hub.lock` behind while
 *  the journal records exactly how far the swap went. Recovery: confirm no
 *  live Hub process holds the directory, run recovery (which restores exact
 *  state from backup), then remove the stale `.hub.lock`. Never remove the
 *  lock while another process may be mutating: two live mutators corrupt.
 */
export function acquireHubLock(hubDir: string): HubLock {
  mkdirSync(hubDir, { recursive: true });
  const path = lockPath(hubDir);
  let created: { owner: HubLockOwner; marker: string; ownerPath: string };
  try {
    created = createLockOwner(path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST" || readJournal(hubDir) === null || lockOwnerIsAlive(path)) {
      throw new HubError("E_HUB_LOCKED", "hub mutation lock is held by another process");
    }
    const snapshot = readLockSnapshot(path);
    if (snapshot?.kind === "directory") {
      if (snapshot.ownerPath !== undefined && snapshot.marker !== undefined) {
        if (lockOwnerIsAlive(path)) throw new HubError("E_HUB_LOCKED", "hub mutation lock is held by another process");
        // Remove only the exact stale owner's token. A replacement lock has a
        // different owner filename, so it cannot be affected by this unlink.
        try {
          rmSync(snapshot.ownerPath, { force: false });
        } catch {
          throw new HubError("E_HUB_LOCKED", "hub mutation lock owner changed during reclamation");
        }
      }
      // rmdir succeeds only for the empty directory just reclaimed. A new
      // owner directory (which contains its own tokenized marker) survives.
      try {
        rmdirSync(path);
      } catch {
        throw new HubError("E_HUB_LOCKED", "hub mutation lock is held by another process");
      }
    } else if (snapshot?.kind === "file" && snapshot.marker !== undefined) {
      // Compatibility for a stale file lock written by the previous binary.
      // A directory replacement cannot be unlinked by this file-only removal.
      try {
        rmSync(path, { force: false });
      } catch {
        throw new HubError("E_HUB_LOCKED", "hub mutation lock owner changed during reclamation");
      }
    } else {
      throw new HubError("E_HUB_LOCKED", "hub mutation lock owner cannot be read");
    }
    try {
      created = createLockOwner(path);
    } catch {
      throw new HubError("E_HUB_LOCKED", "hub mutation lock is held by another process");
    }
  }
  const { owner, marker, ownerPath } = created;
  let released = false;
  return {
    release() {
      if (!released) {
        released = true;
        const current = readLockSnapshot(path);
        if (current?.kind === "directory" && current.ownerPath === ownerPath && current.marker === marker) {
          rmSync(ownerPath, { force: false });
          try { rmdirSync(path); } catch { /* a replacement owner now holds the directory */ }
        }
      }
    },
  };
}

export interface ApplyInput {
  hubDir: string;
  plan: UpdatePlanDocument;
  /** Existing staged tree for internal callers, or a locked preparation hook. */
  stageDir?: string;
  prepareStage?: (stageDir: string) => void | Promise<void>;
}

function busyGuard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    // Windows: an open file blocking rename surfaces here. Never continue
    // half-swapped; the journal records exactly how far the swap went.
    if (e instanceof HubError) throw e;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new HubError("E_HUB_LOCKED", `hub busy (file locked by another process): ${String(code)}`);
    }
    throw e;
  }
}

function copyDirTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  syncDirectory(dirname(dest));
  syncDirectory(dest);
  const entries: Dirent[] = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      throw new HubError("E_EXTRACTION_POLICY", `symlink forbidden in staged tree: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      copyDirTree(from, to);
    } else if (entry.isFile()) {
      writeFileDurable(to, readFileSync(from));
    } else {
      throw new HubError("E_EXTRACTION_POLICY", `non-regular file forbidden in staged tree: ${entry.name}`);
    }
  }
}

/** Build the candidate lock and all adopted trees in isolation. This keeps
 * global catalog/alias/import invariants outside the irreversible swap. */
async function validateProspectiveHub(hubDir: string, sourceId: string, stageDir: string, lockText: string): Promise<void> {
  const prospective = mkdtempSync(join(tmpdir(), "ega-hub-prospective-"));
  let registryHome: string | undefined;
  try {
    for (const file of ["hub.yaml", "sources.yaml"]) {
      writeFileDurable(join(prospective, file), readFileSync(join(hubDir, file)));
    }
    writeFileDurable(join(prospective, "sources.lock.yaml"), lockText);
    const hub = parseHubYaml(readFileSync(join(hubDir, "hub.yaml"), "utf8"));
    for (const owned of hub.owned) {
      const source = join(hubDir, ...owned.path.split("/"));
      const target = join(prospective, ...owned.path.split("/"));
      if (!existsSync(source)) {
        throw new HubError("E_LOCK_MISMATCH", `expected Hub path missing: ${owned.path}`);
      }
      if (lstatSync(source).isSymbolicLink()) {
        throw new HubError("E_EXTRACTION_POLICY", `symlink forbidden in Hub owned root: ${owned.path}`);
      }
      copyDirTree(source, target);
    }
    const adoptedExternal = join(hubDir, "external");
    mkdirSync(join(prospective, "external"), { recursive: true });
    for (const name of readdirSync(adoptedExternal)) {
      const sourceTree = adoptedSourcePath(hubDir, name);
      const targetTree = adoptedSourcePath(prospective, name);
      if (name === sourceId) copyDirTree(stageDir, targetTree);
      else copyDirTree(sourceTree, targetTree);
    }
    const built = await buildHub(prospective);
    registryHome = built.registryHome;
  } finally {
    if (registryHome !== undefined) rmSync(registryHome, { force: true, recursive: true });
    rmSync(prospective, { force: true, recursive: true });
  }
}

interface VerifiedPlan {
  sourceId: string;
  targetCommit: string;
  newTreeDigest: string;
  newSnapshotDigest: string;
  expectedCommit: string;
  expectedTreeDigest: string;
  sourceConfigDigest: string;
}

const PLAN_KEYS = [
  "added_skills",
  "changed_skills",
  "expected_old",
  "extraction_contract",
  "new_selected_tree_digest",
  "new_vendored_snapshot_digest",
  "provenance_changes",
  "removed_skills",
  "source_config_digest",
  "source_id",
  "target_commit",
  "unselected_new_skills",
] as const;
const EXPECTED_OLD_KEYS = ["resolved_commit", "selected_skill_tree_digest"] as const;
const SKILL_KEYS = ["skill_ref", "version_hash"] as const;
const CHANGED_SKILL_KEYS = ["canonical_changed", "new_version", "old_version", "raw_changed", "skill_ref"] as const;
const MUTABLE_REF_KEYS = new Set(["ref", "target_ref", "branch", "rev"]);
const SKILL_REF_RE = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], what: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new HubError("E_PLAN_SCHEMA", `${what} has unknown or missing fields`);
  }
}

function rejectPlanNulls(value: unknown, path: string): void {
  if (value === null) throw new HubError("E_PLAN_SCHEMA", `${path} must not be null`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectPlanNulls(entry, `${path}[${index}]`));
  } else if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, entry]) => rejectPlanNulls(entry, `${path}.${key}`));
  }
}

function rejectMutablePlanRefs(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectMutablePlanRefs(entry, `${path}[${index}]`));
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (MUTABLE_REF_KEYS.has(key)) {
        throw new HubError("E_PLAN_REFETCH", `plan must not carry "${key}" (exact commit only)`);
      }
      rejectMutablePlanRefs(entry, `${path}.${key}`);
    }
  }
}

function requirePlanList(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new HubError("E_PLAN_SCHEMA", `plan payload ${field} must be a list`);
  return value;
}

function requireSortedPlanStrings(value: unknown, field: string): string[] {
  const list = requirePlanList(value, field);
  if (list.some((entry) => typeof entry !== "string")) {
    throw new HubError("E_PLAN_SCHEMA", `plan payload ${field} entries must be strings`);
  }
  const strings = list as string[];
  try {
    assertSortedUnique(strings, `plan payload ${field}`);
    for (const entry of strings) assertRelativePosix(entry, `plan payload ${field}`);
  } catch {
    throw new HubError("E_PLAN_SCHEMA", `plan payload ${field} must contain sorted unique relative paths`);
  }
  return strings;
}

function requireSkillRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !SKILL_REF_RE.test(value)) {
    throw new HubError("E_PLAN_SCHEMA", `plan ${field} must be a namespace/name reference`);
  }
  return value;
}

function requireSkillEntries(value: unknown, field: "added_skills" | "removed_skills"): string[] {
  const list = requirePlanList(value, field);
  const refs: string[] = [];
  for (const [index, entry] of list.entries()) {
    if (!isPlainObject(entry)) throw new HubError("E_PLAN_SCHEMA", `plan payload ${field}[${index}] must be an object`);
    requireExactKeys(entry, SKILL_KEYS, `plan payload ${field}[${index}]`);
    refs.push(requireSkillRef(entry["skill_ref"], `payload ${field}[${index}].skill_ref`));
    if (typeof entry["version_hash"] !== "string" || !SHA256_RE.test(entry["version_hash"])) {
      throw new HubError("E_PLAN_SCHEMA", `plan payload ${field}[${index}].version_hash must match sha256:<64hex>`);
    }
  }
  try {
    assertSortedUnique(refs, `plan payload ${field} skill_ref`);
  } catch {
    throw new HubError("E_PLAN_SCHEMA", `plan payload ${field} must be sorted and unique by skill_ref`);
  }
  return refs;
}

function requireChangedSkills(value: unknown): void {
  const list = requirePlanList(value, "changed_skills");
  const refs: string[] = [];
  for (const [index, entry] of list.entries()) {
    if (!isPlainObject(entry)) throw new HubError("E_PLAN_SCHEMA", `plan payload changed_skills[${index}] must be an object`);
    requireExactKeys(entry, CHANGED_SKILL_KEYS, `plan payload changed_skills[${index}]`);
    refs.push(requireSkillRef(entry["skill_ref"], `payload changed_skills[${index}].skill_ref`));
    for (const version of ["old_version", "new_version"] as const) {
      if (typeof entry[version] !== "string" || !SHA256_RE.test(entry[version])) {
        throw new HubError("E_PLAN_SCHEMA", `plan payload changed_skills[${index}].${version} must match sha256:<64hex>`);
      }
    }
    for (const flag of ["raw_changed", "canonical_changed"] as const) {
      if (typeof entry[flag] !== "boolean") {
        throw new HubError("E_PLAN_SCHEMA", `plan payload changed_skills[${index}].${flag} must be boolean`);
      }
    }
  }
  try {
    assertSortedUnique(refs, "plan payload changed_skills skill_ref");
  } catch {
    throw new HubError("E_PLAN_SCHEMA", "plan payload changed_skills must be sorted and unique by skill_ref");
  }
}

function verifyPlanShape(plan: UpdatePlanDocument): VerifiedPlan {
  const doc = plan as unknown;
  if (!isPlainObject(doc)) {
    throw new HubError("E_PLAN_SCHEMA", "plan must be an object");
  }
  if (doc["object_type"] !== "ega.update-plan" || doc["schema_version"] !== 1) {
    throw new HubError("E_PLAN_SCHEMA", "plan must be an ega.update-plan schema_version 1");
  }
  const verified = verifyEnvelope(doc);
  if (!verified.ok) {
    throw new HubError(
      verified.code === "E_ARTIFACT_DIGEST" ? "E_PLAN_DIGEST" : "E_PLAN_SCHEMA",
      `plan envelope invalid: ${verified.message}`,
    );
  }
  rejectPlanNulls(doc, "plan");
  rejectMutablePlanRefs(doc["payload"], "plan.payload");
  const payload = doc["payload"];
  if (!isPlainObject(payload)) {
    throw new HubError("E_PLAN_SCHEMA", "plan payload must be an object");
  }
  requireExactKeys(payload, PLAN_KEYS, "plan payload");
  const text = (field: string): string => {
    if (typeof payload[field] !== "string") {
      throw new HubError("E_PLAN_SCHEMA", `plan payload ${field} must be a string`);
    }
    return payload[field] as string;
  };
  const targetCommit = text("target_commit");
  const sourceId = text("source_id");
  assertSourceId(sourceId, "plan payload source_id", "E_PLAN_SCHEMA");
  if (!COMMIT_RE.test(targetCommit)) {
    throw new HubError("E_PLAN_COMMIT", "plan target_commit must be 40 lowercase hex");
  }
  const expected = payload["expected_old"];
  if (!isPlainObject(expected)) {
    throw new HubError("E_PLAN_SCHEMA", "plan payload expected_old must be an object");
  }
  requireExactKeys(expected, EXPECTED_OLD_KEYS, "plan payload expected_old");
  if (typeof expected["resolved_commit"] !== "string" || !COMMIT_RE.test(expected["resolved_commit"] as string)) {
    throw new HubError("E_PLAN_COMMIT", "plan expected_old.resolved_commit must be 40 lowercase hex");
  }
  if (typeof expected["selected_skill_tree_digest"] !== "string" || !SHA256_RE.test(expected["selected_skill_tree_digest"] as string)) {
    throw new HubError("E_PLAN_SCHEMA", "plan expected_old.selected_skill_tree_digest must match sha256:<64hex>");
  }
  for (const field of ["new_selected_tree_digest", "new_vendored_snapshot_digest"] as const) {
    if (typeof payload[field] !== "string" || !SHA256_RE.test(payload[field] as string)) {
      throw new HubError("E_PLAN_SCHEMA", `plan payload ${field} must match sha256:<64hex>`);
    }
  }
  if (payload["extraction_contract"] !== 1) {
    throw new HubError("E_PLAN_SCHEMA", "plan extraction_contract must be 1 (this binary understands contract v1 only)");
  }
  if (typeof payload["source_config_digest"] !== "string" || !SHA256_RE.test(payload["source_config_digest"] as string)) {
    throw new HubError("E_PLAN_SCHEMA", "plan source_config_digest must match sha256:<64hex>");
  }
  requireSkillEntries(payload["added_skills"], "added_skills");
  requireSkillEntries(payload["removed_skills"], "removed_skills");
  requireChangedSkills(payload["changed_skills"]);
  requireSortedPlanStrings(payload["unselected_new_skills"], "unselected_new_skills");
  requireSortedPlanStrings(payload["provenance_changes"], "provenance_changes");
  return {
    expectedCommit: expected["resolved_commit"] as string,
    expectedTreeDigest: expected["selected_skill_tree_digest"] as string,
    newSnapshotDigest: payload["new_vendored_snapshot_digest"] as string,
    newTreeDigest: payload["new_selected_tree_digest"] as string,
    sourceConfigDigest: payload["source_config_digest"] as string,
    sourceId,
    targetCommit,
  };
}

export async function applyUpdatePlan(input: ApplyInput): Promise<{ record: SourceLockRecord }> {
  const { hubDir, plan, stageDir: suppliedStageDir, prepareStage } = input;
  if (suppliedStageDir === undefined && prepareStage === undefined) {
    throw new HubError("E_PLAN_SCHEMA", "apply requires a staged tree or locked stage preparation");
  }
  // The caller-supplied plan is untrusted. Parse and verify its complete
  // immutable schema before acquiring the mutation lock or entering recovery.
  const verified = verifyPlanShape(plan);
  const lock = acquireHubLock(hubDir);
  let ownedStageDir: string | undefined;
  try {
    // Recovery mutates Hub state, so it must happen under the same exclusive
    // lock as the update itself. Contract B still requires stage -> PREPARED.
    recoverIfNeeded(hubDir);
    requireCleanJournal(hubDir);
    const lockFile = join(hubDir, "sources.lock.yaml");
    let lockText: string;
    try {
      lockText = readFileSync(lockFile, "utf8");
    } catch {
      throw new HubError("E_LOCK_MISMATCH", "hub lock file missing");
    }
    const adopted = parseSourcesLockYaml(lockText);
    const current = adopted.sources[verified.sourceId];
    if (!current) {
      throw new HubError("E_LOCK_MISMATCH", `plan source ${verified.sourceId} is not adopted`);
    }
    if (
      current.resolved_commit !== verified.expectedCommit ||
      current.selected_skill_tree_digest !== verified.expectedTreeDigest
    ) {
      throw new HubError("E_PLAN_STALE", "plan expected_old no longer matches adopted state");
    }
    // Contract B section 5: the plan binds the exact adopted configuration.
    // A plan built for different sources.yaml intent (roots, provenance,
    // ref) is not stale — it is a foreign plan and must be refused.
    if (current.source_config_digest !== verified.sourceConfigDigest) {
      throw new HubError("E_LOCK_MISMATCH", "plan source_config_digest does not match adopted configuration");
    }
    let stageDir = suppliedStageDir;
    if (stageDir === undefined && prepareStage !== undefined) {
      ownedStageDir = mkdtempSync(join(tmpdir(), "ega-hub-apply-stage-"));
      await prepareStage(ownedStageDir);
      stageDir = ownedStageDir;
    }
    if (stageDir === undefined) throw new HubError("E_PLAN_SCHEMA", "apply stage was not prepared");
    // The staged tree must be exactly what the plan describes.
    const staged = digestStagedTree(stageDir, current.selection.roots);
    if (staged.treeDigest !== verified.newTreeDigest || staged.snapshotDigest !== verified.newSnapshotDigest) {
      throw new HubError("E_PLAN_DIGEST", "staged tree does not match the approved plan");
    }
    // Destination cleanliness + full-Hub validation before committing.
    const staging = join(hubDir, ".staging");
    const backup = join(hubDir, ".backup");
    // A process can die after constructing the stage but before PREPARED is
    // durable. With no journal, the orphan is safe to discard while holding
    // the lock; this preserves Contract B's stage-before-PREPARED ordering.
    if (!readJournal(hubDir) && existsSync(staging) && !existsSync(backup)) {
      removePathDurable(staging);
    }
    if (existsSync(staging) || existsSync(backup) || readJournal(hubDir)) {
      throw new HubError("E_LOCK_MISMATCH", "hub destination not clean (staging/backup/journal remnants)");
    }
    const liveTree = adoptedSourcePath(hubDir, verified.sourceId);
    if (!existsSync(liveTree)) {
      throw new HubError("E_LOCK_MISMATCH", `adopted tree missing for ${verified.sourceId}`);
    }
    const record: SourceLockRecord = {
      ...current,
      resolved_commit: verified.targetCommit,
      selected_skill_tree_digest: staged.treeDigest,
      vendored_snapshot_digest: staged.snapshotDigest,
    };
    const stagedSources: Record<string, SourceLockRecord> = {};
    for (const name of Object.keys(adopted.sources)) {
      stagedSources[name] = name === verified.sourceId ? record : (adopted.sources[name] as SourceLockRecord);
    }
    const newLockText = stringifyYaml({ schema_version: 1, sources: stagedSources });
    // Validate the complete candidate Hub before opening the journal. The
    // real adopted tree and lock remain untouched if any global invariant
    // fails, including duplicate IDs or malformed imported skills.
    await validateProspectiveHub(hubDir, verified.sourceId, stageDir, newLockText);
    // Build + validate the staged tree, then open the journal.
    busyGuard(() => copyDirTree(stageDir, join(staging, verified.sourceId)));
    const journal: HubJournal = {
      backup: ".backup",
      expected_old_commit: verified.expectedCommit,
      journal_version: 1,
      source_id: verified.sourceId,
      staging: ".staging",
      state: "PREPARED",
      target_commit: verified.targetCommit,
    };
    writeJournal(hubDir, journal);
    // Preserve the old tree + lock, install the staged tree.
    busyGuard(() => {
      mkdirSync(backup, { recursive: true });
      syncDirectory(dirname(backup));
      syncDirectory(backup);
      durableRename(liveTree, join(backup, verified.sourceId));
      writeFileDurable(join(backup, "sources.lock.yaml"), lockText);
      durableRename(join(staging, verified.sourceId), liveTree);
    });
    writeJournal(hubDir, { ...journal, state: "TREE_SWAPPED" });
    // Atomically install the new lock.
    busyGuard(() => writeFileAtomic(lockFile, newLockText));
    writeJournal(hubDir, { ...journal, state: "LOCK_SWAPPED" });
    // Verify the complete adopted state, then commit.
    const reread = parseSourcesLockYaml(readFileSync(lockFile, "utf8"));
    const landed = reread.sources[verified.sourceId];
    if (!landed || landed.resolved_commit !== verified.targetCommit) {
      throw new HubError("E_LOCK_MISMATCH", "adopted lock verification failed after install");
    }
    const reverified = digestStagedTree(liveTree, landed.selection.roots);
    if (reverified.treeDigest !== verified.newTreeDigest || reverified.snapshotDigest !== verified.newSnapshotDigest) {
      throw new HubError("E_LOCK_MISMATCH", "adopted tree verification failed after install");
    }
    writeJournal(hubDir, {
      expected_old_commit: journal.expected_old_commit,
      journal_version: journal.journal_version,
      source_id: journal.source_id,
      state: "COMMITTED",
      target_commit: journal.target_commit,
    });
    busyGuard(() => {
      removePathDurable(backup);
      removePathDurable(staging);
    });
    clearJournal(hubDir);
    return { record };
  } finally {
    if (ownedStageDir !== undefined) rmSync(ownedStageDir, { force: true, recursive: true });
    lock.release();
  }
}
