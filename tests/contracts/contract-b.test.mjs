import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, sha256Hex } from "../../packages/hashing/dist/identities.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VALIDATOR = join(REPO, "scripts", "contracts", "validate-contract-b.mjs");
const EXAMPLES = join(REPO, "scripts", "contracts", "examples", "contract-b");

function resign(doc) {
  doc.digest = `sha256:${sha256Hex(
    canonicalizeJson({ object_type: doc.object_type, payload: doc.payload, schema_version: doc.schema_version }),
  )}`;
  return JSON.stringify(doc, null, 2);
}

function read(p) {
  return readFileSync(join(EXAMPLES, p), "utf8");
}

function withSwappedFiles(files, fn) {
  const saved = new Map();
  try {
    for (const [name, content] of Object.entries(files)) {
      const p = join(EXAMPLES, name);
      saved.set(name, readFileSync(p, "utf8"));
      writeFileSync(p, content);
    }
    return fn();
  } finally {
    for (const [name, content] of saved) writeFileSync(join(EXAMPLES, name), content);
  }
}

function runOk() {
  const out = execFileSync("node", [VALIDATOR], { encoding: "utf8" });
  return out;
}

function runBad() {
  try {
    execFileSync("node", [VALIDATOR], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
  throw new Error("validator unexpectedly passed on negative fixture");
}

test("FRESH plan + COMMITTED journal validate (CONTRACT-B-OK)", () => {
  const out = runOk();
  assert.match(out, /CONTRACT-B-OK/);
  assert.match(out, /FRESH/);
  assert.match(out, /no recovery required/);
});

test("stale plan is flagged E_PLAN_STALE", () => {
  const out = withSwappedFiles({ "update-plan.json": read("stale-plan.json") }, runBad);
  assert.match(out, /E_PLAN_STALE/);
});

test("tampered digest fails E_PLAN_DIGEST", () => {
  const bad = read("update-plan.json").replace(
    "sha256:9d8ee63a3ca988aee71f914c658050f1827edd9a98968c8489332c5283a07f2f",
    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  );
  const out = withSwappedFiles({ "update-plan.json": bad }, runBad);
  assert.match(out, /E_PLAN_DIGEST/);
});

test("mutable ref in plan fails E_PLAN_REFETCH", () => {
  const doc = JSON.parse(read("update-plan.json"));
  doc.payload.target_ref = "main";
  const out = withSwappedFiles({ "update-plan.json": resign(doc) }, runBad);
  assert.match(out, /E_PLAN_REFETCH/);
});

test("NOOP plan fails E_PLAN_NOOP", () => {
  const doc = JSON.parse(read("update-plan.json"));
  doc.payload.target_commit = doc.payload.expected_old.resolved_commit;
  doc.payload.added_skills = [];
  doc.payload.removed_skills = [];
  doc.payload.changed_skills = [];
  doc.payload.provenance_changes = [];
  const out = withSwappedFiles({ "update-plan.json": resign(doc) }, runBad);
  assert.match(out, /E_PLAN_NOOP/);
});

test("unknown envelope field fails E_PLAN_SCHEMA", () => {
  const doc = JSON.parse(read("update-plan.json"));
  doc.bogus = true;
  const out = withSwappedFiles({ "update-plan.json": resign(doc) }, runBad);
  assert.match(out, /E_PLAN_SCHEMA/);
});

test("explicit null fails closed", () => {
  const bad = read("journal.json").replace(
    '"state": "COMMITTED"',
    '"state": null',
  );
  const out = withSwappedFiles({ "journal.json": bad }, runBad);
  assert.match(out, /E_JOURNAL_STATE|E_JOURNAL_SCHEMA/);
});

test("TREE_SWAPPED journal demands E_RECOVERY_REQUIRED", () => {
  const bad = JSON.stringify(
    {
      journal_version: 1,
      source_id: "mattpocock",
      expected_old_commit: "3cca18b368ae95cdbdebbff572ccafa662551015",
      target_commit: "7d2e9f43681ab95cdbdebbff572ccafa66255101",
      staging: "staging/mattpocock",
      backup: "backup/mattpocock",
      state: "TREE_SWAPPED",
    },
    null,
    2,
  );
  const out = withSwappedFiles({ "journal.json": bad }, runBad);
  assert.match(out, /E_RECOVERY_REQUIRED/);
});

test("frozen plan digest vectors are stable", () => {
  const out = runOk();
  assert.match(out, /CONTRACT-B-OK/);
  assert.match(read("update-plan.json"), /sha256:9d8ee63a3ca988aee71f914c658050f1827edd9a98968c8489332c5283a07f2f/);
  assert.match(read("stale-plan.json"), /sha256:ec3a9e9eddd0efc7308622c8e8b371cf1176d1338c00cdd51a41c3618fb391df/);
});
