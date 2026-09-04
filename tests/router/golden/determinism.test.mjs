// Golden router determinism, estimator-gate, and warm-benchmark suite (EGA-581).
//
// Three groups:
//   1. x10 determinism: for EACH of the 41 ROUTER scenarios (all batches
//      filtered to kind === "ROUTER", G040 excluded), the catalog registry and
//      the project tree are built ONCE through golden-setup helpers, then the
//      production resolveSkills runs 10 times with the scenario's exact
//      overrides (catalog fixture, explicitSkills, budget). All 10 outputs must
//      be identical on every meaningful field; ONLY resolutionId is ignored,
//      and project-path-bearing fingerprint fields are realpath-normalized
//      before the strict deep compare (symlinked-cwd contract, same semantics
//      as runner.mjs comparableResult — which is intentionally NOT exported,
//      so the normalization is mirrored here). Per-scenario PASS/FAIL is
//      reported.
//   2. estimator gate: assertTokenEstimatorId rejects ANY id other than the
//      frozen canonical ega-o200k-v1, and the golden materialize path (the
//      countContentTokens gate used by skill-materialize.mjs, which
//      golden-setup registry builds run through) is proven to gate: a
//      non-id estimator object is intercepted before its count ever runs.
//   3. warm benchmark: a 100-skill registry is synthesized (20 SKILL_FIXTURES
//      under 5 synthetic namespaces bench-a..bench-e), 5 warm resolves run,
//      then 30 timed resolves of one fixed task are sampled; all sampled
//      values plus the nearest-rank p95 are logged, and p95 must be <= 300ms.

import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import {
  PROJECT_CONFIG_V1_DEFAULTS,
  discoverConfig,
  readConfigAndLock,
  resolveLockMode,
} from "../../../packages/project/dist/index.js";
import { importSkills, openRegistry } from "../../../packages/registry/dist/index.js";
import { resolveSkills } from "../../../packages/router/dist/index.js";
import {
  TokenEstimatorError,
  assertTokenEstimatorCompatibility,
  assertTokenEstimatorId,
  tokenEstimator,
} from "../../../packages/schema/dist/index.js";

import { SKILL_FIXTURES } from "./catalog-data.mjs";
import { buildGoldenProject, buildRegistryForCatalog } from "./golden-setup.mjs";
import { countContentTokens, materializeSkill } from "./skill-materialize.mjs";
import { SCENARIOS_01 } from "./scenarios-01.mjs";
import { SCENARIOS_02 } from "./scenarios-02.mjs";
import { SCENARIOS_03 } from "./scenarios-03.mjs";
import { SCENARIOS_04 } from "./scenarios-04.mjs";
import { SCENARIOS_05 } from "./scenarios-05.mjs";

const ALL_SCENARIOS = [
  ...SCENARIOS_01,
  ...SCENARIOS_02,
  ...SCENARIOS_03,
  ...SCENARIOS_04,
  // G040 is IMPORT_INTEGRATION (not a router case); the matrix runs the
  // router subset of the precision batch only.
  ...SCENARIOS_05.filter((scenario) => scenario.kind === "ROUTER"),
];

// ---------------------------------------------------------------------------
// Policy derivation: mirror of runner.mjs derivePolicy (not exported there).
// The production resolver is purely policy-driven; the harness derives the
// policy through the PRODUCTION project modules — no mirrored semantics.
// ---------------------------------------------------------------------------
function derivePolicy(projectPath) {
  const discovery = discoverConfig(projectPath);
  const { config, lock } = readConfigAndLock(discovery);
  const effective = config ?? PROJECT_CONFIG_V1_DEFAULTS;
  const mode = resolveLockMode({ config: effective, lock });
  const lockedVersions =
    mode.mode === "LOCKED"
      ? new Map(
          Object.keys(mode.lock.skills).map((id) => [id, mode.lock.skills[id].version_hash]),
        )
      : null;
  return {
    allowedNamespaces: effective.namespaces.allow,
    deniedNamespaces: effective.namespaces.deny,
    deniedSkills: effective.skills.deny,
    prefer: effective.skills.prefer,
    defaultMaxSkills: effective.routing.max_skills,
    defaultMaxTokens: effective.routing.max_tokens,
    lockedVersions,
  };
}

