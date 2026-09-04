// SPEC-004 §5.1.3–§5.1.5 explicit skill resolution (EGA-573).
//
// Explicit references resolve BEFORE automatic ranking in SPEC-001 §5.1.12
// order (exact canonical ID → exact global alias → unique bare portable
// name), then canonical-dedupe preserving first occurrence. Visibility scope:
// canonical and alias steps resolve over the full local reference index;
// bare-name uniqueness is scoped to the ELIGIBLE (visible) set per §5.1.17
// (an exact bare name matching several visible skills is ambiguous).
//
// Resolved skills bypass ranking but NEVER policy/lock/version validity.
// Compatibility mismatch becomes a frozen WARNING on an otherwise valid
// explicit skill. Explicit token accounting is separate from the automatic
// budget: over-budget explicits stay explicit with EXPLICIT_OVER_BUDGET.
//
// Policy/lock inputs are AMEND-05-shaped fixtures (§5.3 Wave-4 note: config/
// lock interfaces may use fixtures until SPEC-005 lands per EGA-587).
// A valid explicit skill is reported here; EGA-579 removes explicit IDs from
// the automatic candidate pool for the call.

import { RouterError } from "./errors.js";
import { matchesStrongAntiTrigger } from "./match.js";
import type {
  BudgetStatus,
  CompatibilityWarning,
  RejectedSkill,
  ResolvedSkill,
} from "./types.js";

export const MAX_EXPLICIT_SKILLS = 10;

export interface KnownSkill {
  readonly canonicalId: string;
  readonly aliases: readonly string[];
}

export interface EligibleSkill {
  readonly canonicalId: string;
  readonly portableName: string;
  readonly aliases: readonly string[];
  readonly versionHash: string;
  readonly l1Status: "AUTHORED" | "MISSING";
  readonly l1Tokens: number | null;
  readonly l2Tokens: number | null;
  readonly l2SizeClass: "NORMAL" | "LARGE" | "OVERSIZED";
  readonly platforms: readonly string[];
  readonly antiTriggers: readonly string[];
}

export interface ExplicitPolicyInput {
  readonly deniedNamespaces?: readonly string[];
  /** Empty or undefined allows every namespace. */
  readonly allowedNamespaces?: readonly string[];
  readonly deniedSkills?: readonly string[];
  /** Null/undefined means unlocked (current versions eligible). */
  readonly lockedVersions?: ReadonlyMap<string, string> | null;
}

export interface ExplicitResolutionInput {
  /** Raw user references (validated: max 10, each non-empty after trim). */
  readonly references: readonly string[];
  /** Full local reference index for canonical/alias steps. */
  readonly knownSkills: readonly KnownSkill[];
  /** Eligible L0 rows by canonical ID (current-only / exact-lock). */
  readonly eligible: ReadonlyMap<string, EligibleSkill>;
  readonly policy?: ExplicitPolicyInput;
  /** Normalized project platform evidence (empty = neutral). */
  readonly projectPlatforms?: readonly string[];
  /** Normalized task term sequence (see normalizeTaskTerms). */
  readonly taskTerms?: readonly string[];
  /** Effective automatic maxTokens (explicit never shrinks it). */
  readonly maxTokens: number;
}

export interface ExplicitResolution {
  readonly explicit: ResolvedSkill[];
  readonly rejected: RejectedSkill[];
  readonly explicitSelectedTokens: number;
  readonly budgetStatus: BudgetStatus;
}

function namespaceOf(canonicalId: string): string {
  return canonicalId.slice(0, canonicalId.indexOf("/"));
}

function resolveOneReference(
  ref: string,
  knownSkills: readonly KnownSkill[],
  eligible: ReadonlyMap<string, EligibleSkill>,
): string {
  const trimmed = ref.trim();
  for (const skill of knownSkills) {
    if (skill.canonicalId === trimmed) return skill.canonicalId;
  }
  const ordered = [...knownSkills].sort((a, b) =>
    a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0,
  );
  for (const skill of ordered) {
    if (skill.aliases.includes(trimmed)) return skill.canonicalId;
  }
  const visibleMatches = [...eligible.values()].filter(
    (skill) => skill.portableName === trimmed,
  );
  if (visibleMatches.length === 1) {
    const only = visibleMatches[0];
    if (only !== undefined) return only.canonicalId;
  }
  if (visibleMatches.length > 1) {
    const orderedIds = visibleMatches.map((skill) => skill.canonicalId).sort();
    throw new RouterError(
      "E_SKILL_REFERENCE_AMBIGUOUS",
      `Bare skill reference ${JSON.stringify(trimmed)} is ambiguous: ${orderedIds.map((candidate) => JSON.stringify(candidate)).join(", ")}.`,
    );
  }
  throw new RouterError(
    "E_SKILL_NOT_FOUND",
    `Skill reference ${JSON.stringify(trimmed)} did not match any visible canonical skill.`,
  );
}

