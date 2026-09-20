// Contract A2: turn one reviewed A1 plan into adopted Hub state.
//
// Adoption is deliberately a separate transaction from Contract B updates:
// it may add a source/configuration or an owned local tree, so recovery must
// restore a complete pre-adoption Hub rather than assuming an existing lock.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { parseCanonicalSkillId, prepareSkillRoot } from "@ega-skills/registry";
import { HubError } from "../hub/errors.js";
import { acquireHubLock } from "../hub/apply.js";
import { buildHub } from "../hub/builder.js";
import { parseHubYaml, type HubConfig } from "../hub/hub-config.js";
import {
  AdoptionJournal,
  AdoptionJournalEntry,
  clearAdoptionJournal,
  durableRename,
  digestAdoptionPath,
  recoverAdoptionIfNeeded,
  readAdoptionJournal,
  writeAdoptionJournal,
  writeFileAtomic,
  writeFileDurable,
  removePathDurable,
} from "../hub/journal.js";
import { adoptedSourcePath } from "../hub/paths.js";
import { digestStagedTree } from "../hub/quarantine.js";
import { parseSourcesLockYaml, verifySourcesLock, type SourceLockRecord, type SourcesLock } from "../hub/sources-lock.js";
import { parseSourcesYaml, sourceConfigDigest, type SourceConfig, type SourcesConfig } from "../hub/sources-config.js";
import { verifyAdoptionPlan, verifyAdoptionStage, readHubIntakeState, readHubIntakeStateUnchecked, type AdoptionPlanDocument } from "./adoption-plan.js";
import { requireCandidateApproval } from "./review-store.js";
import { readReviewableCandidate, verifyOwnedDerivativeCandidate, verifyOwnedDerivativeStage, type IntakeCandidateDocument, type OwnedDerivativeCandidateDocument } from "./candidate.js";

interface CurrentContracts {
  readonly hub: HubConfig;
  readonly config: SourcesConfig;
  readonly lock: SourcesLock;
}

export interface AdoptionApplyOptions {
  readonly hubDir: string;
  readonly plan: IntakeCandidateDocument;
  /** Test-only crash injection. Production callers omit this. */
  readonly faultAfter?: "PREPARED" | number;
}

export interface AdoptionApplyResult {
  readonly applied: boolean;
  readonly operation_id: string;
  readonly status: "COMMITTED" | "ALREADY_APPLIED";
  readonly target_state_digest?: string;
}

function emptyContracts(): CurrentContracts {
  return {
    config: { schemaVersion: 1, sources: {} },
    hub: { external: [], hubId: "default", owned: [], schemaVersion: 1 },
    lock: { schemaVersion: 1, sources: {} },
  };
}

function readContracts(hubDir: string): CurrentContracts {
  const paths = ["hub.yaml", "sources.yaml", "sources.lock.yaml"].map((name) => join(hubDir, name));
  const present = paths.filter((path) => existsSync(path)).length;
  if (present === 0) return emptyContracts();
  if (present !== paths.length) throw new HubError("E_HUB_SCHEMA", "Hub adoption requires hub.yaml, sources.yaml, and sources.lock.yaml together");
  const hub = parseHubYaml(readFileSync(paths[0] as string, "utf8"));
  const config = parseSourcesYaml(readFileSync(paths[1] as string, "utf8"));
  const lock = parseSourcesLockYaml(readFileSync(paths[2] as string, "utf8"));
  if (JSON.stringify([...Object.keys(config.sources)].sort()) !== JSON.stringify([...hub.external].sort())) throw new HubError("E_HUB_SCHEMA", "Hub external source coverage does not match sources.yaml");
  verifySourcesLock(config, lock);
  return { config, hub, lock };
}

