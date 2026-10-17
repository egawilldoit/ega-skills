// Contract D1: exact, reviewable owned-derivative proposals.
//
// A derivative is prepared from an immutable staged candidate. The original
// stage is never edited; the proposal records the exact input-file digest and
// replacement bytes, and apply rechecks both before writing a new stage.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { TextEncoder } from "node:util";
import { parseCanonicalSkillId, prepareSkillRoot, SchemaValidationError } from "@ega-skills/registry";
import { canonicalizeJson, createEnvelope, hashBytes, verifyEnvelope, type ArtifactEnvelope } from "@ega-skills/hashing";
import { HubError } from "../hub/errors.js";
import { parseHubYaml } from "../hub/hub-config.js";
import { SHA256_RE, assertRelativePosix } from "../hub/guards.js";
import { verifyAdoptionPlan, verifyAdoptionStage, type AdoptionPlanDocument } from "./adoption-plan.js";

export const DERIVATION_OBJECT_TYPE = "ega.derivation-plan" as const;
export const DERIVATION_PATCH_OBJECT_TYPE = "ega.derivation-patch" as const;
export const DERIVATION_SCHEMA_VERSION = 1 as const;

export interface DerivationPatchPayload {
  readonly skill_id: string;
  readonly path: string;
  readonly expected_digest: string;
  readonly replacement: string;
  readonly reason: string;
  readonly rule_version: string;
}

export type DerivationPatchDocument = ArtifactEnvelope & {
  readonly object_type: "ega.derivation-patch";
  readonly schema_version: 1;
  readonly payload: DerivationPatchPayload;
};

export interface DerivationProposalPayload {
  readonly derivation_contract: "D1";
  readonly candidate_digest: string;
  readonly source_plan_digest: string;
  readonly original: {
    readonly skill_id: string;
    readonly version_hash: string | null;
    readonly relative_root: string;
    readonly input_file_digest: string;
    readonly snapshot_digest: string;
  };
  readonly provenance: {
    readonly source_type: "git" | "local";
    readonly source_locator: string;
    readonly requested_ref: string | null;
    readonly resolved_commit: string | null;
    readonly selected_root: string;
    readonly provenance_files: readonly string[];
    readonly snapshot_digest: string;
  };
  readonly patch: DerivationPatchPayload & { readonly patch_digest: string };
  readonly target: { readonly skill_id: string; readonly relative_root: string };
  readonly predicted_version_hash: string;
  readonly status: "READY";
}

export type DerivationProposalDocument = ArtifactEnvelope & {
  readonly object_type: "ega.derivation-plan";
  readonly schema_version: 1;
  readonly payload: DerivationProposalPayload;
};

