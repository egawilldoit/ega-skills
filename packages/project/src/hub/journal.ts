// 1.1[D] crash-safe update journal (EGA-626). Contract B sections 6-7.
//
// One Hub, one exclusive mutation, one journal file. Every mutating Hub
// command reads the journal FIRST: an incomplete journal is either resumed
// or restored to the exact previous adopted state before anything else runs.
// `hub build` refuses while recovery is incomplete (E_RECOVERY_REQUIRED).
//
// Journal paths are Hub-relative (portable); live layout:
//   trees/<source>/...   adopted vendored tree
//   sources.lock.yaml    adopted lock
//   .staging/            incoming tree + lock under construction
//   .backup/             previous tree + lock preserved across the swap
//   .hub-journal.json    this journal

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubError } from "./errors.js";
import { COMMIT_RE, isPlainObject } from "./guards.js";

export type JournalState = "PREPARED" | "TREE_SWAPPED" | "LOCK_SWAPPED" | "COMMITTED";

export interface HubJournal {
  journal_version: 1;
  source_id: string;
  expected_old_commit: string;
  target_commit: string;
  staging: string;
  backup: string;
  state: JournalState;
}

const STATES: readonly string[] = ["PREPARED", "TREE_SWAPPED", "LOCK_SWAPPED", "COMMITTED"];

export function journalPath(hubDir: string): string {
  return join(hubDir, ".hub-journal.json");
}

/** Durable atomic file write: temp + fsync + rename. */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function checkJournalShape(value: unknown): asserts value is HubJournal {
  if (!isPlainObject(value)) {
    throw new HubError("E_JOURNAL_SCHEMA", "journal must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!["journal_version", "source_id", "expected_old_commit", "target_commit", "staging", "backup", "state"].includes(key)) {
      throw new HubError("E_JOURNAL_SCHEMA", `journal unknown field "${key}"`);
    }
  }
  if (value["journal_version"] !== 1) {
    throw new HubError("E_JOURNAL_SCHEMA", "journal journal_version must be 1");
  }
  if (typeof value["source_id"] !== "string" || (value["source_id"] as string).length === 0) {
    throw new HubError("E_JOURNAL_SCHEMA", "journal source_id must be a non-empty string");
  }
  for (const field of ["expected_old_commit", "target_commit"] as const) {
    if (typeof value[field] !== "string" || !COMMIT_RE.test(value[field] as string)) {
      throw new HubError("E_JOURNAL_SCHEMA", `journal ${field} must be 40 lowercase hex`);
    }
  }
  for (const field of ["staging", "backup"] as const) {
    if (typeof value[field] !== "string" || (value[field] as string).length === 0) {
      throw new HubError("E_JOURNAL_SCHEMA", `journal ${field} must be a non-empty Hub-relative path`);
    }
  }
  if (typeof value["state"] !== "string" || !STATES.includes(value["state"] as string)) {
    throw new HubError("E_JOURNAL_STATE", `journal state must be one of ${STATES.join("/")}`);
  }
  for (const [, entry] of Object.entries(value)) {
    if (entry === null) {
      throw new HubError("E_JOURNAL_SCHEMA", "journal must not contain null");
    }
  }
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
  return parsed;
}

export function writeJournal(hubDir: string, journal: HubJournal): void {
  checkJournalShape(journal as unknown);
  mkdirSync(hubDir, { recursive: true });
  writeFileAtomic(journalPath(hubDir), JSON.stringify(journal, null, 2));
}

export function clearJournal(hubDir: string): void {
  rmSync(journalPath(hubDir), { force: true });
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true, recursive: true });
}

/**
 * Recover an incomplete mutation: restore the exact previous adopted tree
 * and lock from backup when a backup exists, drop staging remnants, clear
 * the journal. COMMITTED journals only need remnant cleanup.
 */
export function recoverIfNeeded(hubDir: string): { recovered: boolean } {
  const journal = readJournal(hubDir);
  if (!journal) return { recovered: false };
  if (journal.state === "COMMITTED") {
    removeIfPresent(join(hubDir, journal.staging));
    removeIfPresent(join(hubDir, journal.backup));
    clearJournal(hubDir);
    return { recovered: true };
  }
  const backupTree = join(hubDir, journal.backup, journal.source_id);
  const backupLock = join(hubDir, journal.backup, "sources.lock.yaml");
  const liveTree = join(hubDir, "trees", journal.source_id);
  const liveLock = join(hubDir, "sources.lock.yaml");
  if (existsSync(backupTree) || existsSync(backupLock)) {
    if (existsSync(liveTree)) rmSync(liveTree, { force: true, recursive: true });
    if (existsSync(backupTree)) renameSync(backupTree, liveTree);
    if (existsSync(backupLock)) {
      writeFileAtomic(liveLock, readFileSync(backupLock, "utf8"));
    }
  }
  removeIfPresent(join(hubDir, journal.staging));
  removeIfPresent(join(hubDir, journal.backup));
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
  removeIfPresent(join(hubDir, journal.staging));
  removeIfPresent(join(hubDir, journal.backup));
  clearJournal(hubDir);
}