/** Strong platform mismatch (§5.1.12.3): project evidence + skill platforms + empty intersection. */
function hasStrongPlatformMismatch(
  projectPlatforms: readonly string[],
  skillPlatforms: readonly string[],
): boolean {
  if (projectPlatforms.length === 0 || skillPlatforms.length === 0) return false;
  return !skillPlatforms.some((platform) => projectPlatforms.includes(platform));
}

export function resolveExplicitSkills(input: ExplicitResolutionInput): ExplicitResolution {
  if (input.references.length > MAX_EXPLICIT_SKILLS) {
    throw new RouterError(
      "E_RESOLVE_REQUEST_INVALID",
      `At most ${MAX_EXPLICIT_SKILLS} explicit skills are allowed; got ${input.references.length}.`,
    );
  }
  for (const ref of input.references) {
    if (ref.trim().length === 0) {
      throw new RouterError("E_RESOLVE_REQUEST_INVALID", "Explicit skill references must be non-empty.");
    }
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const ref of input.references) {
    const canonicalId = resolveOneReference(ref, input.knownSkills, input.eligible);
    if (!seen.has(canonicalId)) {
      seen.add(canonicalId);
      resolved.push(canonicalId);
    }
  }

  const policy = input.policy ?? {};
  const deniedNamespaces = policy.deniedNamespaces ?? [];
  const allowedNamespaces = policy.allowedNamespaces ?? [];
  const deniedSkills = policy.deniedSkills ?? [];
  const locked = policy.lockedVersions ?? null;
  const projectPlatforms = input.projectPlatforms ?? [];
  const taskTerms = input.taskTerms ?? [];

  const explicit: ResolvedSkill[] = [];
  const rejected: RejectedSkill[] = [];
  let explicitSelectedTokens = 0;

  for (const canonicalId of resolved) {
    const namespace = namespaceOf(canonicalId);
    const portableName = canonicalId.slice(namespace.length + 1);
    const row = input.eligible.get(canonicalId);

    if (
      deniedNamespaces.includes(namespace) ||
      (allowedNamespaces.length > 0 && !allowedNamespaces.includes(namespace))
    ) {
      rejected.push({
        id: canonicalId,
        name: portableName,
        ...(row !== undefined ? { versionHash: row.versionHash } : {}),
        evidence: [],
        reasons: ["NAMESPACE_DENIED"],
      });
      continue;
    }
    if (deniedSkills.includes(canonicalId)) {
      rejected.push({
        id: canonicalId,
        name: portableName,
        ...(row !== undefined ? { versionHash: row.versionHash } : {}),
        evidence: [],
        reasons: ["SKILL_DENIED"],
      });
      continue;
    }

    if (locked !== null) {
      const lockedVersion = locked.get(canonicalId);
      if (lockedVersion === undefined || row === undefined || row.versionHash !== lockedVersion) {
        rejected.push({
          id: canonicalId,
          name: portableName,
          ...(row !== undefined ? { versionHash: row.versionHash } : {}),
          evidence: [],
          reasons: ["VERSION_NOT_LOCKED"],
        });
        continue;
      }
    } else if (row === undefined) {
      rejected.push({ id: canonicalId, name: portableName, evidence: [], reasons: ["VERSION_MISSING"] });
      continue;
    }

    const eligible = row;
    const warnings: CompatibilityWarning[] = [];
    if (hasStrongPlatformMismatch(projectPlatforms, eligible.platforms)) {
      warnings.push("EXPLICIT_PLATFORM_MISMATCH");
    }
    if (eligible.antiTriggers.some((anti) => matchesStrongAntiTrigger(anti, taskTerms))) {
      warnings.push("EXPLICIT_ANTI_TRIGGER_MATCH");
    }
    if (eligible.l2SizeClass === "OVERSIZED") {
      warnings.push("EXPLICIT_CONTENT_OVERSIZED");
    }

    const useL1 = eligible.l1Status === "AUTHORED" && eligible.l1Tokens !== null;
    const recommendedContentLevel = useL1 ? "L1" : "L2";
    const recommendedContentTokens = useL1
      ? (eligible.l1Tokens ?? 0)
      : (eligible.l2Tokens ?? 0);
    explicitSelectedTokens += recommendedContentTokens;
    explicit.push({
      id: canonicalId,
      name: portableName,
      versionHash: eligible.versionHash,
      tier: "E",
      recommendedContentLevel,
      recommendedContentTokens,
      evidence: [],
      reasons: locked !== null ? ["EXPLICIT_USER", "LOCKED_VERSION"] : ["EXPLICIT_USER"],
      warnings,
    });
  }

  return {
    explicit,
    rejected,
    explicitSelectedTokens,
    budgetStatus: explicitSelectedTokens > input.maxTokens ? "EXPLICIT_OVER_BUDGET" : "WITHIN_BUDGET",
  };
}
