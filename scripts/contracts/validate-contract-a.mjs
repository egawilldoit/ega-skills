#!/usr/bin/env node
/**
 * Contract A validator (EGA-620) — executable acceptance check for the frozen
 * Hub & Sources contract.
 *
 * Validates docs/contracts/examples/contract-a/{hub.yaml,sources.yaml,
 * sources.lock.yaml} structurally and recomputes:
 *   source_config_digest (JCS/SHA-256 over normalized source config)
 * using the proven V1 primitive in packages/hashing/dist/identities.js.
 * No new dependencies; no lockfile change.
 *
 * Exit 0 = contract examples valid; exit 1 = violation (message on stderr).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { canonicalizeJson, sha256Hex } from "../../packages/hashing/dist/identities.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "examples", "contract-a");
const cliRequire = createRequire(join(HERE, "..", "..", "packages", "cli", "package.json"));
const { parse: parseYaml } = cliRequire("yaml");

const fail = (code, msg) => {
  console.error(`CONTRACT-A-INVALID [${code}]: ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`ok: ${msg}`);

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const NS_RE = /^[a-z0-9][a-z0-9-]*$/;
const DRIVE_RE = /^[A-Za-z]:/;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readYaml(name, code) {
  let text;
  try {
    text = readFileSync(join(EXAMPLES, name), "utf8");
  } catch {
    fail(code, `missing example file ${name}`);
    return null;
  }
  try {
    return parseYaml(text);
  } catch (e) {
    fail(code, `${name} is not valid YAML: ${String(e?.message ?? e).slice(0, 160)}`);
    return null;
  }
}

function checkStrictTop(doc, name, allowed, code) {
  if (!isPlainObject(doc)) {
    fail(code, `${name} top level must be a mapping`);
    return;
  }
  for (const k of Object.keys(doc)) {
    if (!allowed.has(k)) fail(code, `${name} has unknown top-level field "${k}"`);
  }
}

function sortedUnique(arr) {
  return [...new Set(arr)].sort();
}

// AMEND-01: https:// for tracked upstreams, plus file:// and absolute local
// paths for mirrors and offline fixtures. Relative paths never resolve
// deterministically across machines, so they stay rejected.
// Freeze review: URL forms are parsed (not prefix-matched): https:// requires
// a hostname, and no URL form may carry credentials (CWE-200). The repository
// string is hashed verbatim into source_config_digest (§4.1 raw-string rule).
function isValidRepository(repo) {
  if (typeof repo !== "string" || repo.length === 0) return false;
  if (repo.startsWith("https://") || repo.startsWith("file://")) {
    try {
      const url = new URL(repo);
      if (url.username.length > 0 || url.password.length > 0) return false;
      if (url.protocol === "file:") return true;
      return url.protocol === "https:" && url.hostname.length > 0;
    } catch {
      return false;
    }
  }
  if (DRIVE_RE.test(repo) && /^[A-Za-z]:[\\/]/.test(repo)) return true;
  if (repo.startsWith("//") || repo.startsWith("/")) return true;
  return false;
}

/** Repo-relative posix paths only: no backslashes, absolutes, .., or drives. */
function isUnsafeRelativePath(p) {
  return (
    typeof p !== "string" ||
    p.length === 0 ||
    p.includes("\\") ||
    p.startsWith("/") ||
    p.split("/").includes("..") ||
    DRIVE_RE.test(p)
  );
}

function normalizeSourceConfig(name, src) {
  // Normalized preimage for source_config_digest (Contract A §4).
  return {
    namespace: src.namespace,
    provenance_files: sortedUnique(src.provenance_files ?? []),
    repository: src.repository,
    requested_ref: src.ref,
    selection_roots: sortedUnique(src.selection?.roots ?? []),
    type: src.type,
  };
}

function digestOf(value) {
  return `sha256:${sha256Hex(canonicalizeJson(value))}`;
}

