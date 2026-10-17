import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HubError,
  digestStagedTree,
  readJournal,
  recoverIfNeeded,
  writeJournal,
} from "../../packages/project/dist/index.js";

const OLD_COMMIT = "a".repeat(40);
const NEW_COMMIT = "b".repeat(40);
const CONFIG_DIGEST = `sha256:${"c".repeat(64)}`;
const OTHER_COMMIT = "d".repeat(40);

const OLD_BODY = "# alpha\n\nOld adopted body.\n";
const NEW_BODY = "# alpha\n\nIncoming staged body.\n";
const OTHER_BODY = "# alpha\n\nCorrupt backup body.\n";

function writeTree(dir, body, marker = "adopted") {
  mkdirSync(join(dir, "skills", "alpha"), { recursive: true });
  writeFileSync(join(dir, "skills", "alpha", "SKILL.md"), body);
  writeFileSync(join(dir, "LICENSE"), `${marker} license\n`);
}

function treeDigests(dir) {
  return digestStagedTree(dir, ["skills"]);
}

function lockText(commit, tree, snapshot) {
  return `schema_version: 1
sources:
  plan:
    source_config_digest: ${JSON.stringify(CONFIG_DIGEST)}
    repository: ${JSON.stringify("/fixture/repo")}
    requested_ref: ${JSON.stringify("main")}
    namespace: ${JSON.stringify("plan")}
    selection:
      roots:
        - skills
    provenance_files:
      - LICENSE
    extraction_contract: 1
    resolved_commit: ${commit}
    selected_skill_tree_digest: ${tree}
    vendored_snapshot_digest: ${snapshot}
`;
}

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-recovery-"));
  const liveTree = join(hubDir, "external", "plan", "repo");
  writeTree(liveTree, OLD_BODY);
  const oldDigests = treeDigests(liveTree);
  const oldLock = lockText(OLD_COMMIT, oldDigests.treeDigest, oldDigests.snapshotDigest);
  writeFileSync(join(hubDir, "sources.lock.yaml"), oldLock);
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: recovery-test\nowned: []\nexternal:\n  - source: plan\n");
  return { hubDir, liveTree, oldLock };
}

function writeJournalFor(hubDir, state) {
  writeJournal(hubDir, {
    backup: ".backup",
    expected_old_commit: OLD_COMMIT,
    journal_version: 1,
    source_id: "plan",
    staging: ".staging",
    state,
    target_commit: NEW_COMMIT,
  });
}

function liveBody(hubDir) {
  return readFileSync(join(hubDir, "external", "plan", "repo", "skills", "alpha", "SKILL.md"), "utf8");
}

function assertClean(hubDir) {
  assert.equal(existsSync(join(hubDir, ".hub-journal.json")), false, "journal must be cleared");
  assert.equal(existsSync(join(hubDir, ".backup")), false, "backup must be removed");
  assert.equal(existsSync(join(hubDir, ".staging")), false, "staging must be removed");
  assert.equal(readJournal(hubDir), null);
}

function assertRecoveryError(fn) {
  assert.throws(fn, (error) => error instanceof HubError && error.code === "E_RECOVERY_REQUIRED");
}

test("retry after a restored tree never deletes the restored adopted content", () => {
  const { hubDir, liveTree } = makeHub();
  const backup = join(hubDir, ".backup");
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "sources.lock.yaml"), readFileSync(join(hubDir, "sources.lock.yaml")));
  writeJournalFor(hubDir, "TREE_SWAPPED");

  const first = recoverIfNeeded(hubDir);
  assert.deepEqual(first, { recovered: true });
  assert.equal(liveBody(hubDir), OLD_BODY, "restored tree must survive its own cleanup");

  const second = recoverIfNeeded(hubDir);
  assert.deepEqual(second, { recovered: false });
  assert.equal(existsSync(liveTree), true);
  assert.equal(liveBody(hubDir), OLD_BODY);
  assertClean(hubDir);
});

