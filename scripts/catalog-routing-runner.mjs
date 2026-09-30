#!/usr/bin/env node
/**
 * Deterministic routing corpus runner for the clean 48-skill catalog.
 * Materializes the REAL hub build (zero-failure import), then runs every
 * corpus case through the REAL search + resolver APIs in-process.
 *
 * Judging (per the catalog brief §30–§31 + EVAL-599 precedent):
 *  - positive case: PASS when the expected skill is auto-selected, or when
 *    nothing is selected (LOW confidence) and the expected skill is the #1
 *    candidate. "If the current router only emits one winner, the expected
 *    skill must be that winner."
 *  - negative/collision case: PASS when the target skill is neither selected
 *    nor the #1 candidate.
 */
import { buildHub } from "/home/ubuntu/ega-catalog-main/packages/project/dist/index.js";
import { openRegistry, searchSkills } from "/home/ubuntu/ega-catalog-main/packages/registry/dist/index.js";
import { resolveSkills } from "/home/ubuntu/ega-catalog-main/packages/router/dist/index.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const HUB = process.argv[2] ?? "/home/ubuntu/ega-catalog-main/hub";
const CORPUS = process.argv[3] ?? "/tmp/opencode/release-ops/routing/corpus.json";
const OUT = process.argv[4] ?? "/tmp/opencode/release-ops/routing/report.json";

const corpus = JSON.parse(readFileSync(CORPUS, "utf8"));

const build = await buildHub(HUB);
const env = { ...process.env, EGA_SKILLS_HOME: build.registryHome };
const bareProject = "/tmp/opencode/release-ops/routing/bare-project";
mkdirSync(bareProject, { recursive: true });

const rows = [];
for (const task of corpus) {
  const readable = openRegistry({ env, readonly: true });
  let search;
  try {
    search = searchSkills(readable.db, task.task).map((hit) => hit.skillId);
  } finally {
    readable.close();
  }
  const resolved = await resolveSkills({
    task: task.task,
    projectPath: bareProject,
    env,
    ...(task.max_skills === undefined ? {} : { budget: { maxSkills: task.max_skills } }),
  });
  const selected = resolved.selected.map((s) => s.id);
  const candidates = resolved.candidates.map((s) => s.id);
  const forbidden = task.forbidden_ids ?? [];
  let passed;
  if (task.kind === "positive") {
    const expected = task.expected_ids ?? [];
    const forb = new Set(task.forbidden_ids ?? []);
    passed = selected.some((id) => expected.includes(id))
      || (selected.length === 0 && expected.includes(candidates[0] ?? search[0] ?? "") && !forb.has(candidates[0] ?? search[0]));
  } else {
    const forb = new Set(task.forbidden_ids ?? []);
    passed = !selected.some((id) => forb.has(id)) && !forb.has(candidates[0] ?? "");
  }
  rows.push({
    id: task.id,
    kind: task.kind,
    skill: task.skill ?? null,
    task: task.task,
    search_top: search.slice(0, 5),
    selected,
    candidate_top: candidates.slice(0, 6),
    confidence: resolved.confidence,
    expected: task.expected_ids ?? [],
    forbidden: task.forbidden_ids ?? [],
    passed,
  });
  process.stderr.write(`\r${rows.length}/${corpus.length}`);
}
const report = {
  schema_version: 1,
  total: rows.length,
  passed: rows.filter((r) => r.passed).length,
  failed: rows.filter((r) => !r.passed).length,
  results: rows,
};
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
const failures = rows.filter((r) => !r.passed);
console.log(`\n${JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed })}`);
for (const f of failures.slice(0, 40)) {
  console.log(`FAIL ${f.id} [${f.kind}] ${f.skill ?? ""} :: "${f.task.slice(0, 70)}"`);
  console.log(`   selected=${JSON.stringify(f.selected)} top=${JSON.stringify(f.candidate_top.slice(0, 3))}`);
}
if (report.failed > 0) process.exitCode = 1;
