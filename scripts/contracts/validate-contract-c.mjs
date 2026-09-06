#!/usr/bin/env node
/**
 * Contract C validator (EGA-622) — executable acceptance check for the frozen
 * Complete Build & HubRelease contract.
 *
 * Validates scripts/contracts/examples/contract-c/ against Contract C v1 and
 * PROVES release-specific FTS isolation with a real FTS5 database
 * (better-sqlite3 from packages/registry — no new dependencies):
 *   R1 corpus rows  -> FTS table r1
 *   R2 corpus rows  -> FTS table r2 (same database, extra unrelated skill)
 *   R1 search order must be byte-identical before and after R2 exists.
 *
 * Exit 0 = release valid + isolation proven. Exit 1 = violation (class on stderr).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { canonicalizeJson, sha256Hex } from "../../packages/hashing/dist/identities.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "examples", "contract-c");
const registryRequire = createRequire(join(HERE, "..", "..", "packages", "registry", "package.json"));
const Database = registryRequire("better-sqlite3");

// Contract A §4.1 frozen vectors — the release binds adopted sources exactly.
const ADOPTED = {
  mattpocock: {
    source_config_digest: "sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547",
    repository: "https://github.com/mattpocock/skills",
    requested_ref: "main",
    resolved_commit: "3cca18b368ae95cdbdebbff572ccafa662551015",
    selected_skill_tree_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    vendored_snapshot_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  },
  "cursor-pstack": {
    source_config_digest: "sha256:4854f1cae5082f0319da306e2678a6f525a3dba369a3e44245455d03f0490067",
    repository: "https://github.com/cursor/plugins",
    requested_ref: "main",
    resolved_commit: "0123456789abcdef0123456789abcdef01234567",
    selected_skill_tree_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    vendored_snapshot_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
};

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function fail(code, msg) {
  console.error(`${code}: ${msg}`);
  process.exitCode = 1;
}
const ok = (msg) => console.log(`ok: ${msg}`);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function digestOf(value) {
  return `sha256:${sha256Hex(canonicalizeJson(value))}`;
}

function readJson(name) {
  let text;
  try {
    text = readFileSync(join(EXAMPLES, name), "utf8");
  } catch {
    fail("E_RELEASE_SCHEMA", `missing example file ${name}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail("E_RELEASE_SCHEMA", `${name} is not valid JSON: ${String(e?.message ?? e).slice(0, 120)}`);
    return null;
  }
}

function rejectNulls(obj, where) {
  let clean = true;
  const walk = (v, path) => {
    if (v === null) {
      fail("E_RELEASE_SCHEMA", `${where}.${path} must not be null (missing and null differ)`);
      clean = false;
      return;
    }
    if (Array.isArray(v)) v.forEach((e, i) => walk(e, `${path}[${i}]`));
    else if (isPlainObject(v)) for (const [k, e] of Object.entries(v)) walk(e, path ? `${path}.${k}` : k);
  };
  walk(obj, "");
  return clean;
}

// ---- search-index-input.json (R1 corpus) + -r2 variant ----
function checkSearchInput(name) {
  const doc = readJson(name);
  if (!doc) return null;
  if (!isPlainObject(doc) || !Array.isArray(doc.rows)) {
    fail("E_SEARCH_INPUT", `${name} must be {rows: [...]}`);
    return null;
  }
  const ids = new Set();
  for (const r of doc.rows) {
    if (!isPlainObject(r)) {
      fail("E_SEARCH_INPUT", `${name} rows must be objects`);
      continue;
    }
    for (const k of Object.keys(r)) {
      if (!["skill_id", "version_hash", "name", "description", "domains", "platforms", "frameworks", "triggers", "aliases"].includes(k))
        fail("E_SEARCH_INPUT", `${name} row unknown field "${k}"`);
    }
    if (typeof r.skill_id !== "string" || r.skill_id.length === 0) fail("E_SEARCH_INPUT", `${name} row needs skill_id`);
    if (ids.has(r.skill_id)) fail("E_SEARCH_INPUT", `${name} duplicate skill_id ${r.skill_id}`);
    ids.add(r.skill_id);
    if (typeof r.version_hash !== "string" || !SHA256_RE.test(r.version_hash))
      fail("E_SEARCH_INPUT", `${name} row ${r.skill_id} version_hash must match sha256:<64hex>`);
    for (const f of ["domains", "platforms", "frameworks", "triggers", "aliases"]) {
      if (!Array.isArray(r[f])) fail("E_SEARCH_INPUT", `${name} row ${r.skill_id}.${f} must be a list`);
    }
    if (typeof r.name !== "string" || typeof r.description !== "string")
      fail("E_SEARCH_INPUT", `${name} row ${r.skill_id} needs name/description strings`);
  }
  // Deterministic order: rows sorted by skill_id.
  const order = doc.rows.map((r) => r.skill_id);
  if (JSON.stringify(order) !== JSON.stringify([...order].sort()))
    fail("E_SEARCH_INPUT", `${name} rows must be sorted by skill_id`);
  rejectNulls(doc, name);
  return doc;
}

const r1 = checkSearchInput("search-index-input.json");
const r2 = checkSearchInput("search-index-input-r2.json");
if (r1 && process.exitCode !== 1) ok(`search-index-input.json valid (${r1.rows.length} R1 rows)`);
if (r2) {
  const r1ids = new Set(r1?.rows.map((r) => r.skill_id) ?? []);
  const extra = r2.rows.filter((r) => !r1ids.has(r.skill_id));
  if (extra.length === 0) fail("E_SEARCH_INPUT", "search-index-input-r2.json must add an unrelated skill (R2 superset fixture)");
  else ok(`search-index-input-r2.json valid (R2 adds: ${extra.map((r) => r.skill_id).join(",")})`);
}

// ---- alias-map.json (release-scoped: values subset of R1 ids) ----
const aliasMap = readJson("alias-map.json");
if (aliasMap && r1) {
  if (!isPlainObject(aliasMap) || !isPlainObject(aliasMap.aliases))
    fail("E_ALIAS_SCOPE", "alias-map.json must be {aliases: {...}}");
  else {
    for (const k of Object.keys(aliasMap)) if (k !== "aliases") fail("E_ALIAS_SCOPE", `alias-map.json unknown field "${k}"`);
    const keys = Object.keys(aliasMap.aliases);
    if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) fail("E_ALIAS_SCOPE", "alias-map.json aliases must be sorted");
    const r1ids = new Set(r1.rows.map((r) => r.skill_id));
    for (const [alias, target] of Object.entries(aliasMap.aliases)) {
      if (typeof target !== "string" || !r1ids.has(target))
        fail("E_ALIAS_SCOPE", `alias-map.json alias ${alias} targets unselected skill ${target} (no historical inheritance)`);
    }
    rejectNulls(aliasMap, "alias-map.json");
  }
  if (process.exitCode !== 1) ok("alias-map.json release-scoped (no historical inheritance)");
}

// ---- token-artifact.json ----
const tokenArtifact = readJson("token-artifact.json");
if (tokenArtifact && r1) {
  if (!isPlainObject(tokenArtifact)) fail("E_TOKEN_ARTIFACT", "token-artifact.json top level must be an object");
  else {
    for (const k of Object.keys(tokenArtifact))
      if (!["estimator", "counts"].includes(k)) fail("E_TOKEN_ARTIFACT", `token-artifact.json unknown field "${k}"`);
    if (tokenArtifact.estimator !== "ega-o200k-v1")
      fail("E_TOKEN_ARTIFACT", 'token-artifact.json estimator must be "ega-o200k-v1"');
    if (!Array.isArray(tokenArtifact.counts)) fail("E_TOKEN_ARTIFACT", "token-artifact.json counts must be a list");
    else {
      const versions = new Map(r1.rows.map((r) => [r.skill_id, r.version_hash]));
      for (const c of tokenArtifact.counts) {
        if (!isPlainObject(c)) {
          fail("E_TOKEN_ARTIFACT", "token-artifact.json counts entries must be objects");
          continue;
        }
        for (const k of Object.keys(c))
          if (!["skill_id", "version_hash", "level", "tokens"].includes(k))
            fail("E_TOKEN_ARTIFACT", `token-artifact.json counts unknown field "${k}"`);
        if (versions.get(c.skill_id) !== c.version_hash)
          fail("E_TOKEN_ARTIFACT", `token-artifact.json count for ${c.skill_id} must match the R1 version`);
        if (!["L1", "L2"].includes(c.level)) fail("E_TOKEN_ARTIFACT", `token-artifact.json count ${c.skill_id} level must be L1/L2`);
        if (!Number.isInteger(c.tokens) || c.tokens < 0)
          fail("E_TOKEN_ARTIFACT", `token-artifact.json count ${c.skill_id} tokens must be a non-negative integer`);
      }
      if (tokenArtifact.counts.length !== r1.rows.length)
        fail("E_TOKEN_ARTIFACT", "token-artifact.json must cover exactly the R1 catalog (no ambient history)");
    }
    rejectNulls(tokenArtifact, "token-artifact.json");
  }
  if (process.exitCode !== 1) ok("token-artifact.json bound to R1 catalog (ega-o200k-v1)");
}

// ---- hub-release.json (semantic envelope) ----
const release = readJson("hub-release.json");
let releaseDigest = null;
if (release && r1 && aliasMap && tokenArtifact) {
  if (!isPlainObject(release)) fail("E_RELEASE_SCHEMA", "hub-release.json top level must be an object");
  else {
    for (const k of Object.keys(release))
      if (!["object_type", "schema_version", "payload", "digest"].includes(k))
        fail("E_RELEASE_SCHEMA", `hub-release.json unknown envelope field "${k}"`);
    if (release.object_type !== "ega.hub-release") fail("E_RELEASE_SCHEMA", 'hub-release.json object_type must be "ega.hub-release"');
    if (release.schema_version !== 1) fail("E_RELEASE_SCHEMA", "hub-release.json schema_version must be 1");
    // Guarded: a missing payload must fail closed with E_RELEASE_SCHEMA below,
    // not abort inside canonicalization.
    if (isPlainObject(release.payload)) {
      releaseDigest = digestOf({ object_type: release.object_type, payload: release.payload, schema_version: release.schema_version });
      if (release.digest !== releaseDigest) fail("E_RELEASE_DIGEST", `hub-release.json digest mismatch (want ${releaseDigest})`);
    }

    const p = release.payload;
    const allowed = new Set([
      "hub_id",
      "skill_versions",
      "alias_map_digest",
      "search_index_input_digest",
      "token_artifact_digest",
      "adopted_sources",
      "contracts",
      "build",
    ]);
    if (!isPlainObject(p)) fail("E_RELEASE_SCHEMA", "hub-release.json payload must be an object");
    else {
      for (const k of Object.keys(p)) if (!allowed.has(k)) fail("E_RELEASE_SCHEMA", `hub-release.json payload unknown field "${k}"`);
      // Semantic bindings recomputed from the exact fixture files.
      const r1ids = r1.rows.map((r) => r.skill_id);
      const expectedVersions = Object.fromEntries(r1.rows.map((r) => [r.skill_id, r.version_hash]));
      if (JSON.stringify(p.skill_versions) !== JSON.stringify(expectedVersions))
        fail("E_RELEASE_DIGEST", "hub-release.json skill_versions must equal exactly the R1 catalog");
      if (p.alias_map_digest !== digestOf(aliasMap)) fail("E_RELEASE_DIGEST", "hub-release.json alias_map_digest mismatch");
      if (p.search_index_input_digest !== digestOf(r1)) fail("E_RELEASE_DIGEST", "hub-release.json search_index_input_digest mismatch");
      if (p.token_artifact_digest !== digestOf(tokenArtifact)) fail("E_RELEASE_DIGEST", "hub-release.json token_artifact_digest mismatch");
      // Adopted sources pinned to Contract A vectors.
      if (!Array.isArray(p.adopted_sources) || p.adopted_sources.length !== 2)
        fail("E_RELEASE_SCHEMA", "hub-release.json adopted_sources must list exactly the 2 adopted sources");
      else {
        for (const s of p.adopted_sources) {
          const want = ADOPTED[s?.source_id];
          if (!want) {
            fail("E_RELEASE_SCHEMA", `hub-release.json adopted_sources unknown source ${s?.source_id}`);
            continue;
          }
          for (const f of ["source_config_digest", "resolved_commit", "selected_skill_tree_digest", "vendored_snapshot_digest"]) {
            if (s[f] !== want[f]) fail("E_RELEASE_DIGEST", `hub-release.json adopted ${s.source_id}.${f} must equal the Contract A vector`);
          }
        }
      }
      // Contract versions bound (later contracts change these explicitly).
      const c = p.contracts;
      if (!isPlainObject(c)) fail("E_RELEASE_SCHEMA", "hub-release.json contracts must be an object");
      else {
        for (const [k, v] of Object.entries({ schema: "v1.0.1", hashing: 1, router: 1, search: 1, importer_build: 1, hub_contract: "A1", update_contract: "B1", build_contract: "C1" })) {
          if (c[k] !== v) fail("E_RELEASE_SCHEMA", `hub-release.json contracts.${k} must be ${JSON.stringify(v)}`);
        }
        if (c.token_estimator !== "ega-o200k-v1") fail("E_RELEASE_SCHEMA", "hub-release.json contracts.token_estimator must be ega-o200k-v1");
      }
      // Fresh-build attestation: partial success is failure.
      if (!isPlainObject(p.build)) fail("E_BUILD_ATTESTATION", "hub-release.json build attestation must be an object");
      else {
        if (p.build.fresh_registry !== true) fail("E_BUILD_ATTESTATION", "hub-release.json build.fresh_registry must be true");
        if (p.build.import_failures !== 0) fail("E_BUILD_ATTESTATION", "hub-release.json build.import_failures must be 0");
        if (p.build.expected_catalog_match !== true)
          fail("E_BUILD_ATTESTATION", "hub-release.json build.expected_catalog_match must be true");
      }
      // No non-semantic values in the semantic payload (timestamps, paths, URLs).
      const flat = JSON.stringify(p);
      for (const bad of ["timestamp", "build_host", "file://", "/home/", "C:\\"]) {
        if (flat.includes(bad)) fail("E_RELEASE_SCHEMA", `hub-release.json payload carries non-semantic value ${bad}`);
      }
      rejectNulls(p, "hub-release.json payload");
    }
  }
  if (process.exitCode !== 1) ok("hub-release.json semantic envelope valid");
}

// ---- release-package.json (artifact metadata OUTSIDE semantic identity) ----
const pkg = readJson("release-package.json");
if (pkg && releaseDigest) {
  for (const k of Object.keys(pkg))
    if (!["hub_release_digest", "sqlite_artifact_digest", "snapshot_rows"].includes(k))
      fail("E_PACKAGE_BINDING", `release-package.json unknown field "${k}"`);
  if (pkg.hub_release_digest !== releaseDigest) fail("E_PACKAGE_BINDING", "release-package.json hub_release_digest must equal the HubRelease digest");
  if (typeof pkg.sqlite_artifact_digest !== "string" || !SHA256_RE.test(pkg.sqlite_artifact_digest))
    fail("E_PACKAGE_BINDING", "release-package.json sqlite_artifact_digest must match sha256:<64hex>");
  if (pkg.snapshot_rows !== r1?.rows.length) fail("E_PACKAGE_BINDING", "release-package.json snapshot_rows must equal the R1 catalog size");
  rejectNulls(pkg, "release-package.json");
  if (process.exitCode !== 1) ok("release-package.json bound (artifact digest outside semantic identity)");
}

// ---- stable.json (CAS pointer, updated LAST) ----
const stable = readJson("stable.json");
if (stable && releaseDigest) {
  for (const k of Object.keys(stable))
    if (!["hub_id", "stable_release_digest", "cas_version"].includes(k))
      fail("E_STABLE", `stable.json unknown field "${k}"`);
  if (stable.stable_release_digest !== releaseDigest) fail("E_STABLE", "stable.json must point at the verified HubRelease digest");
  if (!Number.isInteger(stable.cas_version) || stable.cas_version < 1)
    fail("E_STABLE", "stable.json cas_version must be a positive integer (CAS precondition)");
  rejectNulls(stable, "stable.json");
  if (process.exitCode !== 1) ok("stable.json CAS pointer valid");
}

// ---- FTS isolation proof (real FTS5): R1 order invariant under R2 ----
if (r1 && r2 && process.exitCode !== 1) {
  const FTS_COLS = ["skill_id", "name", "description", "triggers"];
  const db = new Database(":memory:");
  try {
    const textOf = (r) => [r.name, r.description, (r.triggers ?? []).join(" ")].join("\n");
    db.exec("CREATE VIRTUAL TABLE r1 USING fts5(skill_id, name, description, triggers)");
    const ins1 = db.prepare("INSERT INTO r1(skill_id, name, description, triggers) VALUES (?,?,?,?)");
    for (const r of r1.rows) ins1.run(r.skill_id, r.name, r.description, (r.triggers ?? []).join(" "));
    const q = (t, arg) => t.prepare("SELECT skill_id FROM r1 WHERE r1 MATCH ? ORDER BY rank").all(arg).map((x) => x.skill_id);
    const before = q(db, "tdd OR testing OR review");
    if (before.length === 0) fail("E_SEARCH_ISOLATION", "isolation probe query matched nothing (fixture too sparse)");
    // R2 corpus arrives in the SAME database as its OWN table (never a WHERE filter on shared rows).
    db.exec("CREATE VIRTUAL TABLE r2 USING fts5(skill_id, name, description, triggers)");
    const ins2 = db.prepare("INSERT INTO r2(skill_id, name, description, triggers) VALUES (?,?,?,?)");
    for (const r of r2.rows) ins2.run(r.skill_id, r.name, r.description, (r.triggers ?? []).join(" "));
    const after = q(db, "tdd OR testing OR review");
    if (JSON.stringify(before) !== JSON.stringify(after))
      fail("E_SEARCH_ISOLATION", `R1 order changed after R2 publish: ${before} -> ${after}`);
    // r1 holds exactly the release corpus (no retained history leaks in).
    const n1 = db.prepare("SELECT COUNT(*) AS n FROM r1").get().n;
    if (n1 !== r1.rows.length) fail("E_SEARCH_ISOLATION", `r1 holds ${n1} rows, release catalog has ${r1.rows.length}`);
    void FTS_COLS;
  } finally {
    db.close();
  }
  if (process.exitCode !== 1) ok("FTS isolation proven (R1 order invariant under R2)");
}

if (process.exitCode === 1) {
  console.error("CONTRACT-C-FAIL");
} else {
  console.log("CONTRACT-C-OK");
}