// ---------------------------------------------------------------------------
// Comparable-result semantics — exact mirror of runner.mjs comparableResult
// (module-private there): every field of the ResolutionResult EXCEPT
// resolutionId, with path-bearing fingerprint fields realpath-normalized so a
// symlinked project equals its canonical twin.
// ---------------------------------------------------------------------------
function normalizedPath(path) {
  if (typeof path !== "string" || path.length === 0) return path;
  if (!isAbsolute(path)) return path;
  try {
    lstatSync(path);
    return realpathSync(path);
  } catch {
    return path;
  }
}

function comparableResult(result) {
  const fingerprint = result.projectFingerprint;
  return {
    ...result,
    resolutionId: undefined,
    projectFingerprint: {
      ...fingerprint,
      projectPath: normalizedPath(fingerprint.projectPath),
      packageRoot: normalizedPath(fingerprint.packageRoot),
      workspaceRoot: normalizedPath(fingerprint.workspaceRoot),
      evidence: fingerprint.evidence.map((record) => ({
        ...record,
        source: normalizedPath(record.source),
      })),
    },
  };
}

/** Recursive deep equality (arrays order-sensitive) — mirror of runner.mjs. */
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => deepEqual(entry, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/** One resolveSkills call with a scenario's exact overrides (runner.mjs mirror). */
async function resolveScenario(scenario, home, project) {
  const budget =
    scenario.maxSkills !== undefined || scenario.maxTokens !== undefined
      ? {
          ...(scenario.maxSkills !== undefined ? { maxSkills: scenario.maxSkills } : {}),
          ...(scenario.maxTokens !== undefined ? { maxTokens: scenario.maxTokens } : {}),
        }
      : undefined;
  return resolveSkills({
    task: scenario.task,
    projectPath: project.projectPath,
    policy: derivePolicy(project.projectPath),
    ...(scenario.explicitSkills !== undefined ? { explicitSkills: scenario.explicitSkills } : {}),
    ...(budget !== undefined ? { budget } : {}),
    env: { ...process.env, EGA_SKILLS_HOME: home },
  });
}

// ---------------------------------------------------------------------------
// Group 1 — x10 determinism over the 41 ROUTER scenarios.
// ---------------------------------------------------------------------------
test("x10 determinism: 41 ROUTER scenarios, 10 resolves each, identical outputs (resolutionId only ignored)", async () => {
  assert.equal(
    ALL_SCENARIOS.length,
    41,
    "router matrix must stay exactly 41 cases (G001–G042, G040 excluded)",
  );

  const rows = [];
  let passed = 0;
  let failed = 0;

  for (const scenario of ALL_SCENARIOS) {
    let outcome;
    try {
      const catalog = scenario.skillCatalogFixture ?? "router-default";
      const registry = await buildRegistryForCatalog(catalog);
      const home = registry.home;
      const project = await buildGoldenProject(scenario.projectFixture);

      const first = comparableResult(await resolveScenario(scenario, home, project));
      const mismatches = [];
      for (let i = 1; i < 10; i += 1) {
        const next = comparableResult(await resolveScenario(scenario, home, project));
        if (!deepEqual(first, next)) {
          mismatches.push(i);
        }
      }
      outcome =
        mismatches.length === 0
          ? { pass: true }
          : {
              pass: false,
              detail: `runs [${mismatches.join(", ")}] differ from run 0 (all fields except resolutionId, realpath-normalized)`,
            };
    } catch (error) {
      outcome = {
        pass: false,
        detail: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
      };
    }

    if (outcome.pass) {
      passed += 1;
      rows.push(`[X10] ${scenario.id} PASS`);
    } else {
      failed += 1;
      rows.push(`[X10] ${scenario.id} FAIL — ${outcome.detail}`);
    }
  }

  rows.push("");
  rows.push(`[X10] total=${ALL_SCENARIOS.length} pass=${passed} fail=${failed}`);
  console.log(rows.join("\n"));
  assert.equal(failed, 0, `${failed} of ${ALL_SCENARIOS.length} scenarios non-deterministic across 10 runs`);
});

// ---------------------------------------------------------------------------
// Group 2 — estimator gate.
// ---------------------------------------------------------------------------
test("estimator gate: assertTokenEstimatorId rejects any non-ega-o200k-v1 id", () => {
  for (const bad of [
    "",
    " ",
    "cl100k_base",
    "p50k_base",
    "gpt-4o",
    "ega-o200k",
    "ega-o200k-v2",
    "EGA-O200K-V1",
    "ega-o200k-v1 ",
  ]) {
    assert.throws(
      () => assertTokenEstimatorId(bad),
      (error) =>
        error instanceof TokenEstimatorError && error.code === "E_TOKEN_ESTIMATOR_INCOMPATIBLE",
      `assertTokenEstimatorId(${JSON.stringify(bad)}) must throw E_TOKEN_ESTIMATOR_INCOMPATIBLE`,
    );
  }
  assert.doesNotThrow(() => assertTokenEstimatorId("ega-o200k-v1"));
});

test("estimator gate: golden materialize path calls the gate; non-id estimator object throws before count", () => {
  // The golden materialize path (skill-materialize.mjs countContentTokens,
  // which golden-setup registry builds run through) gates EVERY count on the
  // canonical estimator id before counting.
  assert.equal(tokenEstimator.id, "ega-o200k-v1");
  assert.ok(countContentTokens("golden materialize path invokes the estimator gate") > 0);

  // A non-id estimator OBJECT is intercepted by the production gate before its
  // count can ever run: assertTokenEstimatorCompatibility is the gate entry
  // point that must be satisfied before any counting happens.
  let counted = 0;
  const fakeEstimator = {
    id: "not-ega-o200k-v1",
    count(text) {
      counted += 1;
      return 7;
    },
  };
  assert.throws(
    () => assertTokenEstimatorCompatibility(fakeEstimator, []),
    (error) =>
      error instanceof TokenEstimatorError && error.code === "E_TOKEN_ESTIMATOR_INCOMPATIBLE",
    "a non-id estimator object must throw E_TOKEN_ESTIMATOR_INCOMPATIBLE on the count path",
  );
  assert.equal(counted, 0, "the gate must reject the non-id estimator object BEFORE count runs");

  // Count through the golden path's exact gate invocation on a non-id
  // estimator object's id throws the same frozen code (the object's count is
  // unreachable without the canonical id).
  assert.throws(
    () => {
      assertTokenEstimatorId(fakeEstimator.id);
      fakeEstimator.count("unreachable");
    },
    (error) =>
      error instanceof TokenEstimatorError && error.code === "E_TOKEN_ESTIMATOR_INCOMPATIBLE",
  );
});

// ---------------------------------------------------------------------------
// Group 3 — warm benchmark: 100-skill registry (20 fixtures x 5 namespaces).
// ---------------------------------------------------------------------------

// Mirror of golden-setup's productionSkillMd (module-private there): the
// production parser's portableFrontmatterSchema is strict, so routing-field
// lines are dropped exactly as the golden registry builds do.
function productionSkillMd(skillMd) {
  const lines = skillMd.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) {
    throw new Error("materialized SKILL.md lacks YAML frontmatter delimiters");
  }
  const kept = lines.slice(1, end).filter((line) => /^(name|description): /.test(line));
  return ["---", ...kept, ...lines.slice(end)].join("\n");
}

