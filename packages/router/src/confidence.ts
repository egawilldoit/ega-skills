// SPEC-004 §5.1.17–§5.1.18 confidence and reason codes (EGA-578).
//
// Confidence is computed AFTER provisional composition from deterministic
// evidence only: HIGH (top Tier A, >=2 strong categories, no equivalent
// Tier A competitor, workspace unambiguous), MEDIUM (useful Tier A missing a
// HIGH condition, or Tier B with strong task evidence), LOW (no Tier A/B
// with strong task evidence, ambiguous workspace, or nothing useful).
// LOW normalizes to selected=[] and automaticSelectedTokens=0, retaining at
// most three relevant candidates. No numeric scores, no free-form conflict
// heuristics. Only frozen reason codes are ever emitted.

import { COMPATIBILITY_WARNINGS, NEGATIVE_REASONS, POSITIVE_REASONS } from "./types.js";
import type { Confidence, RoutingEvidence } from "./types.js";

export interface ConfidenceRow {
  readonly id: string;
  readonly tier: "A" | "B" | "C";
  readonly evidence: readonly RoutingEvidence[];
  readonly reasons: readonly string[];
}

export interface ConfidenceInput {
  /** Provisional automatic selection in rank order (pre-normalization). */
  readonly selected: readonly ConfidenceRow[];
  /** Provisional candidates in rank order. */
  readonly candidates: readonly ConfidenceRow[];
  readonly automaticSelectedTokens: number;
  readonly workspaceAmbiguous: boolean;
}

export interface ConfidenceResult {
  readonly confidence: Confidence;
  readonly selected: ConfidenceRow[];
  readonly automaticSelectedTokens: number;
  readonly candidates: ConfidenceRow[];
}

const STRONG_CATEGORIES = ["FRAMEWORK", "PLATFORM", "TASK_TRIGGER", "DOMAIN", "NAME_DESCRIPTION"] as const;
const STRONG_TASK_CATEGORIES = ["TASK_TRIGGER", "DOMAIN", "NAME_DESCRIPTION"] as const;

function distinctStrongCategories(evidence: readonly RoutingEvidence[]): number {
  return new Set(
    evidence.filter((record) => (STRONG_CATEGORIES as readonly string[]).includes(record.category)).map((record) => record.category),
  ).size;
}

function strongTaskValues(evidence: readonly RoutingEvidence[]): Set<string> {
  const values = new Set<string>();
  for (const record of evidence) {
    if ((STRONG_TASK_CATEGORIES as readonly string[]).includes(record.category)) {
      values.add(`${record.category}:${record.value}`);
    }
  }
  return values;
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/** True for every code in the three frozen enums (§5.1.18). */
export function isFrozenReasonCode(code: string): boolean {
  return (
    POSITIVE_REASONS.includes(code) ||
    NEGATIVE_REASONS.includes(code) ||
    (COMPATIBILITY_WARNINGS as readonly string[]).includes(code)
  );
}

export function assessConfidence(input: ConfidenceInput): ConfidenceResult {
  const inPlay = [...input.selected, ...input.candidates].filter(
    (row) => row.tier === "A" || row.tier === "B",
  );
  const relevant = [...input.selected, ...input.candidates].filter((row) => row.evidence.length > 0);
  const top = inPlay[0];

  let confidence: Confidence;
  if (input.workspaceAmbiguous) {
    confidence = "LOW";
  } else if (top === undefined || !inPlay.some((row) => strongTaskValues(row.evidence).size > 0)) {
    confidence = "LOW";
  } else if (top.tier === "A") {
    const topValues = strongTaskValues(top.evidence);
    const competitor = inPlay
      .slice(1)
      .some((row) => row.tier === "A" && sameStringSet(strongTaskValues(row.evidence), topValues));
    confidence =
      distinctStrongCategories(top.evidence) >= 2 && !competitor ? "HIGH" : "MEDIUM";
  } else {
    confidence = inPlay.some(
      (row) => row.tier === "B" && strongTaskValues(row.evidence).size > 0,
    )
      ? "MEDIUM"
      : "LOW";
  }

  if (confidence !== "LOW") {
    return {
      confidence,
      selected: [...input.selected],
      automaticSelectedTokens: input.automaticSelectedTokens,
      candidates: [...input.candidates],
    };
  }

  const retained = relevant.slice(0, 3);
  return {
    confidence: "LOW",
    selected: [],
    automaticSelectedTokens: 0,
    candidates: input.workspaceAmbiguous
      ? retained.map((row) => ({
          ...row,
          reasons: row.reasons.includes("WORKSPACE_AMBIGUOUS")
            ? [...row.reasons]
            : [...row.reasons, "WORKSPACE_AMBIGUOUS"],
        }))
      : retained,
  };
}
