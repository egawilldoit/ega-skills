import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
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
  const directory = mkdtempSync(join(tmpdir(), "ega-contract-a-"));
  cpSync(EXAMPLES, directory, { recursive: true });
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(directory, name), content);
    }
    return fn(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function runGood(examples = EXAMPLES) {
  const out = execFileSync("node", [VALIDATOR], { encoding: "utf8", env: { ...process.env, EGA_CONTRACT_A_EXAMPLES: examples } });
  return out;
}

function runBad(examples = EXAMPLES) {
  try {
    execFileSync("node", [VALIDATOR], {
      encoding: "utf8",
      env: { ...process.env, EGA_CONTRACT_A_EXAMPLES: examples },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

test("unknown top-level field in hub.yaml fails closed [E_HUB_SCHEMA]", () => {
  const out = withSwappedFiles({ "hub.yaml": `${read("hub.yaml")}\nbogus_field: 1\n` }, runBad);
  assert.match(out, /\[E_HUB_SCHEMA\]: hub\.yaml has unknown top-level field/);
  assert.doesNotMatch(out, /ReferenceError/);
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

test("digest mismatch fails closed [E_LOCK_DIGEST]", () => {
  const bad = read("sources.lock.yaml").replace(
    "sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547",
    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  );
  const out = withSwappedFiles({ "sources.lock.yaml": bad }, runBad);
  assert.match(out, /\[E_LOCK_DIGEST\]/);
  assert.match(out, /source_config_digest mismatch/);
});

test("explicit null fails closed", () => {
  const bad = read("sources.lock.yaml").replace(
    "    requested_ref: main\n    namespace: cursor",
    "    requested_ref: main\n    namespace: null",
  );
  // YAML 1.1 parses unquoted null as null; validator must reject it with the
  // explicit-null rule (not merely the equality rule).
  const out = withSwappedFiles({ "sources.lock.yaml": bad }, runBad);
  assert.match(out, /\[E_LOCK_MISMATCH\]/);
  assert.match(out, /namespace must not be null/);
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

test("AMEND-01: relative repository path fails closed [E_SOURCE_SCHEMA]", () => {
  const bad = read("sources.yaml").replace(
    "    repository: https://github.com/mattpocock/skills",
    "    repository: mirror/skills",
  );
  const out = withSwappedFiles({ "sources.yaml": bad }, runBad);
  assert.match(out, /\[E_SOURCE_SCHEMA\]/);
  assert.match(out, /no credentials/);
});

test("frozen source_config_digest vectors are stable", () => {
  const out = runGood();
  assert.match(out, /CONTRACT-A-OK/);
  const lock = read("sources.lock.yaml");
  assert.match(lock, /sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547/);
  assert.match(lock, /sha256:4854f1cae5082f0319da306e2678a6f525a3dba369a3e44245455d03f0490067/);
});

test("freeze review: credential-bearing repository URL fails closed [E_SOURCE_SCHEMA]", () => {
  const bad = read("sources.yaml").replace(
    "    repository: https://github.com/mattpocock/skills",
    "    repository: https://user:s3cret@github.com/mattpocock/skills",
  );
  const out = withSwappedFiles({ "sources.yaml": bad }, runBad);
  assert.match(out, /\[E_SOURCE_SCHEMA\]/);
  assert.match(out, /no credentials/);
});

test("freeze review: bare https:// with no host fails closed [E_SOURCE_SCHEMA]", () => {
  const bad = read("sources.yaml").replace(
    "    repository: https://github.com/mattpocock/skills",
    "    repository: https://",
  );
  const out = withSwappedFiles({ "sources.yaml": bad }, runBad);
  assert.match(out, /\[E_SOURCE_SCHEMA\]/);
  assert.match(out, /repository must be/);
});

test("freeze review: null provenance_files fails closed [E_SOURCE_SCHEMA]", () => {
  const bad = read("sources.yaml").replace(
    "    provenance_files:\n      - LICENSE",
    "    provenance_files: null",
  );
  assert.notEqual(bad, read("sources.yaml"));
  const out = withSwappedFiles({ "sources.yaml": bad }, runBad);
  assert.match(out, /\[E_SOURCE_SCHEMA\]/);
  assert.match(out, /provenance_files must be a non-empty list/);
});

test("freeze review: empty provenance_files fails closed [E_SOURCE_SCHEMA]", () => {
  const bad = read("sources.yaml").replace(
    "    provenance_files:\n      - LICENSE",
    "    provenance_files: []",
  );
  assert.notEqual(bad, read("sources.yaml"));
  const out = withSwappedFiles({ "sources.yaml": bad }, runBad);
  assert.match(out, /\[E_SOURCE_SCHEMA\]/);
  assert.match(out, /provenance_files must be a non-empty list/);
});

test("freeze review: drive-rooted selection root fails closed [E_SOURCE_SELECTION]", () => {
  const bad = read("sources.yaml").replace(
    "        - skills/engineering/code-review",
    "        - C:/escape",
  );
  const out = withSwappedFiles({ "sources.yaml": bad }, runBad);
  assert.match(out, /\[E_SOURCE_SELECTION\]/);
  assert.match(out, /root unsafe/);
});

test("freeze review: drive-rooted owned.path fails closed [E_HUB_SCHEMA]", () => {
  const bad = read("hub.yaml").replace("  - path: owned/ega", "  - path: C:/owned/ega");
  const out = withSwappedFiles({ "hub.yaml": bad }, runBad);
  assert.match(out, /\[E_HUB_SCHEMA\]/);
  assert.match(out, /owned\.path unsafe/);
});

test("freeze review: local-form source_config_digest vectors are stable", () => {
  const digestOf = (obj) => `sha256:${sha256Hex(canonicalizeJson(obj))}`;
  const roots = [
    "skills/engineering/code-review",
    "skills/engineering/tdd",
    "skills/productivity/grilling",
  ];
  // Frozen goldens: repository hashed verbatim (§4.1 raw-string rule).
  assert.equal(
    digestOf({
      namespace: "mattpocock",
      provenance_files: ["LICENSE"],
      repository: "file:///mirror/skills",
      requested_ref: "main",
      selection_roots: roots,
      type: "git",
    }),
    "sha256:e50a08f47b5f7093e65c9eece3a3a4fab52bd3173a6606d220bad3067ff7b59c",
  );
  assert.equal(
    digestOf({
      namespace: "mattpocock",
      provenance_files: ["LICENSE"],
      repository: "/mirror/skills",
      requested_ref: "main",
      selection_roots: roots,
      type: "git",
    }),
    "sha256:2d737a29f5ce6fd50c6226d1558e319b90aefc306728553f82354730a7b611d0",
  );
});
