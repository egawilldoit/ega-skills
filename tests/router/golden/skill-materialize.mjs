// Golden skill materializer for TEST-001 router scenarios (EGA-580).
// Pure and deterministic: the same entry always materializes byte-identical
// SKILL.md / SKILL.core.md / ega.yaml strings. Token budgeting uses the
// production ega-o200k-v1 estimator from packages/schema.

import { SKILL_FIXTURES } from "./catalog-data.mjs";
import {
  assertTokenEstimatorId,
  tokenEstimator,
} from "../../../packages/schema/dist/index.js";

// Neutral filler sentence: intentionally carries no routing significance and
// contains none of the fixture trigger phrases.
const FILLER_SENTENCE =
  "This neutral filler sentence carries no routing significance; it exists solely to calibrate deterministic token budgets for golden materialization.";

// Hard cap on padding-loop iterations (deterministic convergence guarantee).
const MAX_PADDING_ITERATIONS = 50;
// Block cap per iteration keeps the loop well under the iteration cap even for
// the 13000-token oversized target (>= 1 token per unit => <= 26 iterations).
const MAX_UNITS_PER_ITERATION = 500;

/**
 * Count content tokens with the production ega-o200k-v1 estimator.
 * Refuses to proceed if the estimator id is not the expected one.
 * @param {string} text
 * @returns {number}
 */
export function countContentTokens(text) {
  assertTokenEstimatorId(tokenEstimator.id);
  return tokenEstimator.count(text);
}

/** Portable (directory) name: the part after the single `/` of the canonical id. */
function portableNameOf(canonicalId) {
  return canonicalId.slice(canonicalId.indexOf("/") + 1);
}

/** Deterministic description derived from the fixture identity itself. */
function descriptionOf(entry) {
  return `Golden TEST-001 fixture skill for ${entry.canonicalId} (${entry.fixtureId}).`;
}

function yamlString(value) {
  return JSON.stringify(value);
}

/** Emit a YAML list: `[]` for empty, indented block items otherwise. */
function yamlListField(label, items) {
  if (items.length === 0) {
    return `${label}: []`;
  }
  return `${label}:\n${items.map((item) => `  - ${yamlString(item)}`).join("\n")}`;
}

function buildFrontmatter(entry, name) {
  return [
    "---",
    `name: ${name}`,
    `description: ${yamlString(descriptionOf(entry))}`,
    yamlListField("domains", entry.domains),
    yamlListField("platforms", entry.platforms),
    yamlListField("frameworks", entry.frameworks),
    yamlListField("triggers", entry.triggers),
    "---",
  ].join("\n");
}

/** One-line body statement embedding every trigger phrase of the entry. */
function triggersLine(entry) {
  if (entry.triggers.length === 0) {
    return "This skill declares no trigger phrases.";
  }
  return `This skill applies when the request mentions: ${entry.triggers.join(", ")}.`;
}

function buildSkillBody(entry, name) {
  return [
    `# ${name}`,
    "",
    "Golden TEST-001 fixture skill materialized from catalog-data.mjs.",
    "",
    "## Triggers",
    "",
    triggersLine(entry),
  ].join("\n");
}

function buildCoreBody(entry, name) {
  return [
    `# ${name} Core`,
    "",
    "Golden L1 core fixture materialized from catalog-data.mjs.",
    "",
    "## Triggers",
    "",
    triggersLine(entry),
  ].join("\n");
}

/**
 * Pad `content` with repeated neutral sentences toward `targetTokens`,
 * never exceeding the target. Iterative: each iteration measures the real
 * marginal token cost of one filler unit with the production estimator,
 * appends as many whole units as fit, and recounts. Repeated identical units
 * tokenize exactly linearly, so the result never exceeds the target. When
 * fewer than one whole unit remains, a residual refinement probes
 * word-prefixes of the filler sentence for an exact-marginal match, which
 * makes exact-target hits possible. Hard 50-iteration cap (every estimator
 * count is one iteration).
 */
function padToward(content, targetTokens) {
  let current = content;
  let tokens = countContentTokens(current);
  let iterations = 0;
  while (tokens < targetTokens && iterations < MAX_PADDING_ITERATIONS) {
    const unit = `\n${FILLER_SENTENCE}`;
    const marginal = countContentTokens(`${current}${unit}`) - tokens;
    if (marginal <= 0) {
      break;
    }
    const remaining = targetTokens - tokens;
    if (remaining < marginal) {
      // Residual phase: find the first filler prefix whose measured marginal
      // equals the residual exactly (deterministic probe order).
      const words = FILLER_SENTENCE.split(" ");
      let matched = false;
      for (let k = 1; k <= words.length && iterations < MAX_PADDING_ITERATIONS; k += 1) {
        const prefix = words.slice(0, k).join(" ");
        if (countContentTokens(`${current}\n${prefix}`) - tokens === remaining) {
          current = `${current}\n${prefix}`;
          matched = true;
          break;
        }
        iterations += 1;
      }
      if (!matched) {
        break;
      }
      tokens = countContentTokens(current);
      break;
    }
    const units = Math.floor(remaining / marginal);
    current += unit.repeat(Math.min(units, MAX_UNITS_PER_ITERATION));
    tokens = countContentTokens(current);
    iterations += 1;
  }
  if (tokens > targetTokens) {
    // Invariant guard: unreachable given exact per-unit linearity.
    throw new Error(
      `padding overshot target ${targetTokens} with ${tokens} tokens`,
    );
  }
  return current;
}

/**
 * Materialize one golden skill fixture into its three control files.
 * @param {import("./catalog-data.mjs").SkillFixture-like} entry
 * @returns {{skillMd: string, coreMdOrNull: string|null, egaYaml: string}}
 */
export function materializeSkill(entry) {
  const resolved =
    SKILL_FIXTURES.find((fixture) => fixture.fixtureId === entry.fixtureId) ??
    entry;
  const name = portableNameOf(resolved.canonicalId);
  const frontmatter = buildFrontmatter(resolved, name);

  let skillMd = `${frontmatter}\n${buildSkillBody(resolved, name)}`;
  if (resolved.l2.tokenTarget !== null && resolved.l2.tokenTarget !== undefined) {
    // Boundary L2 fixtures carry an exact L2 token target.
    skillMd = padToward(skillMd, resolved.l2.tokenTarget);
  }

  let coreMdOrNull = null;
  if (resolved.l1.status === "AUTHORED") {
    // Authored L1: pad the core toward the L1 token target (<= 900), far under
    // the 1200-token sanity ceiling this suite enforces.
    coreMdOrNull = padToward(buildCoreBody(resolved, name), resolved.l1.tokenTarget);
  }

  // Minimal valid ega.yaml: schema_version: 1 alone parses to empty routing
  // metadata (routing lives in the fixture catalog for TEST-001 scenarios).
  const egaYaml = "schema_version: 1\n";

  return { skillMd, coreMdOrNull, egaYaml };
}