#!/usr/bin/env node

/**
 * Deterministic DISCOVERY evaluation harness (Phase A).
 *
 * This harness deliberately measures TWO different things, because the
 * product distinguishes them (mission §6):
 *
 *   1. EXECUTION SAFETY — the resolver's automatic `selected` list. A LOW
 *      confidence result is SAFE (it selects nothing). A wrong automatic
 *      selection is the only real failure. This harness reuses the frozen
 *      SPEC-004 resolver unchanged; it never re-implements ranking.
 *
 *   2. DISCOVERY QUALITY — the human-facing ranking a `find-skill` style
 *      surface shows the user. It is a PROJECTION of the existing primitives
 *      (resolve `selected`, resolve `candidates`, then `search` fallbacks),
 *      never an independent search algorithm.
 *
 * It reads the committed, digest-verified Hub release artifact read-only. It
 * never writes to the artifact, never imports skills, never touches a user's
 * registry, and never re-hashes or regenerates release state.
 *
 * Usage:
 *   node scripts/eval/discovery.mjs <corpus.json> [--artifact <dir>] [--json]
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openRegistry, searchSkills } from "../../packages/registry/dist/index.js";
import { resolveSkills } from "../../packages/router/dist/index.js";

export const DISCOVERY_EVALUATION_SCHEMA_VERSION = 1;

/** Default artifact directory: the committed deployment artifact. */
const DEFAULT_ARTIFACT = "packages/mcp/artifact";

/** How many resolved candidates the discovery projection considers. */
export const DISCOVERY_CANDIDATE_LIMIT = 3;

/**
 * Collect every skill id a corpus references, so the harness can prove the
 * corpus only names real catalog skills (the same guarantee the catalog
 * generator enforces for presentation metadata).
 */
function referencedSkillIds(corpus) {
  const ids = new Set();
  for (const intent of corpus.intents) {
    if (intent.expected_primary) ids.add(intent.expected_primary);
    for (const id of intent.acceptable_alternatives ?? []) ids.add(id);
    for (const id of intent.must_not_select ?? []) ids.add(id);
  }
  return ids;
}

/**
 * The human-discovery ranking for one task.
 *
 * Built ONLY from existing frozen primitives, in strict precedence order:
 *   1. resolver `selected`  (HIGH/MEDIUM — the execution recommendation)
 *   2. resolver `candidates` (LOW suggestions, never auto-executed)
 *   3. `search` hits         (only when the resolver offers nothing useful)
 *
 * Duplicates are removed while preserving first-seen order, so the ranking is
 * deterministic for a given catalog + task.
 */
export function discoveryRanking(resolved, searchIds) {
  const ordered = [...resolved.selected.map((s) => s.id), ...resolved.candidates.map((s) => s.id), ...searchIds];
  const seen = new Set();
  const ranking = [];
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    ranking.push(id);
  }
  return ranking;
}

function acceptableIds(intent) {
  return [intent.expected_primary, ...(intent.acceptable_alternatives ?? [])].filter(
    (id) => typeof id === "string" && id.length > 0,
  );
}

/**
 * Score one intent.
 *
 * `wrong_automatic_selections` counts each automatically selected skill that
 * is neither the expected primary nor an acceptable alternative. LOW results
 * contribute 0 by construction — selecting nothing is never a wrong
 * selection, which is exactly the safety property we want to preserve.
 */
function scoreIntent(intent, resolved, searchIds) {
  const acceptable = new Set(acceptableIds(intent));
  const mustNot = new Set(intent.must_not_select ?? []);
  const selected = resolved.selected.map((s) => s.id);
  const ranking = discoveryRanking(resolved, searchIds);

  const wrongAutomatic = selected.filter((id) => !acceptable.has(id));
  const rankOfExpected = ranking.indexOf(intent.expected_primary);
  const catastrophicTop3 = ranking
    .slice(0, DISCOVERY_CANDIDATE_LIMIT)
    .filter((id) => mustNot.has(id));

  return {
    id: intent.id,
    task: intent.task,
    confidence: resolved.confidence,
    selected,
    ranking: ranking.slice(0, DISCOVERY_CANDIDATE_LIMIT),
    expected_primary: intent.expected_primary,
    rank_of_expected: rankOfExpected,
    top1: rankOfExpected === 0,
    top3: rankOfExpected >= 0 && rankOfExpected < DISCOVERY_CANDIDATE_LIMIT,
    wrong_automatic_selections: wrongAutomatic,
    low_confidence: resolved.confidence === "LOW",
    catastrophic_top3: catastrophicTop3,
    passed: wrongAutomatic.length === 0 && catastrophicTop3.length === 0,
  };
}