// ---- hub.yaml ----
const hub = readYaml("hub.yaml", "E_HUB_SCHEMA");
if (hub) {
  checkStrictTop(hub, "hub.yaml", new Set(["schema_version", "hub", "owned", "external"]), "E_HUB_SCHEMA");
  if (hub.schema_version !== 1) fail("E_HUB_SCHEMA", "hub.yaml schema_version must be 1");
  if (!isPlainObject(hub.hub) || typeof hub.hub.id !== "string" || hub.hub.id.length === 0)
    fail("E_HUB_SCHEMA", "hub.yaml hub.id must be a non-empty string");
  if (!Array.isArray(hub.owned)) fail("E_HUB_SCHEMA", "hub.yaml owned must be a list");
  else {
    for (const o of hub.owned) {
      if (!isPlainObject(o) || typeof o.path !== "string" || typeof o.namespace !== "string")
        fail("E_HUB_SCHEMA", "hub.yaml owned entries need {path, namespace} strings");
      else {
        if (isUnsafeRelativePath(o.path))
          fail("E_HUB_SCHEMA", `hub.yaml owned.path unsafe: ${o.path}`);
        if (!NS_RE.test(o.namespace)) fail("E_HUB_SCHEMA", `hub.yaml owned.namespace invalid: ${o.namespace}`);
      }
    }
  }
  if (!Array.isArray(hub.external)) fail("E_HUB_SCHEMA", "hub.yaml external must be a list");
  else {
    for (const e of hub.external) {
      if (!isPlainObject(e) || typeof e.source !== "string") fail("E_HUB_SCHEMA", "hub.yaml external entries need {source} string");
    }
  }
  if (process.exitCode !== 1) ok("hub.yaml schema valid");
}

// ---- sources.yaml ----
const sourcesDoc = readYaml("sources.yaml", "E_SOURCE_SCHEMA");
let sourceNames = [];
if (sourcesDoc) {
  checkStrictTop(sourcesDoc, "sources.yaml", new Set(["schema_version", "sources"]), "E_SOURCE_SCHEMA");
  if (sourcesDoc.schema_version !== 1) fail("E_SOURCE_SCHEMA", "sources.yaml schema_version must be 1");
  if (!isPlainObject(sourcesDoc.sources)) fail("E_SOURCE_SCHEMA", "sources.yaml sources must be a mapping");
  else {
    sourceNames = Object.keys(sourcesDoc.sources).sort();
    for (const [name, src] of Object.entries(sourcesDoc.sources)) {
      if (!isPlainObject(src)) {
        fail("E_SOURCE_SCHEMA", `sources.yaml source ${name} must be a mapping`);
        continue;
      }
      const allowed = new Set(["type", "repository", "ref", "namespace", "selection", "provenance_files"]);
      for (const k of Object.keys(src)) if (!allowed.has(k)) fail("E_SOURCE_SCHEMA", `sources.yaml source ${name} unknown field "${k}"`);
      if (src.type !== "git") fail("E_SOURCE_SCHEMA", `sources.yaml source ${name} type must be "git"`);
      if (!isValidRepository(src.repository))
        fail("E_SOURCE_SCHEMA", `sources.yaml source ${name} repository must be https:// (with host, no credentials), file:// (no credentials), or an absolute local path`);
      if (typeof src.ref !== "string" || src.ref.length === 0) fail("E_SOURCE_SCHEMA", `sources.yaml source ${name} ref must be non-empty`);
      if (typeof src.namespace !== "string" || !NS_RE.test(src.namespace))
        fail("E_SOURCE_SCHEMA", `sources.yaml source ${name} namespace invalid`);
      const roots = src.selection?.roots;
      if (!isPlainObject(src.selection) || !Array.isArray(roots) || roots.length === 0)
        fail("E_SOURCE_SELECTION", `sources.yaml source ${name} selection.roots must be a non-empty list`);
      else {
        for (const r of roots) {
          if (isUnsafeRelativePath(r))
            fail("E_SOURCE_SELECTION", `sources.yaml source ${name} root unsafe: ${r}`);
        }
        const sorted = [...roots].sort();
        if (JSON.stringify(roots) !== JSON.stringify(sorted)) fail("E_SOURCE_SELECTION", `sources.yaml source ${name} selection.roots must be sorted`);
        if (new Set(roots).size !== roots.length) fail("E_SOURCE_SELECTION", `sources.yaml source ${name} selection.roots must be unique`);
      }
      // Freeze review: missing and null differ (§4.1), and an empty list
      // carries no redistribution provenance (§6) — all three fail closed.
      if (src.provenance_files === null || src.provenance_files === undefined)
        fail("E_SOURCE_SCHEMA", `sources.yaml source ${name} provenance_files must be a non-empty list (missing and null are different; null is never valid)`);
      else if (!Array.isArray(src.provenance_files) || src.provenance_files.length === 0)
        fail("E_SOURCE_SCHEMA", `sources.yaml source ${name} provenance_files must be a non-empty list`);
      else {
        for (const p of src.provenance_files) {
          if (isUnsafeRelativePath(p))
            fail("E_SOURCE_SELECTION", `sources.yaml source ${name} provenance file unsafe: ${p}`);
        }
      }
    }
  }
  if (process.exitCode !== 1) ok("sources.yaml schema valid");
}

