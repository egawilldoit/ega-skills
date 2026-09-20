#!/usr/bin/env node

// Deterministic routing evaluation harness. It materializes only an isolated
// fixture registry, exercises the real search and resolver APIs, and emits
// metadata sufficient to reproduce the result. It never touches a user's
// registry or project.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalizeJson, hashBytes } from "../../packages/hashing/dist/index.js";
import { importSkills, openRegistry, searchSkills } from "../../packages/registry/dist/index.js";
import { resolveSkills } from "../../packages/router/dist/index.js";

export const ROUTING_EVALUATION_SCHEMA_VERSION = 1;

function sorted(values) {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function expectedPass(scenario, selected) {
  const expected = scenario.expected_ids ?? [];
  const forbidden = new Set(scenario.forbidden_ids ?? []);
  if (selected.some((id) => forbidden.has(id))) return false;
  if (expected.length === 0) return selected.length === 0;
  return selected.some((id) => expected.includes(id));
}

async function writeFixtureSkill(source, skill) {
  const root = join(source, skill.name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), skill.body ?? `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n# ${skill.name}\n\nGuidance.\n`);
  await writeFile(join(root, "ega.yaml"), skill.ega ?? "schema_version: 1\n");
  return root;
}

/** Run the real registry search and resolver for every reviewed task. */
export async function evaluateCorpus(fixture) {
  if (fixture.schema_version !== ROUTING_EVALUATION_SCHEMA_VERSION) {
    throw new Error(`unsupported routing fixture schema: ${fixture.schema_version}`);
  }
  const base = await mkdtemp(join(tmpdir(), "ega-routing-eval-"));
  const source = join(base, "source");
  const project = join(base, "project");
  const home = join(base, "registry");
  await mkdir(source, { recursive: true });
  await mkdir(project, { recursive: true });
  const env = { ...process.env, EGA_SKILLS_HOME: home };
  try {
    for (const skill of fixture.skills) await writeFixtureSkill(source, skill);
    const writable = openRegistry({ env });
    try {
      const summary = await importSkills(writable, { path: source, namespace: fixture.namespace ?? "ega" });
      if (summary.failed !== 0 || summary.imported !== fixture.skills.length) {
        throw new Error(`fixture import failed: ${JSON.stringify(summary)}`);
      }
    } finally {
      writable.close();
    }

    const rows = [];
    for (const scenario of fixture.tasks) {
      const projectPackage = scenario.project_package;
      const packagePath = join(project, "package.json");
      if (projectPackage === null) {
        await rm(packagePath, { force: true });
      } else {
        await writeFile(packagePath, JSON.stringify(projectPackage ?? {}, null, 2));
      }
      const readable = openRegistry({ env, readonly: true });
      let search;
      try {
        search = searchSkills(readable.db, scenario.task).map((hit) => hit.skillId);
      } finally {
        readable.close();
      }
      const resolved = await resolveSkills({
        task: scenario.task,
        projectPath: project,
        env,
        ...(scenario.max_skills === undefined ? {} : { budget: { maxSkills: scenario.max_skills } }),
      });
      const selected = resolved.selected.map((skill) => skill.id);
      const result = {
        id: scenario.id,
        task: scenario.task,
        search_ids: search,
        selected_ids: selected,
        candidate_ids: resolved.candidates.map((skill) => skill.id),
        rejected_ids: resolved.rejected.map((skill) => skill.id),
        selected_levels: resolved.selected.map((skill) => ({ id: skill.id, level: skill.recommendedContentLevel, tokens: skill.recommendedContentTokens })),
        resolver_reasons: Object.fromEntries(resolved.selected.map((skill) => [skill.id, [...skill.reasons]])),
        expected_ids: sorted(scenario.expected_ids ?? []),
        forbidden_ids: sorted(scenario.forbidden_ids ?? []),
        passed: expectedPass(scenario, selected),
      };
      rows.push(result);
    }
    const releaseDigest = fixture.release_digest ?? hashBytes(canonicalizeJson({ namespace: fixture.namespace ?? "ega", skills: fixture.skills }));
    return {
      schema_version: ROUTING_EVALUATION_SCHEMA_VERSION,
      release_digest: releaseDigest,
      metadata_revision: fixture.metadata_revision ?? "routing-metadata-v1",
      task_count: rows.length,
      passed_count: rows.filter((row) => row.passed).length,
      failed_count: rows.filter((row) => !row.passed).length,
      results: rows,
    };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function main() {
  const [fixturePath, outputPath] = process.argv.slice(2);
  if (fixturePath === undefined || outputPath === undefined) {
    process.stderr.write("Usage: node scripts/eval/routing.mjs <fixture.json> <output.json>\n");
    process.exitCode = 2;
    return;
  }
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const report = await evaluateCorpus(fixture);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: outputPath, ...report })}\n`);
  if (report.failed_count > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
