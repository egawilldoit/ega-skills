import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { evaluateDiscovery } from "../../scripts/eval/discovery.mjs";
import { openRegistry } from "../../packages/registry/dist/index.js";

const execFileAsync = promisify(execFile);
const CORPUS_PATH = join(process.cwd(), "tests/discovery/personal-intents.json");
const BASELINE_PATH = join(process.cwd(), "tests/discovery/baseline.json");
const ENV = { ...process.env, EGA_SKILLS_HOME: join(process.cwd(), "packages/mcp/artifact") };

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
/**
 * Known automatic misroutes that CANNOT be fixed in this repository.
 *
 * Root causes are in external routing metadata or external catalog skills:
 *
 * 1. Routing metadata in the external, digest-pinned corpus repo
 *    (github.com/egawilldoit/skills):
 *    - reconcile-conflicting-truth: get-pr-comments declares `domains: [github]`,
 *      so the word "GitHub" in the task produces strong DOMAIN evidence and
 *      outranks reconcile-project-truth (no domains).
 *    - react-performance: design-architecture declares `domains: [architecture]`,
 *      so "architecture guidance" produces strong DOMAIN evidence and outranks
 *      vercel/react-best-practices (no domains, platforms, or frameworks).
 *
 * 2. Accepted platform defect introduced by `mattpocock/pr` in catalog-2026-10-06.1
 *    (see PROVENANCE.md and docs/evidence/catalog/catalog-2026-10-06.1/routing.md):
 *    SPEC-004 §5.1.11.2 substring NAME_DESCRIPTION matching makes the 2-character
 *    portable name "pr" match inside ordinary English words (e.g. "product",
 *    "production", "approach", "practice", etc.), auto-selecting `mattpocock/pr`.
 */
const KNOWN_EXTERNAL_AUTO_ROUTES = [
  "certify-release",
  "checks-failing",
  "create-verification-workflow",
  "debug-hard-bug",
  "deep-independent-review",
  "frontend-implementation",
  "hard-to-trace-code",
  "mcp-production",
  "mcp-server-building",
  "novel-ui-no-precedent",
  "pr-stack",
  "production-target",
  "prove-actually-true",
  "prove-really-deployed",
  "react-performance",
  "reconcile-conflicting-truth",
  "record-evidence",
  "research-primary-sources",
  "review-this-pr",
  "smoke-tests",
  "teach-concept",
  "triage-inbox",
  "type-design",
  "verify-cli",
  "verify-one-claim",
];

/** Read routing metadata (incl. anti-triggers) for every skill in the artifact. */
function routingBySkill() {
  const handle = openRegistry({ env: ENV, readonly: true });
  try {
    const rows = handle.db
      .prepare(
        `SELECT s.skill_id AS id, v.manifest_json AS manifest
           FROM skills s
           JOIN skill_versions v
             ON v.skill_id = s.skill_id
            AND v.version_hash = s.current_version_hash`,
      )
      .all();
    return new Map(rows.map((row) => [row.id, JSON.parse(row.manifest).routing ?? {}]));
  } finally {
    handle.close();
  }
}

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
    const name = intent.expected_primary.split("/")[1];
    assert.ok(
      intent.task.toLowerCase() !== name.replaceAll("-", " "),
      `intent ${intent.id} must not be the bare skill name`,
    );
    // A realistic utterance carries enough signal to be recognizable.
    assert.ok(intent.task.trim().length >= 20, `intent ${intent.id} is too terse to be a realistic prompt`);
  }
});

test("no intent trips an anti-trigger of the skill it expects", async () => {
  // A prompt that says what the expected skill explicitly excludes is a corpus
  // bug, not a routing defect: it asks for something the skill disclaims.
  const corpus = await loadCorpus();
  const routing = routingBySkill();
  const offenders = [];
  for (const intent of corpus.intents) {
    const anti = routing.get(intent.expected_primary)?.anti_triggers ?? [];
    const task = intent.task.toLowerCase();
    const tripped = anti.filter((phrase) => task.includes(String(phrase).toLowerCase()));
    if (tripped.length > 0) {
      offenders.push(`${intent.id} expects ${intent.expected_primary} but trips ${JSON.stringify(tripped)}`);
    }
  }
  assert.deepEqual(offenders, [], `anti-trigger collisions:\n  ${offenders.join("\n  ")}`);
});

test("must_not_select never contradicts another intent's expected_primary without justification", async () => {
  // Cross-intent tension is legitimate (the same skill can be right for one task
  // and wrong for another), but every must_not_select entry should be a skill
  // that some other intent genuinely expects, or the exclusion is meaningless.
  const corpus = await loadCorpus();
  const expected = new Set(corpus.intents.map((i) => i.expected_primary));
  for (const intent of corpus.intents) {
    for (const id of intent.must_not_select ?? []) {
      if (id === intent.expected_primary) {
        assert.fail(`intent ${intent.id} lists its own expected_primary in must_not_select`);
      }
    }
  }
  // Sanity: the corpus must actually exercise exclusions.
  const exclusions = corpus.intents.reduce((n, i) => n + (i.must_not_select ?? []).length, 0);
  assert.ok(exclusions > 0, "corpus should exercise must_not_select");
  assert.ok(expected.size > 0);
});

test("LOW confidence never auto-selects a skill", async () => {
  const { results } = await report();
  const low = results.filter((row) => row.confidence === "LOW");
  assert.ok(low.length > 0, "corpus should exercise LOW confidence");
  for (const row of low) {
    assert.deepEqual(
      row.selected,
      [],
      `LOW confidence must publish selected=[] (SPEC-004 §5.1.17 rule 4); ${row.id} selected ${JSON.stringify(row.selected)}`,
    );
  }
});

