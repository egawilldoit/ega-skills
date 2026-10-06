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

/**
 * How many candidates the discovery projection shows a human.
 *
 * This is the RESOLVER'S window (`selected` then `candidates`), not a search
 * window. Raw `search` hits are deliberately NOT appended here: FTS returns a
 * median of 105 of 114 skills for a typical task, so appending that tail would
 * pad the 3-slot window with arbitrary rows and inflate the top-3 rate without
 * adding any ordering signal a human would use. Search reachability is reported
 * separately as `search_reachable_*`.
 */
export const DISCOVERY_CANDIDATE_LIMIT = 3;

/**
 * Minimum measurable intents (mission §8 asks for >= 50 representative tasks).
 * Enforced on the MEASURABLE subset, so marking intents `pending_skill` can
 * never quietly shrink the suite into a meaningless pass.
 */
export const MIN_MEASURABLE_INTENTS = 50;

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
 * The human-discovery ranking for one task: exactly what the resolver offers a
 * human, in the resolver's own order.
 *
 *   1. resolver `selected`   (HIGH/MEDIUM — the execution recommendation)
 *   2. resolver `candidates` (LOW suggestions, never auto-executed)
 *
 * Duplicates are removed while preserving first-seen order, so the ranking is
 * deterministic for a given catalog + task.
 *
 * Note this is NOT extended with `search` hits. Search is measured on its own
 * (`searchReachable`), because concatenating an FTS tail would pad the window
 * with rows that carry no ranking signal.
 */
