// 1.1[D] crash-safe update journal (EGA-626). Contract B sections 6-7.
//
// One Hub, one exclusive mutation, one journal file. Every mutating Hub
// command reads the journal FIRST: an incomplete journal is either resumed
// or restored to the exact previous adopted state before anything else runs.
// `hub build` refuses while recovery is incomplete (E_RECOVERY_REQUIRED).
//
// Journal paths are Hub-relative (portable); live layout:
//   external/<source>/repo/... adopted vendored tree
//   sources.lock.yaml    adopted lock
//   .staging/            incoming tree + lock under construction
//   .backup/             previous tree + lock preserved across the swap
//   .hub-journal.json    this journal

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { HubError } from "./errors.js";
import { COMMIT_RE, SHA256_RE, assertSourceId, isPlainObject } from "./guards.js";
import { adoptedSourcePath } from "./paths.js";
import { digestStagedTree } from "./quarantine.js";
import { parseSourcesLockYaml } from "./sources-lock.js";
import { acquireOwnerTokenLock } from "./mutation-lock.js";

export type JournalState = "PREPARED" | "TREE_SWAPPED" | "LOCK_SWAPPED" | "COMMITTED";

interface JournalIdentity {
  journal_version: 1;
  source_id: string;
  expected_old_commit: string;
  target_commit: string;
}

export interface IncompleteJournal extends JournalIdentity {
  staging: string;
  backup: string;
  state: Exclude<JournalState, "COMMITTED">;
}

export interface CommittedJournal extends JournalIdentity {
  state: "COMMITTED";
}

export type HubJournal = IncompleteJournal | CommittedJournal;

export type AdoptionJournalState = "PREPARED" | "SWAPPING" | "COMMITTED";

export interface AdoptionJournalEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly old_digest: string | null;
  readonly new_digest: string;
  readonly stage: string;
  readonly backup: string;
}

export interface AdoptionJournal {
  readonly journal_version: 2;
  readonly operation: "ADOPTION";
  readonly operation_id: string;
  readonly expected_old_state_digest: string;
  readonly target_state_digest: string;
  readonly allowed_paths: readonly string[];
  readonly staging: string;
  readonly backup: string;
  readonly entries: readonly AdoptionJournalEntry[];
  readonly swapped_paths: readonly string[];
  readonly state: AdoptionJournalState;
}

const STATES: readonly string[] = ["PREPARED", "TREE_SWAPPED", "LOCK_SWAPPED", "COMMITTED"];

export function journalPath(hubDir: string): string {
  return join(hubDir, ".hub-journal.json");
}