/** Portable (directory) name: the part after the single `/` of the canonical id. */
function portableNameOf(canonicalId) {
  return canonicalId.slice(canonicalId.indexOf("/") + 1);
}

const BENCH_NAMESPACES = ["bench-a", "bench-b", "bench-c", "bench-d", "bench-e"];

/**
 * Synthesize a 100-skill registry: every one of the 20 SKILL_FIXTURES
 * materialized under each of the 5 synthetic namespaces, imported through the
 * production importer exactly as golden-setup registry builds do.
 * @returns {Promise<{home: string, count: number}>}
 */
async function buildBenchRegistry() {
  const base = await mkdtemp(join(tmpdir(), "ega-bench-registry-"));
  const home = join(base, "home");
  await mkdir(home, { recursive: true });

  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  let count = 0;
  try {
    for (const namespace of BENCH_NAMESPACES) {
      for (const fixture of SKILL_FIXTURES) {
        const name = portableNameOf(fixture.canonicalId);
        const root = join(base, "src", namespace, name);
        const materialized = materializeSkill(fixture);
        // Synthesized bench namespaces must not carry the golden alias claim
        // (skill-alias-conflict-v1 and skill-frontend-mobile-v1 BOTH declare
        // alias "mobile-ui" — the exact ROUTER_EXCLUDED conflict). Aliases
        // carry no routing/timing signal here and no explicitSkills are used,
        // so the bench yaml drops the aliases list for every import.
        const egaYaml = materialized.egaYaml.replace(
          /aliases:\n(?:  - [^\n]*\n)*/,
          "aliases: []\n",
        );
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "SKILL.md"), productionSkillMd(materialized.skillMd));
        if (materialized.coreMdOrNull !== null) {
          await writeFile(join(root, "SKILL.core.md"), materialized.coreMdOrNull);
        }
        await writeFile(join(root, "ega.yaml"), egaYaml);

        const summary = await importSkills(registry, { path: root, namespace });
        if (summary.failed !== 0) {
          throw new Error(
            `BENCH_IMPORT_FAILED: ${namespace}/${name}: ${JSON.stringify(summary.failures)}`,
          );
        }
        count += 1;
      }
    }
  } finally {
    registry.close();
  }

  if (count !== 100) {
    throw new Error(`BENCH_REGISTRY_INVALID: imported ${count} skills, expected 100`);
  }
  return { home, count };
}

