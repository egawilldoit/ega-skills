// Verified intake-candidate views shared by review and adoption.
//
// A1 source plans and D1-owned derivatives have different envelopes and
// different provenance rules. This adapter keeps that distinction explicit
// while giving the review/apply boundary one exact identity surface.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEnvelope, hashBytes, verifyEnvelope, type ArtifactEnvelope } from "@ega-skills/hashing";
import { parseCanonicalSkillId, prepareSkillRoot } from "@ega-skills/registry";
import { HubError } from "../hub/errors.js";
import { SHA256_RE, assertRelativePosix } from "../hub/guards.js";
import { readHubIntakeState, verifyAdoptionPlan, verifyAdoptionStage, type AdoptionPlanDocument } from "./adoption-plan.js";
import { verifyDerivationProposal, type DerivationProposalDocument } from "./derivation.js";

export const OWNED_DERIVATIVE_CANDIDATE_OBJECT_TYPE = "ega.owned-derivative-candidate" as const;
export const OWNED_DERIVATIVE_CANDIDATE_SCHEMA_VERSION = 1 as const;

export interface OwnedDerivativeProvenanceFile {
  readonly path: string;
  readonly digest: string;
  readonly content_base64: string;
}

export interface OwnedDerivativeCandidatePayload {
  readonly adoption_contract: "A1-D1";
  readonly candidate_kind: "OWNED_DERIVATIVE";
  readonly baseline_digest: string;
  readonly source_candidate_digest: string;
  readonly derivation_proposal_digest: string;
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
    readonly files: readonly OwnedDerivativeProvenanceFile[];
  };
  readonly patch_digest: string;
  readonly target: {
    readonly skill_id: string;
    readonly version_hash: string;
    readonly relative_root: string;
  };
  readonly status: "READY";
}

export type OwnedDerivativeCandidateDocument = ArtifactEnvelope & {
  readonly object_type: typeof OWNED_DERIVATIVE_CANDIDATE_OBJECT_TYPE;
  readonly schema_version: typeof OWNED_DERIVATIVE_CANDIDATE_SCHEMA_VERSION;
  readonly payload: OwnedDerivativeCandidatePayload;
};

export type IntakeCandidateDocument = AdoptionPlanDocument | OwnedDerivativeCandidateDocument;

