// Contract E — portable package-scoped project fingerprints.
//
// The existing resolver detects evidence from one nearest package. This
// adapter turns that result into a publishable identity without retaining
// absolute paths or uploading application source. Only bounded evidence-file
// digests enter the relevant-input digest.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";

import { canonicalizeJson, hashBytes } from "@ega-skills/hashing";

import { resolveProjectFingerprint } from "./workspace.js";
import type { FingerprintEvidence, ProjectFingerprint } from "./fingerprint.js";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export type RemoteFingerprintRevision =
  | { readonly mode: "git-clean"; readonly commit_sha: string }
  | { readonly mode: "git-dirty"; readonly base_commit_sha: string }
  | { readonly mode: "unversioned" };

export interface RemoteFingerprintEvidence {
  readonly path: string;
  readonly kind: "package-manifest" | "tooling-marker";
}

export interface RemoteProjectFingerprint {
  readonly package_root: string | null;
  readonly workspace_root: string | null;
  readonly workspace_ambiguous: boolean;
  readonly languages: readonly string[];
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly evidence: readonly RemoteFingerprintEvidence[];
  readonly revision: RemoteFingerprintRevision;
  readonly relevant_input_digest: string;
}

export interface RelevantFingerprintInput {
  readonly path: string;
  readonly bytes: Uint8Array | string;
}

export interface CreateRemoteFingerprintInput {
  readonly repository_root: string;
  readonly project_path: string;
  readonly revision: RemoteFingerprintRevision;
  readonly relevant_inputs?: readonly RelevantFingerprintInput[];
}

export class RemoteFingerprintError extends Error {
  readonly code = "E_FINGERPRINT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "RemoteFingerprintError";
  }
}

function fail(message: string): never {
  throw new RemoteFingerprintError(message);
}

function portablePath(repositoryRoot: string, absolutePath: string, field: string): string {
  const root = resolve(repositoryRoot);
  const candidate = resolve(absolutePath);
  const value = relative(root, candidate).split(sep).join("/");
  if (value === "") return ".";
  if (value === ".." || value.startsWith("../") || /^[A-Za-z]:\//.test(value)) {
    fail(`${field} must remain inside the repository root`);
  }
  return value;
}

function sourcePath(evidence: FingerprintEvidence, fingerprint: ProjectFingerprint): string {
  const source = evidence.source.split("#", 1)[0]!;
  const evidenceRoot = evidence.kind === "WORKSPACE" && fingerprint.workspaceRoot !== null
    // workspace.ts rebases workspace evidence to the requested project path;
    // package evidence remains relative to the nearest package root.
    ? fingerprint.projectPath
    : (fingerprint.packageRoot ?? fingerprint.projectPath);
  return resolve(evidenceRoot, source);
}

function evidenceKind(evidence: FingerprintEvidence): RemoteFingerprintEvidence["kind"] {
  return evidence.source.startsWith("package.json") ? "package-manifest" : "tooling-marker";
}

function assertRevision(revision: RemoteFingerprintRevision): void {
  if (revision.mode === "git-clean" && !COMMIT_RE.test(revision.commit_sha)) fail("git-clean requires a 40-character commit SHA");
  if (revision.mode === "git-dirty" && !COMMIT_RE.test(revision.base_commit_sha)) fail("git-dirty requires a 40-character base commit SHA");
  if (revision.mode !== "git-clean" && revision.mode !== "git-dirty" && revision.mode !== "unversioned") fail("unsupported fingerprint revision mode");
}

function relevantInputDigest(inputs: readonly RelevantFingerprintInput[]): string {
  const identities = inputs
    .map((input) => {
      const segments = input.path.split("/");
      if (
        input.path.length === 0 ||
        input.path.startsWith("/") ||
        input.path.includes("\\") ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
      ) {
        fail(`relevant input path ${JSON.stringify(input.path)} is not repository-relative POSIX`);
      }
      return { path: input.path, digest: hashBytes(typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes) };
    })
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0);
  for (let index = 1; index < identities.length; index += 1) {
    if (identities[index - 1]!.path === identities[index]!.path) fail(`duplicate relevant input ${identities[index]!.path}`);
  }
  return hashBytes(canonicalizeJson(identities));
}

function assertPortableRelative(value: unknown, field: string, nullable: boolean): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    fail(`${field} must be a repository-relative POSIX path or null`);
  }
  if (nullable && value === ".") return;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(`${field} must be a normalized repository-relative POSIX path`);
  }
}

