#!/usr/bin/env node
/** Executable Contract E freeze gate for Remote Projects Contract v1. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTOR_PATH = process.env.EGA_CONTRACT_E_VECTOR ?? join(HERE, "examples", "contract-e", "remote-projects.json");
const VECTOR = JSON.parse(readFileSync(VECTOR_PATH, "utf8"));
const errors = [];
const EXPECTED_VECTOR_DIGEST = "sha256:e4a56b717e01e3edc4d571ae7b839757344b0a94953127482390a6f6e39318ac";

function fail(code, message) {
  errors.push(`${code}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExact(actual, expected, code, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code, `${label} does not match the frozen vector`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rejectNulls(value, path = "vector") {
  if (value === null) fail("E_REMOTE_SCHEMA", `${path} must not be null`);
  else if (Array.isArray(value)) value.forEach((entry, index) => rejectNulls(entry, `${path}[${index}]`));
  else if (isObject(value)) for (const [key, entry] of Object.entries(value)) rejectNulls(entry, `${path}.${key}`);
}

rejectNulls(VECTOR);
assertExact(
  Object.keys(VECTOR).sort(),
  ["cache", "context", "contract_name", "contract_version", "errors", "fingerprint", "identity", "lifecycle", "local_authority", "lock", "remote_lock_plan", "selection"],
  "E_REMOTE_SCHEMA",
  "top-level fields",
);
if (VECTOR.contract_name !== "Remote Projects Contract" || VECTOR.contract_version !== 1) {
  fail("E_REMOTE_SCHEMA", "contract identity must be Remote Projects Contract v1");
}

assertExact(VECTOR.identity, {
  digest_algorithm: "sha256",
  canonical_encoding: "RFC8785-JCS",
  id_format: "opaque-nonempty-utf8",
  ids: ["workspace_id", "project_id", "context_id"],
  digest_prefix: "sha256:",
}, "E_REMOTE_IDENTITY", "identity");
assertExact(VECTOR.local_authority, {
  config_file: ".egaskills.yaml",
  lock_file: ".egaskills.lock",
  remote_must_not_mutate_files: true,
  local_refresh_command_unchanged: "ega-skills lock --refresh",
  remote_apply_is_explicit: true,
}, "E_REMOTE_AUTHORITY", "local authority");
assertExact(VECTOR.context.artifact_fields, ["workspace_id", "project_id", "config_digest", "lock_digest", "release_digest", "fingerprint_digest", "context_contract_version"], "E_CONTEXT", "context artifact fields");
assertExact(VECTOR.context, {
  artifact_fields: VECTOR.context.artifact_fields,
  digest_field: "context_digest",
  immutable: true,
  single_release_binding: true,
  fingerprint_nullable: true,
  contract_version: 1,
}, "E_CONTEXT", "context semantics");
assertExact(VECTOR.lock, {
  config_digest_source: "normalized_project_config_jcs",
  lock_digest_source: "validated_normalized_lock_jcs",
  target_release_required: true,
  all_versions_must_be_in_target_release: true,
  cross_release_behavior: "reject",
  implicit_union_behavior: "reject",
}, "E_LOCK", "lock semantics");
assertExact(VECTOR.remote_lock_plan.artifact_fields, ["workspace_id", "project_id", "project_config_digest", "existing_lock_digest", "target_release_digest", "candidate_lock", "added_entries", "removed_entries", "changed_entries", "fingerprint_digest"], "E_REMOTE_LOCK", "plan artifact fields");
if (VECTOR.remote_lock_plan.immutable !== true || VECTOR.remote_lock_plan.review_required_before_apply !== true || VECTOR.remote_lock_plan.apply_writes_only_local_lock !== true) {
  fail("E_REMOTE_LOCK", "remote lock plans must be immutable, reviewed, and local-lock-only on apply");
}
assertExact(VECTOR.fingerprint.fields, ["package_root", "workspace_root", "workspace_ambiguous", "languages", "platforms", "frameworks", "evidence", "revision", "relevant_input_digest"], "E_FINGERPRINT", "fingerprint fields");
assertExact(VECTOR.fingerprint.revision_modes, ["git-clean", "git-dirty", "unversioned"], "E_FINGERPRINT", "revision modes");
for (const key of ["dirty_requires_base_commit", "revision_digest_required", "absolute_paths"]) {
  const expected = key === "absolute_paths" ? "reject" : true;
  if (VECTOR.fingerprint[key] !== expected) fail("E_FINGERPRINT", `${key} is unsafe or incomplete`);
}
if (VECTOR.fingerprint.source_upload !== "never" || VECTOR.fingerprint.roots !== "repository-relative-posix-or-null" || VECTOR.fingerprint.evidence_path !== "repository-relative-posix") {
  fail("E_FINGERPRINT", "fingerprint portability or source boundary weakened");
}
assertExact(VECTOR.selection.exact_binding, ["config_digest", "lock_digest", "release_digest", "fingerprint_digest"], "E_CONTEXT_SELECTION", "context binding");
assertExact({
  missing_behavior: VECTOR.selection.missing_behavior,
  revoked_behavior: VECTOR.selection.revoked_behavior,
  release_mismatch_behavior: VECTOR.selection.release_mismatch_behavior,
  failure_fallback: VECTOR.selection.failure_fallback,
  no_silent_substitution: VECTOR.selection.no_silent_substitution,
}, {
  missing_behavior: "E_CONTEXT_NOT_FOUND",
  revoked_behavior: "E_CONTEXT_REVOKED",
  release_mismatch_behavior: "E_CONTEXT_RELEASE_MISMATCH",
  failure_fallback: "none",
  no_silent_substitution: true,
}, "E_CONTEXT_SELECTION", "selection failures");
if (VECTOR.lifecycle.publish !== "immutable-create" || VECTOR.lifecycle.retain_old_contexts !== true || VECTOR.lifecycle.revoke !== "mark-context-revoked-without-mutation" || VECTOR.lifecycle.revoked_identity_retained !== true || VECTOR.lifecycle.republication !== "new-context-id") {
  fail("E_CONTEXT_LIFECYCLE", "context lifecycle must preserve immutable history");
}
assertExact(VECTOR.cache.key_fields, ["workspace_id", "project_id", "context_id", "config_digest", "lock_digest", "release_digest", "fingerprint_digest", "router_contract", "search_contract", "task_or_query", "explicit_skill_selection", "budget_overrides"], "E_CONTEXT_CACHE", "cache identity");
if (VECTOR.cache.authorization_recheck_before_delivery !== true || VECTOR.cache.revocation_recheck_before_delivery !== true) fail("E_CONTEXT_CACHE", "cache delivery must recheck authorization and revocation");
assertExact(VECTOR.errors, {
  invalid_context: "E_CONTEXT_INVALID",
  context_missing: "E_CONTEXT_NOT_FOUND",
  context_revoked: "E_CONTEXT_REVOKED",
  context_release_mismatch: "E_CONTEXT_RELEASE_MISMATCH",
  lock_release_mismatch: "E_LOCK_RELEASE_MISMATCH",
  plan_review_required: "E_REMOTE_LOCK_REVIEW_REQUIRED",
  fingerprint_invalid: "E_FINGERPRINT_INVALID",
}, "E_REMOTE_ERRORS", "error codes");

const digest = `sha256:${createHash("sha256").update(stableJson(VECTOR)).digest("hex")}`;
if (digest !== EXPECTED_VECTOR_DIGEST) fail("E_VECTOR_DIGEST", `expected ${EXPECTED_VECTOR_DIGEST}, got ${digest}`);
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  console.error("CONTRACT-E-FAIL");
  process.exitCode = 1;
} else {
  console.log(`CONTRACT-E-OK: immutable contexts, single-release locks, relative fingerprints; vector=${digest}`);
}
