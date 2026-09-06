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

const fail = (msg) => {
  console.error(`CONTRACT-A-INVALID: ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`ok: ${msg}`);

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const NS_RE = /^[a-z0-9][a-z0-9-]*$/;
const KNOWN_TOP = new Set(["schema_version", "hub", "owned", "external", "sources"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readYaml(name) {
  let text;
  try {
    text = readFileSync(join(EXAMPLES, name), "utf8");
  } catch {
    fail(`missing example file ${name}`);
    return null;
  }
  try {
    return parseYaml(text);
  } catch (e) {
    fail(`${name} is not valid YAML: ${String(e?.message ?? e).slice(0, 160)}`);
    return null;
  }
}

function checkStrictTop(doc, name, allowed) {
  if (!isPlainObject(doc)) {
    fail(`${name} top level must be a mapping`);
    return;
  }
  for (const k of Object.keys(doc)) {
    if (!allowed.has(k)) fail(`${name} has unknown top-level field "${k}"`);
  }
  if (!KNOWN_TOP.has("schema_version")) fail("internal validator error");
}

function sortedUnique(arr) {
  return [...new Set(arr)].sort();
}

// AMEND-01: https:// for tracked upstreams, plus file:// and absolute local
// paths for mirrors and offline fixtures. Relative paths never resolve
// deterministically across machines, so they stay rejected.
function isValidRepository(repo) {
  if (typeof repo !== "string" || repo.length === 0) return false;
  if (repo.startsWith("https://") || repo.startsWith("file://")) return true;
  if (/^[A-Za-z]:[\\/]/.test(repo)) return true;
  if (repo.startsWith("//") || repo.startsWith("/")) return true;
  return false;
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
const hub = readYaml("hub.yaml");
if (hub) {
  checkStrictTop(hub, "hub.yaml", new Set(["schema_version", "hub", "owned", "external"]));
  if (hub.schema_version !== 1) fail("hub.yaml schema_version must be 1");
  if (!isPlainObject(hub.hub) || typeof hub.hub.id !== "string" || hub.hub.id.length === 0)
    fail("hub.yaml hub.id must be a non-empty string");
  if (!Array.isArray(hub.owned)) fail("hub.yaml owned must be a list");
  else {
    for (const o of hub.owned) {
      if (!isPlainObject(o) || typeof o.path !== "string" || typeof o.namespace !== "string")
        fail("hub.yaml owned entries need {path, namespace} strings");
      else {
        if (o.path.includes("\\") || o.path.startsWith("/") || o.path.includes(".."))
          fail(`hub.yaml owned.path unsafe: ${o.path}`);
        if (!NS_RE.test(o.namespace)) fail(`hub.yaml owned.namespace invalid: ${o.namespace}`);
      }
    }
  }
  if (!Array.isArray(hub.external)) fail("hub.yaml external must be a list");
  else {
    for (const e of hub.external) {
      if (!isPlainObject(e) || typeof e.source !== "string") fail("hub.yaml external entries need {source} string");
    }
  }
  if (process.exitCode !== 1) ok("hub.yaml schema valid");
}

// ---- sources.yaml ----
const sourcesDoc = readYaml("sources.yaml");
let sourceNames = [];
if (sourcesDoc) {
  checkStrictTop(sourcesDoc, "sources.yaml", new Set(["schema_version", "sources"]));
  if (sourcesDoc.schema_version !== 1) fail("sources.yaml schema_version must be 1");
  if (!isPlainObject(sourcesDoc.sources)) fail("sources.yaml sources must be a mapping");
  else {
    sourceNames = Object.keys(sourcesDoc.sources).sort();
    for (const [name, src] of Object.entries(sourcesDoc.sources)) {
      if (!isPlainObject(src)) {
        fail(`sources.yaml source ${name} must be a mapping`);
        continue;
      }
      const allowed = new Set(["type", "repository", "ref", "namespace", "selection", "provenance_files"]);
      for (const k of Object.keys(src)) if (!allowed.has(k)) fail(`sources.yaml source ${name} unknown field "${k}"`);
      if (src.type !== "git") fail(`sources.yaml source ${name} type must be "git"`);
      if (!isValidRepository(src.repository))
        fail(`sources.yaml source ${name} repository must be https://, file://, or an absolute local path`);
      if (typeof src.ref !== "string" || src.ref.length === 0) fail(`sources.yaml source ${name} ref must be non-empty`);
      if (typeof src.namespace !== "string" || !NS_RE.test(src.namespace))
        fail(`sources.yaml source ${name} namespace invalid`);
      const roots = src.selection?.roots;
      if (!isPlainObject(src.selection) || !Array.isArray(roots) || roots.length === 0)
        fail(`sources.yaml source ${name} selection.roots must be a non-empty list`);
      else {
        for (const r of roots) {
          if (typeof r !== "string" || r.length === 0) fail(`sources.yaml source ${name} root must be a non-empty string`);
          else if (r.includes("\\") || r.startsWith("/") || r.split("/").includes(".."))
            fail(`sources.yaml source ${name} root unsafe: ${r}`);
        }
        const sorted = [...roots].sort();
        if (JSON.stringify(roots) !== JSON.stringify(sorted)) fail(`sources.yaml source ${name} selection.roots must be sorted`);
        if (new Set(roots).size !== roots.length) fail(`sources.yaml source ${name} selection.roots must be unique`);
      }
      const prov = src.provenance_files ?? [];
      if (!Array.isArray(prov)) fail(`sources.yaml source ${name} provenance_files must be a list`);
      else {
        for (const p of prov) {
          if (typeof p !== "string" || p.includes("\\") || p.startsWith("/") || p.split("/").includes(".."))
            fail(`sources.yaml source ${name} provenance file unsafe: ${p}`);
        }
      }
      if ("selection" in src && !isPlainObject(src.selection)) fail(`sources.yaml source ${name} selection must be a mapping`);
    }
  }
  if (process.exitCode !== 1) ok("sources.yaml schema valid");
}

