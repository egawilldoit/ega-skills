// Contract A1: an immutable, reviewable source-adoption proposal.
// It binds exact source bytes, the canonical import plan, and the Hub
// baseline. P04 is the first module allowed to turn this proposal into live
// adopted state.

import { existsSync, readFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeJson, createEnvelope, hashBytes, verifyEnvelope, type ArtifactEnvelope } from "@ega-skills/hashing";
import { createImportPlan, emptyRegistryTarget, verifyImportPlan, type ImportPlanDocument } from "@ega-skills/registry";
import { acquireSource, releaseAcquiredSource, type AcquiredSource } from "./acquire.js";
import { HubError } from "../hub/errors.js";
import { parseHubYaml } from "../hub/hub-config.js";
import { requireReadableJournal } from "../hub/journal.js";
import { adoptedSourcePath } from "../hub/paths.js";
import { digestStagedTree } from "../hub/quarantine.js";
import { parseSourcesLockYaml, verifySourcesLock } from "../hub/sources-lock.js";
import { parseSourcesYaml } from "../hub/sources-config.js";
import { assertSourceId, NAMESPACE_RE, SHA256_RE } from "../hub/guards.js";

export const ADOPTION_CONTRACT = "A1" as const;
export const ADOPTION_OBJECT_TYPE = "ega.adoption-plan" as const;
export const ADOPTION_SCHEMA_VERSION = 1 as const;

export interface AdoptionCandidate {
  readonly relative_root: string;
  readonly skill_id: string;
  readonly version_hash: string;
  readonly aliases: readonly string[];
}

export interface AdoptionDiagnostic {
  readonly code: "E_SOURCE_ID_CONFLICT" | "E_NAMESPACE_CONFLICT";
  readonly details: string;
}

export interface AdoptionPlanPayload {
  readonly adoption_contract: "A1";
  readonly source_id: string;
  readonly namespace: string;
  readonly source: {
    readonly type: "git" | "local";
    readonly repository?: string;
    readonly requested_ref?: string;
    readonly resolved_commit?: string;
    readonly source_path?: string;
    readonly selected_roots: readonly string[];
    readonly provenance_files: readonly string[];
    readonly selected_skill_tree_digest: string;
    readonly vendored_snapshot_digest: string;
    readonly extraction_contract: 1;
  };
  readonly hub: {
    readonly baseline_digest: string;
    readonly source_ids: readonly string[];
    readonly namespaces: readonly string[];
  };
  readonly import_plan: ImportPlanDocument;
  readonly candidates: readonly AdoptionCandidate[];
  readonly unselected_skills: readonly string[];
  readonly diagnostics: readonly AdoptionDiagnostic[];
  readonly status: "READY" | "BLOCKED";
}

export type AdoptionPlanDocument = ArtifactEnvelope & {
  readonly object_type: "ega.adoption-plan";
  readonly schema_version: 1;
  readonly payload: AdoptionPlanPayload;
};

