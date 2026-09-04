// SPEC-004 §5.1.6/§5.1.7/§5.1.20 automatic content-level and token-budget
// composition (EGA-577).
//
// Input rows arrive in router-rank order (tiers/tie-break from EGA-575,
// redundancy suppression from EGA-576 applied upstream). This stage decides
// automatic membership ONLY: which ranked rows become `selected`
// recommendations and which remain `candidates`.
//
// Selection rules (exact, §5.1.6 + §5.1.20):
//  - Only Tier A/B rows are eligible. Tier C (and any non-A/B row) is never
//    selected and passes through to `candidates` untouched (§5.1.20.1).
//  - OVERSIZED L2 NEVER auto-selects in V1 — even under a 20,000-token
//    budget — and stays a candidate with `CONTENT_OVERSIZED` (§5.1.6.3).
//  - A missing recommended level (null tokens) is represented with
//    `CONTENT_MISSING`; no silent truncation, no substitute content
//    (§5.1.6.4).
//  - A relevant too-large row stays a candidate with `TOKEN_BUDGET`
//    (§5.1.6.2). All counts use `ega-o200k-v1` upstream; we never re-count.
//  - Otherwise the row is selected while `selected.length < maxSkills`
//    (§5.1.20.2–3). The THIRD selection additionally requires
//    maxSkills === 3 AND >= 1 unique strong TASK_TRIGGER/DOMAIN evidence
//    value not covered by the first two selections (§5.1.20.4, §5.1.16.4).
//  - Rows that fit but cannot be selected (composition limit reached or the
//    third-selection uniqueness gate failed) stay candidates with their
//    incoming reasons unchanged — "relevant items beyond the composition
//    limit" (§5.1.19.1); no fabricated negative reason is invented for them.
//
// Negative reasons are appended in NEGATIVE_REASONS frozen order
// (§5.1.18). Selected totals NEVER exceed `maxTokens`/`maxSkills` (§5.1.6.5).

import { NEGATIVE_REASONS } from "./types.js";
import type {
  CompatibilityWarning,
  ContentLevel,
  ResolvedSkill,
  RoutingEvidence,
  RoutingTier,
} from "./types.js";

export type L2SizeClass = "NORMAL" | "LARGE" | "OVERSIZED";

/** One ranked automatic row (tiers/tie-break output, router-rank order). */
export interface ComposeAutomaticRow {
  readonly id: string;
  readonly name: string;
  readonly versionHash: string;
  readonly tier: RoutingTier;
  readonly evidence: RoutingEvidence[];
  readonly reasons: string[];
  readonly recommendedContentLevel: ContentLevel;
  readonly recommendedContentTokens: number | null;
  readonly l2SizeClass: L2SizeClass;
}

export interface ComposeAutomaticInput {
  /** Rows in router-rank order; membership is decided in this order. */
  readonly rows: readonly ComposeAutomaticRow[];
  /** Effective automatic maxSkills (1–3 per §5.1.7). */
  readonly maxSkills: number;
  /** Effective automatic token budget (per §5.1.7). */
  readonly maxTokens: number;
  /**
   * Active lock: every emitted row uses its locked version, so rows carry
   * LOCKED_VERSION in positive emission position (EGA-579 resolver wiring).
   */
  readonly locked?: boolean;
}

export interface ComposeAutomaticOutput {
  /** Automatic recommendations, router-rank order, at most `maxSkills`. */
  readonly selected: ResolvedSkill[];
  /** Relevant rows NOT selected, router-rank order, negatives appended. */
  readonly candidates: ComposeAutomaticRow[];
  readonly automaticSelectedTokens: number;
}

const NEGATIVE_ORDER = new Map<string, number>(
  NEGATIVE_REASONS.map((reason, index) => [reason, index]),
);

/** Append negatives in frozen §5.1.18 emission order, preserving positives. */
function withNegatives(
  row: ComposeAutomaticRow,
  negatives: readonly string[],
): ComposeAutomaticRow {
  if (negatives.length === 0) return row;
  const appended = [...negatives].sort(
    (a, b) => (NEGATIVE_ORDER.get(a) ?? 0) - (NEGATIVE_ORDER.get(b) ?? 0),
  );
  return { ...row, reasons: [...row.reasons, ...appended] };
}

/**
 * True when the row contributes at least one strong TASK_TRIGGER/DOMAIN
 * evidence value not already covered by the first two selections.
 */
function hasUniqueStrongValue(
  row: ComposeAutomaticRow,
  covered: ReadonlySet<string>,
): boolean {
  return row.evidence.some(
    (record) =>
      (record.category === "TASK_TRIGGER" || record.category === "DOMAIN") &&
      !covered.has(record.value),
  );
}

/** Collect the strong TASK_TRIGGER/DOMAIN values of a row into `covered`. */
function coverStrongValues(row: ComposeAutomaticRow, covered: Set<string>): void {
  for (const record of row.evidence) {
    if (record.category === "TASK_TRIGGER" || record.category === "DOMAIN") {
      covered.add(record.value);
    }
  }
}

/** Mark locked-version rows in positive emission position (before negatives). */
function withLocked(row: ComposeAutomaticRow): ComposeAutomaticRow {
  if (row.reasons.includes("LOCKED_VERSION")) return row;
  return { ...row, reasons: [...row.reasons, "LOCKED_VERSION"] };
}

export function composeAutomatic(input: ComposeAutomaticInput): ComposeAutomaticOutput {
  const selected: ResolvedSkill[] = [];
  const candidates: ComposeAutomaticRow[] = [];
  /** TASK_TRIGGER/DOMAIN values covered by the first two selections (§5.1.20.4). */
  const covered = new Set<string>();
  let remaining = input.maxTokens;

  for (const row of input.rows) {
    const effective = input.locked === true ? withLocked(row) : row;
    if (effective.tier !== "A" && effective.tier !== "B") {
      // Tier C (or any non-A/B row) is candidate-only, untouched.
      candidates.push(effective);
      continue;
    }
    if (effective.l2SizeClass === "OVERSIZED") {
      candidates.push(withNegatives(effective, ["CONTENT_OVERSIZED"]));
      continue;
    }
    if (effective.recommendedContentTokens === null) {
      candidates.push(withNegatives(effective, ["CONTENT_MISSING"]));
      continue;
    }
    const tokens = effective.recommendedContentTokens;
    if (tokens > remaining) {
      candidates.push(withNegatives(effective, ["TOKEN_BUDGET"]));
      continue;
    }

    const selectionIndex = selected.length;
    const isThird = selectionIndex === 2;
    if (isThird) {
      if (input.maxSkills !== 3 || !hasUniqueStrongValue(effective, covered)) {
        candidates.push(effective);
        continue;
      }
    } else if (selectionIndex >= input.maxSkills) {
      candidates.push(effective);
      continue;
    }

    selected.push({
      id: effective.id,
      name: effective.name,
      versionHash: effective.versionHash,
      tier: effective.tier,
      recommendedContentLevel: effective.recommendedContentLevel,
      recommendedContentTokens: tokens,
      evidence: effective.evidence,
      reasons: effective.reasons,
      warnings: [] as CompatibilityWarning[],
    });
    remaining -= tokens;
    if (selectionIndex < 2) coverStrongValues(effective, covered);
  }

  const automaticSelectedTokens = selected.reduce(
    (sum, skill) => sum + skill.recommendedContentTokens,
    0,
  );

  return { selected, candidates, automaticSelectedTokens };
}