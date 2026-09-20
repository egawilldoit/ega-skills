// Contract G local intake planning.
//
// Planning is deliberately separate from import: it reads the source and an
// already-existing registry snapshot, but never creates registry/cache state.
// The artifact is path-independent so it can be reviewed or transported
// before a later apply step binds it to the exact source and target state.

import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { DatabaseConnection } from "better-sqlite3";
import {
  canonicalBytes,
  canonicalPackagePath,
  canonicalizeJson,
  createEnvelope,
  hashBytes,
  isHashingExcludedPath,
  resolveTraversalRoot,
  traverseFiles,
  verifyEnvelope,
  type ArtifactEnvelope,
} from "@ega-skills/hashing";
import { SchemaValidationError, tokenEstimator, validateNamespace, L1_HARD_MAX_TOKENS, type L1Status } from "@ega-skills/schema";

import { DEFAULT_DISCOVERY_DEPTH, DISCOVERY_EXCLUDED_DIRECTORIES, discoverSkillRoots } from "./discovery.js";
import { prepareSkillRoot, type PreparedSkill } from "./preparation.js";

export const INTAKE_CONTRACT = "G1" as const;
export const INTAKE_POLICY_REVISION = "intake-policy-v1" as const;
export const INTAKE_EXTRACTION_POLICY = 1 as const;
export const INTAKE_OBJECT_TYPE = "ega.import-plan" as const;
export const INTAKE_SCHEMA_VERSION = 1 as const;

export type IntakeDiagnosticSeverity = "ERROR" | "WARNING";
export type IntakeCandidateValidation = "VALID" | "INVALID";
export type IntakeChange = "NEW" | "UNCHANGED" | "UPDATE" | "REACTIVATE" | "UNKNOWN";

export interface IntakeDiagnostic {
  readonly code: string;
  readonly severity: IntakeDiagnosticSeverity;
  readonly relative_file: string | null;
  readonly field: string | null;
  readonly candidate_id: string | null;
  readonly related_ids: readonly string[];
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly suggested_action: string;
}

export interface IntakeCandidate {
  readonly relative_root: string;
  readonly proposed_id: string | null;
  readonly validation: IntakeCandidateValidation;
  readonly change: IntakeChange;
  readonly version_hash: string | null;
  readonly current_version_hash: string | null;
  readonly aliases: readonly string[];
  readonly file_count: number;
  readonly canonical_bytes: number | null;
  readonly l1_status: L1Status | null;
  readonly l1_tokens: number | null;
  readonly l2_tokens: number | null;
  readonly diagnostics: readonly IntakeDiagnostic[];
}

export interface IntakeSource {
  readonly type: "local";
  readonly snapshot_digest: string;
  readonly extraction_policy: 1;
}

export interface IntakeTarget {
  readonly mode: "EMPTY" | "REGISTRY";
  readonly state_digest: string;
}

export interface IntakeSummary {
  readonly candidate_count: number;
  readonly valid_count: number;
  readonly invalid_count: number;
  readonly blocked_count: number;
  readonly warning_count: number;
}

export interface ImportPlanPayload {
  readonly intake_contract: "G1";
  readonly namespace: string;
  readonly source: IntakeSource;
  readonly selected_roots: readonly string[];
  readonly policy_revision: "intake-policy-v1";
  readonly target: IntakeTarget;
  readonly discovery_diagnostics: readonly IntakeDiagnostic[];
  readonly candidates: readonly IntakeCandidate[];
  readonly summary: IntakeSummary;
}

export type ImportPlanDocument = ArtifactEnvelope & {
  readonly object_type: "ega.import-plan";
  readonly schema_version: 1;
  readonly payload: ImportPlanPayload;
};

export interface RegistryTargetView {
  readonly mode: IntakeTarget["mode"];
  readonly current: ReadonlyMap<string, string>;
  readonly historical: ReadonlyMap<string, ReadonlySet<string>>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly stateDigest: string;
}

interface RawSnapshotFile {
  readonly root: string;
  readonly path: string;
  readonly raw_hash: string;
  readonly byte_size: number;
}

interface RawSnapshot {
  readonly digest: string;
  readonly files: readonly RawSnapshotFile[];
}

export interface CreateImportPlanOptions {
  readonly sourcePath: string;
  readonly namespace: string;
  readonly target?: RegistryTargetView;
}

export class IntakePlanError extends Error {
  readonly code: "E_INTAKE_TARGET" | "E_INTAKE_SOURCE";

