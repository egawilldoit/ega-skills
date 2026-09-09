import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HubError,
  isValidRepository,
  parseHubYaml,
  parseSourcesLockYaml,
  parseSourcesYaml,
  sourceConfigDigest,
  verifyHubCoverage,
  verifySourcesLock,
} from "../../packages/project/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// ISOLATION RULE: contract example dirs are mutated by their own validator
// tests under concurrent node --test execution, so Hub tests vendor private
// fixture copies here and must never read scripts/contracts/examples.
const EXAMPLES = join(HERE, "hub-fixtures");
const read = (p) => readFileSync(join(EXAMPLES, p), "utf8");

function codeOf(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HubError, `expected HubError, got ${e}`);
    return e.code;
  }
  throw new Error("expected HubError, validation passed");
}

test("parses the frozen Contract A examples and verifies the lock", () => {
  const hub = parseHubYaml(read("hub.yaml"));
  assert.equal(hub.hubId, "personal");
  assert.deepEqual(hub.external, ["mattpocock", "cursor-pstack"]);
  const cfg = parseSourcesYaml(read("sources.yaml"));
  const lock = parseSourcesLockYaml(read("sources.lock.yaml"));
  verifySourcesLock(cfg, lock);
});

test("sourceConfigDigest reproduces the frozen vectors", () => {
  const cfg = parseSourcesYaml(read("sources.yaml"));
  assert.equal(
    sourceConfigDigest(cfg.sources["mattpocock"]),
    "sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547",
  );
  assert.equal(
    sourceConfigDigest(cfg.sources["cursor-pstack"]),
    "sha256:4854f1cae5082f0319da306e2678a6f525a3dba369a3e44245455d03f0490067",
  );
});

test("unsorted selection roots rejected (E_SOURCE_SELECTION)", () => {
  const bad = read("sources.yaml").replace(
    "        - skills/engineering/code-review\n        - skills/engineering/tdd",
    "        - skills/engineering/tdd\n        - skills/engineering/code-review",
  );
  assert.equal(codeOf(() => parseSourcesYaml(bad)), "E_SOURCE_SELECTION");
});

test("traversal root rejected (E_SOURCE_SELECTION)", () => {
  const bad = read("sources.yaml").replace("        - pstack/skills/architect", "        - ../escape");
  assert.equal(codeOf(() => parseSourcesYaml(bad)), "E_SOURCE_SELECTION");
});

test("unknown source field rejected (E_SOURCE_SCHEMA)", () => {
  const bad = read("sources.yaml").replace("    type: git", "    type: git\n    bogus: 1");
  assert.equal(codeOf(() => parseSourcesYaml(bad)), "E_SOURCE_SCHEMA");
});

test("source mapping keys are path-safe", () => {
  const badSources = read("sources.yaml").replace("  mattpocock:", "  ../escape:");
  assert.equal(codeOf(() => parseSourcesYaml(badSources)), "E_SOURCE_SCHEMA");
  const badLock = read("sources.lock.yaml").replace("  mattpocock:", "  ../escape:");
  assert.equal(codeOf(() => parseSourcesLockYaml(badLock)), "E_LOCK_MISMATCH");
});

test("unknown hub field rejected (E_HUB_SCHEMA)", () => {
  assert.equal(codeOf(() => parseHubYaml(`${read("hub.yaml")}\nbogus: 1\n`)), "E_HUB_SCHEMA");
});

test("orphan lock source rejected (E_LOCK_MISMATCH)", () => {
  const cfg = parseSourcesYaml(read("sources.yaml"));
  const lock = parseSourcesLockYaml(read("sources.lock.yaml"));
  lock.sources["ghost"] = { ...lock.sources["mattpocock"] };
  assert.equal(codeOf(() => verifySourcesLock(cfg, lock)), "E_LOCK_MISMATCH");
});

test("digest mismatch rejected (E_LOCK_DIGEST)", () => {
  const cfg = parseSourcesYaml(read("sources.yaml"));
  const lock = parseSourcesLockYaml(read("sources.lock.yaml"));
  lock.sources["mattpocock"].source_config_digest =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  assert.equal(codeOf(() => verifySourcesLock(cfg, lock)), "E_LOCK_DIGEST");
});