function assertSortedUnique(values: unknown, field: string): void {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) fail(`${field} must be a string array`);
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) fail(`${field} must be sorted and unique`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${field} has unexpected or missing fields`);
  }
}

/** Verify the portable shape before a fingerprint becomes a hosted identity. */
export function verifyRemoteProjectFingerprint(value: unknown): asserts value is RemoteProjectFingerprint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("fingerprint must be an object");
  const fingerprint = value as Record<string, unknown>;
  assertExactKeys(fingerprint, [
    "package_root",
    "workspace_root",
    "workspace_ambiguous",
    "languages",
    "platforms",
    "frameworks",
    "evidence",
    "revision",
    "relevant_input_digest",
  ], "fingerprint");
  assertPortableRelative(fingerprint.package_root, "package_root", true);
  assertPortableRelative(fingerprint.workspace_root, "workspace_root", true);
  if (typeof fingerprint.workspace_ambiguous !== "boolean") fail("workspace_ambiguous must be boolean");
  assertSortedUnique(fingerprint.languages, "languages");
  assertSortedUnique(fingerprint.platforms, "platforms");
  assertSortedUnique(fingerprint.frameworks, "frameworks");
  if (!Array.isArray(fingerprint.evidence)) fail("evidence must be an array");
  let previousEvidence = "";
  for (const record of fingerprint.evidence) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) fail("evidence contains an invalid record");
    assertExactKeys(record, ["path", "kind"], "evidence record");
    assertPortableRelative(record.path, "evidence.path", false);
    if (record.kind !== "package-manifest" && record.kind !== "tooling-marker") fail("evidence.kind is invalid");
    const identity = `${record.path}\u0000${record.kind}`;
    if (identity <= previousEvidence) fail("evidence must be sorted and unique");
    previousEvidence = identity;
  }
  if (typeof fingerprint.revision !== "object" || fingerprint.revision === null || Array.isArray(fingerprint.revision)) fail("revision must be an object");
  const revision = fingerprint.revision as Record<string, unknown>;
  if (revision.mode === "git-clean") {
    assertExactKeys(revision, ["mode", "commit_sha"], "git-clean revision");
    if (typeof revision.commit_sha !== "string" || !COMMIT_RE.test(revision.commit_sha)) fail("git-clean requires a 40-character commit SHA");
  } else if (revision.mode === "git-dirty") {
    assertExactKeys(revision, ["mode", "base_commit_sha"], "git-dirty revision");
    if (typeof revision.base_commit_sha !== "string" || !COMMIT_RE.test(revision.base_commit_sha)) fail("git-dirty requires a 40-character base commit SHA");
  } else if (revision.mode === "unversioned") {
    assertExactKeys(revision, ["mode"], "unversioned revision");
  } else {
    fail("revision.mode is invalid");
  }
  if (typeof fingerprint.relevant_input_digest !== "string" || !DIGEST_RE.test(fingerprint.relevant_input_digest)) fail("relevant_input_digest is invalid");
}

export function hashRemoteFingerprint(fingerprint: RemoteProjectFingerprint): string {
  verifyRemoteProjectFingerprint(fingerprint);
  return hashBytes(canonicalizeJson(fingerprint));
}

export function createRemoteProjectFingerprint(input: CreateRemoteFingerprintInput): RemoteProjectFingerprint {
  assertRevision(input.revision);
  const detected = resolveProjectFingerprint(input.project_path);
  const evidence = detected.evidence
    .map((record) => ({
      path: portablePath(input.repository_root, sourcePath(record, detected), "fingerprint evidence path"),
      kind: evidenceKind(record),
    }))
    .filter((record, index, all) => all.findIndex((candidate) => candidate.path === record.path && candidate.kind === record.kind) === index)
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
  let inputs: readonly RelevantFingerprintInput[];
  if (input.relevant_inputs !== undefined) {
    inputs = input.relevant_inputs;
  } else {
    try {
      inputs = evidence.map((record) => ({
        path: record.path,
        bytes: readFileSync(resolve(input.repository_root, record.path)),
      }));
    } catch (error) {
      fail(`fingerprint evidence could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const result: RemoteProjectFingerprint = Object.freeze({
    package_root: detected.packageRoot === null ? null : portablePath(input.repository_root, detected.packageRoot, "package_root"),
    workspace_root: detected.workspaceRoot === null ? null : portablePath(input.repository_root, detected.workspaceRoot, "workspace_root"),
    workspace_ambiguous: detected.workspaceAmbiguous,
    languages: Object.freeze([...detected.languages]),
    platforms: Object.freeze([...detected.platforms]),
    frameworks: Object.freeze([...detected.frameworks]),
    evidence: Object.freeze(evidence),
    revision: Object.freeze(input.revision),
    relevant_input_digest: relevantInputDigest(inputs),
  });
  if (!DIGEST_RE.test(result.relevant_input_digest)) fail("relevant input digest is invalid");
  verifyRemoteProjectFingerprint(result);
  return result;
}

/** Read only Git metadata; a non-Git directory becomes explicit unversioned state. */
export function detectRemoteFingerprintRevision(repositoryRoot: string): RemoteFingerprintRevision {
  try {
    const inside = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (inside !== "true") return { mode: "unversioned" };
    const head = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!COMMIT_RE.test(head)) return { mode: "unversioned" };
    const status = execFileSync("git", ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    return status.trim().length === 0 ? { mode: "git-clean", commit_sha: head } : { mode: "git-dirty", base_commit_sha: head };
  } catch {
    return { mode: "unversioned" };
  }
}