export interface VerifiedCandidateView {
  readonly document: IntakeCandidateDocument;
  readonly digest: string;
  readonly kind: "SOURCE_ADOPTION" | "OWNED_DERIVATIVE";
  readonly baseline_digest: string;
  readonly entries: readonly { readonly skill_id: string; readonly version_hash: string }[];
  readonly derivative_stage_root?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function fail(message: string): never {
  throw new HubError("E_PLAN_SCHEMA", `intake candidate: ${message}`);
}

function stageName(digest: string): string {
  if (!SHA256_RE.test(digest)) fail("candidate digest is invalid");
  return digest.slice("sha256:".length);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} is invalid`);
  return value;
}

function digest(value: unknown, field: string): string {
  const result = string(value, field);
  if (!SHA256_RE.test(result)) fail(`${field} is invalid`);
  return result;
}

function relativePath(value: unknown, field: string): string {
  const result = string(value, field);
  try { assertRelativePosix(result, field); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  return result;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const value = (a << 16) | (b << 8) | c;
    result += BASE64[(value >>> 18) & 63]! + BASE64[(value >>> 12) & 63]! + (index + 1 < bytes.length ? BASE64[(value >>> 6) & 63]! : "=") + (index + 2 < bytes.length ? BASE64[value & 63]! : "=");
  }
  return result;
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("provenance content is not base64");
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64.indexOf(value[index] as string);
    const b = BASE64.indexOf(value[index + 1] as string);
    const c = value[index + 2] === "=" ? 0 : BASE64.indexOf(value[index + 2] as string);
    const d = value[index + 3] === "=" ? 0 : BASE64.indexOf(value[index + 3] as string);
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((chunk >>> 16) & 255);
    if (value[index + 2] !== "=") bytes.push((chunk >>> 8) & 255);
    if (value[index + 3] !== "=") bytes.push(chunk & 255);
  }
  return new Uint8Array(bytes);
}

function verifyProvenanceFiles(value: unknown): readonly OwnedDerivativeProvenanceFile[] {
  if (!Array.isArray(value)) fail("provenance.files is invalid");
  const files = value.map((raw, index) => {
    if (!record(raw) || !exactKeys(raw, ["path", "digest", "content_base64"])) fail(`provenance.files[${index}] is invalid`);
    const path = relativePath(raw.path, `provenance.files[${index}].path`);
    const fileDigest = digest(raw.digest, `provenance.files[${index}].digest`);
    const content = string(raw.content_base64, `provenance.files[${index}].content_base64`);
    const bytes = decodeBase64(content);
    if (encodeBase64(bytes) !== content || hashBytes(bytes) !== fileDigest) fail(`provenance.files[${index}] content digest does not match`);
    return { content_base64: content, digest: fileDigest, path };
  });
  const paths = files.map((file) => file.path);
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort()) || new Set(paths).size !== paths.length) fail("provenance.files must be sorted and unique");
  return files;
}

export function verifyOwnedDerivativeCandidate(value: unknown): OwnedDerivativeCandidateDocument {
  const envelope = verifyEnvelope(value);
  if (!envelope.ok || !record(value) || value.object_type !== OWNED_DERIVATIVE_CANDIDATE_OBJECT_TYPE || value.schema_version !== OWNED_DERIVATIVE_CANDIDATE_SCHEMA_VERSION) {
    fail(`envelope is invalid: ${envelope.ok ? "unexpected type or schema" : envelope.message}`);
  }
  const payload = value.payload;
  if (!record(payload) || !exactKeys(payload, ["adoption_contract", "candidate_kind", "baseline_digest", "source_candidate_digest", "derivation_proposal_digest", "original", "provenance", "patch_digest", "target", "status"])) fail("payload fields are invalid");
  if (payload.adoption_contract !== "A1-D1" || payload.candidate_kind !== "OWNED_DERIVATIVE" || payload.status !== "READY") fail("identity fields are invalid");
  digest(payload.baseline_digest, "baseline_digest");
  digest(payload.source_candidate_digest, "source_candidate_digest");
  digest(payload.derivation_proposal_digest, "derivation_proposal_digest");
  digest(payload.patch_digest, "patch_digest");
  const original = payload.original;
  if (!record(original) || !exactKeys(original, ["skill_id", "version_hash", "relative_root", "input_file_digest", "snapshot_digest"])) fail("original is invalid");
  string(original.skill_id, "original.skill_id");
  if (original.version_hash !== null) digest(original.version_hash, "original.version_hash");
  relativePath(original.relative_root, "original.relative_root");
  digest(original.input_file_digest, "original.input_file_digest");
  digest(original.snapshot_digest, "original.snapshot_digest");
  const provenance = payload.provenance;
  if (!record(provenance) || !exactKeys(provenance, ["source_type", "source_locator", "requested_ref", "resolved_commit", "selected_root", "provenance_files", "snapshot_digest", "files"])) fail("provenance is invalid");
  if (provenance.source_type !== "git" && provenance.source_type !== "local") fail("provenance.source_type is invalid");
  string(provenance.source_locator, "provenance.source_locator");
  if (provenance.requested_ref !== null) string(provenance.requested_ref, "provenance.requested_ref");
  if (provenance.resolved_commit !== null && !/^[0-9a-f]{40}$/.test(string(provenance.resolved_commit, "provenance.resolved_commit"))) fail("provenance.resolved_commit is invalid");
  relativePath(provenance.selected_root, "provenance.selected_root");
  if (!Array.isArray(provenance.provenance_files) || !provenance.provenance_files.every((entry) => typeof entry === "string")) fail("provenance.provenance_files is invalid");
  const provenancePaths = provenance.provenance_files as string[];
  for (const path of provenancePaths) relativePath(path, "provenance.provenance_files");
  if (JSON.stringify(provenancePaths) !== JSON.stringify([...provenancePaths].sort()) || new Set(provenancePaths).size !== provenancePaths.length) fail("provenance.provenance_files must be sorted and unique");
  digest(provenance.snapshot_digest, "provenance.snapshot_digest");
  const files = verifyProvenanceFiles(provenance.files);
  if (JSON.stringify(files.map((file) => file.path)) !== JSON.stringify(provenancePaths)) fail("provenance files do not match provenance_files");
  const target = payload.target;
  if (!record(target) || !exactKeys(target, ["skill_id", "version_hash", "relative_root"])) fail("target is invalid");
  const targetSkillId = string(target.skill_id, "target.skill_id");
  try { parseCanonicalSkillId(targetSkillId); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  digest(target.version_hash, "target.version_hash");
  relativePath(target.relative_root, "target.relative_root");
  return value as unknown as OwnedDerivativeCandidateDocument;
}

function candidateStageRoot(hubDir: string, proposalDigest: string): string {
  return join(resolve(hubDir), ".intake-staging", stageName(proposalDigest));
}

function readProposal(stageRoot: string, expectedDigest: string): DerivationProposalDocument {
  const path = join(stageRoot, "derivation-plan.json");
  if (!existsSync(path)) fail("derivation proposal stage is missing");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { fail("derivation proposal stage is not valid JSON"); }
  const proposal = verifyDerivationProposal(raw);
  if (proposal.digest !== expectedDigest) fail("derivation proposal digest does not match candidate");
  return proposal;
}

export function createOwnedDerivativeCandidate(input: { readonly hubDir: string; readonly proposal: DerivationProposalDocument }): OwnedDerivativeCandidateDocument {
  const proposal = verifyDerivationProposal(input.proposal);
  const stageRoot = candidateStageRoot(input.hubDir, proposal.digest);
  const stagedProposal = readProposal(stageRoot, proposal.digest);
  if (stagedProposal.digest !== proposal.digest) fail("staged derivation proposal does not match");
  const state = readHubIntakeState(input.hubDir);
  const files = proposal.payload.provenance.provenance_files.map((path) => {
    const source = join(stageRoot, "provenance", ...path.split("/"));
    if (!existsSync(source)) fail(`staged provenance file is missing: ${path}`);
    const bytes = readFileSync(source);
    return { content_base64: encodeBase64(bytes), digest: hashBytes(bytes), path };
  });
  const payload: OwnedDerivativeCandidatePayload = {
    adoption_contract: "A1-D1",
    baseline_digest: state.baselineDigest,
    candidate_kind: "OWNED_DERIVATIVE",
    derivation_proposal_digest: proposal.digest,
    original: {
      input_file_digest: proposal.payload.original.input_file_digest,
      relative_root: proposal.payload.original.relative_root,
      skill_id: proposal.payload.original.skill_id,
      snapshot_digest: proposal.payload.original.snapshot_digest,
      version_hash: proposal.payload.original.version_hash,
    },
    patch_digest: proposal.payload.patch.patch_digest,
    provenance: { ...proposal.payload.provenance, files },
    source_candidate_digest: proposal.payload.candidate_digest,
    status: "READY",
    target: {
      relative_root: proposal.payload.target.relative_root,
      skill_id: proposal.payload.target.skill_id,
      version_hash: proposal.payload.predicted_version_hash,
    },
  };
  return createEnvelope({ object_type: OWNED_DERIVATIVE_CANDIDATE_OBJECT_TYPE, payload, schema_version: OWNED_DERIVATIVE_CANDIDATE_SCHEMA_VERSION }) as OwnedDerivativeCandidateDocument;
}

export function ownedDerivativeCandidatePath(hubDir: string, proposalDigest: string): string {
  return join(candidateStageRoot(hubDir, proposalDigest), "owned-adoption-candidate.json");
}

export function writeOwnedDerivativeCandidate(hubDir: string, candidate: OwnedDerivativeCandidateDocument): string {
  const verified = verifyOwnedDerivativeCandidate(candidate);
  const path = ownedDerivativeCandidatePath(hubDir, verified.payload.derivation_proposal_digest);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(verified, null, 2)}\n`);
  return path;
}