function copyPath(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new HubError("E_EXTRACTION_POLICY", `non-regular file forbidden in adoption state: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === ".hub.lock" || entry.name === ".hub-journal.json" || entry.name === ".adoption-journal.json" || entry.name === ".adoption-staging" || entry.name === ".adoption-backup" || entry.name === ".intake-staging") continue;
      copyPath(join(source, entry.name), join(destination, entry.name));
    }
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileDurable(destination, readFileSync(source));
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function yamlText(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 0 });
}

function sourceConfigYamlValue(config: SourceConfig): Record<string, unknown> {
  return {
    namespace: config.namespace,
    provenance_files: [...config.provenanceFiles],
    ref: config.ref,
    repository: config.repository,
    selection: { roots: [...config.selection.roots] },
    type: config.type,
  };
}

function sourceConfigFromPlan(plan: AdoptionPlanDocument): SourceConfig {
  const source = plan.payload.source;
  if (source.type !== "git" || source.repository === undefined || source.requested_ref === undefined) throw new HubError("E_SOURCE_SCHEMA", "local adoption cannot create a Git source configuration");
  return {
    namespace: plan.payload.namespace,
    provenanceFiles: [...source.provenance_files],
    ref: source.requested_ref,
    repository: source.repository,
    selection: { roots: [...source.selected_roots] },
    type: "git",
  };
}

function nextContracts(current: CurrentContracts, plan: AdoptionPlanDocument): { hub: string; sources: string; lock: string; targetPath: string; targetKind: "file" | "directory"; receipt?: string } {
  const source = plan.payload.source;
  const sourceId = plan.payload.source_id;
  const targetPath = source.type === "git" ? adoptedSourcePath("", sourceId).replaceAll("\\", "/") : `owned/${sourceId}`;
  if (current.config.sources[sourceId] !== undefined || current.hub.external.includes(sourceId) || current.hub.owned.some((entry) => entry.path === targetPath)) throw new HubError("E_SOURCE_SCHEMA", `source or owned path already exists: ${sourceId}`);
  if (Object.values(current.config.sources).some((entry) => entry.namespace === plan.payload.namespace) || current.hub.owned.some((entry) => entry.namespace === plan.payload.namespace)) throw new HubError("E_SOURCE_SCHEMA", `namespace already exists in Hub: ${plan.payload.namespace}`);

  const hubValue = {
    schema_version: 1,
    hub: { id: current.hub.hubId },
    owned: source.type === "local"
      ? [...current.hub.owned, { path: targetPath, namespace: plan.payload.namespace }].sort((left, right) => left.path.localeCompare(right.path))
      : [...current.hub.owned].sort((left, right) => left.path.localeCompare(right.path)),
    external: source.type === "git"
      ? [...current.hub.external, sourceId].sort().map((source) => ({ source }))
      : [...current.hub.external].sort().map((source) => ({ source })),
  };
  const configSources = { ...current.config.sources };
  const lockSources = { ...current.lock.sources };
  let receipt: string | undefined;
  if (source.type === "git") {
    const config = sourceConfigFromPlan(plan);
    configSources[sourceId] = config;
    const lock: SourceLockRecord = {
      extraction_contract: 1,
      namespace: config.namespace,
      provenance_files: [...config.provenanceFiles],
      repository: config.repository,
      requested_ref: config.ref,
      resolved_commit: source.resolved_commit as string,
      selected_skill_tree_digest: source.selected_skill_tree_digest,
      selection: { roots: [...config.selection.roots] },
      source_config_digest: sourceConfigDigest(config),
      vendored_snapshot_digest: source.vendored_snapshot_digest,
    };
    lockSources[sourceId] = lock;
  } else {
    receipt = `.intake-provenance/${sourceId}.json`;
  }
  const sourcesYaml = Object.fromEntries(Object.entries(sortedRecord(configSources)).map(([name, config]) => [name, sourceConfigYamlValue(config)]));
  return {
    hub: yamlText(hubValue),
    lock: yamlText({ schema_version: 1, sources: sortedRecord(lockSources) }),
    sources: yamlText({ schema_version: 1, sources: sourcesYaml }),
    targetKind: "directory",
    targetPath,
    ...(receipt === undefined ? {} : { receipt }),
  };
}

function stageDirectoryName(digest: string): string {
  return digest.replace(/^sha256:/, "");
}

function targetDigest(path: string): string | null { return digestAdoptionPath(path); }

function pathKind(path: string): "file" | "directory" {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  throw new HubError("E_EXTRACTION_POLICY", `adoption target is not a regular file or directory: ${path}`);
}

function faultAfterValue(options: AdoptionApplyOptions): "PREPARED" | number | undefined {
  if (options.faultAfter !== undefined) return options.faultAfter;
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.EGA_TEST_ADOPTION_FAIL_AFTER;
  if (raw === "PREPARED") return raw;
  if (raw !== undefined && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

/** Test-only SIGKILL barriers. A production caller cannot enable these. */
function adoptionCrashBarrier(name: string): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env?.EGA_TEST_ADOPTION_BARRIER !== name) return;
  const marker = env.EGA_TEST_ADOPTION_BARRIER_FILE;
  const release = env.EGA_TEST_ADOPTION_BARRIER_RELEASE;
  if (marker === undefined || release === undefined) throw new Error("test adoption barrier requires marker and release paths");
  writeFileSync(marker, `${name}\n`);
  while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

function derivativeReceiptPath(candidate: OwnedDerivativeCandidateDocument): string {
  return `.intake-provenance/derivative-${stageDirectoryName(candidate.digest)}.json`;
}

async function applyOwnedDerivativeCandidate(options: AdoptionApplyOptions, candidate: OwnedDerivativeCandidateDocument): Promise<AdoptionApplyResult> {
  const hubDir = resolve(options.hubDir);
  const lock = acquireHubLock(hubDir);
  let journalWritten = false;
  let temporary: string | undefined;
  let transactionRoot: string | undefined;
  let backupRoot: string | undefined;
  try {
    recoverAdoptionIfNeeded(hubDir);
    const currentState = readHubIntakeState(hubDir);
    const current = readContracts(hubDir);
    const candidateView = readReviewableCandidate(candidate, hubDir);
    if (candidateView.kind !== "OWNED_DERIVATIVE" || candidateView.derivative_stage_root === undefined) throw new HubError("E_PLAN_SCHEMA", "owned derivative candidate is not reviewable");
    await verifyOwnedDerivativeStage(hubDir, candidate);
    const parsed = parseCanonicalSkillId(candidate.payload.target.skill_id);
    const owned = current.hub.owned.find((entry) => entry.namespace === parsed.namespace);
    if (owned === undefined) throw new HubError("E_SOURCE_SCHEMA", `owned namespace is not declared in Hub: ${parsed.namespace}`);
    const targetPath = join(owned.path, candidate.payload.target.relative_root).replaceAll("\\", "/");
    const targetAbsolute = join(hubDir, ...targetPath.split("/"));
    const receiptPath = derivativeReceiptPath(candidate);
    if (existsSync(join(hubDir, receiptPath)) && existsSync(targetAbsolute)) {
      const existing = await prepareSkillRoot(targetAbsolute, parsed.namespace);
      if (existing.versionHash !== candidate.payload.target.version_hash) throw new HubError("E_SOURCE_SCHEMA", `owned target ${candidate.payload.target.skill_id} has different bytes`);
      let receipt: unknown;
      try { receipt = JSON.parse(readFileSync(join(hubDir, receiptPath), "utf8")); } catch { throw new HubError("E_RECOVERY_REQUIRED", "owned derivative receipt is corrupt"); }
      if (receipt !== null && typeof receipt === "object" && !Array.isArray(receipt) && (receipt as { candidate_digest?: unknown }).candidate_digest === candidate.digest) return { applied: false, operation_id: candidate.digest, status: "ALREADY_APPLIED" };
    }
    if (currentState.baselineDigest !== candidate.payload.baseline_digest) throw new HubError("E_PLAN_STALE", "owned derivative candidate baseline no longer matches the Hub");
    requireCandidateApproval(hubDir, candidate);
    if (existsSync(targetAbsolute)) {
      const existing = await prepareSkillRoot(targetAbsolute, parsed.namespace);
      if (existing.versionHash !== candidate.payload.target.version_hash) throw new HubError("E_SOURCE_SCHEMA", `owned target ${candidate.payload.target.skill_id} already contains different bytes`);
      throw new HubError("E_SOURCE_SCHEMA", `owned target ${candidate.payload.target.skill_id} exists without matching derivative lineage`);
    }
    const stagedTarget = join(candidateView.derivative_stage_root, "source", ...candidate.payload.target.relative_root.split("/"));
    temporary = mkdtempSync(join(tmpdir(), "ega-derivative-prospective-"));
    copyPath(hubDir, temporary);
    copyPath(stagedTarget, join(temporary, ...targetPath.split("/")));
    const prospectiveReceipt = join(temporary, ...receiptPath.split("/"));
    mkdirSync(dirname(prospectiveReceipt), { recursive: true });
    writeFileDurable(prospectiveReceipt, `${JSON.stringify({ candidate_digest: candidate.digest, derivation_proposal_digest: candidate.payload.derivation_proposal_digest, provenance: candidate.payload.provenance }, null, 2)}\n`);
    await buildHub(temporary);
    const targetState = readHubIntakeStateUnchecked(temporary);
    transactionRoot = `.adoption-staging/${stageDirectoryName(candidate.digest)}`;
    backupRoot = `.adoption-backup/${stageDirectoryName(candidate.digest)}`;
    const targetPaths = [targetPath, receiptPath].sort();
    const entries: AdoptionJournalEntry[] = [];
    for (const path of targetPaths) {
      const source = join(temporary, ...path.split("/"));
      const stage = `${transactionRoot}/new/${path}`;
      const backup = `${backupRoot}/old/${path}`;
      const live = join(hubDir, ...path.split("/"));
      const oldDigest = targetDigest(live);
      const newDigest = targetDigest(source);
      if (newDigest === null) throw new HubError("E_BUILD_ATTESTATION", `prospective derivative path is missing: ${path}`);
      const kind = pathKind(source);
      copyPath(source, join(hubDir, ...stage.split("/")));
      if (oldDigest !== null) copyPath(live, join(hubDir, ...backup.split("/")));
      entries.push({ backup, kind, new_digest: newDigest, old_digest: oldDigest, path, stage });
    }
    const journal: AdoptionJournal = {
      allowed_paths: targetPaths,
      backup: backupRoot,
      entries,
      expected_old_state_digest: currentState.baselineDigest,
      journal_version: 2,
      operation: "ADOPTION",
      operation_id: candidate.digest,
      state: "PREPARED",
      staging: transactionRoot,
      swapped_paths: [],
      target_state_digest: targetState.baselineDigest,
    };
    writeAdoptionJournal(hubDir, journal);
    journalWritten = true;
    adoptionCrashBarrier("PREPARED");
    if (faultAfterValue(options) === "PREPARED") throw new Error("test fault after adoption journal PREPARED");
    let swapped: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] as AdoptionJournalEntry;
      const live = join(hubDir, ...entry.path.split("/"));
      const stage = join(hubDir, ...entry.stage.split("/"));
      if (existsSync(live)) removePathDurable(live);
      adoptionCrashBarrier("AFTER_OLD_TARGET_REMOVAL");
      mkdirSync(dirname(live), { recursive: true });
      durableRename(stage, live);
      adoptionCrashBarrier("AFTER_REPLACEMENT_BEFORE_JOURNAL");
      swapped = [...swapped, entry.path].sort();
      writeAdoptionJournal(hubDir, { ...journal, state: "SWAPPING", swapped_paths: swapped });
      if (faultAfterValue(options) === index) throw new Error(`test fault after derivative path ${entry.path}`);
    }
    adoptionCrashBarrier("AFTER_FINAL_REPLACEMENT");
    const landed = readHubIntakeStateUnchecked(hubDir);
    if (landed.baselineDigest !== targetState.baselineDigest) throw new HubError("E_RECOVERY_REQUIRED", "derivative landed state digest does not match the prospective build");
    writeAdoptionJournal(hubDir, { ...journal, state: "COMMITTED", swapped_paths: swapped });
    adoptionCrashBarrier("COMMITTED_BEFORE_CLEANUP");
    recoverAdoptionIfNeeded(hubDir);
    journalWritten = false;
    return { applied: true, operation_id: candidate.digest, status: "COMMITTED", target_state_digest: targetState.baselineDigest };
  } finally {
    if (temporary !== undefined) rmSync(temporary, { force: true, recursive: true });
    if (!journalWritten) {
      if (transactionRoot !== undefined) rmSync(join(hubDir, transactionRoot), { force: true, recursive: true });
      if (backupRoot !== undefined) rmSync(join(hubDir, backupRoot), { force: true, recursive: true });
    }
    lock.release();
  }
}

/** Apply exactly one reviewed A1 plan with crash-safe multi-path recovery. */
export async function applyAdoptionPlan(options: AdoptionApplyOptions): Promise<AdoptionApplyResult> {
  const hubDir = resolve(options.hubDir);
  if (options.plan.object_type === "ega.owned-derivative-candidate") return applyOwnedDerivativeCandidate(options, verifyOwnedDerivativeCandidate(options.plan));
  const plan = verifyAdoptionPlan(options.plan);
  if (plan.payload.status !== "READY") throw new HubError("E_PLAN_SCHEMA", "blocked adoption plan cannot be applied");
  const lock = acquireHubLock(hubDir);
  let journalWritten = false;
  let temporary: string | undefined;
  let transactionRoot: string | undefined;
  let backupRoot: string | undefined;
  try {
    recoverAdoptionIfNeeded(hubDir);
    const currentState = readHubIntakeState(hubDir);
    const current = readContracts(hubDir);
    const alreadyApplied = currentState.baselineDigest !== plan.payload.hub.baseline_digest && await isAlreadyApplied(hubDir, current, plan);
    if (alreadyApplied) return { applied: false, operation_id: plan.digest, status: "ALREADY_APPLIED" };
    if (currentState.baselineDigest !== plan.payload.hub.baseline_digest) throw new HubError("E_PLAN_STALE", "adoption plan baseline no longer matches the Hub");
    const stageRoot = verifyAdoptionStage(hubDir, plan);
    requireCandidateApproval(hubDir, plan);
    const contracts = nextContracts(current, plan);
    temporary = mkdtempSync(join(tmpdir(), "ega-adoption-prospective-"));
    copyPath(hubDir, temporary);
    writeFileDurable(join(temporary, "hub.yaml"), contracts.hub);
    writeFileDurable(join(temporary, "sources.yaml"), contracts.sources);
    writeFileDurable(join(temporary, "sources.lock.yaml"), contracts.lock);
    const stagedSource = join(stageRoot, "source");
    const prospectiveTarget = join(temporary, contracts.targetPath);
    copyPath(stagedSource, prospectiveTarget);
    if (contracts.receipt !== undefined) {
      const receiptPath = join(temporary, contracts.receipt);
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileDurable(receiptPath, `${JSON.stringify({ adoption_plan: plan.digest, source_path: plan.payload.source.source_path, selected_roots: plan.payload.source.selected_roots, selected_skill_tree_digest: plan.payload.source.selected_skill_tree_digest, vendored_snapshot_digest: plan.payload.source.vendored_snapshot_digest }, null, 2)}\n`);
    }
    await buildHub(temporary);
    const targetState = readHubIntakeStateUnchecked(temporary);
    const targetPaths = ["hub.yaml", "sources.yaml", "sources.lock.yaml", contracts.targetPath, ...(contracts.receipt === undefined ? [] : [contracts.receipt])].sort();
    const transactionName = stageDirectoryName(plan.digest);
    transactionRoot = `.adoption-staging/${transactionName}`;
    backupRoot = `.adoption-backup/${transactionName}`;
    const entries: AdoptionJournalEntry[] = [];
    for (const path of targetPaths) {
      const source = join(temporary, path);
      const stage = `${transactionRoot}/new/${path}`;
      const backup = `${backupRoot}/old/${path}`;
      const live = join(hubDir, path);
      const oldDigest = targetDigest(live);
      const newDigest = targetDigest(source);
      if (newDigest === null) throw new HubError("E_BUILD_ATTESTATION", `prospective adoption path is missing: ${path}`);
      const kind = pathKind(source);
      const stageAbsolute = join(hubDir, stage);
      const backupAbsolute = join(hubDir, backup);
      copyPath(source, stageAbsolute);
      if (oldDigest !== null) copyPath(live, backupAbsolute);
      entries.push({ backup, kind, new_digest: newDigest, old_digest: oldDigest, path, stage });
    }
    const journal: AdoptionJournal = {
      allowed_paths: targetPaths,
      backup: backupRoot,
      entries,
      expected_old_state_digest: currentState.baselineDigest,
      journal_version: 2,
      operation: "ADOPTION",
      operation_id: plan.digest,
      state: "PREPARED",
      staging: transactionRoot,
      swapped_paths: [],
      target_state_digest: targetState.baselineDigest,
    };
    writeAdoptionJournal(hubDir, journal);
    journalWritten = true;
    adoptionCrashBarrier("PREPARED");
    if (faultAfterValue(options) === "PREPARED") throw new Error("test fault after adoption journal PREPARED");
    let swapped: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] as AdoptionJournalEntry;
      const live = join(hubDir, entry.path);
      const stage = join(hubDir, entry.stage);
      if (existsSync(live)) {
        removePathDurable(live);
      }
      adoptionCrashBarrier("AFTER_OLD_TARGET_REMOVAL");
      mkdirSync(dirname(live), { recursive: true });
      durableRename(stage, live);
      adoptionCrashBarrier("AFTER_REPLACEMENT_BEFORE_JOURNAL");
      swapped = [...swapped, entry.path].sort();
      writeAdoptionJournal(hubDir, { ...journal, state: "SWAPPING", swapped_paths: swapped });
      if (faultAfterValue(options) === index) throw new Error(`test fault after adoption path ${entry.path}`);
    }
    adoptionCrashBarrier("AFTER_FINAL_REPLACEMENT");
    for (const entry of entries) if (targetDigest(join(hubDir, entry.path)) !== entry.new_digest) throw new HubError("E_RECOVERY_REQUIRED", `adoption landed digest mismatch for ${entry.path}`);
    const landed = readHubIntakeStateUnchecked(hubDir);
    if (landed.baselineDigest !== targetState.baselineDigest) throw new HubError("E_RECOVERY_REQUIRED", "adoption landed state digest does not match the prospective build");
    writeAdoptionJournal(hubDir, { ...journal, state: "COMMITTED", swapped_paths: swapped });
    adoptionCrashBarrier("COMMITTED_BEFORE_CLEANUP");
    recoverAdoptionIfNeeded(hubDir);
    journalWritten = false;
    return { applied: true, operation_id: plan.digest, status: "COMMITTED", target_state_digest: targetState.baselineDigest };
  } finally {
    if (temporary !== undefined) rmSync(temporary, { force: true, recursive: true });
    if (!journalWritten) {
      if (transactionRoot !== undefined) rmSync(join(hubDir, transactionRoot), { force: true, recursive: true });
      if (backupRoot !== undefined) rmSync(join(hubDir, backupRoot), { force: true, recursive: true });
    }
    lock.release();
  }
}

async function isAlreadyApplied(hubDir: string, current: CurrentContracts, plan: AdoptionPlanDocument): Promise<boolean> {
  const source = plan.payload.source;
  const sourceId = plan.payload.source_id;
  if (source.type === "git") {
    const config = current.config.sources[sourceId];
    const lock = current.lock.sources[sourceId];
    if (!config || !lock || !current.hub.external.includes(sourceId)) return false;
    if (config.repository !== source.repository || config.ref !== source.requested_ref || config.namespace !== plan.payload.namespace || lock.resolved_commit !== source.resolved_commit || lock.selected_skill_tree_digest !== source.selected_skill_tree_digest || lock.vendored_snapshot_digest !== source.vendored_snapshot_digest) return false;
    const tree = digestStagedTree(adoptedSourcePath(hubDir, sourceId), source.selected_roots);
    if (tree.treeDigest !== source.selected_skill_tree_digest || tree.snapshotDigest !== source.vendored_snapshot_digest) return false;
  } else {
    const owned = current.hub.owned.find((entry) => entry.path === `owned/${sourceId}` && entry.namespace === plan.payload.namespace);
    if (!owned || !existsSync(join(hubDir, ".intake-provenance", `${sourceId}.json`))) return false;
    const tree = digestStagedTree(join(hubDir, owned.path), source.selected_roots);
    if (tree.treeDigest !== source.selected_skill_tree_digest || tree.snapshotDigest !== source.vendored_snapshot_digest) return false;
    const receipt = JSON.parse(readFileSync(join(hubDir, ".intake-provenance", `${sourceId}.json`), "utf8")) as { adoption_plan?: string };
    if (receipt.adoption_plan !== plan.digest) return false;
  }
  await buildHub(hubDir);
  return true;
}