function syncFile(path: string): void {
  // NOTE (Windows): fsync requires a writable handle — "r" fails EPERM.
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Sync directory metadata where the platform exposes directory fsync. */
export function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    // Windows does not expose POSIX directory handles. File fsync plus the
    // successful rename remains the strongest supported guarantee there.
    if (!["EINVAL", "EISDIR", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(String(code))) throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeFileDurable(path: string, data: string | Uint8Array): void {
  writeFileSync(path, data);
  syncFile(path);
  syncDirectory(dirname(path));
}

export function durableRename(from: string, to: string): void {
  syncDirectory(dirname(from));
  renameSync(from, to);
  syncDirectory(dirname(from));
  if (dirname(from) !== dirname(to)) syncDirectory(dirname(to));
}

export function removePathDurable(path: string): void {
  rmSync(path, { force: true, recursive: true });
  syncDirectory(dirname(path));
}

/** Durable atomic file write: temp + fsync + rename + parent-directory sync. */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  syncFile(tmp);
  durableRename(tmp, path);
}

function checkJournalShape(value: unknown): asserts value is HubJournal {
  if (!isPlainObject(value)) {
    throw new HubError("E_JOURNAL_SCHEMA", "journal must be an object");
  }
  const state = value["state"];
  const allowed = state === "COMMITTED"
    ? ["journal_version", "source_id", "expected_old_commit", "target_commit", "state"]
    : ["journal_version", "source_id", "expected_old_commit", "target_commit", "staging", "backup", "state"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new HubError("E_JOURNAL_SCHEMA", `journal unknown field "${key}"`);
    }
  }
  if (value["journal_version"] !== 1) {
    throw new HubError("E_JOURNAL_SCHEMA", "journal journal_version must be 1");
  }
  assertSourceId(value["source_id"], "journal source_id", "E_JOURNAL_SCHEMA");
  for (const field of ["expected_old_commit", "target_commit"] as const) {
    if (typeof value[field] !== "string" || !COMMIT_RE.test(value[field] as string)) {
      throw new HubError("E_JOURNAL_SCHEMA", `journal ${field} must be 40 lowercase hex`);
    }
  }
  if (state !== "COMMITTED") {
    for (const field of ["staging", "backup"] as const) {
      if (typeof value[field] !== "string" || (value[field] as string).length === 0) {
        throw new HubError("E_JOURNAL_SCHEMA", `journal ${field} must be a non-empty Hub-relative path`);
      }
    }
  }
  if (typeof state !== "string" || !STATES.includes(state)) {
    throw new HubError("E_JOURNAL_STATE", `journal state must be one of ${STATES.join("/")}`);
  }
  for (const [, entry] of Object.entries(value)) {
    if (entry === null) {
      throw new HubError("E_JOURNAL_SCHEMA", "journal must not contain null");
    }
  }
}

interface JournalPaths {
  staging: string;
  backup: string;
  backupTree: string;
  backupLock: string;
  liveTree: string;
  liveLock: string;
}

function confinedJournalPath(hubDir: string, value: string, field: string): string {
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").includes("..")) {
    throw new HubError("E_JOURNAL_SCHEMA", `journal ${field} must remain beneath the Hub directory`);
  }
  const root = resolve(hubDir);
  const candidate = resolve(root, value);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new HubError("E_JOURNAL_SCHEMA", `journal ${field} must remain beneath the Hub directory`);
  }
  return candidate;
}

export function adoptionJournalPath(hubDir: string): string {
  return join(hubDir, ".adoption-journal.json");
}

const ADOPTION_STATES: readonly string[] = ["PREPARED", "SWAPPING", "COMMITTED"];

function checkAdoptionTarget(root: string, value: string, field: string): string {
  const ownedPath = /^(?:hub\.yaml|sources\.yaml|sources\.lock\.yaml|external\/[a-z0-9][a-z0-9-]*\/repo|owned\/[a-z0-9][a-z0-9-]*|\.intake-provenance\/[a-z0-9][a-z0-9-]*\.json)$/;
  if (!ownedPath.test(value)) {
    throw new HubError("E_JOURNAL_SCHEMA", `adoption journal ${field} is not an owned Hub path`);
  }
  return confinedJournalPath(root, value, field);
}

