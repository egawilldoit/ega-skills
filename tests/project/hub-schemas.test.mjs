import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HubError,
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

test("hub lists exactly the configured sources", () => {
  const hub = parseHubYaml(read("hub.yaml"));
  const cfg = parseSourcesYaml(read("sources.yaml"));
  verifyHubCoverage(hub, cfg);
  assert.equal(codeOf(() => verifyHubCoverage({ ...hub, external: ["mattpocock"] }, cfg)), "E_HUB_SCHEMA");
});

test("explicit null rejected (missing and null differ)", () => {
  assert.equal(codeOf(() => parseHubYaml("schema_version: 1\nhub: null\nowned: []\nexternal: []\n")), "E_HUB_SCHEMA");
});
