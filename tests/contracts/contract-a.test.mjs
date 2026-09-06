import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, sha256Hex } from "../../packages/hashing/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VALIDATOR = join(REPO, "scripts", "contracts", "validate-contract-a.mjs");
const EXAMPLES = join(REPO, "scripts", "contracts", "examples", "contract-a");

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

function runGood() {
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

test("good fixtures validate (CONTRACT-A-OK)", () => {
  const out = runGood();
  assert.match(out, /CONTRACT-A-OK/);
  assert.match(out, /hub\.yaml schema valid/);
  assert.match(out, /sources\.yaml schema valid/);
  assert.match(out, /sources\.lock\.yaml self-contained/);
});

test("unknown top-level field in hub.yaml fails closed", () => {
  const out = withSwappedFiles({ "hub.yaml": `${read("hub.yaml")}\nbogus_field: 1\n` }, runBad);
  assert.match(out, /unknown top-level field/);
});

test("unsorted selection roots fail closed", () => {
  const bad = read("sources.yaml").replace(
    "        - skills/engineering/code-review\n        - skills/engineering/tdd",
    "        - skills/engineering/tdd\n        - skills/engineering/code-review",
  );
  assert.notEqual(bad, read("sources.yaml"));
  const out = withSwappedFiles({ "sources.yaml": bad }, runBad);
  assert.match(out, /must be sorted/);
});

test("orphan lock source fails closed", () => {
  const bad = read("sources.lock.yaml").replace("  mattpocock:", "  ghostsource:\n    source_config_digest: sha256:0000000000000000000000000000000000000000000000000000000000000000\n    repository: https://example.com/x\n    requested_ref: main\n    namespace: ghost\n    selection:\n      roots:\n        - a\n    provenance_files: []\n    resolved_commit: 0000000000000000000000000000000000000000\n    selected_skill_tree_digest: sha256:0000000000000000000000000000000000000000000000000000000000000000\n    vendored_snapshot_digest: sha256:0000000000000000000000000000000000000000000000000000000000000000\n    extraction_contract: 1\n  mattpocock:");
  const out = withSwappedFiles({ "sources.lock.yaml": bad }, runBad);
  assert.match(out, /must equal sources\.yaml sources/);
});

test("digest mismatch fails closed", () => {
  const bad = read("sources.lock.yaml").replace(
    "sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547",
    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  );
  const out = withSwappedFiles({ "sources.lock.yaml": bad }, runBad);
  assert.match(out, /source_config_digest mismatch/);
});

test("explicit null fails closed", () => {
  const bad = read("sources.lock.yaml").replace(
    "    requested_ref: main\n    namespace: cursor",
    "    requested_ref: main\n    namespace: null",
  );
  // YAML 1.1 parses unquoted null as null; validator must reject it.
  const out = withSwappedFiles({ "sources.lock.yaml": bad }, runBad);
  assert.match(out, /must not be null|namespace must equal sources\.yaml/);
});

test("unsafe traversal root fails closed", () => {
  const bad = read("sources.yaml").replace(
    "        - pstack/skills/architect",
    "        - ../escape",
  );
  const out = withSwappedFiles({ "sources.yaml": bad }, runBad);
  assert.match(out, /unsafe/);
});

test("AMEND-01: file:// repository validates with recomputed digests", () => {
  const sources = read("sources.yaml").replace(
    "    repository: https://github.com/mattpocock/skills",
    "    repository: file:///mirror/skills",
  );
  const digestOf = (obj) => `sha256:${sha256Hex(canonicalizeJson(obj))}`;
  const norm = {
    namespace: "mattpocock",
    provenance_files: ["LICENSE"],
    repository: "file:///mirror/skills",
    requested_ref: "main",
    selection_roots: ["skills/engineering/code-review", "skills/engineering/tdd", "skills/productivity/grilling"],
    type: "git",
  };
  const lock = read("sources.lock.yaml")
    .replace("    repository: https://github.com/mattpocock/skills", "    repository: file:///mirror/skills")
    .replace(
      "sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547",
      digestOf(norm),
    );
  const out = withSwappedFiles({ "sources.yaml": sources, "sources.lock.yaml": lock }, runGood);
  assert.match(out, /CONTRACT-A-OK/);
});

test("AMEND-01: relative repository path fails closed", () => {
  const bad = read("sources.yaml").replace(
    "    repository: https://github.com/mattpocock/skills",
    "    repository: mirror/skills",
  );
  const out = withSwappedFiles({ "sources.yaml": bad }, runBad);
  assert.match(out, /repository must be https:\/\/, file:\/\/, or an absolute local path/);
});

test("frozen source_config_digest vectors are stable", () => {
  const out = runGood();
  assert.match(out, /CONTRACT-A-OK/);
  const lock = read("sources.lock.yaml");
  assert.match(lock, /sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547/);
  assert.match(lock, /sha256:4854f1cae5082f0319da306e2678a6f525a3dba369a3e44245455d03f0490067/);
});