test("normal TREE_SWAPPED recovery restores old content and is repeatable", () => {
  const { hubDir, liveTree } = makeHub();
  const backupTree = join(hubDir, ".backup", "plan");
  mkdirSync(backupTree, { recursive: true });
  writeTree(backupTree, OLD_BODY);
  writeFileSync(join(hubDir, ".backup", "sources.lock.yaml"), readFileSync(join(hubDir, "sources.lock.yaml"), "utf8"));
  writeTree(liveTree, NEW_BODY, "incoming");
  writeJournalFor(hubDir, "TREE_SWAPPED");

  assert.deepEqual(recoverIfNeeded(hubDir), { recovered: true });
  assert.equal(liveBody(hubDir), OLD_BODY);
  assertClean(hubDir);
  assert.deepEqual(recoverIfNeeded(hubDir), { recovered: false });
  assert.equal(liveBody(hubDir), OLD_BODY);
});

const crashWindows = [
  ["PREPARED with staging only", "PREPARED", (hubDir) => {
    writeTree(join(hubDir, ".staging", "plan"), NEW_BODY, "staged");
  }],
  ["PREPARED with an empty backup directory", "PREPARED", (hubDir) => {
    mkdirSync(join(hubDir, ".backup"), { recursive: true });
    writeTree(join(hubDir, ".staging", "plan"), NEW_BODY, "staged");
  }],
  ["old tree renamed, backup lock not yet written", "TREE_SWAPPED", (hubDir) => {
    const backupTree = join(hubDir, ".backup", "plan");
    rmSync(join(hubDir, "external", "plan", "repo"), { recursive: true, force: true });
    mkdirSync(backupTree, { recursive: true });
    writeTree(backupTree, OLD_BODY);
  }],
  ["incoming tree installed before TREE_SWAPPED", "TREE_SWAPPED", (hubDir) => {
    const backupTree = join(hubDir, ".backup", "plan");
    mkdirSync(backupTree, { recursive: true });
    writeTree(backupTree, OLD_BODY);
    writeFileSync(join(hubDir, ".backup", "sources.lock.yaml"), readFileSync(join(hubDir, "sources.lock.yaml"), "utf8"));
    writeTree(join(hubDir, "external", "plan", "repo"), NEW_BODY, "incoming");
  }],
  ["new lock installed before LOCK_SWAPPED", "TREE_SWAPPED", (hubDir) => {
    const backupTree = join(hubDir, ".backup", "plan");
    mkdirSync(backupTree, { recursive: true });
    writeTree(backupTree, OLD_BODY);
    writeFileSync(join(hubDir, ".backup", "sources.lock.yaml"), readFileSync(join(hubDir, "sources.lock.yaml"), "utf8"));
    writeTree(join(hubDir, "external", "plan", "repo"), NEW_BODY, "incoming");
    const incoming = treeDigests(join(hubDir, "external", "plan", "repo"));
    writeFileSync(join(hubDir, "sources.lock.yaml"), lockText(NEW_COMMIT, incoming.treeDigest, incoming.snapshotDigest));
  }],
  ["backup removed before the journal is cleared", "TREE_SWAPPED", () => {
    // the live state is already the old state; only the journal remains
  }],
];

for (const [name, state, arrange] of crashWindows) {
  test(`crash window converges: ${name}`, () => {
    const { hubDir } = makeHub();
    arrange(hubDir);
    writeJournalFor(hubDir, state);
    assert.deepEqual(recoverIfNeeded(hubDir), { recovered: true });
    assert.equal(liveBody(hubDir), OLD_BODY);
    assertClean(hubDir);
    assert.deepEqual(recoverIfNeeded(hubDir), { recovered: false });
    assert.equal(liveBody(hubDir), OLD_BODY);
  });
}

