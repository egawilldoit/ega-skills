// SPEC-004 §5.2 public output types + §5.1.13/§5.1.18 frozen enums (EGA-573).
//
// Shared result vocabulary for the explicit stage (EGA-573), tiers/filters
// (EGA-574/575), composition (EGA-576/577), confidence (EGA-578) and the
// resolver (EGA-579). Enum orders are contract: emission follows them.

export type RoutingTier = "E" | "A" | "B" | "C";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type LockStatus = "LOCKED" | "UNLOCKED";
export type BudgetStatus = "WITHIN_BUDGET" | "EXPLICIT_OVER_BUDGET";
export type ContentLevel = "L1" | "L2";

export type EvidenceCategory =
  | "FRAMEWORK"
  | "PLATFORM"
  | "TASK_TRIGGER"
  | "DOMAIN"
  | "NAME_DESCRIPTION"
  | "PROJECT_PREFERENCE"
  | "LEXICAL";

export interface RoutingEvidence {
  readonly category: EvidenceCategory;
  readonly value: string;
}

export type CompatibilityWarning =
  | "EXPLICIT_PLATFORM_MISMATCH"
  | "EXPLICIT_ANTI_TRIGGER_MATCH"
  | "EXPLICIT_CONTENT_OVERSIZED";

/** Positive reasons in frozen §5.1.18 emission order. */
export const POSITIVE_REASONS: readonly string[] = Object.freeze([
  "EXPLICIT_USER",
  "PROJECT_PREFERENCE",
  "FRAMEWORK_MATCH",
  "PLATFORM_MATCH",
  "TASK_TRIGGER_MATCH",
  "DOMAIN_MATCH",
  "DESCRIPTION_MATCH",
  "LEXICAL_MATCH",
  "TOKEN_EFFICIENT",
  "LOCKED_VERSION",
]);

/** Negative reasons in frozen §5.1.18 order. */
export const NEGATIVE_REASONS: readonly string[] = Object.freeze([
  "NAMESPACE_DENIED",
  "SKILL_DENIED",
  "VERSION_NOT_LOCKED",
  "VERSION_MISSING",
  "INVALID_SKILL",
  "PLATFORM_MISMATCH",
  "ANTI_TRIGGER_MATCH",
  "REDUNDANT_HIGHER_RANKED",
  "TOKEN_BUDGET",
  "CONTENT_MISSING",
  "CONTENT_OVERSIZED",
  "WORKSPACE_AMBIGUOUS",
]);

export const COMPATIBILITY_WARNINGS: readonly CompatibilityWarning[] = Object.freeze([
  "EXPLICIT_PLATFORM_MISMATCH",
  "EXPLICIT_ANTI_TRIGGER_MATCH",
  "EXPLICIT_CONTENT_OVERSIZED",
]);

export interface ResolvedSkill {
  readonly id: string;
  readonly name: string;
  readonly versionHash: string;
  readonly tier: RoutingTier;
  readonly recommendedContentLevel: ContentLevel;
  readonly recommendedContentTokens: number;
  readonly evidence: RoutingEvidence[];
  readonly reasons: string[];
  readonly warnings: CompatibilityWarning[];
}

export interface RejectedSkill {
  readonly id: string;
  readonly name: string;
  readonly versionHash?: string;
  readonly tier?: RoutingTier;
  readonly evidence: RoutingEvidence[];
  readonly reasons: string[];
}
