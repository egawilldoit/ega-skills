#!/usr/bin/env node
/**
 * Contract B validator (EGA-621) — executable acceptance check for the frozen
 * UpdatePlan & Recovery contract.
 *
 * Validates scripts/contracts/examples/contract-b/ against Contract B v1:
 *   adopted.json      current adopted source state (fixture authority)
 *   update-plan.json  immutable UpdatePlan envelope (digest recomputed via the
 *                     proven V1 JCS/SHA-256 primitive)
 *   stale-plan.json   a plan whose expected_old no longer matches adopted.json
 *                     (used by tests through file swap; must be STALE)
 *   journal.json      crash-safe update journal (COMMITTED passes; any other
 *                     state fails closed with RECOVERY_REQUIRED)
 *
 * Exit 0 = plan FRESH and journal clean. Exit 1 = violation (class on stderr).
 * No network, no git, no new dependencies.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, sha256Hex } from "../../packages/hashing/dist/identities.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "examples", "contract-b");

// Contract A §4.1 frozen vector (mattpocock) — the plan must bind this exact
// adopted configuration; Contract B never reinterprets Contract A state.
const MATT_CONFIG_DIGEST =
  "sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const JOURNAL_STATES = ["PREPARED", "TREE_SWAPPED", "LOCK_SWAPPED", "COMMITTED"];

function fail(code, msg) {
  console.error(`${code}: ${msg}`);
  process.exitCode = 1;
}
const ok = (msg) => console.log(`ok: ${msg}`);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readJson(name) {
  let text;
  try {
    text = readFileSync(join(EXAMPLES, name), "utf8");
  } catch {
    fail("E_PLAN_SCHEMA", `missing example file ${name}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail("E_PLAN_SCHEMA", `${name} is not valid JSON: ${String(e?.message ?? e).slice(0, 120)}`);
    return null;
  }
}

function rejectNulls(obj, where) {
  let bad = false;
  const walk = (v, path) => {
    if (v === null) {
      fail("E_PLAN_SCHEMA", `${where}.${path} must not be null (missing and null differ)`);
      bad = true;
      return;
    }
    if (Array.isArray(v)) v.forEach((e, i) => walk(e, `${path}[${i}]`));
    else if (isPlainObject(v)) for (const [k, e] of Object.entries(v)) walk(e, path ? `${path}.${k}` : k);
  };
  walk(obj, "");
  return !bad;
}

// ---- adopted.json ----
const adopted = readJson("adopted.json");
if (adopted) {
  const allowed = new Set(["source_id", "source_config_digest", "resolved_commit", "selected_skill_tree_digest"]);
  if (!isPlainObject(adopted)) fail("E_PLAN_SCHEMA", "adopted.json top level must be an object");
  else {
    for (const k of Object.keys(adopted)) if (!allowed.has(k)) fail("E_PLAN_SCHEMA", `adopted.json unknown field "${k}"`);
    if (adopted.source_id !== "mattpocock") fail("E_PLAN_SCHEMA", "adopted.json source_id must be mattpocock");
    if (adopted.source_config_digest !== MATT_CONFIG_DIGEST)
      fail("E_PLAN_SCHEMA", "adopted.json source_config_digest must equal the Contract A frozen vector");
    if (typeof adopted.resolved_commit !== "string" || !COMMIT_RE.test(adopted.resolved_commit))
      fail("E_PLAN_SCHEMA", "adopted.json resolved_commit must be 40 lowercase hex");
    if (typeof adopted.selected_skill_tree_digest !== "string" || !SHA256_RE.test(adopted.selected_skill_tree_digest))
      fail("E_PLAN_SCHEMA", "adopted.json selected_skill_tree_digest must match sha256:<64hex>");
    rejectNulls(adopted, "adopted.json");
  }
  if (process.exitCode !== 1) ok("adopted.json schema valid");
}

// ---- update-plan.json ----
const plan = readJson("update-plan.json");
if (plan && adopted) {
  if (!isPlainObject(plan)) fail("E_PLAN_SCHEMA", "update-plan.json top level must be an object");
  else {
    for (const k of Object.keys(plan))
      if (!["object_type", "schema_version", "payload", "digest"].includes(k))
        fail("E_PLAN_SCHEMA", `update-plan.json unknown envelope field "${k}"`);
    if (plan.object_type !== "ega.update-plan") fail("E_PLAN_SCHEMA", 'update-plan.json object_type must be "ega.update-plan"');
    if (plan.schema_version !== 1) fail("E_PLAN_SCHEMA", "update-plan.json schema_version must be 1");
    // Digest preimage excludes digest (Contract B §3, post-V1 spec §2.2).
    const recomputed = `sha256:${sha256Hex(
      canonicalizeJson({ object_type: plan.object_type, payload: plan.payload, schema_version: plan.schema_version }),
    )}`;
    if (plan.digest !== recomputed) fail("E_PLAN_DIGEST", `update-plan.json digest mismatch (want ${recomputed})`);

    const p = plan.payload;
    const allowedPayload = new Set([
      "source_id",
      "source_config_digest",
      "expected_old",
      "target_commit",
      "new_selected_tree_digest",
      "new_vendored_snapshot_digest",
      "added_skills",
      "removed_skills",
      "changed_skills",
      "unselected_new_skills",
      "provenance_changes",
      "extraction_contract",
    ]);
    if (!isPlainObject(p)) fail("E_PLAN_SCHEMA", "update-plan.json payload must be an object");
    else {
      for (const k of Object.keys(p)) if (!allowedPayload.has(k)) fail("E_PLAN_SCHEMA", `update-plan.json payload unknown field "${k}"`);
      // A moving ref anywhere in the plan means apply could silently refetch.
      for (const bad of ["ref", "target_ref", "branch", "rev"]) {
        if (bad in p) fail("E_PLAN_REFETCH", `update-plan.json payload must not carry "${bad}" (exact commit only)`);
        if (isPlainObject(p.expected_old) && bad in p.expected_old)
          fail("E_PLAN_REFETCH", `update-plan.json expected_old must not carry "${bad}"`);
      }
      if (p.source_id !== "mattpocock") fail("E_PLAN_SCHEMA", "update-plan.json payload source_id must be mattpocock");
      if (p.source_config_digest !== MATT_CONFIG_DIGEST)
        fail("E_PLAN_SCHEMA", "update-plan.json payload source_config_digest must equal the Contract A frozen vector");
      if (!isPlainObject(p.expected_old)) fail("E_PLAN_SCHEMA", "update-plan.json payload expected_old must be an object");
      else {
        for (const k of Object.keys(p.expected_old))
          if (!["resolved_commit", "selected_skill_tree_digest"].includes(k))
            fail("E_PLAN_SCHEMA", `update-plan.json expected_old unknown field "${k}"`);
        if (typeof p.expected_old.resolved_commit !== "string" || !COMMIT_RE.test(p.expected_old.resolved_commit))
          fail("E_PLAN_COMMIT", "update-plan.json expected_old.resolved_commit must be 40 lowercase hex");
        if (typeof p.expected_old.selected_skill_tree_digest !== "string" || !SHA256_RE.test(p.expected_old.selected_skill_tree_digest))
          fail("E_PLAN_SCHEMA", "update-plan.json expected_old.selected_skill_tree_digest must match sha256:<64hex>");
      }
      if (typeof p.target_commit !== "string" || !COMMIT_RE.test(p.target_commit))
        fail("E_PLAN_COMMIT", "update-plan.json target_commit must be 40 lowercase hex (exact commit, never a ref)");
      for (const f of ["new_selected_tree_digest", "new_vendored_snapshot_digest"]) {
        if (typeof p[f] !== "string" || !SHA256_RE.test(p[f]))
          fail("E_PLAN_SCHEMA", `update-plan.json ${f} must match sha256:<64hex>`);
      }
      for (const f of ["added_skills", "removed_skills", "changed_skills", "unselected_new_skills", "provenance_changes"]) {
        if (!Array.isArray(p[f])) fail("E_PLAN_SCHEMA", `update-plan.json ${f} must be a list`);
      }
      if (Array.isArray(p.changed_skills)) {
        for (const c of p.changed_skills) {
          if (!isPlainObject(c)) {
            fail("E_PLAN_SCHEMA", "update-plan.json changed_skills entries must be objects");
            continue;
          }
          for (const k of Object.keys(c))
            if (!["skill_ref", "old_version", "new_version", "raw_changed", "canonical_changed"].includes(k))
              fail("E_PLAN_SCHEMA", `update-plan.json changed_skills unknown field "${k}"`);
          if (typeof c.raw_changed !== "boolean" || typeof c.canonical_changed !== "boolean")
            fail("E_PLAN_SCHEMA", "update-plan.json changed_skills entries need boolean raw_changed/canonical_changed");
          for (const v of [c.old_version, c.new_version]) {
            if (typeof v !== "string" || !SHA256_RE.test(v))
              fail("E_PLAN_SCHEMA", "update-plan.json changed_skills versions must match sha256:<64hex>");
          }
        }
      }
      if (p.extraction_contract !== 1) fail("E_PLAN_SCHEMA", "update-plan.json extraction_contract must be 1");
      rejectNulls(p, "update-plan.json payload");

      // Stale-plan rule: expected_old must equal currently adopted state.
      if (
        isPlainObject(p.expected_old) &&
        (p.expected_old.resolved_commit !== adopted.resolved_commit ||
          p.expected_old.selected_skill_tree_digest !== adopted.selected_skill_tree_digest)
      ) {
        fail("E_PLAN_STALE", "update-plan.json expected_old no longer matches adopted state (stale plan)");
      }
      // A plan that changes nothing is not a plan.
      const changeCount =
        (Array.isArray(p.added_skills) ? p.added_skills.length : 0) +
        (Array.isArray(p.removed_skills) ? p.removed_skills.length : 0) +
        (Array.isArray(p.changed_skills) ? p.changed_skills.length : 0) +
        (Array.isArray(p.provenance_changes) ? p.provenance_changes.length : 0);
      if (
        typeof p.target_commit === "string" &&
        isPlainObject(p.expected_old) &&
        p.target_commit === p.expected_old.resolved_commit &&
        changeCount === 0
      ) {
        fail("E_PLAN_NOOP", "update-plan.json target equals adopted state with zero changes");
      }
    }
  }
  if (process.exitCode !== 1) ok("update-plan.json envelope valid and FRESH");
}

// ---- journal.json ----
const journal = readJson("journal.json");
if (journal) {
  const allowed = new Set(["journal_version", "source_id", "expected_old_commit", "target_commit", "staging", "backup", "state"]);
  if (!isPlainObject(journal)) fail("E_JOURNAL_SCHEMA", "journal.json top level must be an object");
  else {
    for (const k of Object.keys(journal)) if (!allowed.has(k)) fail("E_JOURNAL_SCHEMA", `journal.json unknown field "${k}"`);
    if (journal.journal_version !== 1) fail("E_JOURNAL_SCHEMA", "journal.json journal_version must be 1");
    if (journal.source_id !== "mattpocock") fail("E_JOURNAL_SCHEMA", "journal.json source_id must be mattpocock");
    for (const f of ["expected_old_commit", "target_commit"]) {
      if (typeof journal[f] !== "string" || !COMMIT_RE.test(journal[f]))
        fail("E_JOURNAL_SCHEMA", `journal.json ${f} must be 40 lowercase hex`);
    }
    if (!JOURNAL_STATES.includes(journal.state))
      fail("E_JOURNAL_STATE", `journal.json state must be one of ${JOURNAL_STATES.join("/")}`);
    if (journal.state === "COMMITTED") {
      if ("staging" in journal || "backup" in journal)
        fail("E_JOURNAL_SCHEMA", "journal.json COMMITTED must not retain staging/backup");
    } else if (process.exitCode !== 1) {
      if (typeof journal.staging !== "string" || journal.staging.length === 0)
        fail("E_JOURNAL_SCHEMA", "journal.json non-COMMITTED state needs a staging location");
      if (typeof journal.backup !== "string" || journal.backup.length === 0)
        fail("E_JOURNAL_SCHEMA", "journal.json non-COMMITTED state needs a backup location");
    }
    rejectNulls(journal, "journal.json");
    // Crash-safety gate: hub build MUST refuse while recovery is incomplete.
    if (JOURNAL_STATES.includes(journal.state) && journal.state !== "COMMITTED")
      fail("E_RECOVERY_REQUIRED", `journal.json state ${journal.state} requires recovery before hub build`);
  }
  if (process.exitCode !== 1) ok("journal.json clean (COMMITTED, no recovery required)");
}

if (process.exitCode === 1) {
  console.error("CONTRACT-B-FAIL");
} else {
  console.log("CONTRACT-B-OK");
}