test("lock record missing scalar fields fails fast with validator codes", () => {
  const noDigest = read("sources.lock.yaml").replace(
    "    source_config_digest: sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547\n",
    "",
  );
  assert.notEqual(noDigest, read("sources.lock.yaml"));
  assert.equal(codeOf(() => parseSourcesLockYaml(noDigest)), "E_LOCK_DIGEST");
  const noCommit = read("sources.lock.yaml").replace("    resolved_commit: 0123456789abcdef0123456789abcdef01234567\n", "");
  assert.equal(codeOf(() => parseSourcesLockYaml(noCommit)), "E_LOCK_COMMIT");
  const noTree = read("sources.lock.yaml").replace(
    "    selected_skill_tree_digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    "",
  );
  assert.equal(codeOf(() => parseSourcesLockYaml(noTree)), "E_TREE_DIGEST");
  const noRepo = read("sources.lock.yaml").replace("    repository: https://github.com/cursor/plugins\n", "");
  assert.equal(codeOf(() => parseSourcesLockYaml(noRepo)), "E_LOCK_MISMATCH");
});

test("lock record malformed formats fail fast at parse with validator codes", () => {
  const badDigest = read("sources.lock.yaml").replace(
    "sha256:d8ed1c9a3d40681bbecf96def27ea3504adedc6a0dd6e5732a1348daf734f547",
    "sha256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  );
  assert.equal(codeOf(() => parseSourcesLockYaml(badDigest)), "E_LOCK_DIGEST");
  const badCommit = read("sources.lock.yaml").replace("resolved_commit: 0123456789abcdef0123456789abcdef01234567", "resolved_commit: NOTACOMMIT");
  assert.equal(codeOf(() => parseSourcesLockYaml(badCommit)), "E_LOCK_COMMIT");
  const badContract = read("sources.lock.yaml").replace("    extraction_contract: 1", "    extraction_contract: 2");
  assert.equal(codeOf(() => parseSourcesLockYaml(badContract)), "E_LOCK_MISMATCH");
});

test("hub lists exactly the configured sources", () => {
  const hub = parseHubYaml(read("hub.yaml"));
  const cfg = parseSourcesYaml(read("sources.yaml"));
  verifyHubCoverage(hub, cfg);
  assert.equal(codeOf(() => verifyHubCoverage({ ...hub, external: ["mattpocock"] }, cfg)), "E_HUB_SCHEMA");
});

test("explicit null rejected (missing and null differ)", () => {
  assert.equal(codeOf(() => parseHubYaml("schema_version: 1\nhub: null\nowned: []\nexternal: []\n")), "E_HUB_SCHEMA");
});

test("nested Hub and source schemas reject unknown fields and unsafe source ids", () => {
  assert.equal(codeOf(() => parseHubYaml(read("hub.yaml").replace("hub:\n  id: personal", "hub:\n  id: personal\n  extra: true"))), "E_HUB_SCHEMA");
  assert.equal(codeOf(() => parseHubYaml(read("hub.yaml").replace("  - path: owned/ega\n    namespace: ega", "  - path: owned/ega\n    namespace: ega\n    extra: true"))), "E_HUB_SCHEMA");
  assert.equal(codeOf(() => parseHubYaml(read("hub.yaml").replace("  - source: mattpocock", "  - source: ../escape"))), "E_HUB_SCHEMA");
  assert.equal(codeOf(() => parseSourcesYaml(read("sources.yaml").replace("    selection:\n", "    selection:\n      extra: true\n"))), "E_SOURCE_SELECTION");
});

test("nested lock selection and provenance are strict canonical sets", () => {
  const lockText = read("sources.lock.yaml");
  assert.equal(codeOf(() => parseSourcesLockYaml(lockText.replace("    selection:\n", "    selection:\n      extra: true\n"))), "E_LOCK_MISMATCH");
  assert.equal(codeOf(() => parseSourcesLockYaml(lockText.replace("    provenance_files:\n", "    provenance_files:\n      - ../escape\n"))), "E_LOCK_MISMATCH");
});

test("lock scalar and collection constraints match sources.yaml", () => {
  const lockText = read("sources.lock.yaml");
  assert.equal(codeOf(() => parseSourcesLockYaml(lockText.replace("    repository: https://github.com/mattpocock/skills", "    repository: mirror/skills"))), "E_LOCK_MISMATCH");
  assert.equal(codeOf(() => parseSourcesLockYaml(lockText.replace("    namespace: mattpocock", "    namespace: bad namespace"))), "E_LOCK_MISMATCH");
  assert.equal(codeOf(() => parseSourcesLockYaml(lockText.replace("    requested_ref: main", "    requested_ref: \"\""))), "E_LOCK_MISMATCH");
  assert.equal(codeOf(() => parseSourcesLockYaml(lockText.replace("      roots:\n        - skills/engineering/code-review\n        - skills/engineering/tdd\n        - skills/productivity/grilling", "      roots: []"))), "E_LOCK_MISMATCH");
  assert.equal(codeOf(() => parseSourcesLockYaml(lockText.replace("    provenance_files:\n      - LICENSE", "    provenance_files: []"))), "E_LOCK_MISMATCH");
});

// Final Contract A reconciliation: runtime accepts exactly what the
// executable validator accepts — no divergence in either direction.
test("credential-bearing repository rejected (E_SOURCE_SCHEMA)", () => {
  const bad = read("sources.yaml").replace(
    "    repository: https://github.com/mattpocock/skills",
    "    repository: https://user:s3cret@github.com/mattpocock/skills",
  );
  assert.equal(codeOf(() => parseSourcesYaml(bad)), "E_SOURCE_SCHEMA");
  assert.equal(isValidRepository("https://user:s3cret@github.com/mattpocock/skills"), false);
});

test("bare https:// with no host rejected (E_SOURCE_SCHEMA)", () => {
  const bad = read("sources.yaml").replace(
    "    repository: https://github.com/mattpocock/skills",
    "    repository: https://",
  );
  assert.equal(codeOf(() => parseSourcesYaml(bad)), "E_SOURCE_SCHEMA");
  assert.equal(isValidRepository("https://"), false);
});

test("file:// and absolute local paths accepted, relative rejected", () => {
  assert.equal(isValidRepository("file:///mirror/skills"), true);
  assert.equal(isValidRepository("/mirror/skills"), true);
  assert.equal(isValidRepository("C:/mirror/skills"), true);
  assert.equal(isValidRepository("//server/share/skills"), true);
  assert.equal(isValidRepository("mirror/skills"), false);
  const fileYaml = read("sources.yaml").replace(
    "    repository: https://github.com/mattpocock/skills",
    "    repository: file:///mirror/skills",
  );
  const cfg = parseSourcesYaml(fileYaml);
  assert.equal(cfg.sources["mattpocock"].repository, "file:///mirror/skills");
});

test("drive-rooted selection root rejected (E_SOURCE_SELECTION)", () => {
  const bad = read("sources.yaml").replace("        - skills/engineering/code-review", "        - C:/escape");
  assert.equal(codeOf(() => parseSourcesYaml(bad)), "E_SOURCE_SELECTION");
});

test("provenance missing/null/empty rejected (E_SOURCE_SCHEMA)", () => {
  const missing = read("sources.yaml").replace("    provenance_files:\n      - LICENSE\n", "");
  assert.equal(codeOf(() => parseSourcesYaml(missing)), "E_SOURCE_SCHEMA");
  const nulled = read("sources.yaml").replace("    provenance_files:\n      - LICENSE\n", "    provenance_files: null\n");
  assert.equal(codeOf(() => parseSourcesYaml(nulled)), "E_SOURCE_SCHEMA");
  const emptied = read("sources.yaml").replace("    provenance_files:\n      - LICENSE\n", "    provenance_files: []\n");
  assert.equal(codeOf(() => parseSourcesYaml(emptied)), "E_SOURCE_SCHEMA");
});
