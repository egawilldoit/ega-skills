export {
  deriveFingerprintSets,
  detectDirectoryEvidence,
  fingerprintDirectory,
} from "./fingerprint.js";
export { localDirectoryScan } from "./fingerprint-fs.js";
export type {
  DirectoryScan,
  FingerprintEvidence,
  ProjectFingerprint,
} from "./fingerprint.js";
export type { LocalDirectoryScan } from "./fingerprint-fs.js";
export { RouterError } from "./errors.js";
export type { RouterErrorCode } from "./errors.js";
export { resolveProjectFingerprint } from "./workspace.js";
export {
  isContiguousSubsequence,
  matchesStrongAntiTrigger,
  normalizeIdentifierPhrase,
  normalizeTaskTerms,
} from "./match.js";
export { MAX_EXPLICIT_SKILLS, resolveExplicitSkills } from "./explicit.js";
export type {
  EligibleSkill,
  ExplicitPolicyInput,
  ExplicitResolution,
  ExplicitResolutionInput,
  KnownSkill,
} from "./explicit.js";
export {
  COMPATIBILITY_WARNINGS,
  NEGATIVE_REASONS,
  POSITIVE_REASONS,
} from "./types.js";
export type {
  BudgetStatus,
  CompatibilityWarning,
  Confidence,
  ContentLevel,
  EvidenceCategory,
  LockStatus,
  RejectedSkill,
  ResolvedSkill,
  RoutingEvidence,
  RoutingTier,
} from "./types.js";
export {
  applyAutomaticFilters,
} from "./filters.js";
export type {
  AutomaticFiltersInput,
  AutomaticFiltersOutput,
} from "./filters.js";
export { assignTiers } from "./tiers.js";
export type { TierAssignmentInput, TierCandidate, TieredCandidate } from "./tiers.js";
export { suppressRedundant } from "./redundancy.js";
export type {
  AutomaticTier,
  RedundancyInput,
  RedundancyOutput,
  RedundancyRow,
} from "./redundancy.js";