/** Aggregate metrics per mission §9. */
export function summarize(rows, thresholds) {
  const total = rows.length;
  const top1 = rows.filter((r) => r.top1).length;
  const top3 = rows.filter((r) => r.top3).length;
  const wrongRows = rows.filter((r) => r.wrong_automatic_selections.length > 0);
  const catastrophic = rows.filter((r) => r.catastrophic_top3.length > 0);
  const lowRows = rows.filter((r) => r.low_confidence);

  const ratio = (n) => (total === 0 ? 0 : n / total);
  const metrics = {
    intent_count: total,
    top1_count: top1,
    top1_rate: ratio(top1),
    top3_count: top3,
    top3_rate: ratio(top3),
    wrong_automatic_selection_count: wrongRows.reduce((n, r) => n + r.wrong_automatic_selections.length, 0),
    wrong_automatic_selection_intents: wrongRows.length,
    catastrophic_top3_count: catastrophic.length,
    low_confidence_count: lowRows.length,
  };

  const targets = {
    wrong_automatic_selections: metrics.wrong_automatic_selection_count === 0,
    top1: metrics.top1_rate >= (thresholds?.top1 ?? 0.9),
    top3: metrics.top3_rate >= (thresholds?.top3 ?? 0.98),
    no_catastrophic_top3: metrics.catastrophic_top3_count === 0,
  };

  return {
    ...metrics,
    targets,
    // Human-readable pass/fail; `exec` is the release-blocking gate.
    exec_ok: targets.wrong_automatic_selections && targets.no_catastrophic_top3,
    discovery_ok: targets.top1 && targets.top3,
  };
}

/**
 * Run the whole corpus against the committed artifact.
 *
 * @param corpus Parsed corpus document (see tests/discovery/personal-intents.json).
 * @param options.artifactDir Directory holding the verified release artifact.
 */
