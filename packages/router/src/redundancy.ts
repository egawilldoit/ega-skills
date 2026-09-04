// SPEC-004 §5.1.16 redundancy suppression (EGA-576).
//
// Runs at resolve pipeline step 9 on the post-tie-break ranked candidate
// list (§5.1.10–§5.1.14); input rows are given in router-rank order, best
// first, so "A precedes B" is exactly "A won the §5.1.14 tie-break".
//
// Candidate B is suppressed behind the earliest earlier kept candidate A
// when ALL of §5.1.16.1 hold:
//   1. A is the same or a stronger tier (rank A=0, B=1, C=2);
//   2. every FRAMEWORK/PLATFORM evidence value of B is present in A;
//   3. B has no TASK_TRIGGER/DOMAIN evidence value absent from A.
// Suppressed rows are RejectedSkill with the frozen negative reason
// REDUNDANT_HIGHER_RANKED and empty evidence (§5.1.15 table, §5.1.16.2) and
// leave `kept`, so they never suppress later rows. Distinct workflow/domain
// evidence composes (§5.1.16.3). Pure: no similarity state is stored across
// resolutions; evaluation is within the input row set only.

import type { RejectedSkill, RoutingEvidence, RoutingTier } from "./types.js";

/** Automatic-only tiers; explicit rows never enter automatic composition. */
export type AutomaticTier = Exclude<RoutingTier, "E">;

export interface RedundancyRow {
  readonly id: string;
  readonly name: string;
  readonly versionHash: string;
  readonly tier: AutomaticTier;
  readonly evidence: readonly RoutingEvidence[];
}

export interface RedundancyInput {
  /** Rows in router-rank order (best first), e.g. after the §5.1.14 tie-break. */
  readonly rows: readonly RedundancyRow[];
}

export interface RedundancyOutput {
  /** Non-suppressed rows, in input order. */
  readonly kept: readonly RedundancyRow[];
  /** Suppressed rows as rejects: REDUNDANT_HIGHER_RANKED, empty evidence. */
  readonly suppressed: readonly RejectedSkill[];
}

/** Coverage categories compared per §5.1.16.1 conditions 2–3. */
const COVERAGE_CATEGORIES = ["FRAMEWORK", "PLATFORM", "TASK_TRIGGER", "DOMAIN"] as const;

function tierRank(tier: AutomaticTier): number {
  return tier === "A" ? 0 : tier === "B" ? 1 : 2;
}

function categoryValues(
  evidence: readonly RoutingEvidence[],
  category: (typeof COVERAGE_CATEGORIES)[number],
): ReadonlySet<string> {
  const values = new Set<string>();
  for (const record of evidence) {
    if (record.category === category) values.add(record.value);
  }
  return values;
}

/** TRUE when `earlier` covers `row` per §5.1.16.1 conditions 1–3. */
function coveredBy(earlier: RedundancyRow, row: RedundancyRow): boolean {
  if (tierRank(earlier.tier) > tierRank(row.tier)) return false;
  for (const category of COVERAGE_CATEGORIES) {
    const earlierValues = categoryValues(earlier.evidence, category);
    for (const value of categoryValues(row.evidence, category)) {
      if (!earlierValues.has(value)) return false;
    }
  }
  return true;
}

/**
 * Suppress redundant candidates behind the earliest earlier kept row that
 * covers them (SPEC-004 §5.1.16). Deterministic, pure, order-respecting.
 */
export function suppressRedundant(input: RedundancyInput): RedundancyOutput {
  const kept: RedundancyRow[] = [];
  const suppressed: RejectedSkill[] = [];
  for (const row of input.rows) {
    const earlier = kept.find((candidate) => coveredBy(candidate, row));
    if (earlier === undefined) {
      kept.push(row);
    } else {
      suppressed.push({
        id: row.id,
        name: row.name,
        versionHash: row.versionHash,
        evidence: [],
        reasons: ["REDUNDANT_HIGHER_RANKED"],
      });
    }
  }
  return { kept, suppressed };
}