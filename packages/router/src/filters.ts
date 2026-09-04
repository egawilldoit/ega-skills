// SPEC-004 §5.1.15 automatic hard filters (EGA-574).
//
// Applied at resolve pipeline step 7, after the eligible L0 candidate set is
// loaded (§5.1.1.6) and BEFORE tiers/evidence/tie-break (§5.1.10–§5.1.14).
// Each candidate is rejected with its deterministic negative reason when any
// frozen §5.1.15 condition holds; conditions are evaluated in the fixed order
// below and the FIRST match wins. Rejects carry empty evidence and exactly
// one reason. Absence of platform evidence is NEVER a mismatch (§5.1.12.3),
// and an empty task term sequence NEVER matches an anti-trigger (§5.1.11.3).
//
// Policy/lock inputs are AMEND-05-shaped fixtures (§5.3 Wave-4 note: config/
// lock interfaces may use fixtures until SPEC-005 lands per EGA-587).

import { hasStrongPlatformMismatch, matchesStrongAntiTrigger } from "./match.js";
import type { EligibleSkill, ExplicitPolicyInput } from "./explicit.js";
import type { RejectedSkill } from "./types.js";

export interface AutomaticFiltersInput {
  /** Eligible L0 candidate rows in caller order (upstream router-rank order). */
  readonly candidates: readonly EligibleSkill[];
  readonly policy?: ExplicitPolicyInput;
  /** Normalized project platform evidence (empty/absent = neutral). */
  readonly projectPlatforms?: readonly string[];
  /** Normalized task term sequence (see normalizeTaskTerms). */
  readonly taskTerms?: readonly string[];
}

export interface AutomaticFiltersOutput {
  /** Candidates that passed every hard filter, in input order. */
  readonly passed: readonly EligibleSkill[];
  /** Rejects in candidate order, each with empty evidence and one reason. */
  readonly rejected: readonly RejectedSkill[];
}

function namespaceOf(canonicalId: string): string {
  return canonicalId.slice(0, canonicalId.indexOf("/"));
}

function reject(
  candidate: EligibleSkill,
  reason: string,
): RejectedSkill {
  return {
    id: candidate.canonicalId,
    name: candidate.portableName,
    versionHash: candidate.versionHash,
    evidence: [],
    reasons: [reason],
  };
}

export function applyAutomaticFilters(input: AutomaticFiltersInput): AutomaticFiltersOutput {
  const policy = input.policy ?? {};
  const deniedNamespaces = policy.deniedNamespaces ?? [];
  const allowedNamespaces = policy.allowedNamespaces ?? [];
  const deniedSkills = policy.deniedSkills ?? [];
  const locked = policy.lockedVersions ?? null;
  const projectPlatforms = input.projectPlatforms ?? [];
  const taskTerms = input.taskTerms ?? [];

  const passed: EligibleSkill[] = [];
  const rejected: RejectedSkill[] = [];

  for (const candidate of input.candidates) {
    const namespace = namespaceOf(candidate.canonicalId);

    // 1. namespace in namespaces.deny, or non-empty namespaces.allow lacking it.
    if (
      deniedNamespaces.includes(namespace) ||
      (allowedNamespaces.length > 0 && !allowedNamespaces.includes(namespace))
    ) {
      rejected.push(reject(candidate, "NAMESPACE_DENIED"));
      continue;
    }

    // 2. canonical ID in skills.deny.
    if (deniedSkills.includes(candidate.canonicalId)) {
      rejected.push(reject(candidate, "SKILL_DENIED"));
      continue;
    }

    // 3. active lock excludes the candidate version.
    if (locked !== null && locked.get(candidate.canonicalId) !== candidate.versionHash) {
      rejected.push(reject(candidate, "VERSION_NOT_LOCKED"));
      continue;
    }

    // 4. strong platform mismatch (§5.1.12.3).
    if (hasStrongPlatformMismatch(projectPlatforms, candidate.platforms)) {
      rejected.push(reject(candidate, "PLATFORM_MISMATCH"));
      continue;
    }

    // 5. strong anti-trigger match (§5.1.11.3).
    if (candidate.antiTriggers.some((anti) => matchesStrongAntiTrigger(anti, taskTerms))) {
      rejected.push(reject(candidate, "ANTI_TRIGGER_MATCH"));
      continue;
    }

    passed.push(candidate);
  }

  return { passed, rejected };
}