export async function evaluateDiscovery(corpus, options = {}) {
  if (corpus.schema_version !== DISCOVERY_EVALUATION_SCHEMA_VERSION) {
    throw new Error(`unsupported discovery corpus schema: ${corpus.schema_version}`);
  }
  const artifactDir = resolve(options.artifactDir ?? DEFAULT_ARTIFACT);
  const registryDatabase = join(artifactDir, "registry.sqlite");
  if (!existsSync(registryDatabase)) {
    throw new Error(`artifact registry not found: ${registryDatabase}`);
  }

  // A throwaway bare project so project discovery never picks up this repo's
  // own control files; every intent is evaluated from the artifact catalog.
  const project = await mkdtemp(join(tmpdir(), "ega-discovery-eval-"));
  const env = { ...process.env, EGA_SKILLS_HOME: artifactDir };

  // Fail closed on a corpus that targets a different release. Without this, a
  // re-vendored catalog would silently be scored against an old corpus while
  // the report still printed the corpus's stale digest.
  const release = JSON.parse(await readFile(join(artifactDir, "hub-release.json"), "utf8"));
  if (release.digest !== corpus.release_digest) {
    throw new Error(
      `corpus targets release ${corpus.release_digest} but artifact is ${release.digest}: ` +
        "re-vendor the corpus and update tests/discovery/personal-intents.json",
    );
  }

  // The read-only handle stays open for the whole run: `search` and
  // `resolve` both read the same verified catalog snapshot.
  const readable = openRegistry({ env, readonly: true });
  try {
    // Fail closed BEFORE doing any work: an all-pending corpus would otherwise
    // report 0 intents with every rate at 0 and `exec_ok: true`.
    if (corpus.intents.every((intent) => intent.pending_skill === true)) {
      throw new Error("discovery corpus has no measurable intents (every intent is pending_skill)");
    }
    const catalogSkillCount = readable.db.prepare("SELECT COUNT(*) AS c FROM skills").get().c;
    const searchByTask = (task) => searchSkills(readable.db, task).map((hit) => hit.skillId);

    // Fail closed on a corpus that names a skill the catalog does not have:
    // a typo must never silently weaken an expectation.
    const known = new Set(
      readable.db.prepare("SELECT skill_id AS id FROM skills").all().map((row) => row.id),
    );
    const missing = [...referencedSkillIds(corpus)].filter((id) => !known.has(id));
    const undeclaredMissing = missing.filter(
      (id) => !corpus.intents.some((i) => i.pending_skill && i.expected_primary === id),
    );
    if (undeclaredMissing.length > 0) {
      throw new Error(
        `corpus references skills absent from the catalog: ${undeclaredMissing.join(", ")}`,
      );
    }

    const rows = [];
    for (const intent of corpus.intents) {
      const resolved = await resolveSkills({
        task: intent.task,
        projectPath: project,
        env,
        ...(intent.max_skills === undefined ? {} : { budget: { maxSkills: intent.max_skills } }),
      });
      rows.push({ ...scoreIntent(intent, resolved, searchByTask(intent.task)), pending: Boolean(intent.pending_skill) });
    }

    // Pending intents prove a missing skill; they are excluded from routing
    // rates but reported so the gap stays visible.
    const measurable = rows.filter((row) => !row.pending);
    const pending = rows.filter((row) => row.pending);

    return {
      schema_version: DISCOVERY_EVALUATION_SCHEMA_VERSION,
      corpus_id: corpus.corpus_id,
      release_digest: corpus.release_digest,
      catalog_skill_count: catalogSkillCount,
      summary: summarize(measurable, corpus.thresholds),
      pending_skill_intents: pending.map((row) => ({ id: row.id, expected_primary: row.expected_primary })),
      results: rows,
    };
  } finally {
    readable.close();
    await rm(project, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const corpusPath = args[0];
  if (corpusPath === undefined) {
    process.stderr.write(
      "Usage: node scripts/eval/discovery.mjs <corpus.json> [--artifact <dir>] [--json]\n",
    );
    process.exitCode = 2;
    return;
  }
  const artifactFlag = args.indexOf("--artifact");
  const artifactDir = artifactFlag >= 0 ? args[artifactFlag + 1] : undefined;

  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const report = await evaluateDiscovery(corpus, { artifactDir });

  if (!args.includes("--json")) {
    const s = report.summary;
    process.stdout.write(
      [
        `discovery: corpus=${report.corpus_id} catalog=${report.catalog_skill_count} intents=${s.intent_count}`,
        `  exec safety : wrong automatic selections=${s.wrong_automatic_selection_count} (target 0) ${s.targets.wrong_automatic_selections ? "OK" : "FAIL"}`,
        `  catastrophic: must-not-select in top3=${s.catastrophic_top3_count} (target 0) ${s.targets.no_catastrophic_top3 ? "OK" : "FAIL"}`,
        `  top-1       : ${s.top1_count}/${s.intent_count} = ${(s.top1_rate * 100).toFixed(1)}% (target >=90%) ${s.targets.top1 ? "OK" : "BELOW"}`,
        `  top-3       : ${s.top3_count}/${s.intent_count} = ${(s.top3_rate * 100).toFixed(1)}% (target >=98%) ${s.targets.top3 ? "OK" : "BELOW"}`,
        `  LOW cases   : ${s.low_confidence_count}`,
        ...(report.pending_skill_intents.length > 0
          ? [`  pending    : ${report.pending_skill_intents.length} intent(s) name a skill absent from this release (proves the gap): ${report.pending_skill_intents.map((p) => p.expected_primary).join(", ")}`]
          : []),
        "",
      ].join("\n"),
    );
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.summary.exec_ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();