#!/usr/bin/env node
/** Executable Contract D freeze gate for Hosted MCP Contract v1. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTOR_PATH = process.env.EGA_CONTRACT_D_VECTOR ?? join(HERE, "examples", "contract-d", "hosted-runtime.json");
const VECTOR = JSON.parse(readFileSync(VECTOR_PATH, "utf8"));
const errors = [];
const EXPECTED_VECTOR_DIGEST = "sha256:6a0f5a9332cd66f2edf5f9fee22d908c69640da8a09d2a30bfb2893bca476f03";

function fail(code, message) {
  errors.push(`${code}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExact(actual, expected, code, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code, `${label} does not match the frozen vector`);
}

function rejectNulls(value, path = "vector") {
  if (value === null) fail("E_HOSTED_SCHEMA", `${path} must not be null`);
  else if (Array.isArray(value)) value.forEach((entry, index) => rejectNulls(entry, `${path}[${index}]`));
  else if (isObject(value)) for (const [key, entry] of Object.entries(value)) rejectNulls(entry, `${path}.${key}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

rejectNulls(VECTOR);
assertExact(
  Object.keys(VECTOR).sort(),
  ["auth", "authorization", "cache", "contract_name", "contract_version", "credentials", "emergency_deny", "errors", "recovery", "responses", "scope", "startup", "tools", "transport"],
  "E_HOSTED_SCHEMA",
  "top-level fields",
);
if (VECTOR.contract_name !== "Hosted MCP Contract" || VECTOR.contract_version !== 1) {
  fail("E_HOSTED_SCHEMA", "contract identity must be Hosted MCP Contract v1");
}

assertExact(VECTOR.tools.names, ["resolve", "search", "inspect", "get_content"], "E_HOSTED_TOOLS", "tool names");
if (Object.keys(VECTOR.tools.schemas).sort().join(",") !== "get_content,inspect,resolve,search") {
  fail("E_HOSTED_TOOLS", "tool schemas must cover exactly the four tools");
}
const expectedSchemas = {
  resolve: {
    required: ["task"],
    optional: ["explicit_skills", "max_skills", "max_tokens", "release_digest", "context_id"],
    rejects: ["project_path"],
    response_fields: ["effective_release_digest", "project_context", "fingerprint_status"],
  },
  search: {
    required: ["query"],
    optional: ["limit", "release_digest", "context_id"],
    rejects: ["project_path"],
    response_fields: ["effective_release_digest", "project_context", "fingerprint_status"],
  },
  inspect: {
    required: ["skill_id"],
    optional: ["version_hash", "release_digest", "context_id"],
    rejects: ["project_path"],
    response_fields: ["effective_release_digest", "project_context", "fingerprint_status"],
  },
  get_content: {
    required: ["skill_id", "version_hash", "level", "max_tokens"],
    optional: ["file_path", "release_digest", "context_id"],
    rejects: ["project_path"],
    response_fields: ["effective_release_digest", "project_context", "fingerprint_status"],
  },
};
for (const name of Object.keys(expectedSchemas)) assertExact(VECTOR.tools.schemas[name], expectedSchemas[name], "E_HOSTED_SCHEMA", `${name} schema`);
for (const [name, schema] of Object.entries(VECTOR.tools.schemas)) {
  if (!Array.isArray(schema.required) || !Array.isArray(schema.optional) || !Array.isArray(schema.rejects)) {
    fail("E_HOSTED_SCHEMA", `${name} schema lists must be arrays`);
  }
  if (!schema.response_fields?.includes("effective_release_digest")) {
    fail("E_HOSTED_SCHEMA", `${name} response must expose effective_release_digest`);
  }
  if (!schema.rejects?.includes("project_path")) fail("E_SCOPE_CONTRACT", `${name} must reject project_path`);
}

assertExact(VECTOR.scope.personal_mode_tools, ["resolve", "search"], "E_SCOPE_CONTRACT", "personal mode tools");
if (VECTOR.scope.inspect_get_content.requires_explicit_scope !== true) fail("E_SCOPE_CONTRACT", "inspect/get_content require explicit scope");
assertExact(VECTOR.scope.inspect_get_content.allowed_scope, ["release_digest", "context_id"], "E_SCOPE_CONTRACT", "inspect/get_content scope");
for (const key of ["context_release_mismatch", "missing_or_revoked_context", "context_failure_fallback", "project_path"]) {
  if (VECTOR.scope[key] !== (key === "context_failure_fallback" ? "none" : "reject")) fail("E_SCOPE_CONTRACT", `${key} must fail closed`);
}
if (VECTOR.scope.stable_resolution !== "resolve_once_per_request") fail("E_SCOPE_CONTRACT", "stable pointer must resolve once per request");
if (VECTOR.scope.effective_release_field !== "effective_release_digest") fail("E_SCOPE_CONTRACT", "effective release field is required");

if (VECTOR.transport.protocol !== "streamable-http" || VECTOR.transport.endpoint !== "/mcp" || VECTOR.transport.https_required !== true || VECTOR.transport.origin_validation !== "allowlist") {
  fail("E_TRANSPORT", "Streamable HTTP, HTTPS, /mcp, and Origin allowlisting are required");
}
assertExact(VECTOR.transport.limits, {
  max_request_bytes: 1048576,
  max_response_bytes: 8388608,
  request_timeout_ms: 30000,
  tool_timeout_ms: 15000,
  max_concurrent_requests: 32,
  max_connections: 128,
  max_content_bytes: 1048576,
}, "E_TRANSPORT_LIMIT", "transport limits");

if (VECTOR.auth.mandatory !== true) fail("E_AUTH", "authentication is mandatory");
assertExact(VECTOR.auth.oauth, {
  discovery: true,
  browser_login: true,
  mcp_initialization: true,
  validate: ["issuer", "audience_resource", "signature", "expiry", "not_before", "scope", "revocation"],
}, "E_AUTH", "OAuth flow");
assertExact(VECTOR.auth.never_log, ["access_token", "refresh_token", "authorization_code", "client_secret"], "E_AUTH", "credential log denylist");
assertExact(VECTOR.authorization.chain, ["user", "personal_workspace", "authorized_hub_release", "skill_version", "blob"], "E_AUTHZ", "authorization chain");
if (VECTOR.authorization.independent_per_tool !== true || VECTOR.authorization.hash_is_not_authorization !== true) fail("E_AUTHZ", "each tool must authorize independently");

assertExact(VECTOR.emergency_deny.targets, ["hub_release", "skill_version", "source"], "E_DENY", "emergency deny targets");
if (VECTOR.emergency_deny.mutable !== true || VECTOR.emergency_deny.check_before_cache !== true || VECTOR.emergency_deny.no_substitution !== true) fail("E_DENY", "emergency deny must be mutable, pre-cache, and non-substituting");
if (VECTOR.emergency_deny.error !== "E_CONTENT_DENIED") fail("E_DENY", "denial must return explicit security error");

assertExact(VECTOR.cache.key_fields, ["workspace", "release_or_context", "router_contract", "search_contract", "task_or_query", "explicit_skill_selection", "budget_overrides", "policy_digest", "fingerprint_digest"], "E_CACHE", "cache identity");
if (VECTOR.cache.authorization_recheck_before_delivery !== true || VECTOR.cache.deny_recheck_before_delivery !== true) fail("E_CACHE", "authorization and deny must be rechecked before cache delivery");

assertExact(VECTOR.startup.integrity_order, ["hub_release_digest", "snapshot_artifact_digest", "sqlite_readonly", "database_integrity", "embedded_release_identity", "search_contract", "index_row_identity", "required_blobs", "emergency_deny", "healthy"], "E_STARTUP_INTEGRITY", "startup integrity order");
if (VECTOR.startup.healthy_only_after_all !== true) fail("E_STARTUP_INTEGRITY", "healthy must be last");

for (const key of ["runtime_read_only", "publication_credentials_in_runtime"]) if (VECTOR.credentials[key] !== (key === "runtime_read_only")) fail("E_CREDENTIAL_BOUNDARY", `${key} has unsafe value`);
for (const key of ["may_publish", "may_modify_git", "may_change_source_config", "may_modify_hub", "may_change_stable_pointer"]) if (VECTOR.credentials[key] !== false) fail("E_CREDENTIAL_BOUNDARY", `${key} must be false`);
assertExact(VECTOR.recovery.backup, ["stable_release_pointer", "auth_metadata", "authorization_metadata", "immutable_release_storage"], "E_RECOVERY", "recovery backup scope");
if (!VECTOR.recovery.restore_test_required || !VECTOR.recovery.rollback_test_required || VECTOR.recovery.rollback !== "repoint_retained_release") fail("E_RECOVERY", "restore and retained-release rollback are required");
assertExact(VECTOR.responses.personal_mode, { project_context: "NONE", fingerprint_status: "NONE", effective_release_required: true }, "E_RESPONSE", "personal response boundary");
assertExact(VECTOR.errors, {
  missing_scope: "E_SCOPE_REQUIRED",
  context_missing: "E_CONTEXT_NOT_FOUND",
  context_revoked: "E_CONTEXT_REVOKED",
  context_release_mismatch: "E_CONTEXT_RELEASE_MISMATCH",
  content_denied: "E_CONTENT_DENIED",
  origin_rejected: "E_ORIGIN_REJECTED",
  limit_exceeded: "E_REQUEST_LIMIT",
  startup_integrity: "E_STARTUP_INTEGRITY",
}, "E_ERRORS", "hosted error codes");

const digest = `sha256:${createHash("sha256").update(stableJson(VECTOR)).digest("hex")}`;
if (digest !== EXPECTED_VECTOR_DIGEST) fail("E_VECTOR_DIGEST", `expected ${EXPECTED_VECTOR_DIGEST}, got ${digest}`);
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  console.error("CONTRACT-D-FAIL");
  process.exitCode = 1;
} else {
  console.log(`CONTRACT-D-OK: exactly four tools; startup integrity order valid; scope matrix valid; vector=${digest}`);
}
