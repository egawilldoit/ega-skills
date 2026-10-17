import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { buildRoutingCandidate } from "../../scripts/eval/build-routing-candidate.mjs";
import { evaluateDiscovery } from "../../scripts/eval/discovery.mjs";

const ROOT = process.cwd();
const CORPUS_PATH = join(ROOT, "tests/discovery/personal-intents.json");
const candidate = await buildRoutingCandidate();
const CANDIDATE_ARTIFACT = candidate.artifactDir;
let evaluation;
const evaluate = async () => evaluation ??= evaluateDiscovery(await loadCorpus(), { artifactDir: CANDIDATE_ARTIFACT });

async function loadCorpus() {
  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8"));
  // Declare the rebuilt experiment explicitly; preserve all prompts and gates.
  return { ...corpus, release_digest: candidate.digest };
}

test("combined candidate has zero excluded-skill auto-selections", async () => {
  const report = await evaluate();
  const offenders = report.results
    .filter((row) => !row.pending && row.catastrophic_auto_selected.length > 0)
    .map((row) => row.id);
  assert.deepEqual(
    offenders,
    [],
    `candidate still auto-selects excluded skills: ${offenders.join(", ")}`,
  );
  assert.equal(report.summary.catastrophic_auto_selected_count, 0);
});

test("combined candidate keeps the valid PR-writing control selecting mattpocock/pr", async () => {
  const report = await evaluate();
  const row = report.results.find((r) => r.id === "write-pr-body");
  assert.ok(row, "write-pr-body intent missing from corpus");
  assert.deepEqual(row.selected, ["mattpocock/pr"], "valid PR-writing control regressed");
});

test("combined candidate no longer auto-selects get-pr-comments or design-architecture for the excluded intents", async () => {
  const report = await evaluate();
  const reconcile = report.results.find((r) => r.id === "reconcile-conflicting-truth");
  const react = report.results.find((r) => r.id === "react-performance");
  const release = report.results.find((r) => r.id === "release-certification-console");
  assert.ok(reconcile && !reconcile.selected.includes("egawilldoit/get-pr-comments"));
  assert.ok(react && !react.selected.includes("egawilldoit/design-architecture"));
  assert.equal(react.ranking[0], "vercel/react-best-practices");
  assert.ok(release && !release.selected.includes("mattpocock/pr"));
});

test("combined candidate keeps certify-production-target discoverable", async () => {
  const report = await evaluate();
  const row = report.results.find((r) => r.id === "prove-really-deployed");
  assert.ok(row, "prove-really-deployed intent missing");
  assert.ok(row.ranking.includes("egawilldoit/certify-production-target"), "certify-production-target not in window");
});

test("metadata narrowing preserves genuine comments, architecture and release PR requests", async () => {
  const corpus = await loadCorpus();
  const controls = [
    ["comments-control", "Fetch and summarize the review comments on this pull request", "egawilldoit/get-pr-comments"],
    ["architecture-control", "Design the architecture for a new billing subsystem", "egawilldoit/design-architecture"],
    ["release-pr-control", "Write the PR body for this release fix", "mattpocock/pr"],
  ];
  const report = await evaluateDiscovery({ ...corpus, intents: controls.map(([id, task, expected_primary]) => ({ id, task, expected_primary, acceptable_alternatives: [], must_not_select: [] })) }, { artifactDir: CANDIDATE_ARTIFACT });
  for (const row of report.results) assert.deepEqual(row.selected, [row.expected_primary], row.id);
});