function checkAdoptionJournalShape(value: unknown): asserts value is AdoptionJournal {
  if (!isPlainObject(value)) throw new HubError("E_JOURNAL_SCHEMA", "adoption journal must be an object");
  const allowed = ["journal_version", "operation", "operation_id", "expected_old_state_digest", "target_state_digest", "allowed_paths", "staging", "backup", "entries", "swapped_paths", "state"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new HubError("E_JOURNAL_SCHEMA", "adoption journal has unknown fields");
  if (value["journal_version"] !== 2 || value["operation"] !== "ADOPTION") throw new HubError("E_JOURNAL_SCHEMA", "adoption journal version or operation is invalid");
  for (const field of ["operation_id", "expected_old_state_digest", "target_state_digest"] as const) {
    if (typeof value[field] !== "string" || !SHA256_RE.test(value[field] as string)) throw new HubError("E_JOURNAL_SCHEMA", `adoption journal ${field} must be sha256:<64hex>`);
  }
  if (!Array.isArray(value["allowed_paths"]) || !(value["allowed_paths"] as unknown[]).every((entry) => typeof entry === "string")) throw new HubError("E_JOURNAL_SCHEMA", "adoption journal allowed_paths is invalid");
  if (!Array.isArray(value["entries"]) || (value["entries"] as unknown[]).length === 0) throw new HubError("E_JOURNAL_SCHEMA", "adoption journal entries must be non-empty");
  if (!Array.isArray(value["swapped_paths"]) || !(value["swapped_paths"] as unknown[]).every((entry) => typeof entry === "string")) throw new HubError("E_JOURNAL_SCHEMA", "adoption journal swapped_paths is invalid");
  if (typeof value["staging"] !== "string" || typeof value["backup"] !== "string") throw new HubError("E_JOURNAL_SCHEMA", "adoption journal staging and backup are required");
  confinedJournalPath(".", value["staging"] as string, "staging");
  confinedJournalPath(".", value["backup"] as string, "backup");
  if (typeof value["state"] !== "string" || !ADOPTION_STATES.includes(value["state"] as string)) throw new HubError("E_JOURNAL_STATE", "adoption journal state is invalid");
  const paths: string[] = [];
  for (const rawEntry of value["entries"] as unknown[]) {
    if (!isPlainObject(rawEntry)) throw new HubError("E_JOURNAL_SCHEMA", "adoption journal entry must be an object");
    const keys = ["path", "kind", "old_digest", "new_digest", "stage", "backup"];
    if (Object.keys(rawEntry).some((key) => !keys.includes(key))) throw new HubError("E_JOURNAL_SCHEMA", "adoption journal entry has unknown fields");
    if (typeof rawEntry["path"] !== "string" || (rawEntry["kind"] !== "file" && rawEntry["kind"] !== "directory") || (rawEntry["old_digest"] !== null && (typeof rawEntry["old_digest"] !== "string" || !SHA256_RE.test(rawEntry["old_digest"] as string))) || typeof rawEntry["new_digest"] !== "string" || !SHA256_RE.test(rawEntry["new_digest"] as string) || typeof rawEntry["stage"] !== "string" || typeof rawEntry["backup"] !== "string") {
      throw new HubError("E_JOURNAL_SCHEMA", "adoption journal entry is invalid");
    }
    paths.push(rawEntry["path"] as string);
  }
  const allowedPaths = value["allowed_paths"] as string[];
  const swappedPaths = value["swapped_paths"] as string[];
  if (new Set(paths).size !== paths.length || JSON.stringify([...paths].sort()) !== JSON.stringify([...allowedPaths].sort()) || new Set(swappedPaths).size !== swappedPaths.length || swappedPaths.some((path) => !paths.includes(path))) {
    throw new HubError("E_JOURNAL_SCHEMA", "adoption journal path lists are inconsistent");
  }
  if (JSON.stringify([...allowedPaths].sort()) !== JSON.stringify(allowedPaths) || JSON.stringify([...swappedPaths].sort()) !== JSON.stringify(swappedPaths)) throw new HubError("E_JOURNAL_SCHEMA", "adoption journal path lists must be sorted");
}

function adoptionDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new HubError("E_RECOVERY_REQUIRED", `adoption recovery found an unsafe path: ${path}`);
  if (stat.isFile()) return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  return digestStagedTree(path, ["__adoption_no_selected_root__"]).snapshotDigest;
}

export function digestAdoptionPath(path: string): string | null {
  return adoptionDigest(path);
}