export interface HubIntakeState {
  readonly baselineDigest: string;
  readonly sourceIds: readonly string[];
  readonly namespaces: readonly string[];
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function stageDirectoryName(digest: string): string {
  // The envelope digest includes `sha256:` for readability. The staging
  // directory is also used on Windows, where `:` is not a legal filename
  // character.
  return digest.replace(/^sha256:/, "");
}

function contractFiles(hubDir: string): { readonly hub: string; readonly sources: string; readonly lock: string } | null {
  const paths = {
    hub: join(hubDir, "hub.yaml"),
    lock: join(hubDir, "sources.lock.yaml"),
    sources: join(hubDir, "sources.yaml"),
  };
  const present = Object.values(paths).filter((path) => existsSync(path)).length;
  if (present === 0) return null;
  if (present !== 3) throw new HubError("E_HUB_SCHEMA", "Hub intake requires hub.yaml, sources.yaml, and sources.lock.yaml together");
  return paths;
}

/** Verify every byte in an immutable A1 stage before a consumer uses it. */
export function verifyAdoptionStage(hubPath: string, plan: AdoptionPlanDocument): string {
  const hubDir = resolve(hubPath);
  const root = resolve(hubDir, ".intake-staging", stageDirectoryName(plan.digest));
  const planPath = join(root, "adoption-plan.json");
  const sourceDir = join(root, "source");
  if (!existsSync(planPath) || !existsSync(sourceDir)) throw new HubError("E_PLAN_STALE", "adoption stage is missing; run hub intake stage first");
  let staged: unknown;
  try { staged = JSON.parse(readFileSync(planPath, "utf8")); } catch { throw new HubError("E_PLAN_DIGEST", "adoption stage plan is not valid JSON"); }
  const verified = verifyAdoptionPlan(staged);
  if (verified.digest !== plan.digest) throw new HubError("E_PLAN_DIGEST", "adoption stage plan digest does not match the requested plan");
  const tree = digestStagedTree(sourceDir, plan.payload.source.selected_roots);
  if (tree.treeDigest !== plan.payload.source.selected_skill_tree_digest || tree.snapshotDigest !== plan.payload.source.vendored_snapshot_digest) throw new HubError("E_PLAN_DIGEST", "adoption stage no longer matches the reviewed plan");
  return root;
}

/** Read Hub identity without changing any Hub file or cleaning recovery remnants. */
export function readHubIntakeStateUnchecked(hubPath: string): HubIntakeState {
  const hubDir = resolve(hubPath);
  const files = contractFiles(hubDir);
  if (files === null) {
    return { baselineDigest: hashBytes(canonicalizeJson({ state: "EMPTY" })), namespaces: [], sourceIds: [] };
  }
  const hubText = readFileSync(files.hub, "utf8");
  const sourcesText = readFileSync(files.sources, "utf8");
  const lockText = readFileSync(files.lock, "utf8");
  const hub = parseHubYaml(hubText);
  const config = parseSourcesYaml(sourcesText);
  const lock = parseSourcesLockYaml(lockText);
  verifySourcesLock(config, lock);
  const configuredSources = sorted(Object.keys(config.sources));
  if (sameJson(configuredSources, sorted(hub.external)) === false) {
    throw new HubError("E_HUB_SCHEMA", "Hub external source coverage does not match sources.yaml");
  }
  const sourceIds = configuredSources;
  const namespaces = sorted([
    ...Object.values(config.sources).map((source) => source.namespace),
    ...hub.owned.map((entry) => entry.namespace),
  ]);
  const treeDigests = sourceIds.map((sourceId) => {
    const record = lock.sources[sourceId];
    if (record === undefined) throw new HubError("E_LOCK_MISMATCH", `Hub lock is missing source ${sourceId}`);
    const tree = digestStagedTree(adoptedSourcePath(hubDir, sourceId), record.selection.roots);
    if (tree.treeDigest !== record.selected_skill_tree_digest || tree.snapshotDigest !== record.vendored_snapshot_digest) {
      throw new HubError("E_TREE_DIGEST", `adopted tree for ${sourceId} does not match its lock identity`);
    }
    return { source_id: sourceId, tree_digest: tree.treeDigest, snapshot_digest: tree.snapshotDigest };
  });
  const ownedDigests = hub.owned.map((entry) => {
    const ownedPath = resolve(hubDir, ...entry.path.split("/"));
    if (!existsSync(ownedPath)) throw new HubError("E_HUB_SCHEMA", `owned Hub path is missing: ${entry.path}`);
    return {
      namespace: entry.namespace,
      path: entry.path,
      snapshot_digest: digestStagedTree(ownedPath, ["__owned_content_is_not_a_selected_root__"]).snapshotDigest,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const receiptDir = join(hubDir, ".intake-provenance");
  const receipts = existsSync(receiptDir)
    ? readdirSync(receiptDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({
          path: `.intake-provenance/${entry.name}`,
          digest: hashBytes(readFileSync(join(receiptDir, entry.name))),
        }))
    : [];
  return {
    baselineDigest: hashBytes(canonicalizeJson({
      files: [
        { path: "hub.yaml", digest: hashBytes(new TextEncoder().encode(hubText)) },
        { path: "sources.lock.yaml", digest: hashBytes(new TextEncoder().encode(lockText)) },
        { path: "sources.yaml", digest: hashBytes(new TextEncoder().encode(sourcesText)) },
      ],
      owned: ownedDigests,
      receipts,
      source_ids: sourceIds,
      tree_digests: treeDigests,
    })),
    namespaces,
    sourceIds,
  };
}

/** Read the Hub baseline without changing state. Recovery calls this after
 * it has validated the journal but before the journal is cleared. */
export function readHubIntakeState(hubPath: string): HubIntakeState {
  const hubDir = resolve(hubPath);
  requireReadableJournal(hubDir);
  return readHubIntakeStateUnchecked(hubDir);
}

function candidateList(importPlan: ImportPlanDocument): AdoptionCandidate[] {
  return importPlan.payload.candidates
    .filter((candidate) => candidate.validation === "VALID" && candidate.proposed_id !== null && candidate.version_hash !== null)
    .map((candidate) => ({
      aliases: [...candidate.aliases].sort(),
      relative_root: candidate.relative_root,
      skill_id: candidate.proposed_id as string,
      version_hash: candidate.version_hash as string,
    }));
}

export function createAdoptionPlan(input: {
  readonly source: AcquiredSource;
  readonly sourceId: string;
  readonly namespace: string;
  readonly hub: HubIntakeState;
  readonly importPlan: ImportPlanDocument;
}): AdoptionPlanDocument {
  assertSourceId(input.sourceId, "adoption plan source_id", "E_PLAN_SCHEMA");
  if (!NAMESPACE_RE.test(input.namespace)) throw new HubError("E_SOURCE_SCHEMA", "adoption plan namespace is invalid");
  const diagnostics: AdoptionDiagnostic[] = [];
  if (input.hub.sourceIds.includes(input.sourceId)) {
    diagnostics.push({ code: "E_SOURCE_ID_CONFLICT", details: `source id already exists: ${input.sourceId}` });
  }
  if (input.hub.namespaces.includes(input.namespace)) {
    diagnostics.push({ code: "E_NAMESPACE_CONFLICT", details: `namespace already exists in Hub: ${input.namespace}` });
  }
  const source = input.source.sourceType === "git"
    ? {
        extraction_contract: 1 as const,
        provenance_files: [...input.source.provenanceFiles],
        repository: input.source.source,
        requested_ref: input.source.requestedRef as string,
        resolved_commit: input.source.resolvedCommit as string,
        selected_roots: [...input.source.roots],
        selected_skill_tree_digest: input.source.tree.treeDigest,
        type: "git" as const,
        vendored_snapshot_digest: input.source.tree.snapshotDigest,
      }
    : {
        extraction_contract: 1 as const,
        provenance_files: [...input.source.provenanceFiles],
        selected_roots: [...input.source.roots],
        selected_skill_tree_digest: input.source.tree.treeDigest,
        source_path: input.source.source,
        type: "local" as const,
        vendored_snapshot_digest: input.source.tree.snapshotDigest,
      };
  const payload: AdoptionPlanPayload = {
    adoption_contract: ADOPTION_CONTRACT,
    candidates: candidateList(input.importPlan),
    diagnostics,
    hub: {
      baseline_digest: input.hub.baselineDigest,
      namespaces: [...input.hub.namespaces],
      source_ids: [...input.hub.sourceIds],
    },
    import_plan: input.importPlan,
    namespace: input.namespace,
    source,
    source_id: input.sourceId,
    status: diagnostics.length === 0 && input.importPlan.payload.summary.blocked_count === 0 ? "READY" : "BLOCKED",
    unselected_skills: [...input.source.unselectedSkills],
  };
  return createEnvelope({ object_type: ADOPTION_OBJECT_TYPE, payload, schema_version: ADOPTION_SCHEMA_VERSION }) as AdoptionPlanDocument;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function verifyAdoptionPlan(value: unknown): AdoptionPlanDocument {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !record(value) || value.object_type !== ADOPTION_OBJECT_TYPE || value.schema_version !== ADOPTION_SCHEMA_VERSION) {
    throw new HubError("E_PLAN_SCHEMA", `adoption plan envelope invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  const payload = value.payload;
  if (!record(payload) || !exactKeys(payload, ["adoption_contract", "source_id", "namespace", "source", "hub", "import_plan", "candidates", "unselected_skills", "diagnostics", "status"])) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan payload fields are invalid");
  }
  if (payload.adoption_contract !== ADOPTION_CONTRACT || typeof payload.source_id !== "string" || typeof payload.namespace !== "string" || (payload.status !== "READY" && payload.status !== "BLOCKED")) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan identity fields are invalid");
  }
  assertSourceId(payload.source_id, "adoption plan source_id", "E_PLAN_SCHEMA");
  if (!NAMESPACE_RE.test(payload.namespace)) throw new HubError("E_PLAN_SCHEMA", "adoption plan namespace is invalid");
  const source = payload.source;
  if (!record(source) || typeof source.type !== "string") {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan source fields are invalid");
  }
  const requiredSourceKeys = source.type === "git"
    ? ["type", "repository", "requested_ref", "resolved_commit", "selected_roots", "provenance_files", "selected_skill_tree_digest", "vendored_snapshot_digest", "extraction_contract"]
    : ["type", "source_path", "selected_roots", "provenance_files", "selected_skill_tree_digest", "vendored_snapshot_digest", "extraction_contract"];
  if (!exactKeys(source, requiredSourceKeys)) throw new HubError("E_PLAN_SCHEMA", "adoption plan source fields are invalid");
  if (source.type !== "git" && source.type !== "local") throw new HubError("E_PLAN_SCHEMA", "adoption plan source type is invalid");
  if (!Array.isArray(source.selected_roots) || !source.selected_roots.every((entry) => typeof entry === "string") || !Array.isArray(source.provenance_files) || !source.provenance_files.every((entry) => typeof entry === "string")) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan source paths are invalid");
  }
  if (!SHA256_RE.test(source.selected_skill_tree_digest as string) || !SHA256_RE.test(source.vendored_snapshot_digest as string) || source.extraction_contract !== 1) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan source digests are invalid");
  }
  if (source.type === "git" && (typeof source.repository !== "string" || typeof source.requested_ref !== "string" || typeof source.resolved_commit !== "string")) {
    throw new HubError("E_PLAN_SCHEMA", "Git adoption plan source identity is incomplete");
  }
  if (source.type === "git" && !/^[0-9a-f]{40}$/.test(source.resolved_commit as string)) throw new HubError("E_PLAN_COMMIT", "adoption plan commit is invalid");
  if (source.type === "local" && typeof source.source_path !== "string") throw new HubError("E_PLAN_SCHEMA", "local adoption plan source path is missing");
  const hub = payload.hub;
  if (!record(hub) || !exactKeys(hub, ["baseline_digest", "source_ids", "namespaces"]) || !SHA256_RE.test(hub.baseline_digest as string) || !Array.isArray(hub.source_ids) || !hub.source_ids.every((entry) => typeof entry === "string") || !Array.isArray(hub.namespaces) || !hub.namespaces.every((entry) => typeof entry === "string")) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan Hub baseline is invalid");
  }
  let nestedImportPlan: ImportPlanDocument;
  try {
    nestedImportPlan = verifyImportPlan(payload.import_plan);
  } catch (error) {
    throw new HubError("E_PLAN_SCHEMA", `nested import plan is invalid: ${(error as Error).message}`);
  }
  if (nestedImportPlan.payload.namespace !== payload.namespace || !sameJson(nestedImportPlan.payload.selected_roots, source.selected_roots)) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan and nested import plan disagree about namespace or selected roots");
  }
  if (!sameJson(payload.candidates, candidateList(nestedImportPlan))) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan candidates do not match the nested import plan");
  }
  if (!Array.isArray(payload.candidates) || !payload.candidates.every((candidate) => record(candidate) && exactKeys(candidate, ["relative_root", "skill_id", "version_hash", "aliases"]) && typeof candidate.relative_root === "string" && typeof candidate.skill_id === "string" && SHA256_RE.test(candidate.version_hash as string) && Array.isArray(candidate.aliases) && candidate.aliases.every((alias) => typeof alias === "string"))) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan candidates are invalid");
  }
  if (!Array.isArray(payload.unselected_skills) || !payload.unselected_skills.every((entry) => typeof entry === "string") || !Array.isArray(payload.diagnostics) || !payload.diagnostics.every((entry) => record(entry) && exactKeys(entry, ["code", "details"]))) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan diagnostics are invalid");
  }
  return value as unknown as AdoptionPlanDocument;
}

function sourceOptions(plan: AdoptionPlanDocument): Parameters<typeof acquireSource>[0] {
  const source = plan.payload.source;
  if (source.type === "git") {
    if (source.repository === undefined || source.requested_ref === undefined || source.resolved_commit === undefined) {
      throw new HubError("E_PLAN_SCHEMA", "Git adoption plan source identity is incomplete");
    }
    return {
      commit: source.resolved_commit,
      provenanceFiles: source.provenance_files,
      ref: source.requested_ref,
      roots: source.selected_roots,
      source: source.repository,
      sourceType: "git",
    };
  }
  if (source.source_path === undefined) throw new HubError("E_PLAN_SCHEMA", "local adoption plan source path is missing");
  return {
    provenanceFiles: source.provenance_files,
    roots: source.selected_roots,
    source: source.source_path,
    sourceType: "local",
  };
}

function copyTree(source: string, destination: string): void {
  const entries = readdirSync(source, { withFileTypes: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new HubError("E_EXTRACTION_POLICY", `symlink forbidden in intake staging: ${entry.name}`);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) writeFileSync(to, readFileSync(from));
    else throw new HubError("E_EXTRACTION_POLICY", `non-regular file forbidden in intake staging: ${entry.name}`);
  }
}

/** Reacquire and persist only operator staging; adopted Hub contracts remain untouched. */
export async function stageAdoptionPlan(plan: AdoptionPlanDocument, hubPath: string): Promise<{ readonly path: string; readonly digest: string }> {
  const verified = verifyAdoptionPlan(plan);
  const importPlan = verified.payload.import_plan.payload;
  const hasNonRepairBlock = verified.payload.diagnostics.length > 0
    || importPlan.candidates.length === 0
    || importPlan.discovery_diagnostics.some((diagnostic) => diagnostic.severity === "ERROR")
    || importPlan.candidates.some((candidate) => candidate.validation === "VALID" && candidate.diagnostics.some((diagnostic) => diagnostic.severity === "ERROR"));
  if (verified.payload.status === "BLOCKED" && hasNonRepairBlock) {
    throw new HubError("E_PLAN_SCHEMA", "adoption plan with source or namespace conflicts cannot be staged");
  }
  const acquired = acquireSource(sourceOptions(verified));
  try {
    if (acquired.tree.treeDigest !== verified.payload.source.selected_skill_tree_digest || acquired.tree.snapshotDigest !== verified.payload.source.vendored_snapshot_digest) {
      throw new HubError("E_PLAN_DIGEST", "source snapshot no longer matches adoption plan");
    }
    const targetPlan = await createImportPlan({
      sourcePath: acquired.snapshotDir,
      namespace: verified.payload.namespace,
      target: emptyRegistryTarget(),
    });
    if (targetPlan.digest !== verified.payload.import_plan.digest) throw new HubError("E_PLAN_DIGEST", "canonical import plan no longer matches adoption plan");
    const hubDir = resolve(hubPath);
    const root = join(hubDir, ".intake-staging", stageDirectoryName(verified.digest));
    if (existsSync(root)) {
      const existing = digestStagedTree(join(root, "source"), verified.payload.source.selected_roots);
      if (existing.treeDigest !== acquired.tree.treeDigest || existing.snapshotDigest !== acquired.tree.snapshotDigest) throw new HubError("E_PLAN_DIGEST", "existing operator stage does not match adoption plan");
      return { digest: verified.digest, path: root };
    }
    const parent = join(hubDir, ".intake-staging");
    mkdirSync(parent, { recursive: true });
    const temporary = mkdtempSync(join(parent, ".pending-"));
    try {
      copyTree(acquired.snapshotDir, join(temporary, "source"));
      writeFileSync(join(temporary, "adoption-plan.json"), `${JSON.stringify(verified, null, 2)}\n`);
      renameSync(temporary, root);
    } catch (error) {
      rmSync(temporary, { force: true, recursive: true });
      throw error;
    }
    return { digest: verified.digest, path: root };
  } finally {
    releaseAcquiredSource(acquired);
  }
}