export interface DerivationApplyResult {
  readonly candidate_digest: string;
  readonly derived_skill_id: string;
  readonly version_hash: string;
  readonly path: string;
  readonly idempotent: boolean;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function fail(message: string): never {
  throw new HubError("E_DERIVATION", message);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  return value;
}

function stageName(digest: string): string {
  if (!SHA256_RE.test(digest)) fail("derivation candidate digest is invalid");
  return digest.slice("sha256:".length);
}

function digestReplacement(patch: DerivationPatchPayload): string {
  return hashBytes(canonicalizeJson({
    expected_digest: patch.expected_digest,
    path: patch.path,
    reason: patch.reason,
    replacement: patch.replacement,
    rule_version: patch.rule_version,
    skill_id: patch.skill_id,
  }));
}

export function verifyDerivationPatch(value: unknown): DerivationPatchDocument {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !isRecord(value) || value.object_type !== DERIVATION_PATCH_OBJECT_TYPE || value.schema_version !== DERIVATION_SCHEMA_VERSION) {
    fail(`derivation patch envelope is invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  const payload = value.payload;
  if (!isRecord(payload) || !exactKeys(payload, ["skill_id", "path", "expected_digest", "replacement", "reason", "rule_version"])) {
    fail("derivation patch payload fields are invalid");
  }
  const skillId = stringField(payload.skill_id, "derivation patch skill_id");
  const path = stringField(payload.path, "derivation patch path");
  const replacement = stringField(payload.replacement, "derivation patch replacement");
  const reason = stringField(payload.reason, "derivation patch reason");
  const ruleVersion = stringField(payload.rule_version, "derivation patch rule_version");
  const expectedDigest = stringField(payload.expected_digest, "derivation patch expected_digest");
  try {
    parseCanonicalSkillId(skillId);
    assertRelativePosix(path, "derivation patch path");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!SHA256_RE.test(expectedDigest) || reason.length === 0 || ruleVersion.length === 0) {
    fail("derivation patch identity fields are invalid");
  }
  return value as unknown as DerivationPatchDocument;
}

export function verifyDerivationProposal(value: unknown): DerivationProposalDocument {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !isRecord(value) || value.object_type !== DERIVATION_OBJECT_TYPE || value.schema_version !== DERIVATION_SCHEMA_VERSION) {
    fail(`derivation plan envelope is invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  const payload = value.payload;
  if (!isRecord(payload) || !exactKeys(payload, ["derivation_contract", "candidate_digest", "source_plan_digest", "original", "provenance", "patch", "target", "predicted_version_hash", "status"]) || payload.derivation_contract !== "D1" || payload.status !== "READY") {
    fail("derivation plan payload fields are invalid");
  }
  const candidateDigest = stringField(payload.candidate_digest, "derivation plan candidate_digest");
  const sourcePlanDigest = stringField(payload.source_plan_digest, "derivation plan source_plan_digest");
  const predictedVersionHash = stringField(payload.predicted_version_hash, "derivation plan predicted_version_hash");
  if (sourcePlanDigest !== candidateDigest || !SHA256_RE.test(candidateDigest) || !SHA256_RE.test(sourcePlanDigest) || !SHA256_RE.test(predictedVersionHash)) {
    fail("derivation plan digests are invalid");
  }
  const original = payload.original;
  if (!isRecord(original) || !exactKeys(original, ["skill_id", "version_hash", "relative_root", "input_file_digest", "snapshot_digest"])) {
    fail("derivation plan original identity is invalid");
  }
  const originalSkillId = stringField(original.skill_id, "derivation plan original.skill_id");
  const originalVersionHash = original.version_hash === null ? null : stringField(original.version_hash, "derivation plan original.version_hash");
  const originalRoot = stringField(original.relative_root, "derivation plan original.relative_root");
  const originalInputDigest = stringField(original.input_file_digest, "derivation plan original.input_file_digest");
  const originalSnapshotDigest = stringField(original.snapshot_digest, "derivation plan original.snapshot_digest");
  if ((originalVersionHash !== null && !SHA256_RE.test(originalVersionHash)) || !SHA256_RE.test(originalInputDigest) || !SHA256_RE.test(originalSnapshotDigest)) {
    fail("derivation plan original identity is invalid");
  }
  const provenance = payload.provenance;
  if (!isRecord(provenance) || !exactKeys(provenance, ["source_type", "source_locator", "requested_ref", "resolved_commit", "selected_root", "provenance_files", "snapshot_digest"])) {
    fail("derivation plan provenance is invalid");
  }
  const sourceType = provenance.source_type;
  const sourceLocator = stringField(provenance.source_locator, "derivation plan provenance.source_locator");
  const requestedRef = provenance.requested_ref === null ? null : stringField(provenance.requested_ref, "derivation plan provenance.requested_ref");
  const resolvedCommit = provenance.resolved_commit === null ? null : stringField(provenance.resolved_commit, "derivation plan provenance.resolved_commit");
  const selectedRoot = stringField(provenance.selected_root, "derivation plan provenance.selected_root");
  const provenanceFiles = provenance.provenance_files;
  const provenanceSnapshot = stringField(provenance.snapshot_digest, "derivation plan provenance.snapshot_digest");
  if ((sourceType !== "git" && sourceType !== "local") || sourceLocator.length === 0 || !Array.isArray(provenanceFiles) || !provenanceFiles.every((entry) => typeof entry === "string") || !SHA256_RE.test(provenanceSnapshot) || (resolvedCommit !== null && !/^[0-9a-f]{40}$/.test(resolvedCommit))) {
    fail("derivation plan provenance values are invalid");
  }
  if (sourceType === "git" && (requestedRef === null || resolvedCommit === null)) fail("Git derivation provenance is incomplete");
  if (sourceType === "local" && (requestedRef !== null || resolvedCommit !== null)) fail("local derivation provenance must not contain Git identity");
  assertRelativePosix(selectedRoot, "derivation plan provenance.selected_root");
  try {
    parseCanonicalSkillId(originalSkillId);
    assertRelativePosix(originalRoot, "derivation plan original.relative_root");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const patch = payload.patch;
  if (!isRecord(patch) || !exactKeys(patch, ["skill_id", "path", "expected_digest", "replacement", "reason", "rule_version", "patch_digest"])) {
    fail("derivation plan patch is invalid");
  }
  const patchSkillId = stringField(patch.skill_id, "derivation plan patch.skill_id");
  const patchPath = stringField(patch.path, "derivation plan patch.path");
  const patchExpectedDigest = stringField(patch.expected_digest, "derivation plan patch.expected_digest");
  const patchReplacement = stringField(patch.replacement, "derivation plan patch.replacement");
  const patchReason = stringField(patch.reason, "derivation plan patch.reason");
  const patchRuleVersion = stringField(patch.rule_version, "derivation plan patch.rule_version");
  const patchDigest = stringField(patch.patch_digest, "derivation plan patch.patch_digest");
  if (!SHA256_RE.test(patchExpectedDigest) || !SHA256_RE.test(patchDigest)) fail("derivation plan patch digests are invalid");
  if (digestReplacement({
    expected_digest: patchExpectedDigest,
    path: patchPath,
    reason: patchReason,
    replacement: patchReplacement,
    rule_version: patchRuleVersion,
    skill_id: patchSkillId,
  }) !== patchDigest) {
    fail("derivation patch digest does not match its exact fields");
  }
  verifyDerivationPatch(createEnvelope({ object_type: DERIVATION_PATCH_OBJECT_TYPE, payload: {
    expected_digest: patchExpectedDigest,
    path: patchPath,
    reason: patchReason,
    replacement: patchReplacement,
    rule_version: patchRuleVersion,
    skill_id: patchSkillId,
  }, schema_version: DERIVATION_SCHEMA_VERSION }));
  const target = payload.target;
  if (!isRecord(target) || !exactKeys(target, ["skill_id", "relative_root"])) {
    fail("derivation plan target is invalid");
  }
  const targetSkillId = stringField(target.skill_id, "derivation plan target.skill_id");
  const targetRoot = stringField(target.relative_root, "derivation plan target.relative_root");
  try {
    parseCanonicalSkillId(targetSkillId);
    assertRelativePosix(targetRoot, "derivation plan target.relative_root");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return value as unknown as DerivationProposalDocument;
}

function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) fail(`symlink forbidden in derivative source: ${entry.name}`);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) writeFileSync(to, readFileSync(from));
    else fail(`non-regular file forbidden in derivative source: ${entry.name}`);
  }
}