// ---- sources.lock.yaml ----
const lock = readYaml("sources.lock.yaml");
if (lock && sourcesDoc) {
  checkStrictTop(lock, "sources.lock.yaml", new Set(["schema_version", "sources"]));
  if (lock.schema_version !== 1) fail("sources.lock.yaml schema_version must be 1");
  if (!isPlainObject(lock.sources)) fail("sources.lock.yaml sources must be a mapping");
  else {
    const lockNames = Object.keys(lock.sources).sort();
    // Lock must cover exactly the configured sources (self-contained adoption).
    if (JSON.stringify(lockNames) !== JSON.stringify(sourceNames))
      fail(`sources.lock.yaml sources [${lockNames}] must equal sources.yaml sources [${sourceNames}]`);
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
        fail(`sources.lock.yaml source ${name} must be a mapping`);
        continue;
      }
      for (const k of Object.keys(rec)) if (!allowed.has(k)) fail(`sources.lock.yaml source ${name} unknown field "${k}"`);
      const cfg = sourcesDoc.sources?.[name];
      if (!cfg) continue;
      // Recompute source_config_digest from sources.yaml (normative preimage).
      const expected = digestOf(normalizeSourceConfig(name, cfg));
      if (rec.source_config_digest !== expected)
        fail(`sources.lock.yaml source ${name} source_config_digest mismatch (want ${expected})`);
      if (rec.repository !== cfg.repository) fail(`sources.lock.yaml source ${name} repository must equal sources.yaml`);
      if (rec.requested_ref !== cfg.ref) fail(`sources.lock.yaml source ${name} requested_ref must equal sources.yaml ref`);
      if (rec.namespace !== cfg.namespace) fail(`sources.lock.yaml source ${name} namespace must equal sources.yaml`);
      if (JSON.stringify(sortedUnique(rec.selection?.roots ?? [])) !== JSON.stringify(sortedUnique(cfg.selection.roots)))
        fail(`sources.lock.yaml source ${name} selection.roots must equal sources.yaml`);
      if (JSON.stringify(sortedUnique(rec.provenance_files ?? [])) !== JSON.stringify(sortedUnique(cfg.provenance_files ?? [])))
        fail(`sources.lock.yaml source ${name} provenance_files must equal sources.yaml`);
      if (typeof rec.resolved_commit !== "string" || !COMMIT_RE.test(rec.resolved_commit))
        fail(`sources.lock.yaml source ${name} resolved_commit must be 40 lowercase hex`);
      for (const f of ["selected_skill_tree_digest", "vendored_snapshot_digest"]) {
        if (typeof rec[f] !== "string" || !SHA256_RE.test(rec[f])) fail(`sources.lock.yaml source ${name} ${f} must match sha256:<64hex>`);
      }
      if (rec.extraction_contract !== 1) fail(`sources.lock.yaml source ${name} extraction_contract must be 1`);
      // missing vs null are different: explicit nulls are rejected.
      for (const [k, v] of Object.entries(rec)) if (v === null) fail(`sources.lock.yaml source ${name}.${k} must not be null`);
    }
  }
  if (process.exitCode !== 1) ok("sources.lock.yaml self-contained and digests verify");
}

if (process.exitCode === 1) {
  console.error("CONTRACT-A-FAIL");
} else {
  console.log("CONTRACT-A-OK");
}