test("missing adopted content is never reported as recovered", () => {
  const { hubDir } = makeHub();
  rmSync(join(hubDir, "external", "plan", "repo"), { recursive: true, force: true });
  const backup = join(hubDir, ".backup");
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "sources.lock.yaml"), readFileSync(join(hubDir, "sources.lock.yaml")));
  writeJournalFor(hubDir, "TREE_SWAPPED");

  assertRecoveryError(() => recoverIfNeeded(hubDir));
  assert.equal(readJournal(hubDir) !== null, true, "journal must remain for retry");
  assert.equal(existsSync(join(backup, "sources.lock.yaml")), true, "recovery material must remain");
});

test("provenance-only backup corruption is rejected because the snapshot digest is verified", () => {
  const { hubDir, liveTree, oldLock } = makeHub();
  const lockTreeDigest = oldLock.match(/selected_skill_tree_digest: (sha256:[0-9a-f]{64})/)?.[1];
  const lockSnapshotDigest = oldLock.match(/vendored_snapshot_digest: (sha256:[0-9a-f]{64})/)?.[1];
  assert.ok(lockTreeDigest && lockSnapshotDigest);

  const backupTree = join(hubDir, ".backup", "plan");
  mkdirSync(backupTree, { recursive: true });
  writeTree(backupTree, OLD_BODY, "backup");
  writeFileSync(join(backupTree, "LICENSE"), "TAMPERED provenance license\n");
  writeFileSync(join(hubDir, ".backup", "sources.lock.yaml"), oldLock);
  writeTree(liveTree, NEW_BODY, "incoming");
  writeJournalFor(hubDir, "TREE_SWAPPED");

  const backupState = digestStagedTree(backupTree, ["skills"]);
  assert.equal(backupState.treeDigest, lockTreeDigest, "the selected tree digest must be unchanged by the provenance edit");
  assert.notEqual(backupState.snapshotDigest, lockSnapshotDigest, "the snapshot digest must differ — this is provenance-only corruption");

  assertRecoveryError(() => recoverIfNeeded(hubDir));
  assert.equal(liveBody(hubDir), NEW_BODY, "live content must be untouched");
  assert.equal(existsSync(backupTree), true, "backup material must remain");
  assert.equal(readJournal(hubDir) !== null, true, "journal must remain for retry");
});

test("a corrupt backup tree is never installed over live content", () => {
  const { hubDir, liveTree } = makeHub();
  const backupTree = join(hubDir, ".backup", "plan");
  mkdirSync(backupTree, { recursive: true });
  writeTree(backupTree, OTHER_BODY, "corrupt");
  writeFileSync(join(hubDir, ".backup", "sources.lock.yaml"), readFileSync(join(hubDir, "sources.lock.yaml"), "utf8"));
  writeTree(liveTree, NEW_BODY, "incoming");
  writeJournalFor(hubDir, "TREE_SWAPPED");

  assertRecoveryError(() => recoverIfNeeded(hubDir));
  assert.equal(liveBody(hubDir), NEW_BODY, "live content must be untouched");
  assert.equal(existsSync(backupTree), true, "backup material must remain");
  assert.equal(readJournal(hubDir) !== null, true);
});

test("a backup lock that does not bind the expected old commit fails closed", () => {
  const { hubDir, liveTree } = makeHub();
  const backupTree = join(hubDir, ".backup", "plan");
  mkdirSync(backupTree, { recursive: true });
  writeTree(backupTree, OLD_BODY, "backup");
  const digests = treeDigests(backupTree);
  writeFileSync(join(hubDir, ".backup", "sources.lock.yaml"), lockText(OTHER_COMMIT, digests.treeDigest, digests.snapshotDigest));
  writeTree(liveTree, NEW_BODY, "incoming");
  writeJournalFor(hubDir, "TREE_SWAPPED");

  assertRecoveryError(() => recoverIfNeeded(hubDir));
  assert.equal(liveBody(hubDir), NEW_BODY);
  assert.equal(existsSync(backupTree), true);
  assert.equal(readJournal(hubDir) !== null, true);
});