function sourceStage(hubDir: string, candidateDigest: string): { readonly plan: AdoptionPlanDocument; readonly root: string } {
  const stageRoot = join(resolve(hubDir), ".intake-staging", stageName(candidateDigest));
  const planPath = join(stageRoot, "adoption-plan.json");
  if (!existsSync(planPath)) fail(`staged candidate is missing: ${candidateDigest}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    fail(`staged candidate plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const plan = verifyAdoptionPlan(raw);
  if (plan.digest !== candidateDigest) fail("staged candidate plan digest does not match its requested identity");
  try {
    return { plan, root: join(verifyAdoptionStage(hubDir, plan), "source") };
  } catch (error) {
    if (error instanceof HubError) fail(error.message);
    throw error;
  }
}

interface DerivationSourceCandidate {
  readonly relative_root: string;
  readonly skill_id: string;
  readonly version_hash: string | null;
}

function findCandidate(plan: AdoptionPlanDocument, skillId: string, patchPath: string): DerivationSourceCandidate {
  const candidate = plan.payload.candidates.find((entry) => entry.skill_id === skillId);
  if (candidate !== undefined) return candidate;
  const invalid = plan.payload.import_plan.payload.candidates.find((entry) => entry.validation === "INVALID" && (patchPath === entry.relative_root || patchPath.startsWith(`${entry.relative_root}/`)));
  if (invalid === undefined) fail(`staged candidate does not contain ${skillId}`);
  const parsed = parseCanonicalSkillId(skillId);
  if (parsed.namespace !== plan.payload.namespace) fail(`derivation source ${skillId} is outside the adoption namespace`);
  return { relative_root: invalid.relative_root, skill_id: skillId, version_hash: null };
}

function pathWithin(root: string, candidatePath: string): string {
  const absolute = resolve(root, ...candidatePath.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}/`) && !absolute.startsWith(`${root}\\`)) fail("derivation patch path escapes candidate root");
  return absolute;
}

function checkPatchPath(sourceRoot: string, candidateRoot: string, patchPath: string): string {
  const prefix = `${candidateRoot}/`;
  if (!patchPath.startsWith(prefix)) fail(`derivation patch path must be under candidate root ${candidateRoot}`);
  return pathWithin(sourceRoot, patchPath);
}

function temporaryPatchedRoot(sourceRoot: string, candidateRoot: string, targetName: string, patch: DerivationPatchPayload): { readonly root: string; readonly cleanup: () => void } {
  const targetFile = checkPatchPath(sourceRoot, candidateRoot, patch.path);
  let before: Uint8Array;
  try {
    before = readFileSync(targetFile);
  } catch {
    fail(`derivation patch file is missing: ${patch.path}`);
  }
  if (hashBytes(before) !== patch.expected_digest) fail(`derivation patch precondition failed for ${patch.path}`);
  const parent = mkdtempSync(join(tmpdir(), "ega-derivative-"));
  const root = join(parent, targetName);
  copyTree(join(sourceRoot, ...candidateRoot.split("/")), root);
  const inside = relative(join(sourceRoot, ...candidateRoot.split("/")), targetFile).replaceAll("\\", "/");
  if (inside.startsWith("../") || inside === "..") fail("derivation patch path escaped candidate root");
  writeFileSync(join(root, ...inside.split("/")), new TextEncoder().encode(patch.replacement));
  return { cleanup: () => rmSync(parent, { force: true, recursive: true }), root };
}

async function checkOwnedTarget(hubDir: string, targetId: string, versionHash: string): Promise<void> {
  const hubFile = join(hubDir, "hub.yaml");
  if (!existsSync(hubFile)) return;
  const hub = parseHubYaml(readFileSync(hubFile, "utf8"));
  const parsed = parseCanonicalSkillId(targetId);
  const owned = hub.owned.find((entry) => entry.namespace === parsed.namespace);
  if (owned === undefined) return;
  const root = join(hubDir, ...owned.path.split("/"), parsed.name);
  if (!existsSync(root)) return;
  try {
    const existing = await prepareSkillRoot(root, parsed.namespace);
    if (existing.versionHash !== versionHash) fail(`owned target ${targetId} already contains different bytes`);
  } catch (error) {
    if (error instanceof HubError) throw error;
    fail(`owned target ${targetId} is not a valid existing skill: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function patchForPlan(patch: DerivationPatchDocument): DerivationPatchPayload {
  const verified = verifyDerivationPatch(patch);
  return {
    expected_digest: verified.payload.expected_digest,
    path: verified.payload.path,
    reason: verified.payload.reason,
    replacement: verified.payload.replacement,
    rule_version: verified.payload.rule_version,
    skill_id: verified.payload.skill_id,
  };
}

export async function createDerivationProposal(input: {
  readonly hubDir: string;
  readonly candidate: AdoptionPlanDocument;
  readonly patch: DerivationPatchDocument;
  readonly ownedId: string;
}): Promise<DerivationProposalDocument> {
  const candidate = verifyAdoptionPlan(input.candidate);
  const patch = patchForPlan(input.patch);
  let target;
  try {
    target = parseCanonicalSkillId(input.ownedId);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const staged = sourceStage(input.hubDir, candidate.digest);
  const original = findCandidate(candidate, patch.skill_id, patch.path);
  const targetRoot = temporaryPatchedRoot(staged.root, original.relative_root, target.name, patch);
  try {
    const prepared = await prepareSkillRoot(targetRoot.root, target.namespace);
    if (prepared.skillId !== input.ownedId) fail(`patched derivative identity is ${prepared.skillId}, expected ${input.ownedId}`);
    const inputFile = pathWithin(staged.root, patch.path);
    await checkOwnedTarget(resolve(input.hubDir), input.ownedId, prepared.versionHash);
    const payload: DerivationProposalPayload = {
      candidate_digest: candidate.digest,
      derivation_contract: "D1",
      original: {
        input_file_digest: patch.expected_digest,
        relative_root: original.relative_root,
        skill_id: original.skill_id,
        snapshot_digest: candidate.payload.source.vendored_snapshot_digest,
        version_hash: original.version_hash,
      },
      patch: { ...patch, patch_digest: digestReplacement(patch) },
      provenance: candidate.payload.source.type === "git"
        ? {
            provenance_files: [...candidate.payload.source.provenance_files],
            requested_ref: candidate.payload.source.requested_ref as string,
            resolved_commit: candidate.payload.source.resolved_commit as string,
            selected_root: original.relative_root,
            snapshot_digest: candidate.payload.source.vendored_snapshot_digest,
            source_locator: candidate.payload.source.repository as string,
            source_type: "git" as const,
          }
        : {
            provenance_files: [...candidate.payload.source.provenance_files],
            requested_ref: null,
            resolved_commit: null,
            selected_root: original.relative_root,
            snapshot_digest: candidate.payload.source.vendored_snapshot_digest,
            source_locator: candidate.payload.source.source_path as string,
            source_type: "local" as const,
          },
      predicted_version_hash: prepared.versionHash,
      source_plan_digest: candidate.digest,
      status: "READY",
      target: { relative_root: target.name, skill_id: input.ownedId },
    };
    // Read the precondition after preparation as well: this keeps a source
    // replacement between the initial check and proposal creation visible.
    if (hashBytes(readFileSync(inputFile)) !== patch.expected_digest) fail(`derivation patch precondition changed for ${patch.path}`);
    return createEnvelope({ object_type: DERIVATION_OBJECT_TYPE, payload, schema_version: DERIVATION_SCHEMA_VERSION }) as DerivationProposalDocument;
  } catch (error) {
    if (error instanceof HubError) throw error;
    if (error instanceof SchemaValidationError) fail(`derivative candidate is invalid: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    targetRoot.cleanup();
  }
}

export async function applyDerivationProposal(input: { readonly hubDir: string; readonly proposal: DerivationProposalDocument }): Promise<DerivationApplyResult> {
  const proposal = verifyDerivationProposal(input.proposal);
  const staged = sourceStage(input.hubDir, proposal.payload.candidate_digest);
  const original = findCandidate(staged.plan, proposal.payload.patch.skill_id, proposal.payload.patch.path);
  if (original.relative_root !== proposal.payload.original.relative_root || original.version_hash !== proposal.payload.original.version_hash) fail("staged candidate no longer matches derivation proposal");
  const patch: DerivationPatchPayload = {
    expected_digest: proposal.payload.patch.expected_digest,
    path: proposal.payload.patch.path,
    reason: proposal.payload.patch.reason,
    replacement: proposal.payload.patch.replacement,
    rule_version: proposal.payload.patch.rule_version,
    skill_id: proposal.payload.patch.skill_id,
  };
  const target = parseCanonicalSkillId(proposal.payload.target.skill_id);
  const targetRoot = temporaryPatchedRoot(staged.root, original.relative_root, target.name, patch);
  try {
    const prepared = await prepareSkillRoot(targetRoot.root, target.namespace);
    if (prepared.skillId !== proposal.payload.target.skill_id || prepared.versionHash !== proposal.payload.predicted_version_hash) fail("derivative bytes no longer match the proposal prediction");
    const inputFile = pathWithin(staged.root, patch.path);
    if (hashBytes(readFileSync(inputFile)) !== patch.expected_digest) fail(`derivation patch precondition failed for ${patch.path}`);
    await checkOwnedTarget(resolve(input.hubDir), proposal.payload.target.skill_id, prepared.versionHash);
    const stageRoot = join(resolve(input.hubDir), ".intake-staging", stageName(proposal.digest));
    if (existsSync(stageRoot)) {
      const existingPlan = JSON.parse(readFileSync(join(stageRoot, "derivation-plan.json"), "utf8"));
      const verifiedExisting = verifyDerivationProposal(existingPlan);
      if (verifiedExisting.digest !== proposal.digest) fail("existing derivative stage does not match proposal");
      const existingPrepared = await prepareSkillRoot(join(stageRoot, "source", ...proposal.payload.target.relative_root.split("/")), target.namespace);
      if (existingPrepared.versionHash !== proposal.payload.predicted_version_hash) fail("existing derivative stage has different bytes");
      return { candidate_digest: proposal.payload.candidate_digest, derived_skill_id: proposal.payload.target.skill_id, idempotent: true, path: stageRoot, version_hash: prepared.versionHash };
    }
    const parent = join(resolve(input.hubDir), ".intake-staging");
    mkdirSync(parent, { recursive: true });
    const temporary = mkdtempSync(join(parent, ".pending-"));
    try {
      copyTree(targetRoot.root, join(temporary, "source", ...proposal.payload.target.relative_root.split("/")));
      for (const provenanceFile of staged.plan.payload.source.provenance_files) {
        const source = pathWithin(staged.root, provenanceFile);
        const destination = join(temporary, "provenance", ...provenanceFile.split("/"));
        mkdirSync(resolve(destination, ".."), { recursive: true });
        writeFileSync(destination, readFileSync(source));
      }
      writeFileSync(join(temporary, "derivation-plan.json"), `${JSON.stringify(proposal, null, 2)}\n`);
      renameSync(temporary, stageRoot);
    } catch (error) {
      rmSync(temporary, { force: true, recursive: true });
      throw error;
    }
    return { candidate_digest: proposal.payload.candidate_digest, derived_skill_id: proposal.payload.target.skill_id, idempotent: false, path: stageRoot, version_hash: prepared.versionHash };
  } catch (error) {
    if (error instanceof HubError) throw error;
    if (error instanceof SchemaValidationError) fail(`derivative candidate is invalid: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    targetRoot.cleanup();
  }
}

export async function deriveCandidate(input: {
  readonly hubDir: string;
  readonly candidate: AdoptionPlanDocument;
  readonly patch: DerivationPatchDocument;
  readonly ownedId: string;
}): Promise<DerivationApplyResult & { readonly proposal: DerivationProposalDocument }> {
  const proposal = await createDerivationProposal(input);
  const result = await applyDerivationProposal({ hubDir: input.hubDir, proposal });
  return { ...result, proposal };
}