// ---- sources.lock.yaml ----
const lock = readYaml("sources.lock.yaml", "E_LOCK_MISMATCH");
if (lock && sourcesDoc) {
  checkStrictTop(lock, "sources.lock.yaml", new Set(["schema_version", "sources"]), "E_LOCK_MISMATCH");
  if (lock.schema_version !== 1) fail("E_LOCK_MISMATCH", "sources.lock.yaml schema_version must be 1");
  if (!isPlainObject(lock.sources)) fail("E_LOCK_MISMATCH", "sources.lock.yaml sources must be a mapping");
  else {
    const lockNames = Object.keys(lock.sources).sort();
    // Lock must cover exactly the configured sources (self-contained adoption).
    if (JSON.stringify(lockNames) !== JSON.stringify(sourceNames))
      fail("E_LOCK_MISMATCH", `sources.lock.yaml sources [${lockNames}] must equal sources.yaml sources [${sourceNames}]`);
    for (const [name, rec] of Object.entries(lock.sources)) {
      const allowed = new Set([
        "source_config_digest",
        "repository",
        "requested_ref",
        "namespace",
        "selection",
        "provenance_files",
        "resolved_commit",
        "selected_skill_tree_digest",
        "vendored_snapshot_digest",
        "extraction_contract",
      ]);
      if (!isPlainObject(rec)) {
        fail("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} must be a mapping`);
        continue;
      }
      for (const k of Object.keys(rec)) if (!allowed.has(k)) fail("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} unknown field "${k}"`);
      const cfg = sourcesDoc.sources?.[name];
      if (!cfg) continue;
      // Recompute source_config_digest from sources.yaml (normative preimage).
      const expected = digestOf(normalizeSourceConfig(name, cfg));
      if (rec.source_config_digest !== expected)
        fail("E_LOCK_DIGEST", `sources.lock.yaml source ${name} source_config_digest mismatch (want ${expected})`);
      if (rec.repository !== cfg.repository) fail("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} repository must equal sources.yaml`);
      if (rec.requested_ref !== cfg.ref) fail("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} requested_ref must equal sources.yaml ref`);
      if (rec.namespace !== cfg.namespace) fail("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} namespace must equal sources.yaml`);
      if (JSON.stringify(sortedUnique(rec.selection?.roots ?? [])) !== JSON.stringify(sortedUnique(cfg.selection?.roots ?? [])))
        fail("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} selection.roots must equal sources.yaml`);
      if (JSON.stringify(sortedUnique(rec.provenance_files ?? [])) !== JSON.stringify(sortedUnique(cfg.provenance_files ?? [])))
        fail("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} provenance_files must equal sources.yaml`);
      if (typeof rec.resolved_commit !== "string" || !COMMIT_RE.test(rec.resolved_commit))
        fail("E_LOCK_COMMIT", `sources.lock.yaml source ${name} resolved_commit must be 40 lowercase hex`);
      for (const f of ["selected_skill_tree_digest", "vendored_snapshot_digest"]) {
        if (typeof rec[f] !== "string" || !SHA256_RE.test(rec[f])) fail("E_TREE_DIGEST", `sources.lock.yaml source ${name} ${f} must match sha256:<64hex>`);
      }
      if (rec.extraction_contract !== 1) fail("E_LOCK_MISMATCH", `sources.lock.yaml source ${name} extraction_contract must be 1`);
      // missing vs null are different: explicit nulls are rejected.
      for (const [k, v] of Object.entries(rec)) if (v === null) fail("E_LOCK_MISMATCH", `sources.lock.yaml source ${name}.${k} must not be null`);
    }
  }
  if (process.exitCode !== 1) ok("sources.lock.yaml self-contained and digests verify");
}

if (process.exitCode === 1) {
  console.error("CONTRACT-A-FAIL");
} else {
  console.log("CONTRACT-A-OK");
}