export function readReviewableCandidate(value: unknown, hubDir: string): VerifiedCandidateView {
  if (record(value) && value.object_type === "ega.adoption-plan") {
    const plan = verifyAdoptionPlan(value);
    verifyAdoptionStage(hubDir, plan);
    return { baseline_digest: plan.payload.hub.baseline_digest, digest: plan.digest, document: plan, entries: plan.payload.candidates.map((entry) => ({ skill_id: entry.skill_id, version_hash: entry.version_hash })), kind: "SOURCE_ADOPTION" };
  }
  const candidate = verifyOwnedDerivativeCandidate(value);
  const stageRoot = candidateStageRoot(hubDir, candidate.payload.derivation_proposal_digest);
  const proposal = readProposal(stageRoot, candidate.payload.derivation_proposal_digest);
  if (proposal.payload.candidate_digest !== candidate.payload.source_candidate_digest || proposal.payload.patch.patch_digest !== candidate.payload.patch_digest || proposal.payload.target.skill_id !== candidate.payload.target.skill_id || proposal.payload.predicted_version_hash !== candidate.payload.target.version_hash || proposal.payload.original.skill_id !== candidate.payload.original.skill_id || proposal.payload.original.version_hash !== candidate.payload.original.version_hash || proposal.payload.original.relative_root !== candidate.payload.original.relative_root || proposal.payload.original.input_file_digest !== candidate.payload.original.input_file_digest || proposal.payload.original.snapshot_digest !== candidate.payload.original.snapshot_digest || proposal.payload.provenance.snapshot_digest !== candidate.payload.provenance.snapshot_digest) fail("candidate does not match its derivation proposal");
  const sourcePlanPath = join(resolve(hubDir), ".intake-staging", stageName(proposal.payload.candidate_digest), "adoption-plan.json");
  if (!existsSync(sourcePlanPath)) fail("derivative source candidate is missing");
  const sourcePlan = verifyAdoptionPlan(JSON.parse(readFileSync(sourcePlanPath, "utf8")));
  if (sourcePlan.digest !== proposal.payload.source_plan_digest || sourcePlan.payload.source.vendored_snapshot_digest !== candidate.payload.provenance.snapshot_digest) fail("derivative source plan does not match candidate provenance");
  verifyAdoptionStage(hubDir, sourcePlan);
  const original = sourcePlan.payload.import_plan.payload.candidates.find((entry) => entry.relative_root === candidate.payload.original.relative_root);
  if (original === undefined || (original.proposed_id !== null && original.proposed_id !== candidate.payload.original.skill_id) || original.version_hash !== candidate.payload.original.version_hash) fail("derivative original candidate does not match source plan");
  const source = join(stageRoot, "source", ...candidate.payload.target.relative_root.split("/"));
  if (!existsSync(source)) fail("derived candidate source is missing");
  if (!existsSync(join(source, "SKILL.md"))) fail("derived candidate skill root is missing SKILL.md");
  for (const file of candidate.payload.provenance.files) {
    const staged = join(stageRoot, "provenance", ...file.path.split("/"));
    if (!existsSync(staged) || hashBytes(readFileSync(staged)) !== file.digest) fail(`derived candidate provenance is invalid: ${file.path}`);
  }
  return { baseline_digest: candidate.payload.baseline_digest, derivative_stage_root: stageRoot, digest: candidate.digest, document: candidate, entries: [{ skill_id: candidate.payload.target.skill_id, version_hash: candidate.payload.target.version_hash }], kind: "OWNED_DERIVATIVE" };
}