export function discoveryRanking(resolved) {
  const ordered = [...resolved.selected.map((s) => s.id), ...resolved.candidates.map((s) => s.id)];
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
 *
 * Catastrophic results are split by severity, because they are NOT equivalent:
 *   - `catastrophic_auto_selected`: an excluded skill would have RUN. Real risk.
 *   - `catastrophic_suggested_only`: an excluded skill merely occupies a
 *     suggestion slot the user must choose from. Cosmetic, not a safety issue.
 */
function scoreIntent(intent, resolved, searchIds) {
  const acceptable = new Set(acceptableIds(intent));
  const mustNot = new Set(intent.must_not_select ?? []);
  const selected = resolved.selected.map((s) => s.id);
  const ranking = discoveryRanking(resolved);

  const wrongAutomatic = selected.filter((id) => !acceptable.has(id));
  const rankOfExpected = ranking.indexOf(intent.expected_primary);
  const window = ranking.slice(0, DISCOVERY_CANDIDATE_LIMIT);
  const catastrophicTop3 = window.filter((id) => mustNot.has(id));
  const catastrophicAuto = catastrophicTop3.filter((id) => selected.includes(id));
  const searchRank = searchIds.indexOf(intent.expected_primary);

  return {
    id: intent.id,
    task: intent.task,
    confidence: resolved.confidence,
    selected,
    candidates: resolved.candidates.map((s) => s.id),
    ranking: window,
    expected_primary: intent.expected_primary,
    // Position within the resolver's own window: 0..2, or -1 when absent.
    rank_of_expected: rankOfExpected,
    top1: rankOfExpected === 0,
    top3: rankOfExpected >= 0 && rankOfExpected < DISCOVERY_CANDIDATE_LIMIT,
    // Search is a SEPARATE fallback path, measured on its own.
    search_reachable: searchRank >= 0 && searchRank < DISCOVERY_CANDIDATE_LIMIT,
    search_rank: searchRank,
    auto_select_attempted: selected.length > 0,
    wrong_automatic_selections: wrongAutomatic,
    low_confidence: resolved.confidence === "LOW",
    catastrophic_top3: catastrophicTop3,
    catastrophic_auto_selected: catastrophicAuto,
    passed: wrongAutomatic.length === 0 && catastrophicAuto.length === 0,
  };
}

/** Aggregate metrics per mission §9. */
export function summarize(rows, thresholds) {
  const total = rows.length;
  const top1 = rows.filter((r) => r.top1).length;
  const top3 = rows.filter((r) => r.top3).length;
  const searchReachable = rows.filter((r) => r.search_reachable).length;
  const wrongRows = rows.filter((r) => r.wrong_automatic_selections.length > 0);
  const autoRows = rows.filter((r) => r.auto_select_attempted);
  const catastrophic = rows.filter((r) => r.catastrophic_top3.length > 0);
  const catastrophicAuto = rows.filter((r) => r.catastrophic_auto_selected.length > 0);
  const lowRows = rows.filter((r) => r.low_confidence);

  // A run that measured nothing must never look like a clean pass. An empty
  // denominator yields a rate of 0, which would otherwise read as "0% wrong".
  if (total === 0) throw new Error("no measurable intents to summarize");
  const ratio = (n, over = total) => (over === 0 ? 0 : n / over);
  const metrics = {
    intent_count: total,
    // Most intents are LOW and select nothing, so the wrong-selection rate is
    // only meaningful against the intents that actually attempted a selection.
    auto_select_attempts: autoRows.length,
    top1_count: top1,
    top1_rate: ratio(top1),
    top3_count: top3,
    top3_rate: ratio(top3),
    search_reachable_count: searchReachable,
    search_reachable_rate: ratio(searchReachable),
    wrong_automatic_selection_count: wrongRows.reduce((n, r) => n + r.wrong_automatic_selections.length, 0),
    wrong_automatic_selection_intents: wrongRows.length,
    wrong_automatic_selection_rate: ratio(wrongRows.length, autoRows.length),
    catastrophic_top3_count: catastrophic.length,
    catastrophic_auto_selected_count: catastrophicAuto.length,
    catastrophic_suggested_only_count: catastrophic.length - catastrophicAuto.length,
    low_confidence_count: lowRows.length,
  };

  const targets = {
    // An empty attempt denominator is an UNMEASURED pass, not a clean one.
    measured_attempts: metrics.auto_select_attempts > 0,
    wrong_automatic_selections: metrics.wrong_automatic_selection_count === 0,
    top1: metrics.top1_rate >= (thresholds?.top1 ?? 0.9),
    top3: metrics.top3_rate >= (thresholds?.top3 ?? 0.98),
    // Only an auto-selected excluded skill is a safety failure; a suggestion
    // slot is a presentation issue, reported separately.
    no_catastrophic_auto_selection: metrics.catastrophic_auto_selected_count === 0,
  };

  return {
    ...metrics,
    targets,
    exec_ok: targets.wrong_automatic_selections && targets.no_catastrophic_auto_selection,
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
    // Fail closed BEFORE doing any work on a corpus that measures nothing.
    // `every(pending)` alone is not enough: N intents may all name the same
    // absent skill as `expected_primary` with `pending_skill`, leaving a single
    // measurable intent and a vacuous report.
    const measurableCount = corpus.intents.filter((intent) => intent.pending_skill !== true).length;
    if (measurableCount === 0) {
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

  // The corpus-size floor belongs to the CLI, not to the library: a caller may
  // legitimately evaluate a small subset, but `pnpm eval:discovery` reporting a
  // pass over 6 intents would be misleading.
  const measurable = corpus.intents.filter((intent) => intent.pending_skill !== true).length;
  if (measurable < MIN_MEASURABLE_INTENTS) {
    process.stderr.write(
      `discovery: FAIL corpus needs at least ${MIN_MEASURABLE_INTENTS} measurable intents, found ${measurable}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const report = await evaluateDiscovery(corpus, { artifactDir });

  if (!args.includes("--json")) {
    const s = report.summary;
    process.stdout.write(
      [
        `discovery: corpus=${report.corpus_id} catalog=${report.catalog_skill_count} intents=${s.intent_count}`,
        `  window      : resolver selected+candidates only (max ${DISCOVERY_CANDIDATE_LIMIT}); search measured separately`,
        `  exec safety : wrong automatic selections=${s.wrong_automatic_selection_count} across ${s.auto_select_attempts} attempts = ${(s.wrong_automatic_selection_rate * 100).toFixed(1)}% (target 0) ${s.targets.wrong_automatic_selections ? "OK" : "FAIL"}`,
        `  excluded    : auto-selected=${s.catastrophic_auto_selected_count} (target 0) ${s.targets.no_catastrophic_auto_selection ? "OK" : "FAIL"}; suggestion-only=${s.catastrophic_suggested_only_count}`,
        `  top-1       : ${s.top1_count}/${s.intent_count} = ${(s.top1_rate * 100).toFixed(1)}% (target >=90%) ${s.targets.top1 ? "OK" : "BELOW"}`,
        `  top-3       : ${s.top3_count}/${s.intent_count} = ${(s.top3_rate * 100).toFixed(1)}% (target >=98%) ${s.targets.top3 ? "OK" : "BELOW"}`,
        `  search-only : expected in top ${DISCOVERY_CANDIDATE_LIMIT} of FTS = ${s.search_reachable_count}/${s.intent_count} = ${(s.search_reachable_rate * 100).toFixed(1)}%`,
        `  LOW cases   : ${s.low_confidence_count} of ${s.intent_count}`,
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