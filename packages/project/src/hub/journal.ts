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

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { HubError } from "./errors.js";
import { COMMIT_RE, assertSourceId, isPlainObject } from "./guards.js";
import { adoptedSourcePath } from "./paths.js";

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

/**
 * Recover an incomplete mutation: restore the exact previous adopted tree
 * and lock from backup when a backup exists, drop staging remnants, clear
 * the journal. COMMITTED journals only need remnant cleanup.
 */
export function recoverIfNeeded(hubDir: string): { recovered: boolean } {
  const journal = readJournal(hubDir);
  if (!journal) return { recovered: false };
  const paths = journalPaths(hubDir, journal);
  if (journal.state === "COMMITTED") {
    removeIfPresent(paths.staging);
    removeIfPresent(paths.backup);
    clearJournal(hubDir);
    return { recovered: true };
  }
  if (existsSync(paths.backupTree) || existsSync(paths.backupLock)) {
    if (existsSync(paths.liveTree)) removePathDurable(paths.liveTree);
    if (existsSync(paths.backupTree)) durableRename(paths.backupTree, paths.liveTree);
    if (existsSync(paths.backupLock)) {
      writeFileAtomic(paths.liveLock, readFileSync(paths.backupLock, "utf8"));
    }
  }
  removeIfPresent(paths.staging);
  removeIfPresent(paths.backup);
  clearJournal(hubDir);
  return { recovered: true };
}

/**
 * Gate for mutating/build commands: refuse while an incomplete journal
 * requires recovery. COMMITTED remnants are cleaned so a crashed cleanup
 * never blocks the next command.
 */
export function requireCleanJournal(hubDir: string): void {
  const journal = readJournal(hubDir);
  if (!journal) return;
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
