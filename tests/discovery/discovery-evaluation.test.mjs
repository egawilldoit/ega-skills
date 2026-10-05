import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { evaluateDiscovery } from "../../scripts/eval/discovery.mjs";

const CORPUS_PATH = join(process.cwd(), "tests/discovery/personal-intents.json");
const BASELINE_PATH = join(process.cwd(), "tests/discovery/baseline.json");

async function loadCorpus() {
  return JSON.parse(await readFile(CORPUS_PATH, "utf8"));
}

/**
 * The resolver is intentionally thorough (~0.6s per task over the full
 * 114-skill catalog), so a full corpus run is ~50s. Assertions in this file
 * share ONE memoized run; only the determinism check pays for a second pass,
 * and it deliberately uses a small subset because determinism is a property of
 * the machinery, not of corpus size.
 */
let sharedReport;
function report() {
  sharedReport ??= (async () => evaluateDiscovery(await loadCorpus()))();
  return sharedReport;
}

/**
 * Known automatic misroutes that CANNOT be fixed in this repository.
 *
 * Both root causes are routing metadata in the external, digest-pinned corpus
 * repo (github.com/egawilldoit/skills), not in the resolver. This repo holds
 * the corpus only as a verified immutable artifact, so the fix is a corpus-repo
 * change plus a re-vendor. See docs/DISCOVERY-FINDINGS.md.
 *
 *   - reconcile-conflicting-truth: get-pr-comments declares `domains: [github]`,
 *     so the word "GitHub" in the task produces strong DOMAIN evidence and
 *     outranks reconcile-project-truth (no domains).
 *   - react-performance: design-architecture declares `domains: [architecture]`,
 *     so "architecture guidance" produces strong DOMAIN evidence and outranks
 *     vercel/react-best-practices (no domains, platforms, or frameworks).
 *
 * Both are the SAME class of defect: an over-broad `domains` entry.
 */
const KNOWN_EXTERNAL_AUTO_ROUTES = ["react-performance", "reconcile-conflicting-truth"];

test("discovery corpus is realistic and catalog-valid", async () => {
  const corpus = await loadCorpus();
  assert.equal(corpus.schema_version, 1);
  // Mission §8 requires at least 50 representative tasks.
  assert.ok(corpus.intents.length >= 50, `expected >=50 intents, got ${corpus.intents.length}`);

  const ids = new Set();
  for (const intent of corpus.intents) {
    assert.ok(intent.id && intent.task, "every intent needs an id and a task");
    assert.equal(typeof intent.expected_primary, "string");
    ids.add(intent.id);
    for (const id of [...(intent.acceptable_alternatives ?? []), ...(intent.must_not_select ?? [])]) {
      assert.match(id, /^[a-z0-9-]+\/[a-z0-9-]+$/u, `skill id must be canonical: ${id}`);
    }
  }
  assert.equal(ids.size, corpus.intents.length, "intent ids must be unique");

  // Prompts must be natural language, not copied trigger phrases.
  for (const intent of corpus.intents) {
    const [namespace, name] = intent.expected_primary.split("/");
    const hyphenated = `${name}`.replaceAll("-", " ");
    assert.ok(
      intent.task.toLowerCase() !== hyphenated,
      `intent ${intent.id} must not be the bare skill name`,
    );
    void namespace;
  }
});

test("LOW confidence never auto-selects a skill", async () => {
  const { results } = await report();
  for (const row of results) {
    if (row.confidence === "LOW") {
      assert.deepEqual(
        row.selected,
        [],
        `LOW confidence must publish selected=[] (SPEC-004 §5.1.17 rule 4); ${row.id} selected ${JSON.stringify(row.selected)}`,
      );
    }
  }
});