function copyAdoptionPath(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new HubError("E_RECOVERY_REQUIRED", `adoption recovery found an unsafe backup path: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) copyAdoptionPath(join(source, entry.name), join(destination, entry.name));
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileDurable(destination, readFileSync(source));
}

function readAdoptionJournalForRoot(hubDir: string, journal: AdoptionJournal): void {
  const root = resolve(hubDir);
  confinedJournalPath(root, journal.staging, "staging");
  confinedJournalPath(root, journal.backup, "backup");
  for (const entry of journal.entries) {
    checkAdoptionTarget(root, entry.path, "entry.path");
    confinedJournalPath(root, entry.stage, "entry.stage");
    confinedJournalPath(root, entry.backup, "entry.backup");
  }
}

export function readAdoptionJournal(hubDir: string): AdoptionJournal | null {
  const path = adoptionJournalPath(hubDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new HubError("E_JOURNAL_SCHEMA", "adoption journal is not valid JSON"); }
  checkAdoptionJournalShape(parsed);
  readAdoptionJournalForRoot(hubDir, parsed);
  return parsed;
}

export function writeAdoptionJournal(hubDir: string, journal: AdoptionJournal): void {
  checkAdoptionJournalShape(journal);
  readAdoptionJournalForRoot(hubDir, journal);
  mkdirSync(hubDir, { recursive: true });
  writeFileAtomic(adoptionJournalPath(hubDir), JSON.stringify(journal, null, 2));
}

export function clearAdoptionJournal(hubDir: string): void {
  removePathDurable(adoptionJournalPath(hubDir));
}

function restoreAdoptionEntry(hubDir: string, entry: AdoptionJournalEntry): void {
  const root = resolve(hubDir);
  const target = checkAdoptionTarget(root, entry.path, "entry.path");
  const backup = confinedJournalPath(root, entry.backup, "entry.backup");
  if (adoptionDigest(target) !== null) removePathDurable(target);
  if (entry.old_digest !== null) {
    if (adoptionDigest(backup) !== entry.old_digest) throw new HubError("E_RECOVERY_REQUIRED", `adoption backup digest mismatch for ${entry.path}`);
    mkdirSync(dirname(target), { recursive: true });
    copyAdoptionPath(backup, target);
  }
  if (adoptionDigest(target) !== entry.old_digest) throw new HubError("E_RECOVERY_REQUIRED", `adoption restore digest mismatch for ${entry.path}`);
}

export function recoverAdoptionIfNeeded(hubDir: string): { recovered: boolean } {
  const journal = readAdoptionJournal(hubDir);
  if (!journal) return { recovered: false };
  const root = resolve(hubDir);
  const staging = confinedJournalPath(root, journal.staging, "staging");
  const backup = confinedJournalPath(root, journal.backup, "backup");
  if (journal.state === "COMMITTED") {
    for (const entry of journal.entries) {
      if (adoptionDigest(checkAdoptionTarget(root, entry.path, "entry.path")) !== entry.new_digest) throw new HubError("E_RECOVERY_REQUIRED", `committed adoption digest mismatch for ${entry.path}`);
    }
    removeIfPresent(staging);
    removeIfPresent(backup);
    clearAdoptionJournal(root);
    return { recovered: true };
  }
  for (const entry of journal.entries) {
    if (entry.old_digest !== null && adoptionDigest(confinedJournalPath(root, entry.backup, "entry.backup")) !== entry.old_digest) {
      throw new HubError("E_RECOVERY_REQUIRED", `adoption backup digest mismatch for ${entry.path}`);
    }
  }
  for (const entry of journal.entries) restoreAdoptionEntry(root, entry);
  removeIfPresent(staging);
  removeIfPresent(backup);
  clearAdoptionJournal(root);
  return { recovered: true };
}

function journalPaths(hubDir: string, journal: HubJournal): JournalPaths {
  const root = resolve(hubDir);
  const staging = journal.state === "COMMITTED"
    ? join(root, ".staging")
    : confinedJournalPath(root, journal.staging, "staging");
  const backup = journal.state === "COMMITTED"
    ? join(root, ".backup")
    : confinedJournalPath(root, journal.backup, "backup");
  return {
    backup,
    backupLock: join(backup, "sources.lock.yaml"),
    backupTree: join(backup, journal.source_id),
    liveLock: join(root, "sources.lock.yaml"),
    liveTree: adoptedSourcePath(root, journal.source_id),
    staging,
  };
}

/** Null when no journal exists. Corrupt journals fail closed. */
export function readJournal(hubDir: string): HubJournal | null {
  const path = journalPath(hubDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new HubError("E_JOURNAL_SCHEMA", "journal is not valid JSON");
  }
  checkJournalShape(parsed);
  journalPaths(hubDir, parsed);
  return parsed;
}

export function writeJournal(hubDir: string, journal: HubJournal): void {
  checkJournalShape(journal as unknown);
  journalPaths(hubDir, journal);
  mkdirSync(hubDir, { recursive: true });
  writeFileAtomic(journalPath(hubDir), JSON.stringify(journal, null, 2));
}

export function clearJournal(hubDir: string): void {
  removePathDurable(journalPath(hubDir));
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) removePathDurable(path);
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

/**
 * Lock/tree consistency check for recovery: the adopted lock must bind the
 * journal's expected previous commit, and the restored tree must match BOTH
 * identities the lock records — the selected skill tree digest AND the
 * vendored snapshot digest (selected roots plus provenance files). A
 * provenance-only edit changes the snapshot without moving the tree digest,
 * so verifying either one alone would accept a backup that is not the exact
 * previous adopted state. Any mismatch fails closed so recovery never
 * reports success over content it could not verify.
 */
function verifyAdoptedState(tree: string, lockPath: string, journal: IncompleteJournal): void {
  let record;
  try {
    const lock = parseSourcesLockYaml(readFileSync(lockPath, "utf8"));
    record = lock.sources[journal.source_id];
  } catch (error) {
    throw new HubError("E_RECOVERY_REQUIRED", `recovery cannot read the adopted lock: ${messageOf(error)}`);
  }
  if (record === undefined || record.resolved_commit !== journal.expected_old_commit) {
    throw new HubError(
      "E_RECOVERY_REQUIRED",
      "recovery lock does not bind the expected previous commit",
    );
  }
  let state;
  try {
    state = digestStagedTree(tree, record.selection.roots);
  } catch (error) {
    throw new HubError("E_RECOVERY_REQUIRED", `recovery cannot verify the adopted tree: ${messageOf(error)}`);
  }
  if (state.treeDigest !== record.selected_skill_tree_digest) {
    throw new HubError("E_RECOVERY_REQUIRED", "recovery tree digest does not match the adopted lock");
  }
  if (state.snapshotDigest !== record.vendored_snapshot_digest) {
    throw new HubError("E_RECOVERY_REQUIRED", "recovery snapshot digest does not match the adopted lock");
  }
}

/**
 * Recover an incomplete mutation: restore the exact previous adopted tree
 * and lock from backup when a backup exists, drop staging remnants, clear
 * the journal. COMMITTED journals only need remnant cleanup.
 *
 * Recovery is idempotent and fail-closed:
 * - The live tree is removed only when a complete backup tree is present and
 *   verified against the lock, so a restored tree is never deleted merely
 *   because a backup lock or other remnant remains.
 * - Backup material is removed only after the restored live tree and lock
 *   are both present and verified against the journal's expected commit.
 * - Missing or unverifiable adopted content raises E_RECOVERY_REQUIRED and
 *   leaves all recovery material in place for a later attempt.
 */
/** Internal recovery for callers that already own `.hub.lock`. */
export function recoverIfNeededLocked(hubDir: string): { recovered: boolean } {
  const adoption = recoverAdoptionIfNeeded(hubDir);
  const journal = readJournal(hubDir);
  if (!journal) return { recovered: adoption.recovered };
  const paths = journalPaths(hubDir, journal);
  if (journal.state === "COMMITTED") {
    removeIfPresent(paths.staging);
    removeIfPresent(paths.backup);
    clearJournal(hubDir);
    return { recovered: true };
  }
  const hasBackupTree = existsSync(paths.backupTree);
  const hasBackupLock = existsSync(paths.backupLock);
  if (hasBackupTree) {
    // Verify the backup before touching the live tree: once the backup is
    // renamed into place it is the only copy of the old adopted content.
    const referenceLock = hasBackupLock ? paths.backupLock : paths.liveLock;
    if (!existsSync(referenceLock)) {
      throw new HubError(
        "E_RECOVERY_REQUIRED",
        "recovery cannot verify the backup tree without an adopted lock",
      );
    }
    verifyAdoptedState(paths.backupTree, referenceLock, journal);
    removeIfPresent(paths.liveTree);
    durableRename(paths.backupTree, paths.liveTree);
  }
  if (hasBackupLock) {
    writeFileAtomic(paths.liveLock, readFileSync(paths.backupLock, "utf8"));
  }
  if (!existsSync(paths.liveTree) || !existsSync(paths.liveLock)) {
    throw new HubError(
      "E_RECOVERY_REQUIRED",
      "recovery cannot find the adopted tree and lock; refusing to report success",
    );
  }
  verifyAdoptedState(paths.liveTree, paths.liveLock, journal);
  removeIfPresent(paths.staging);
  removeIfPresent(paths.backup);
  clearJournal(hubDir);
  return { recovered: true };
}

/** Public recovery entry point. Recovery itself is a mutation and therefore
 * must hold the same owner-bound lock as apply/update/review operations. */
export function recoverIfNeeded(hubDir: string): { recovered: boolean } {
  const lock = acquireOwnerTokenLock(join(resolve(hubDir), ".hub.lock"), {
    beforeReclaim: () => {
      readJournal(hubDir);
      readAdoptionJournal(hubDir);
    },
    error: (message) => new HubError("E_HUB_LOCKED", message),
  });
  try {
    return recoverIfNeededLocked(hubDir);
  } finally {
    lock.release();
  }
}

/**
 * Gate for mutating/build commands: refuse while an incomplete journal
 * requires recovery. COMMITTED remnants are cleaned so a crashed cleanup
 * never blocks the next command.
 */
export function requireCleanJournal(hubDir: string): void {
  const journal = readJournal(hubDir);
  if (journal !== null) {
    if (journal.state !== "COMMITTED") {
      throw new HubError(
        "E_RECOVERY_REQUIRED",
        `incomplete journal (${journal.state}) requires recovery before this command`,
      );
    }
    const paths = journalPaths(hubDir, journal);
    removeIfPresent(paths.staging);
    removeIfPresent(paths.backup);
    clearJournal(hubDir);
  }
  const adoption = readAdoptionJournal(hubDir);
  if (adoption === null) return;
  if (adoption.state !== "COMMITTED") {
    throw new HubError("E_RECOVERY_REQUIRED", `incomplete adoption journal (${adoption.state}) requires recovery before this command`);
  }
  const root = resolve(hubDir);
  removeIfPresent(confinedJournalPath(root, adoption.staging, "staging"));
  removeIfPresent(confinedJournalPath(root, adoption.backup, "backup"));
  clearAdoptionJournal(root);
}

/**
 * Read-only gate for builders and previews. A COMMITTED journal still owns
 * cleanup authority, so inspection must report it instead of deleting its
 * recovery remnants. Explicit recovery remains the only cleanup path.
 */
export function requireReadableJournal(hubDir: string): void {
  const journal = readJournal(hubDir);
  if (journal !== null) {
    throw new HubError(
      "E_RECOVERY_REQUIRED",
      `journal (${journal.state}) requires explicit recovery before read-only inspection`,
    );
  }
  const adoption = readAdoptionJournal(hubDir);
  if (adoption !== null) {
    throw new HubError(
      "E_RECOVERY_REQUIRED",
      `adoption journal (${adoption.state}) requires explicit recovery before read-only inspection`,
    );
  }
}
