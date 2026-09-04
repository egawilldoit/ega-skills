// Golden router scenario runner (TEST-001 §5.1.0–§5.1.7, EGA-580).
//
// runGoldenScenario(scenario) executes the scenario against a LIVE
// ResolutionResult produced by the PRODUCTION resolver (packages/router dist)
// on a registry + project tree built fresh through golden-setup.mjs, then
// asserts the scenario's `expected` contract. GOLDEN IS ORACLE: mismatches are
// reported, never repaired; routing expectations are never weakened and no
// router code is touched.
//
// Request overrides honored:
//   - skillCatalogFixture (omitted => normative "router-default" catalog)
//   - explicitSkills -> ResolveInput.explicitSkills
//   - maxSkills / maxTokens -> ResolveInput.budget (only when present)
//   - equivalentProjectFixture -> rerun the identical request against that
//     fixture and require deep equality of ALL result fields except
//     resolutionId after realpath normalization (symlinked-cwd contract).
//
// Assertion semantics (normative §5.1.0):
//   - mustExplicit/mustSelect/mustCandidate/mustReject: subset membership in
//     the corresponding output collection (explicit/selected/candidates/
//     rejected).
//   - mustNotSelect: listed IDs MUST be absent from selected.
//   - explicitOrder/selectedOrder/candidateOrder: exact equality of the
//     collection's id order.
//   - rejectedPrefixOrder: rejected ids MUST begin with exactly those ids.
//   - confidence: element-wise equality against [result.confidence] (the
//     resolver emits a single scalar confidence per resolution).
//   - lockStatus/budgetStatus: exact equality.
//   - requiredReasonsBySkill: every listed reason MUST occur on the skill's
//     entry in whichever output collection holds it.
//   - requiredWarningsBySkill: every listed warning MUST occur on that
//     successful EXPLICIT skill result (§5.1.0).
//   - requiredRecommendedContentBySkill: the skill's entry in
//     explicit/selected/candidates MUST expose the exact
//     recommendedContentLevel and recommendedContentTokens.
//
// Failure objects: { scenario: <id>, code, assertion, expected, actual,
// detail } with `code` drawn ONLY from the frozen GOLDEN_* set (§5.1.7):
//   GOLDEN_FIXTURE_INVALID            setup/resolve threw (fixture or request)
//   GOLDEN_EXPECTED_SELECTION_MISSING expected member/order/reason/warning/
//                                     content/status absent or inexact
//   GOLDEN_UNEXPECTED_SELECTION       mustNotSelect member present in selected
//   GOLDEN_CONFIDENCE_MISMATCH        confidence element-wise mismatch
//   GOLDEN_TOKEN_BUDGET_EXCEEDED      budgetStatus equality mismatch
//   GOLDEN_NON_DETERMINISTIC          equivalentProjectFixture rerun differs
//                                     (all fields but resolutionId, after
//                                     realpath normalization)

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import { resolveSkills } from "../../../packages/router/dist/index.js";
import {
  buildGoldenProject,
  buildRegistryForCatalog,
} from "./golden-setup.mjs";

/** Frozen golden diagnostic codes (TEST-001 §5.1.7); never runtime E_* codes. */
export const GOLDEN_CODES = Object.freeze({
  GOLDEN_FIXTURE_INVALID: "GOLDEN_FIXTURE_INVALID",
  GOLDEN_EXPECTED_SELECTION_MISSING: "GOLDEN_EXPECTED_SELECTION_MISSING",
  GOLDEN_UNEXPECTED_SELECTION: "GOLDEN_UNEXPECTED_SELECTION",
  GOLDEN_CONFIDENCE_MISMATCH: "GOLDEN_CONFIDENCE_MISMATCH",
  GOLDEN_TOKEN_BUDGET_EXCEEDED: "GOLDEN_TOKEN_BUDGET_EXCEEDED",
  GOLDEN_NON_DETERMINISTIC: "GOLDEN_NON_DETERMINISTIC",
});

function fmt(value) {
  return JSON.stringify(value);
}

/**
 * Realpath-normalize one path value: symlinked-cwd contract. Non-absolute or
 * missing paths (already relative/normalized or gone) are kept unchanged.
 */
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

/**
 * Deep-compare shape used by the equivalentProjectFixture rerun: every field
 * of the ResolutionResult except resolutionId, with path-bearing fingerprint
 * fields realpath-normalized so a symlinked project equals its canonical twin.
 */
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

/** Recursive deep equality (arrays order-sensitive). */
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

/**
 * Run one frozen golden scenario against a live production resolution.
 * @param {object} scenario RouterGoldenScenario (tests/router/golden scenarios-01..04).
 * @returns {Promise<{pass: boolean, failures: object[]}>}
 */
