// EGA-587 integration gate: resolver-derived policy ≡ harness-derived policy.
//
// SPEC-005 §5.1.12 (EGA-587): when `resolveSkills` is called WITHOUT
// `input.policy`, the production resolver must derive the effective policy
// from the REAL project tree through the production project subsystem
// (discoverConfig + readConfigAndLock + PROJECT_CONFIG_V1_DEFAULTS +
// resolveLockMode — see packages/router/src/resolver.ts deriveProjectPolicy).
//
// This test proves the integration end-to-end on three golden scenarios
// covering the three effective-policy regimes:
//
//   G001 (scenarios-01) — plain: no control files, V1 built-in defaults,
//                          UNLOCKED, currents resolve.
//   G025 (scenarios-03) — namespace deny: .egaskills.yaml denies the
//                          `experimental` namespace; explicit reference is
//                          rejected with NAMESPACE_DENIED.
//   G026 (scenarios-03) — active lock: adjacent .egaskills.lock pins
//                          immutable versions; LOCKED regime, explicit
//                          reference rejected with VERSION_NOT_LOCKED.
//
// For each scenario the SAME built catalog and SAME project tree are resolved
// TWICE through the production resolver:
//   1. policy OMITTED  -> resolver derives it via the real project subsystem
//   2. policy SUPPLIED -> the harness-derived explicit policy (the same
//                         derivePolicy the golden runner uses, exported from
//                         golden/runner.mjs — no mirrored config/lock logic)
// and the two ResolutionResults must be IDENTICAL on every field except
// resolutionId (a per-resolution randomUUID — the one permitted difference).
// Scenario contract sanity checks run on the resolver-derived result so the
// equivalence cannot pass vacuously on an empty/wrong resolution.
//
// Tests import the built packages (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { resolveSkills } from "../../packages/router/dist/index.js";
import {
  buildGoldenProject,
  buildRegistryForCatalog,
} from "./golden/golden-setup.mjs";
import { derivePolicy } from "./golden/runner.mjs";
import { SCENARIOS_01 } from "./golden/scenarios-01.mjs";
import { SCENARIOS_03 } from "./golden/scenarios-03.mjs";

const EQUIVALENT_SCENARIO_IDS = Object.freeze(["G001", "G025", "G026"]);

function findByScenarioId(scenarios, id) {
  const found = scenarios.find((scenario) => scenario.id === id);
  assert.ok(
    found !== undefined,
    `scenario ${id} must exist in the golden corpus (contract drift)`,
  );
  return found;
}

// One permitted difference: resolutionId is a per-resolution randomUUID.
function withoutResolutionId(result) {
  const { resolutionId, ...rest } = result;
  return { ...rest, resolutionId: undefined };
}

/**
 * Run one equivalence case. Builds the scenario's catalog + project ONCE,
 * resolves twice against those exact trees (policy omitted vs explicit
 * harness-derived policy), and returns both full results.
 */
async function resolveDerivedAndSupplied(scenario) {
  const catalog = scenario.skillCatalogFixture ?? "router-default";
  const registry = await buildRegistryForCatalog(catalog);
  const project = await buildGoldenProject(scenario.projectFixture);
  const env = { ...process.env, EGA_SKILLS_HOME: registry.home };

  const common = {
    task: scenario.task,
    projectPath: project.projectPath,
    ...(scenario.explicitSkills !== undefined
      ? { explicitSkills: scenario.explicitSkills }
      : {}),
    env,
  };

  // 1) policy OMITTED: the resolver must derive it from the real project tree.
  const derived = await resolveSkills({ ...common });
  // 2) policy SUPPLIED: the harness-derived explicit policy over the SAME tree.
  const policy = derivePolicy(project.projectPath);
  const supplied = await resolveSkills({ ...common, policy });

  return { derived, supplied, policy, cleanup: () => {
    const registryBase = join(registry.home, "..");
    return Promise.all([
      rm(registryBase, { recursive: true, force: true }),
      rm(project.dir, { recursive: true, force: true }),
    ]);
  } };
}

// Scenario contract sanity checks (run on the resolver-derived result): the
// equivalence must hold over a NON-TRIVIAL resolution, not two empty ones.
const SANITY = {
  G001: (result) => {
    const selectedIds = result.selected.map((skill) => skill.id);
    assert.ok(
      selectedIds.includes("ega/react-frontend"),
      "G001 derived: ega/react-frontend must be selected",
    );
    assert.ok(
      selectedIds.includes("ega/systematic-debugging"),
      "G001 derived: ega/systematic-debugging must be selected",
    );
    assert.ok(
      !selectedIds.includes("ega/frontend-mobile"),
      "G001 derived: ega/frontend-mobile must NOT be selected",
    );
    assert.equal(result.confidence, "HIGH");
  },
  G025: (result) => {
    const rejected = result.rejected.find(
      (skill) => skill.id === "experimental/react-helper",
    );
    assert.ok(rejected, "G025 derived: experimental/react-helper must be rejected");
    assert.ok(
      rejected.reasons.includes("NAMESPACE_DENIED"),
      "G025 derived: rejection reason NAMESPACE_DENIED",
    );
  },
  G026: (result) => {
    assert.equal(result.lockStatus, "LOCKED");
    const rejected = result.rejected.find((skill) => skill.id === "ega/react-frontend");
    assert.ok(rejected, "G026 derived: ega/react-frontend must be rejected");
    assert.ok(
      rejected.reasons.includes("VERSION_NOT_LOCKED"),
      "G026 derived: rejection reason VERSION_NOT_LOCKED",
    );
  },
};

for (const scenarioId of EQUIVALENT_SCENARIO_IDS) {
  const scenario = findByScenarioId(
    scenarioId === "G001" ? SCENARIOS_01 : SCENARIOS_03,
    scenarioId,
  );

  test(`EGA-587 policy equivalence: ${scenario.id} (${scenario.projectFixture}) — resolver-derived ≡ harness-derived policy`, async (t) => {
    let outcome;
    let cleanup = () => Promise.resolve();
    try {
      const built = await resolveDerivedAndSupplied(scenario);
      cleanup = built.cleanup;
      outcome = built;
    } catch (error) {
      await cleanup();
      throw new Error(
        `POLICY EQUIVALENCE SETUP CRASH on ${scenario.id}: ${error?.stack ?? error}`,
      );
    }
    t.after(() => cleanup());

    const { derived, supplied } = outcome;

    // Both resolutionIds must exist; they are the ONE permitted difference.
    assert.equal(typeof derived.resolutionId, "string");
    assert.equal(typeof supplied.resolutionId, "string");
    assert.ok(derived.resolutionId.length > 0);
    assert.ok(supplied.resolutionId.length > 0);

    // Every field except resolutionId must be identical.
    assert.deepEqual(
      withoutResolutionId(derived),
      withoutResolutionId(supplied),
      `${scenario.id}: policy-omitted and policy-supplied resolutions must agree on every field except resolutionId`,
    );

    // Non-vacuousness: the derived result must honour the scenario contract.
    SANITY[scenario.id](derived);

    console.log(
      `[POLICY EQUIVALENCE] ${scenario.id} PASS (derived-resolver policy ≡ harness-derived policy; only resolutionId differs)`,
    );
  });
}