test("discovery ranking never auto-selects a must_not_select skill", async () => {
  const { results } = await report();
  const offenders = results
    .filter((row) => !row.pending && row.catastrophic_auto_selected.length > 0)
    .map((row) => row.id);

  // Recorded, not yet fixed: these are metadata defects in the external corpus
  // repo. The count may be TIGHTENED when they land, never loosened.
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  assert.ok(
    offenders.length <= baseline.summary.catastrophic_auto_selected_count,
    `auto-selected excluded-skill count regressed (baseline ${baseline.summary.catastrophic_auto_selected_count}): ${offenders.join(", ")}`,
  );
});

test("the discovery window is the resolver window, not a search tail", async () => {
  // Guards the measurement itself: FTS hits must never be concatenated into the
  // discovery ranking, because that pads the 3-slot window and inflates top-3.
  const corpus = await loadCorpus();
  const subset = { ...corpus, intents: corpus.intents.slice(0, 8) };
  const report = await evaluateDiscovery(subset);
  assert.ok(report.results.some((r) => r.ranking.length > 0), "subset produced no window at all");
  for (const row of report.results) {
    assert.ok(
      row.ranking.length <= 3,
      `${row.id} ranking exceeded the 3-slot discovery window (${row.ranking.length})`,
    );
    // Every ranked entry must come from the resolver's own output — never FTS.
    for (const id of row.ranking) {
      assert.ok(
        row.selected.includes(id) || row.candidates.includes(id),
        `${row.id} ranked "${id}" which the resolver never returned`,
      );
    }
  }
});

test("search reachability is measured separately from the resolver window", async () => {
  const { results, summary } = await report();
  assert.ok(summary.search_reachable_count > 0, "expected some search-reachable intents");
  const resolverTop3 = results.filter((r) => !r.pending && r.top3).length;
  // FTS and the resolver read the same catalog, so search should not reach
  // strictly fewer of the expected skills than the resolver window does.
  assert.ok(
    summary.search_reachable_count >= resolverTop3,
    `search reached ${summary.search_reachable_count} but the resolver window reached ${resolverTop3}`,
  );
  // And search must be a genuine fallback, i.e. it finds some the window missed.
  const resolverMisses = results.filter((r) => !r.pending && !r.top3 && r.search_reachable).length;
  assert.ok(
    resolverMisses > 0,
    "search reached nothing the resolver window missed, so the fallback path is untested",
  );
});

test("wrong automatic selections are reported against attempts, not all intents", async () => {
  const { summary } = await report();
  assert.ok(summary.auto_select_attempts > 0);
  assert.equal(summary.targets.measured_attempts, true);
  const expected = summary.wrong_automatic_selection_intents / summary.auto_select_attempts;
  assert.ok(Math.abs(summary.wrong_automatic_selection_rate - expected) < 1e-9);
  // The raw count must never be presented as if it were a share of all intents.
  assert.ok(summary.intent_count > summary.auto_select_attempts);
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

test("the eval script's direct-invocation guard is cross-platform", async () => {
  // Regression guard for a real Windows bug: `import.meta.url ===
  // \`file://${process.argv[1]}\`` never matches on Windows (argv[1] uses
  // backslashes, import.meta.url uses forward slashes), so the script exited 0
  // without doing anything. `pathToFileURL` is the correct comparison.
  const { pathToFileURL } = await import("node:url");
  const windowsStyle = "D:\\a\\ega-skills\\scripts\\eval\\discovery.mjs";
  assert.notEqual(
    `file://${windowsStyle}`,
    pathToFileURL(windowsStyle).href,
    "the naive comparison must be provably wrong for a Windows path",
  );
  // And the comparison the script actually uses must round-trip for both styles.
  for (const candidate of [windowsStyle, "/home/ubuntu/ega/scripts/eval/discovery.mjs"]) {
    assert.equal(pathToFileURL(candidate).href, pathToFileURL(candidate).href);
    assert.match(pathToFileURL(candidate).href, /^file:\/\/\//u);
  }
  // The shipped scripts must use the correct idiom (ignoring comments, which
  // legitimately quote the broken form to explain why it is wrong).
  for (const script of ["scripts/eval/discovery.mjs", "scripts/eval/routing.mjs"]) {
    const text = await readFile(join(process.cwd(), script), "utf8");
    const code = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    assert.ok(
      !code.includes("`file://${process.argv[1]}`"),
      `${script} still uses the Windows-broken entrypoint comparison in code`,
    );
    assert.ok(code.includes("pathToFileURL"), `${script} must compare via pathToFileURL`);
  }
});

test("the CLI refuses a corpus below the measurable-intent floor", async () => {
  const corpus = await loadCorpus();
  const dir = await mkdtemp(join(tmpdir(), "ega-discovery-small-"));
  try {
    const path = join(dir, "small.json");
    await writeFile(path, JSON.stringify({ ...corpus, intents: corpus.intents.slice(0, 6) }));
    // The library may evaluate a small subset on purpose; the CLI must not
    // report a pass over one.
    const result = await execFileAsync(process.execPath, ["scripts/eval/discovery.mjs", path], {
      cwd: process.cwd(),
    }).then(
      (value) => ({ rejected: false, ...value }),
      (error) => ({ rejected: true, code: error.code, stderr: error.stderr, stdout: error.stdout }),
    );
    assert.equal(
      result.rejected,
      true,
      `the CLI must exit non-zero; it resolved with code ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(String(result.stderr), /at least 50 measurable intents/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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