  constructor(code: "E_INTAKE_TARGET" | "E_INTAKE_SOURCE", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntakePlanError";
    this.code = code;
  }
}

interface CurrentRow {
  readonly skill_id: string;
  readonly current_version_hash: string;
}

interface VersionRow {
  readonly skill_id: string;
  readonly version_hash: string;
}

interface AliasRow {
  readonly alias: string;
  readonly skill_id: string;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compare);
}

function normalizedRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.length === 0 ? "." : normalized;
}

function relativeRoot(sourcePath: string, root: string): string {
  const sourceRoot = resolve(sourcePath);
  const value = normalizedRelativePath(root === sourceRoot ? "" : root.slice(sourceRoot.length).replace(/^[/\\]/, ""));
  return value === "" ? "." : value;
}

function diagnosticSort(left: IntakeDiagnostic, right: IntakeDiagnostic): number {
  const leftKey = [left.code, left.severity, left.relative_file ?? "", left.field ?? "", left.candidate_id ?? "", left.related_ids.join(",")].join("\u0000");
  const rightKey = [right.code, right.severity, right.relative_file ?? "", right.field ?? "", right.candidate_id ?? "", right.related_ids.join(",")].join("\u0000");
  return compare(leftKey, rightKey);
}

function makeDiagnostic(input: {
  readonly code: string;
  readonly severity: IntakeDiagnosticSeverity;
  readonly relativeFile?: string | null;
  readonly field?: string | null;
  readonly candidateId?: string | null;
  readonly relatedIds?: readonly string[];
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly suggestedAction: string;
}): IntakeDiagnostic {
  return Object.freeze({
    code: input.code,
    severity: input.severity,
    relative_file: input.relativeFile ?? null,
    field: input.field ?? null,
    candidate_id: input.candidateId ?? null,
    related_ids: Object.freeze(sorted(input.relatedIds ?? [])),
    details: Object.freeze({ ...(input.details ?? {}) }),
    suggested_action: input.suggestedAction,
  });
}

function sourceErrorDiagnostic(root: string, error: unknown): IntakeDiagnostic {
  if (error instanceof SchemaValidationError) {
    const path = error.path === undefined ? null : normalizedRelativePath(error.path).replace(`${basename(root)}/`, "");
    return makeDiagnostic({
      code: error.code,
      severity: "ERROR",
      relativeFile: path,
      field: error.field ?? null,
      details: {},
      suggestedAction: "repair the candidate and rerun import-plan",
    });
  }
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "E_CANDIDATE_INVALID";
  return makeDiagnostic({
    code,
    severity: "ERROR",
    details: {},
    suggestedAction: "repair the candidate and rerun import-plan",
  });
}

async function auditDiscovery(sourcePath: string): Promise<readonly IntakeDiagnostic[]> {
  const diagnostics: IntakeDiagnostic[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      diagnostics.push(makeDiagnostic({
        code: "E_DISCOVERY_UNREADABLE",
        severity: "ERROR",
        relativeFile: relativeRoot(sourcePath, directory),
        details: { depth },
        suggestedAction: "make the source directory readable and rerun import-plan",
      }));
      return;
    }
    entries.sort((left, right) => compare(left.name, right.name));
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) return;
    if (depth >= DEFAULT_DISCOVERY_DEPTH) {
      if (entries.some((entry) => entry.isDirectory() && !entry.isSymbolicLink())) {
        diagnostics.push(makeDiagnostic({
          code: "W_DISCOVERY_DEPTH_LIMIT",
          severity: "WARNING",
          relativeFile: relativeRoot(sourcePath, directory),
          details: { max_depth: DEFAULT_DISCOVERY_DEPTH },
          suggestedAction: "place the skill root within the discovery depth or pass an explicit skill path",
        }));
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || DISCOVERY_EXCLUDED_DIRECTORIES.includes(entry.name)) continue;
      await visit(join(directory, entry.name), depth + 1);
    }
  }
  await visit(sourcePath, 0);
  return Object.freeze(diagnostics.sort(diagnosticSort));
}

