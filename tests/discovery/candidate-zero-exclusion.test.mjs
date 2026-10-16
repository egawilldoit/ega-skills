import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { evaluateDiscovery } from "../../scripts/eval/discovery.mjs";

const ROOT = process.cwd();
const CORPUS_PATH = join(ROOT, "tests/discovery/personal-intents.json");
const CANDIDATE_ARTIFACT = join(ROOT, "packages/mcp/candidate-artifact");
const ENV = { ...process.env, EGA_SKILLS_HOME: CANDIDATE_ARTIFACT };

async function loadCorpus() {
  return JSON.parse(await readFile(CORPUS_PATH, "utf8"));
}

test("combined candidate has zero excluded-skill auto-selections", async () => {
  const corpus = await loadCorpus();
  const report = await evaluateDiscovery(corpus, { artifactDir: CANDIDATE_ARTIFACT });
  const offenders = report.results
    .filter((row) => !row.pending && row.catastrophic_auto_selected.length > 0)
    .map((row) => row.id);
  assert.deepEqual(
    offenders,
    [],
    `candidate still auto-selects excluded skills: ${offenders.join(", ")}`,
  );
  assert.equal(report.summary.catastrophic_auto_selected_count, 0);
  // Strict gate: the candidate must not merely match a loosened baseline.
  assert.ok(report.summary.catastrophic_auto_selected_count === 0);
});

test("combined candidate keeps the valid PR-writing control selecting mattpocock/pr", async () => {
  const corpus = await loadCorpus();
  const report = await evaluateDiscovery(corpus, { artifactDir: CANDIDATE_ARTIFACT });
  const row = report.results.find((r) => r.id === "write-pr-body");
  assert.ok(row, "write-pr-body intent missing from corpus");
  assert.deepEqual(row.selected, ["mattpocock/pr"], "valid PR-writing control regressed");
});

test("combined candidate no longer auto-selects get-pr-comments or design-architecture for the excluded intents", async () => {
  const corpus = await loadCorpus();
  const report = await evaluateDiscovery(corpus, { artifactDir: CANDIDATE_ARTIFACT });
  const reconcile = report.results.find((r) => r.id === "reconcile-conflicting-truth");
  const react = report.results.find((r) => r.id === "react-performance");
  const release = report.results.find((r) => r.id === "release-certification-console");
  assert.ok(reconcile && !reconcile.selected.includes("egawilldoit/get-pr-comments"));
  assert.ok(react && !react.selected.includes("egawilldoit/design-architecture"));
  assert.ok(release && !release.selected.includes("mattpocock/pr"));
});

test("combined candidate keeps certify-production-target discoverable", async () => {
  const corpus = await loadCorpus();
  const report = await evaluateDiscovery(corpus, { artifactDir: CANDIDATE_ARTIFACT });
  const row = report.results.find((r) => r.id === "prove-really-deployed");
  assert.ok(row, "prove-really-deployed intent missing");
  assert.ok(row.ranking.includes("egawilldoit/certify-production-target"), "certify-production-target not in window");
});