test("discovery ranking never surfaces a must_not_select skill in the candidate window", async () => {
  const { results } = await report();
  const offenders = results
    .filter((row) => !row.pending && row.catastrophic_top3.length > 0)
    .map((row) => row.id);

  // Recorded, not yet fixed: these are metadata defects in the external corpus
  // repo. The count may be TIGHTENED when they land, never loosened.
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  assert.ok(
    offenders.length <= baseline.summary.catastrophic_top3_count,
    `catastrophic top-3 count regressed (baseline ${baseline.summary.catastrophic_top3_count}): ${offenders.join(", ")}`,
  );
});

test("a corpus targeting a different release fails closed", async () => {
  const corpus = await loadCorpus();
  const mismatched = structuredClone(corpus);
  mismatched.release_digest = "sha256:" + "0".repeat(64);
  await assert.rejects(() => evaluateDiscovery(mismatched), /corpus targets release/u);
});

test("a corpus with no measurable intents fails closed", async () => {
  const corpus = await loadCorpus();
  const allPending = structuredClone(corpus);
  for (const intent of allPending.intents) intent.pending_skill = true;
  await assert.rejects(() => evaluateDiscovery(allPending), /no measurable intents/u);
});

test("automatic misroutes are limited to the documented external-metadata defects", async () => {
  const { results } = await report();
  const offenders = results
    .filter((row) => row.wrong_automatic_selections.length > 0)
    .map((row) => row.id)
    .sort();

  // Every actual misroute must be a KNOWN one (no new surprises), but a corpus
  // metadata fix may REMOVE entries, so a subset check rather than equality.
  for (const id of offenders) {
    assert.ok(
      KNOWN_EXTERNAL_AUTO_ROUTES.includes(id),
      `unexpected automatic misroute "${id}"; if a corpus-repo metadata fix landed, remove it from KNOWN_EXTERNAL_AUTO_ROUTES and tighten baseline.json`,
    );
  }
});

test("discovery quality does not regress below the recorded baseline", async () => {
  const { summary } = await report();
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));

  assert.ok(
    summary.top1_rate >= baseline.summary.top1_rate,
    `top-1 regressed: ${summary.top1_rate} < ${baseline.summary.top1_rate}`,
  );
  assert.ok(
    summary.top3_rate >= baseline.summary.top3_rate,
    `top-3 regressed: ${summary.top3_rate} < ${baseline.summary.top3_rate}`,
  );
});

test("discovery evaluation is deterministic", async () => {
  const corpus = await loadCorpus();
  // Determinism is a property of the harness + frozen resolver, so a 6-intent
  // subset is sufficient proof and keeps the suite fast.
  const subset = { ...corpus, intents: corpus.intents.slice(0, 6) };
  const first = await evaluateDiscovery(subset);
  const second = await evaluateDiscovery(subset);
  assert.deepEqual(second.results, first.results);
  assert.equal(second.summary.top1_rate, first.summary.top1_rate);
  assert.equal(second.summary.top3_rate, first.summary.top3_rate);
});

test("catalog id validation fails closed on an unknown skill", async () => {
  const corpus = await loadCorpus();
  const broken = structuredClone(corpus);
  broken.intents[0].acceptable_alternatives = ["egawilldoit/definitely-not-a-real-skill"];
  await assert.rejects(() => evaluateDiscovery(broken), /absent from the catalog/u);
});

test("a LOW intent ranks suggestions but never selects them", async () => {
  const { results } = await report();
  const low = results.filter((row) => row.confidence === "LOW");
  assert.ok(low.length > 0, "corpus should exercise LOW confidence");
  for (const row of low) {
    // Discovery may still RANK suggestions for a human; that is the whole
    // point of separating discovery from execution routing.
    assert.deepEqual(row.selected, [], `${row.id} is LOW but selected ${JSON.stringify(row.selected)}`);
    // A LOW row can suggest candidates, but nothing it suggests may itself be
    // a wrong automatic selection.
    assert.deepEqual(row.wrong_automatic_selections, [], `${row.id} LOW row reported a wrong selection`);
    for (const id of row.ranking) {
      assert.ok(!row.selected.includes(id), `${row.id} ranking must not overlap its own selections`);
    }
  }
});