import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { evaluateCorpus } from "../../scripts/eval/routing.mjs";

test("QL-02: routing corpus captures search hits separately from resolver selections", async () => {
  const fixture = JSON.parse(await readFile(join(process.cwd(), "tests/evaluation/routing-corpus.json"), "utf8"));
  const report = await evaluateCorpus(fixture);
  assert.equal(report.task_count, 30);
  assert.equal(report.failed_count, 0);
  const descriptionOnly = report.results.find((row) => row.id === "description-only");
  assert.deepEqual(descriptionOnly.search_ids, ["ega/attractive-guide"]);
  assert.deepEqual(descriptionOnly.selected_ids, []);
  assert.deepEqual(descriptionOnly.expected_ids, []);
  assert.equal(descriptionOnly.passed, true);
  assert.match(report.release_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(report.metadata_revision, "routing-corpus-v1");
});
