#!/usr/bin/env node
/**
 * Independent assembly of the Issue 168 I1 semantic HubRelease identity.
 *
 * This is evidence tooling, not a release builder. It deliberately does not
 * import the project's release/projection code: it reads the verified registry,
 * the pinned adoption plan and the reviewed policy, assembles the canonical
 * preimage from first principles, and hashes it with the frozen JCS/SHA-256
 * primitive. Its output must equal `ega-skills hub release project`.
 *
 * Usage:
 *   node scripts/eval/issue-168-independent-release.mjs \
 *     --registry <registry.sqlite> --plan <adoption-plan.json> \
 *     --policy <invocation-policy.json> --baseline <hub-release.json>
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { canonicalizeJson, sha256Hex } from "../../packages/hashing/dist/index.js";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

const require = createRequire(new URL("../../packages/registry/package.json", import.meta.url));
const Database = require("better-sqlite3");

const registryPath = arg("registry");
const plan = JSON.parse(readFileSync(arg("plan"), "utf8"));
const policy = JSON.parse(readFileSync(arg("policy"), "utf8"));
const baseline = JSON.parse(readFileSync(arg("baseline"), "utf8"));

const digest = (value) => `sha256:${sha256Hex(canonicalizeJson(value))}`;
const payloadDigest = (objectType, schemaVersion, payload) => digest({ object_type: objectType, payload, schema_version: schemaVersion });
const sortObject = (entries) => Object.fromEntries([...entries].sort(([left], [right]) => (left < right ? -1 : 1)));

const policyDigest = payloadDigest(policy.object_type, policy.schema_version, policy.payload);
if (policyDigest !== policy.digest) throw new Error(`policy digest mismatch: ${policyDigest}`);

const sourceConfig = {
  namespace: plan.payload.namespace,
  provenance_files: [...new Set(plan.payload.source.provenance_files)].sort(),
  repository: plan.payload.source.repository,
  requested_ref: plan.payload.source.requested_ref,
  selection_roots: [...new Set(plan.payload.source.selected_roots)].sort(),
  type: plan.payload.source.type,
};

const db = new Database(registryPath, { readonly: true });
try {
  const rows = db.prepare("SELECT skill_id, version_hash, manifest_json FROM skill_versions ORDER BY skill_id").all();
  const byId = new Map(rows.map((row) => [row.skill_id, row]));
  const baselineIds = Object.keys(baseline.payload.skill_versions);
  for (const id of baselineIds) {
    if (byId.get(id)?.version_hash !== baseline.payload.skill_versions[id]) throw new Error(`baseline drift: ${id}`);
  }
  const governed = policy.payload.bindings.map((binding) => binding.skill_id).sort();
  const added = rows.filter((row) => !baselineIds.includes(row.skill_id)).map((row) => row.skill_id);
  if (JSON.stringify(added) !== JSON.stringify(governed)) throw new Error("added catalog is not the governed roster");

  const versions = {};
  const aliases = {};
  const searchRows = [];
  const counts = [];
  for (const row of rows) {
    const manifest = JSON.parse(row.manifest_json);
    if (digest(manifest) !== row.version_hash) throw new Error(`manifest hash mismatch: ${row.skill_id}`);
    versions[row.skill_id] = row.version_hash;
    for (const alias of manifest.routing.aliases) {
      if (aliases[alias] && aliases[alias] !== row.skill_id) throw new Error(`alias collision: ${alias}`);
      aliases[alias] = row.skill_id;
    }
    searchRows.push({
      aliases: [...manifest.routing.aliases],
      description: manifest.portable.description,
      domains: [...manifest.routing.domains],
      frameworks: [...manifest.routing.frameworks],
      name: manifest.portable.name,
      platforms: [...manifest.routing.platforms],
      skill_id: row.skill_id,
      triggers: [...manifest.routing.triggers],
      version_hash: row.version_hash,
    });
    const skillMd = manifest.files.find((file) => file.path === "SKILL.md");
    const token = db.prepare("SELECT token_count FROM token_counts WHERE blob_hash = ? AND estimator_id = ?").get(skillMd.blob_hash, "ega-o200k-v1");
    if (!token) throw new Error(`missing token count: ${row.skill_id}`);
    counts.push({ level: "L2", skill_id: row.skill_id, tokens: token.token_count, version_hash: row.version_hash });
  }

  const adopted = [...baseline.payload.adopted_sources, {
    resolved_commit: plan.payload.source.resolved_commit,
    selected_skill_tree_digest: plan.payload.source.selected_skill_tree_digest,
    source_config_digest: digest(sourceConfig),
    source_id: plan.payload.source_id,
    vendored_snapshot_digest: plan.payload.source.vendored_snapshot_digest,
  }].sort((left, right) => (left.source_id < right.source_id ? -1 : 1));

  const payload = {
    adopted_sources: adopted,
    alias_map_digest: digest({ aliases: sortObject(Object.entries(aliases)) }),
    build: { expected_catalog_match: true, fresh_registry: true, import_failures: 0 },
    contracts: {
      build_contract: "C2", hashing: 1, hub_contract: "A1", importer_build: 1,
      router: 2, schema: "v1.0.1", search: 1, token_estimator: "ega-o200k-v1", update_contract: "B1",
    },
    hub_id: baseline.payload.hub_id,
    invocation_policy_digest: policyDigest,
    invocation_profile: policy.payload.profile,
    search_index_input_digest: digest({ rows: searchRows }),
    skill_versions: sortObject(Object.entries(versions)),
    token_artifact_digest: digest({ counts, estimator: "ega-o200k-v1" }),
  };

  process.stdout.write(`${JSON.stringify({
    adopted_sources: adopted,
    digest: payloadDigest("ega.hub-release", 2, payload),
    policy_digest: policyDigest,
    skill_count: rows.length,
    skill_versions: governed.length,
  }, null, 2)}\n`);
} finally {
  db.close();
}