async function rawSnapshotForRoots(sourcePath: string, roots: readonly string[]): Promise<RawSnapshot> {
  const files: RawSnapshotFile[] = [];
  for (const root of roots) {
    const traversalRoot = await resolveTraversalRoot(root);
    const rootLabel = relativeRoot(sourcePath, root);
    const traversed = await traverseFiles(traversalRoot, {
      shouldVisit(path) {
        return !isHashingExcludedPath(path);
      },
    });
    for (const file of traversed) {
      const path = canonicalPackagePath(file.relativePath);
      const bytes = await file.read();
      files.push({
        root: rootLabel,
        path,
        raw_hash: hashBytes(bytes),
        byte_size: bytes.byteLength,
      });
    }
  }
  files.sort((left, right) => compare(
    [left.root, left.path].join("\u0000"),
    [right.root, right.path].join("\u0000"),
  ));
  const preimage = {
    extraction_policy: INTAKE_EXTRACTION_POLICY,
    files,
  };
  return Object.freeze({
    digest: hashBytes(canonicalizeJson(preimage)),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
}

function targetDigest(input: {
  readonly mode: IntakeTarget["mode"];
  readonly current: ReadonlyMap<string, string>;
  readonly historical: ReadonlyMap<string, ReadonlySet<string>>;
  readonly aliases: ReadonlyMap<string, string>;
}): string {
  const current = [...input.current.entries()].sort((left, right) => compare(left[0], right[0]));
  const historical = [...input.historical.entries()]
    .sort((left, right) => compare(left[0], right[0]))
    .map(([skillId, hashes]) => [skillId, sorted(hashes)] as const);
  const aliases = [...input.aliases.entries()].sort((left, right) => compare(left[0], right[0]));
  return hashBytes(canonicalizeJson({
    mode: input.mode,
    policy_revision: INTAKE_POLICY_REVISION,
    current,
    historical,
    aliases,
  }));
}

export function emptyRegistryTarget(): RegistryTargetView {
  const current = new Map<string, string>();
  const historical = new Map<string, ReadonlySet<string>>();
  const aliases = new Map<string, string>();
  return {
    mode: "EMPTY",
    current,
    historical,
    aliases,
    stateDigest: targetDigest({ mode: "EMPTY", current, historical, aliases }),
  };
}

export function registryTargetFromDatabase(db: DatabaseConnection): RegistryTargetView {
  const current = new Map<string, string>();
  for (const row of db.prepare("SELECT skill_id, current_version_hash FROM skills ORDER BY skill_id ASC").all<CurrentRow>()) {
    current.set(row.skill_id, row.current_version_hash);
  }
  const historical = new Map<string, Set<string>>();
  for (const row of db.prepare("SELECT skill_id, version_hash FROM skill_versions ORDER BY skill_id ASC, version_hash ASC").all<VersionRow>()) {
    const hashes = historical.get(row.skill_id) ?? new Set<string>();
    hashes.add(row.version_hash);
    historical.set(row.skill_id, hashes);
  }
  const aliases = new Map<string, string>();
  for (const row of db.prepare("SELECT alias, skill_id FROM skill_aliases ORDER BY alias ASC").all<AliasRow>()) {
    aliases.set(row.alias, row.skill_id);
  }
  return {
    mode: "REGISTRY",
    current,
    historical,
    aliases,
    stateDigest: targetDigest({ mode: "REGISTRY", current, historical, aliases }),
  };
}

function canonicalBytesForPrepared(prepared: PreparedSkill): number {
  return prepared.files.reduce((sum, file) => sum + file.record.byte_size, 0);
}

function l1Warning(prepared: PreparedSkill): IntakeDiagnostic | null {
  const core = prepared.files.find((file) => file.record.path === "SKILL.core.md");
  if (core === undefined || prepared.l1Status !== "MISSING") return null;
  const tokens = tokenEstimator.count(new TextDecoder().decode(canonicalBytes(core.bytes)));
  if (tokens <= L1_HARD_MAX_TOKENS) return null;
  return makeDiagnostic({
    code: "W_L1_DOWNGRADED",
    severity: "WARNING",
    relativeFile: "SKILL.core.md",
    field: "l1_status",
    candidateId: prepared.skillId,
    details: { from: "AUTHORED", to: "MISSING", token_count: tokens, max_tokens: L1_HARD_MAX_TOKENS },
    suggestedAction: "review the L1 size warning; no generated L1 will be added",
  });
}

function candidateChange(prepared: PreparedSkill, target: RegistryTargetView): IntakeChange {
  const current = target.current.get(prepared.skillId);
  if (current === undefined) return "NEW";
  if (current === prepared.versionHash) return "UNCHANGED";
  return target.historical.get(prepared.skillId)?.has(prepared.versionHash) === true ? "REACTIVATE" : "UPDATE";
}

function invalidCandidate(rootLabel: string, fileCount: number, diagnostics: readonly IntakeDiagnostic[]): IntakeCandidate {
  return Object.freeze({
    relative_root: rootLabel,
    proposed_id: null,
    validation: "INVALID",
    change: "UNKNOWN",
    version_hash: null,
    current_version_hash: null,
    aliases: Object.freeze([]),
    file_count: fileCount,
    canonical_bytes: null,
    l1_status: null,
    l1_tokens: null,
    l2_tokens: null,
    diagnostics: Object.freeze([...diagnostics].sort(diagnosticSort)),
  });
}

export async function createImportPlan(options: CreateImportPlanOptions): Promise<ImportPlanDocument> {
  validateNamespace(options.namespace, { field: "namespace" });
  const sourcePath = resolve(options.sourcePath);
  const target = options.target ?? emptyRegistryTarget();
  let roots: string[];
  try {
    roots = await discoverSkillRoots(sourcePath);
  } catch (error) {
    throw new IntakePlanError("E_INTAKE_SOURCE", `Unable to discover intake source ${sourcePath}.`, error);
  }
  roots.sort();
  const selectedRoots = roots.map((root) => relativeRoot(sourcePath, root)).sort(compare);
  const discoveryDiagnostics = [...await auditDiscovery(sourcePath)];
  if (roots.length === 0 && !discoveryDiagnostics.some((diagnostic) => diagnostic.code === "E_DISCOVERY_UNREADABLE")) {
    discoveryDiagnostics.push(makeDiagnostic({
      code: "E_DISCOVERY_NO_ROOTS",
      severity: "ERROR",
      relativeFile: ".",
      details: { max_depth: DEFAULT_DISCOVERY_DEPTH },
      suggestedAction: "provide a folder containing SKILL.md or pass an explicit skill path",
    }));
  }
  const rawSnapshot = await rawSnapshotForRoots(sourcePath, roots);
  const rawFilesByRoot = new Map<string, number>();
  for (const file of rawSnapshot.files) rawFilesByRoot.set(file.root, (rawFilesByRoot.get(file.root) ?? 0) + 1);

  const candidates: IntakeCandidate[] = [];
  for (const root of roots) {
    const rootLabel = relativeRoot(sourcePath, root);
    try {
      const prepared = await prepareSkillRoot(root, options.namespace);
      const diagnostics: IntakeDiagnostic[] = [];
      const warning = l1Warning(prepared);
      if (warning !== null) diagnostics.push(warning);
      candidates.push(Object.freeze({
        relative_root: rootLabel,
        proposed_id: prepared.skillId,
        validation: "VALID",
        change: candidateChange(prepared, target),
        version_hash: prepared.versionHash,
        current_version_hash: target.current.get(prepared.skillId) ?? null,
        aliases: Object.freeze([...prepared.routing.aliases].sort(compare)),
        file_count: prepared.files.length,
        canonical_bytes: canonicalBytesForPrepared(prepared),
        l1_status: prepared.l1Status,
        l1_tokens: prepared.l1Tokens,
        l2_tokens: prepared.l2Tokens,
        diagnostics: Object.freeze(diagnostics),
      }));
    } catch (error) {
      candidates.push(invalidCandidate(rootLabel, rawFilesByRoot.get(rootLabel) ?? 0, [sourceErrorDiagnostic(root, error)]));
    }
  }

  const byId = new Map<string, IntakeCandidate[]>();
  const byAlias = new Map<string, IntakeCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.validation !== "VALID" || candidate.proposed_id === null) continue;
    const idCandidates = byId.get(candidate.proposed_id) ?? [];
    idCandidates.push(candidate);
    byId.set(candidate.proposed_id, idCandidates);
    for (const alias of candidate.aliases) {
      const aliasCandidates = byAlias.get(alias) ?? [];
      aliasCandidates.push(candidate);
      byAlias.set(alias, aliasCandidates);
    }
  }

  const withConflicts = candidates.map((candidate) => {
    if (candidate.validation !== "VALID" || candidate.proposed_id === null) return candidate;
    const diagnostics = [...candidate.diagnostics];
    const duplicateIds = byId.get(candidate.proposed_id) ?? [];
    if (duplicateIds.length > 1) {
      diagnostics.push(makeDiagnostic({
        code: "E_DUPLICATE_ID",
        severity: "ERROR",
        field: "proposed_id",
        candidateId: candidate.proposed_id,
        relatedIds: duplicateIds.map((entry) => entry.relative_root),
        details: { occurrences: duplicateIds.length },
        suggestedAction: "keep one candidate for the ID or rename the duplicate source",
      }));
    }
    for (const alias of candidate.aliases) {
      const owner = target.aliases.get(alias);
      if (owner !== undefined && owner !== candidate.proposed_id) {
        diagnostics.push(makeDiagnostic({
          code: "E_ALIAS_CONFLICT",
          severity: "ERROR",
          field: "aliases",
          candidateId: candidate.proposed_id,
          relatedIds: [owner, candidate.proposed_id],
          details: { alias },
          suggestedAction: "rename the alias or explicitly resolve its existing owner",
        }));
      }
      const aliasCandidates = byAlias.get(alias) ?? [];
      if (aliasCandidates.length > 1 && aliasCandidates.some((entry) => entry.proposed_id !== candidate.proposed_id)) {
        diagnostics.push(makeDiagnostic({
          code: "E_ALIAS_CONFLICT",
          severity: "ERROR",
          field: "aliases",
          candidateId: candidate.proposed_id,
          relatedIds: aliasCandidates.map((entry) => entry.proposed_id ?? ""),
          details: { alias },
          suggestedAction: "assign the alias to one candidate before apply",
        }));
      }
    }
    return Object.freeze({ ...candidate, diagnostics: Object.freeze(diagnostics.sort(diagnosticSort)) });
  });

  const summary: IntakeSummary = Object.freeze({
    candidate_count: withConflicts.length,
    valid_count: withConflicts.filter((candidate) => candidate.validation === "VALID").length,
    invalid_count: withConflicts.filter((candidate) => candidate.validation === "INVALID").length,
    blocked_count: withConflicts.filter((candidate) => candidate.validation === "INVALID" || candidate.diagnostics.some((diagnostic) => diagnostic.severity === "ERROR")).length
      + discoveryDiagnostics.filter((diagnostic) => diagnostic.severity === "ERROR").length,
    warning_count: discoveryDiagnostics.filter((diagnostic) => diagnostic.severity === "WARNING").length
      + withConflicts.reduce((sum, candidate) => sum + candidate.diagnostics.filter((diagnostic) => diagnostic.severity === "WARNING").length, 0),
  });
  const payload: ImportPlanPayload = Object.freeze({
    intake_contract: INTAKE_CONTRACT,
    namespace: options.namespace,
    source: Object.freeze({ type: "local", snapshot_digest: rawSnapshot.digest, extraction_policy: INTAKE_EXTRACTION_POLICY }),
    selected_roots: Object.freeze(selectedRoots),
    policy_revision: INTAKE_POLICY_REVISION,
    target: Object.freeze({ mode: target.mode, state_digest: target.stateDigest }),
    discovery_diagnostics: Object.freeze(discoveryDiagnostics.sort(diagnosticSort)),
    candidates: Object.freeze(withConflicts.sort((left, right) => compare(left.relative_root, right.relative_root))),
    summary,
  });
  return createEnvelope({
    object_type: INTAKE_OBJECT_TYPE,
    schema_version: INTAKE_SCHEMA_VERSION,
    payload,
  }) as ImportPlanDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compare);
  return JSON.stringify(keys) === JSON.stringify([...expected].sort(compare));
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isHashIdentity(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validDiagnostic(value: unknown): value is IntakeDiagnostic {
  if (!isRecord(value) || !exactKeys(value, ["code", "severity", "relative_file", "field", "candidate_id", "related_ids", "details", "suggested_action"])) return false;
  return typeof value.code === "string"
    && (value.severity === "ERROR" || value.severity === "WARNING")
    && (value.relative_file === null || typeof value.relative_file === "string")
    && (value.field === null || typeof value.field === "string")
    && (value.candidate_id === null || typeof value.candidate_id === "string")
    && stringArray(value.related_ids)
    && isRecord(value.details)
    && Object.values(value.details).every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")
    && typeof value.suggested_action === "string";
}

function validCandidate(value: unknown): value is IntakeCandidate {
  if (!isRecord(value) || !exactKeys(value, ["relative_root", "proposed_id", "validation", "change", "version_hash", "current_version_hash", "aliases", "file_count", "canonical_bytes", "l1_status", "l1_tokens", "l2_tokens", "diagnostics"])) return false;
  return typeof value.relative_root === "string"
    && (value.proposed_id === null || typeof value.proposed_id === "string")
    && (value.validation === "VALID" || value.validation === "INVALID")
    && (value.change === "NEW" || value.change === "UNCHANGED" || value.change === "UPDATE" || value.change === "REACTIVATE" || value.change === "UNKNOWN")
    && (value.version_hash === null || typeof value.version_hash === "string")
    && (value.current_version_hash === null || typeof value.current_version_hash === "string")
    && stringArray(value.aliases)
    && Number.isInteger(value.file_count) && (value.file_count as number) >= 0
    && (value.canonical_bytes === null || (Number.isInteger(value.canonical_bytes) && (value.canonical_bytes as number) >= 0))
    && (value.l1_status === null || value.l1_status === "AUTHORED" || value.l1_status === "MISSING")
    && (value.l1_tokens === null || (Number.isInteger(value.l1_tokens) && (value.l1_tokens as number) >= 0))
    && (value.l2_tokens === null || (Number.isInteger(value.l2_tokens) && (value.l2_tokens as number) >= 0))
    && Array.isArray(value.diagnostics) && value.diagnostics.every(validDiagnostic);
}

export function verifyImportPlan(value: unknown): ImportPlanDocument {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !isRecord(value) || value.object_type !== INTAKE_OBJECT_TYPE || value.schema_version !== INTAKE_SCHEMA_VERSION) {
    throw new Error(`Invalid import plan envelope: ${envelope.ok ? "unexpected object type or schema" : envelope.message}`);
  }
  const payload = value.payload;
  if (!isRecord(payload) || !exactKeys(payload, ["intake_contract", "namespace", "source", "selected_roots", "policy_revision", "target", "discovery_diagnostics", "candidates", "summary"])) throw new Error("Invalid import plan payload fields.");
  if (payload.intake_contract !== INTAKE_CONTRACT || typeof payload.namespace !== "string" || payload.policy_revision !== INTAKE_POLICY_REVISION || !stringArray(payload.selected_roots) || !Array.isArray(payload.discovery_diagnostics) || !payload.discovery_diagnostics.every(validDiagnostic) || !Array.isArray(payload.candidates) || !payload.candidates.every(validCandidate)) throw new Error("Invalid import plan payload values.");
  try {
    validateNamespace(payload.namespace, { field: "namespace" });
  } catch {
    throw new Error("Invalid import plan namespace.");
  }
  if (!isRecord(payload.source) || !exactKeys(payload.source, ["type", "snapshot_digest", "extraction_policy"]) || payload.source.type !== "local" || !isHashIdentity(payload.source.snapshot_digest) || payload.source.extraction_policy !== INTAKE_EXTRACTION_POLICY) throw new Error("Invalid import plan source.");
  if (!isRecord(payload.target) || !exactKeys(payload.target, ["mode", "state_digest"]) || (payload.target.mode !== "EMPTY" && payload.target.mode !== "REGISTRY") || !isHashIdentity(payload.target.state_digest)) throw new Error("Invalid import plan target.");
  for (const candidate of payload.candidates) {
    if (candidate.validation === "VALID" && !isHashIdentity(candidate.version_hash)) throw new Error("Invalid import plan candidate identity.");
    if (candidate.validation === "INVALID" && candidate.version_hash !== null) throw new Error("Invalid import plan invalid candidate identity.");
    if (candidate.current_version_hash !== null && !isHashIdentity(candidate.current_version_hash)) throw new Error("Invalid import plan current identity.");
  }
  if (!isRecord(payload.summary) || !exactKeys(payload.summary, ["candidate_count", "valid_count", "invalid_count", "blocked_count", "warning_count"]) || !Object.values(payload.summary).every((entry) => Number.isInteger(entry) && (entry as number) >= 0)) throw new Error("Invalid import plan summary.");
  const expectedSummary = {
    candidate_count: payload.candidates.length,
    valid_count: payload.candidates.filter((candidate) => candidate.validation === "VALID").length,
    invalid_count: payload.candidates.filter((candidate) => candidate.validation === "INVALID").length,
    blocked_count: payload.candidates.filter((candidate) => candidate.validation === "INVALID" || candidate.diagnostics.some((diagnostic) => diagnostic.severity === "ERROR")).length
      + payload.discovery_diagnostics.filter((diagnostic) => diagnostic.severity === "ERROR").length,
    warning_count: payload.discovery_diagnostics.filter((diagnostic) => diagnostic.severity === "WARNING").length
      + payload.candidates.reduce((sum, candidate) => sum + candidate.diagnostics.filter((diagnostic) => diagnostic.severity === "WARNING").length, 0),
  };
  for (const key of Object.keys(expectedSummary) as (keyof typeof expectedSummary)[]) {
    if (payload.summary[key] !== expectedSummary[key]) throw new Error("Invalid import plan summary counts.");
  }
  return value as unknown as ImportPlanDocument;
}
