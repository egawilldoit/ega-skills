// 1.1[D] exact update application (EGA-626). Contract B sections 5-6.
//
// Applies ONE approved UpdatePlan to the adopted Hub state, exactly as
// described: plan digest, config binding, stale check, exact commit, stage
// digest verification, destination cleanliness, full-Hub validation — then
// the crash-safe swap from journal.ts. Never re-resolves the tracked ref.
// The server (and this function) NEVER mutates the caller's project files;
// it mutates only the Hub directory it owns.

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { verifyEnvelope } from "@ega-skills/hashing";
import { HubError } from "./errors.js";
import { COMMIT_RE, SHA256_RE, assertSourceId, isPlainObject } from "./guards.js";
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

export interface HubLock {
  release(): void;
}

function lockPath(hubDir: string): string {
  return join(hubDir, ".hub.lock");
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
  let fd: number;
  try {
    fd = openSync(lockPath(hubDir), "wx");
  } catch {
    throw new HubError("E_HUB_LOCKED", "hub mutation lock is held by another process");
  }
  closeSync(fd);
  let released = false;
  return {
    release() {
      if (!released) {
        released = true;
        rmSync(lockPath(hubDir), { force: true });
      }
    },
  };
}

export interface ApplyInput {
  hubDir: string;
  plan: UpdatePlanDocument;
  stageDir: string;
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
    const owned = join(hubDir, "owned");
    if (existsSync(owned)) copyDirTree(owned, join(prospective, "owned"));
    const adoptedTrees = join(hubDir, "trees");
    mkdirSync(join(prospective, "trees"), { recursive: true });
    for (const name of readdirSync(adoptedTrees)) {
      const sourceTree = join(adoptedTrees, name);
      const targetTree = join(prospective, "trees", name);
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
  const payload = doc["payload"];
  if (!isPlainObject(payload)) {
    throw new HubError("E_PLAN_SCHEMA", "plan payload must be an object");
  }
  for (const forbidden of ["ref", "target_ref", "branch", "rev"]) {
    if (forbidden in payload) {
      throw new HubError("E_PLAN_REFETCH", `plan must not carry "${forbidden}" (exact commit only)`);
    }
  }
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
  const { hubDir, plan, stageDir } = input;
  const lock = acquireHubLock(hubDir);
  try {
    // Recovery mutates Hub state, so it must happen under the same exclusive
    // lock as the update itself. Contract B still requires stage -> PREPARED.
    recoverIfNeeded(hubDir);
    requireCleanJournal(hubDir);
    const verified = verifyPlanShape(plan);
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
    const liveTree = join(hubDir, "trees", verified.sourceId);
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
    writeJournal(hubDir, { ...journal, state: "COMMITTED" });
    busyGuard(() => {
      removePathDurable(backup);
      removePathDurable(staging);
    });
    clearJournal(hubDir);
    return { record };
  } finally {
    lock.release();
  }
}