test(
  "warm benchmark: 100-skill registry, 30 timed resolves, p95 <= 300ms",
  { timeout: 600_000 },
  async () => {
    const { home, count } = await buildBenchRegistry();
    const project = await buildGoldenProject("nextjs-web");
    const task = "Fix a hydration mismatch in this Next.js dashboard.";
    const env = { ...process.env, EGA_SKILLS_HOME: home };
    const resolveOnce = () =>
      resolveSkills({
        task,
        projectPath: project.projectPath,
        policy: derivePolicy(project.projectPath),
        env,
      });

    // Warm-up: 5 resolves to settle lazy registries/encoders/caches.
    for (let i = 0; i < 5; i += 1) {
      await resolveOnce();
    }

    const samples = [];
    for (let i = 0; i < 30; i += 1) {
      const start = performance.now();
      await resolveOnce();
      samples.push(performance.now() - start);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    // Nearest-rank p95 over 30 samples: ceil(0.95*30)=29th smallest (1-based).
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];

    console.log(`[BENCH] registry skills=${count} namespaces=${BENCH_NAMESPACES.length}`);
    console.log(
      `[BENCH] samples(ms)=${samples.map((s) => s.toFixed(1)).join(", ")}`,
    );
    console.log(`[BENCH] min=${sorted[0].toFixed(1)} median=${sorted[14].toFixed(1)} p95=${p95.toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)}`);

    assert.ok(
      p95 <= 300,
      `warm benchmark p95 ${p95.toFixed(1)}ms exceeds the 300ms budget`,
    );
  },
);