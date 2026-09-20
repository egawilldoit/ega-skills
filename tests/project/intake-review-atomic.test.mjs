import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireSource,
  createAdoptionPlan,
  readHubIntakeState,
  readReviewRecords,
  stageAdoptionPlan,
  writeCandidateReview,
} from "../../packages/project/dist/index.js";
import { createImportPlan, emptyRegistryTarget } from "../../packages/registry/dist/index.js";

function skill(name, body) {
  return `---\nname: ${name}\ndescription: ${name} atomic review test skill.\n---\n\n${body}\n`;
}

async function makeTwoSkillCandidate(base) {
  const source = join(base, "source");
  for (const [name, body] of [["alpha", "alpha body"], ["beta", "beta body"]]) {
    const directory = join(source, "skills", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), skill(name, body));
  }
  writeFileSync(join(source, "LICENSE"), "License.\n");
  const acquired = acquireSource({ provenanceFiles: ["LICENSE"], roots: ["skills/alpha", "skills/beta"], source, sourceType: "local" });
  const importPlan = await createImportPlan({ sourcePath: acquired.snapshotDir, namespace: "intake", target: emptyRegistryTarget() });
  const hub = join(base, "hub");
  mkdirSync(hub);
  const candidate = createAdoptionPlan({ hub: readHubIntakeState(hub), importPlan, namespace: "intake", source: acquired, sourceId: "local" });
  await stageAdoptionPlan(candidate, hub);
  rmSync(acquired.workspace, { recursive: true, force: true });
  return { candidate, hub };
}

test("W2: a multi-skill review batch is all-or-none and retry converges after rename", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-review-atomic-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { candidate, hub } = await makeTwoSkillCandidate(base);
  assert.throws(
    () => writeCandidateReview({ candidate, decision: "APPROVED", expectedRevision: 0, faultAfter: "BEFORE_RENAME", hubDir: hub }),
    /before review batch rename/,
  );
  assert.deepEqual(readReviewRecords(hub), []);
  assert.equal(existsSync(join(hub, "intake", "review-batches")), false);

  assert.throws(
    () => writeCandidateReview({ actor: "reviewer", candidate, decision: "APPROVED", expectedRevision: 0, faultAfter: "AFTER_RENAME", hubDir: hub }),
    /after review batch rename/,
  );
  const committed = readReviewRecords(hub);
  assert.deepEqual(committed.map((record) => [record.payload.skill_id, record.payload.revision]), [["intake/alpha", 1], ["intake/beta", 1]]);
  const batchFiles = readdirSync(join(hub, "intake", "review-batches"));
  assert.equal(batchFiles.filter((entry) => /^b-[0-9a-f]{64}\.json$/.test(entry)).length, 1);

  const retry = writeCandidateReview({ actor: "reviewer", candidate, decision: "APPROVED", expectedRevision: 0, hubDir: hub });
  assert.match(retry.request_id, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(retry.records.map((record) => record.payload.revision), [1, 1]);
  assert.equal(readReviewRecords(hub).length, 2);
});

test("W2: mixed revisions and unknown batch artifacts fail closed without partial writes", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ega-review-cas-batch-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { candidate, hub } = await makeTwoSkillCandidate(base);
  writeCandidateReview({ candidate, decision: "APPROVED", expectedRevision: 0, hubDir: hub });
  assert.throws(
    () => writeCandidateReview({ candidate, decision: "REJECTED", expectedRevisions: { "intake/alpha": 1, "intake/beta": 0 }, hubDir: hub }),
    /E_REVIEW_STALE: intake\/beta/,
  );
  assert.throws(
    () => writeCandidateReview({ candidate, decision: "REJECTED", expectedRevisions: { "intake/alpha": 1 }, hubDir: hub }),
    /expected-revisions keys must exactly match/,
  );
  assert.equal(readReviewRecords(hub).length, 2);

  const pending = join(hub, "intake", "review-batches", "b-pending.json.tmp");
  writeFileSync(pending, "not committed");
  assert.equal(readReviewRecords(hub).length, 2);
  const committedPath = readdirSync(join(hub, "intake", "review-batches")).find((entry) => entry.endsWith(".json"));
  writeFileSync(join(hub, "intake", "review-batches", committedPath), "{}");
  assert.throws(() => readReviewRecords(hub), /invalid review batch envelope|not valid JSON/);
});