export async function runGoldenScenario(scenario) {
  const failures = [];
  const fail = (code, assertion, expected, actual) => {
    failures.push({
      scenario: scenario.id,
      code,
      assertion,
      expected,
      actual,
      detail: `${assertion}: expected ${fmt(expected)} actual ${fmt(actual)}`,
    });
  };

  const budget =
    scenario.maxSkills !== undefined || scenario.maxTokens !== undefined
      ? {
          ...(scenario.maxSkills !== undefined ? { maxSkills: scenario.maxSkills } : {}),
          ...(scenario.maxTokens !== undefined ? { maxTokens: scenario.maxTokens } : {}),
        }
      : undefined;

  let result;
  let home;
  try {
    const catalog = scenario.skillCatalogFixture ?? "router-default";
    const registry = await buildRegistryForCatalog(catalog);
    home = registry.home;
    const project = await buildGoldenProject(scenario.projectFixture);
    result = await resolveSkills({
      task: scenario.task,
      projectPath: project.projectPath,
      ...(scenario.explicitSkills !== undefined ? { explicitSkills: scenario.explicitSkills } : {}),
      ...(budget !== undefined ? { budget } : {}),
      env: { ...process.env, EGA_SKILLS_HOME: home },
    });
  } catch (error) {
    fail(
      GOLDEN_CODES.GOLDEN_FIXTURE_INVALID,
      "setup/resolve",
      "catalog build + project build + resolveSkills succeed",
      `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    );
    return { pass: false, failures };
  }

  const ids = (collection) => collection.map((skill) => skill.id);
  const explicitIds = ids(result.explicit);
  const selectedIds = ids(result.selected);
  const candidateIds = ids(result.candidates);
  const rejectedIds = ids(result.rejected);

  const expected = scenario.expected ?? {};

  // --- subset membership -------------------------------------------------
  if (expected.mustExplicit !== undefined) {
    const missing = expected.mustExplicit.filter((id) => !explicitIds.includes(id));
    if (missing.length > 0) {
      fail(
        GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
        "mustExplicit",
        missing,
        explicitIds,
      );
    }
  }
  if (expected.mustSelect !== undefined) {
    const missing = expected.mustSelect.filter((id) => !selectedIds.includes(id));
    if (missing.length > 0) {
      fail(
        GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
        "mustSelect",
        missing,
        selectedIds,
      );
    }
  }
  if (expected.mustNotSelect !== undefined) {
    const present = expected.mustNotSelect.filter((id) => selectedIds.includes(id));
    if (present.length > 0) {
      fail(
        GOLDEN_CODES.GOLDEN_UNEXPECTED_SELECTION,
        "mustNotSelect",
        "absent from selected",
        present,
      );
    }
  }
  if (expected.mustCandidate !== undefined) {
    const missing = expected.mustCandidate.filter((id) => !candidateIds.includes(id));
    if (missing.length > 0) {
      fail(
        GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
        "mustCandidate",
        missing,
        candidateIds,
      );
    }
  }
  if (expected.mustReject !== undefined) {
    const missing = expected.mustReject.filter((id) => !rejectedIds.includes(id));
    if (missing.length > 0) {
      fail(
        GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
        "mustReject",
        missing,
        rejectedIds,
      );
    }
  }

  // --- exact order equality ---------------------------------------------
  if (expected.explicitOrder !== undefined) {
    if (!deepEqual(expected.explicitOrder, explicitIds)) {
      fail(
        GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
        "explicitOrder",
        expected.explicitOrder,
        explicitIds,
      );
    }
  }
  if (expected.selectedOrder !== undefined) {
    if (!deepEqual(expected.selectedOrder, selectedIds)) {
      fail(
        GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
        "selectedOrder",
        expected.selectedOrder,
        selectedIds,
      );
    }
  }
  if (expected.candidateOrder !== undefined) {
    if (!deepEqual(expected.candidateOrder, candidateIds)) {
      fail(
        GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
        "candidateOrder",
        expected.candidateOrder,
        candidateIds,
      );
    }
  }
  if (expected.rejectedPrefixOrder !== undefined) {
    const prefix = rejectedIds.slice(0, expected.rejectedPrefixOrder.length);
    if (!deepEqual(expected.rejectedPrefixOrder, prefix)) {
      fail(
        GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
        "rejectedPrefixOrder",
        expected.rejectedPrefixOrder,
        prefix,
      );
    }
  }

  // --- confidence element-wise ------------------------------------------
  if (expected.confidence !== undefined) {
    const actualConfidence = [result.confidence];
    if (
      actualConfidence.length !== expected.confidence.length ||
      !expected.confidence.every((level, i) => level === actualConfidence[i])
    ) {
      fail(
        GOLDEN_CODES.GOLDEN_CONFIDENCE_MISMATCH,
        "confidence",
        expected.confidence,
        actualConfidence,
      );
    }
  }

  // --- status equality ---------------------------------------------------
  if (expected.lockStatus !== undefined && expected.lockStatus !== result.lockStatus) {
    fail(
      GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
      "lockStatus",
      expected.lockStatus,
      result.lockStatus,
    );
  }
  if (expected.budgetStatus !== undefined && expected.budgetStatus !== result.budgetStatus) {
    fail(
      GOLDEN_CODES.GOLDEN_TOKEN_BUDGET_EXCEEDED,
      "budgetStatus",
      expected.budgetStatus,
      result.budgetStatus,
    );
  }

  // --- per-skill collections ---------------------------------------------
  const resolvedById = new Map(
    [...result.explicit, ...result.selected, ...result.candidates, ...result.rejected].map(
      (skill) => [skill.id, skill],
    ),
  );

  if (expected.requiredReasonsBySkill !== undefined) {
    for (const entry of expected.requiredReasonsBySkill) {
      const skill = resolvedById.get(entry.skillId);
      if (skill === undefined) {
        fail(
          GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
          `requiredReasonsBySkill(${entry.skillId})`,
          `${entry.skillId} present in a result collection`,
          "absent from explicit/selected/candidates/rejected",
        );
        continue;
      }
      const actualReasons = skill.reasons ?? [];
      const missingReasons = entry.reasons.filter((reason) => !actualReasons.includes(reason));
      if (missingReasons.length > 0) {
        fail(
          GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
          `requiredReasonsBySkill(${entry.skillId})`,
          missingReasons,
          actualReasons,
        );
      }
    }
  }

  if (expected.requiredWarningsBySkill !== undefined) {
    // Normative §5.1.0: warnings are asserted on the SUCCESSFUL EXPLICIT
    // skill result only.
    const explicitById = new Map(result.explicit.map((skill) => [skill.id, skill]));
    for (const entry of expected.requiredWarningsBySkill) {
      const skill = explicitById.get(entry.skillId);
      if (skill === undefined) {
        fail(
          GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
          `requiredWarningsBySkill(${entry.skillId})`,
          `${entry.skillId} in successful explicit collection`,
          "absent from explicit",
        );
        continue;
      }
      const actualWarnings = skill.warnings ?? [];
      const missingWarnings = entry.warnings.filter((warning) => !actualWarnings.includes(warning));
      if (missingWarnings.length > 0) {
        fail(
          GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
          `requiredWarningsBySkill(${entry.skillId})`,
          missingWarnings,
          actualWarnings,
        );
      }
    }
  }

  if (expected.requiredRecommendedContentBySkill !== undefined) {
    for (const entry of expected.requiredRecommendedContentBySkill) {
      const skill = resolvedById.get(entry.skillId);
      if (skill === undefined || skill.recommendedContentLevel === undefined) {
        fail(
          GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
          `requiredRecommendedContentBySkill(${entry.skillId})`,
          `${entry.skillId} in explicit/selected/candidates`,
          "absent",
        );
        continue;
      }
      const actual = {
        level: skill.recommendedContentLevel,
        tokens: skill.recommendedContentTokens,
      };
      const expectedContent = { level: entry.level, tokens: entry.tokens };
      if (!deepEqual(expectedContent, actual)) {
        fail(
          GOLDEN_CODES.GOLDEN_EXPECTED_SELECTION_MISSING,
          `requiredRecommendedContentBySkill(${entry.skillId})`,
          expectedContent,
          actual,
        );
      }
    }
  }

  // --- equivalentProjectFixture determinism rerun ------------------------
  if (scenario.equivalentProjectFixture !== undefined) {
    try {
      const second = await buildGoldenProject(scenario.equivalentProjectFixture);
      const rerun = await resolveSkills({
        task: scenario.task,
        projectPath: second.projectPath,
        ...(scenario.explicitSkills !== undefined ? { explicitSkills: scenario.explicitSkills } : {}),
        ...(budget !== undefined ? { budget } : {}),
        env: { ...process.env, EGA_SKILLS_HOME: home },
      });
      const firstCompared = comparableResult(result);
      const secondCompared = comparableResult(rerun);
      if (!deepEqual(firstCompared, secondCompared)) {
        fail(
          GOLDEN_CODES.GOLDEN_NON_DETERMINISTIC,
          "equivalentProjectFixture rerun (all fields except resolutionId, realpath-normalized)",
          firstCompared,
          secondCompared,
        );
      }
    } catch (error) {
      fail(
        GOLDEN_CODES.GOLDEN_FIXTURE_INVALID,
        "equivalentProjectFixture rerun",
        "equivalent project build + resolveSkills succeed",
        `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
      );
    }
  }

  return { pass: failures.length === 0, failures };
}