/** Recompute the canonical prepared identity from the immutable derivative stage. */
export async function verifyOwnedDerivativeStage(hubDir: string, candidate: OwnedDerivativeCandidateDocument): Promise<VerifiedCandidateView> {
  const view = readReviewableCandidate(candidate, hubDir);
  if (view.kind !== "OWNED_DERIVATIVE" || view.derivative_stage_root === undefined) fail("owned derivative candidate stage is unavailable");
  const target = parseCanonicalSkillId(candidate.payload.target.skill_id);
  const root = join(view.derivative_stage_root, "source", ...candidate.payload.target.relative_root.split("/"));
  let prepared;
  try {
    prepared = await prepareSkillRoot(root, target.namespace);
  } catch (error) {
    fail(`derived candidate is no longer valid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (prepared.skillId !== candidate.payload.target.skill_id || prepared.versionHash !== candidate.payload.target.version_hash) fail("derived candidate bytes no longer match the reviewed identity");
  return view;
}

export function resolveCandidateDocument(reference: string, hubDir: string): IntakeCandidateDocument {
  const direct = resolve(reference);
  let path = existsSync(direct) ? direct : undefined;
  if (path === undefined && SHA256_RE.test(reference)) {
    const stagingRoot = join(resolve(hubDir), ".intake-staging");
    const directStagePaths = [
      join(stagingRoot, stageName(reference), "owned-adoption-candidate.json"),
      join(stagingRoot, stageName(reference), "adoption-plan.json"),
    ];
    path = directStagePaths.find((entry) => existsSync(entry));
    if (path === undefined && existsSync(stagingRoot)) {
      for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
        const candidatePath = join(stagingRoot, entry.name, "owned-adoption-candidate.json");
        if (!existsSync(candidatePath)) continue;
        try {
          const candidate = verifyOwnedDerivativeCandidate(JSON.parse(readFileSync(candidatePath, "utf8")));
          if (candidate.digest === reference) { path = candidatePath; break; }
        } catch {
          // The selected candidate will be verified again below; malformed
          // unrelated staging does not make a different digest unresolvable.
        }
      }
    }
  }
  if (path === undefined) throw new HubError("E_PLAN_SCHEMA", `intake candidate not found: ${reference}`);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new HubError("E_PLAN_SCHEMA", `intake candidate is not valid JSON: ${path}`); }
  if (record(value) && value.object_type === "ega.adoption-plan") return verifyAdoptionPlan(value);
  return verifyOwnedDerivativeCandidate(value);
}
