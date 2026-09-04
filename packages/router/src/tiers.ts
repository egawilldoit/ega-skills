// SPEC-004 §5.1.10–§5.1.14 tiers, evidence and tie-break (EGA-575).
//
// Tier A: strong project compatibility AND strong task relevance. Tier B:
// strong task relevance WITHOUT enough project evidence. Tier C: everything
// else (lexical-only; never automatic selected content merely by rank).
// Evidence predicates are exact and deterministic; tie-break is the frozen
// six-rule order. No numeric scores, no BM25 values, no stemming or fuzzy
// matching. Operates on post-filter candidates; membership filtering belongs
// to composition (EGA-577/579).

import {
  isContiguousSubsequence,
  normalizeIdentifierPhrase,
  normalizeTaskTerms,
} from "./match.js";
import { POSITIVE_REASONS } from "./types.js";
import type {
  EvidenceCategory,
  ResolvedSkill,
  RoutingEvidence,
  RoutingTier,
} from "./types.js";

export interface TierCandidate {
  readonly canonicalId: string;
  readonly portableName: string;
  readonly aliases: readonly string[];
  readonly versionHash: string;
  readonly l1Status: "AUTHORED" | "MISSING";
  readonly l1Tokens: number | null;
  readonly l2Tokens: number | null;
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly triggers: readonly string[];
  readonly domains: readonly string[];
  readonly description: string;
}

export interface TierAssignmentInput {
  readonly candidates: readonly TierCandidate[];
  readonly task: string;
  readonly projectFrameworks: readonly string[];
  readonly projectPlatforms: readonly string[];
  readonly prefer?: readonly string[];
  /** Canonical IDs in relative FTS rank order, best first. Values never surface. */
  readonly ftsOrder?: readonly string[];
}

export interface TieredCandidate {
  readonly id: string;
  readonly tier: RoutingTier;
  readonly evidence: RoutingEvidence[];
  readonly reasons: string[];
  readonly recommendedContentTokens: number;
  readonly ftsRank: number | null;
}

const STRONG_TASK_CATEGORIES: ReadonlySet<EvidenceCategory> = new Set([
  "FRAMEWORK",
  "PLATFORM",
  "TASK_TRIGGER",
  "DOMAIN",
  "NAME_DESCRIPTION",
]);

const TERM_RE = /[\p{L}\p{N}]+/gu;

function triggerTerms(trigger: string): string[] {
  return normalizeIdentifierPhrase(trigger).match(TERM_RE) ?? [];
}

function evidenceValue(
  list: RoutingEvidence[],
  category: EvidenceCategory,
  value: string,
): void {
  if (value.length > 0) list.push({ category, value });
}

function collectEvidence(
  candidate: TierCandidate,
  taskTerms: readonly string[],
  normalizedTask: string,
  projectFrameworks: readonly string[],
  projectPlatforms: readonly string[],
  prefer: readonly string[],
  ftsOrder: readonly string[],
): RoutingEvidence[] {
  const evidence: RoutingEvidence[] = [];
  for (const framework of candidate.frameworks) {
    if (projectFrameworks.includes(framework)) evidenceValue(evidence, "FRAMEWORK", framework);
  }
  for (const platform of candidate.platforms) {
    if (projectPlatforms.includes(platform)) evidenceValue(evidence, "PLATFORM", platform);
  }
  for (const trigger of candidate.triggers) {
    if (isContiguousSubsequence(taskTerms, triggerTerms(trigger))) {
      evidenceValue(evidence, "TASK_TRIGGER", trigger);
    }
  }
  for (const domain of candidate.domains) {
    const phrase = normalizeIdentifierPhrase(domain);
    if (phrase.length > 0 && normalizedTask.includes(phrase)) {
      evidenceValue(evidence, "DOMAIN", domain);
    }
  }
  const names = [candidate.portableName, ...candidate.aliases];
  for (const name of names) {
    const phrase = normalizeIdentifierPhrase(name);
    if (phrase.length > 0 && normalizedTask.includes(phrase)) {
      evidenceValue(evidence, "NAME_DESCRIPTION", name);
      break;
    }
  }
  if (ftsOrder.includes(candidate.canonicalId)) {
    evidenceValue(evidence, "LEXICAL", taskTerms.join(" "));
  }
  const hasRelevant = evidence.length > 0;
  if (hasRelevant && prefer.includes(candidate.canonicalId)) {
    evidenceValue(evidence, "PROJECT_PREFERENCE", candidate.canonicalId);
  }
  const order = ["FRAMEWORK", "PLATFORM", "TASK_TRIGGER", "DOMAIN", "NAME_DESCRIPTION", "PROJECT_PREFERENCE", "LEXICAL"];
  return evidence.sort((a, b) => {
    const orderDiff = order.indexOf(a.category) - order.indexOf(b.category);
    if (orderDiff !== 0) return orderDiff;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });
}

function hasProjectStrength(evidence: readonly RoutingEvidence[]): boolean {
  return evidence.some((record) => record.category === "FRAMEWORK" || record.category === "PLATFORM");
}

function hasTaskStrength(evidence: readonly RoutingEvidence[]): boolean {
  return evidence.some(
    (record) =>
      record.category === "TASK_TRIGGER" ||
      record.category === "DOMAIN" ||
      record.category === "NAME_DESCRIPTION",
  );
}

function distinctStrongValues(evidence: readonly RoutingEvidence[]): number {
  return new Set(
    evidence.filter((record) => STRONG_TASK_CATEGORIES.has(record.category)).map((record) => record.value),
  ).size;
}

function recommendedTokens(candidate: TierCandidate): number {
  if (candidate.l1Status === "AUTHORED" && candidate.l1Tokens !== null) return candidate.l1Tokens;
  return candidate.l2Tokens ?? 0;
}

const REASON_BY_CATEGORY: Record<EvidenceCategory, string> = {
  FRAMEWORK: "FRAMEWORK_MATCH",
  PLATFORM: "PLATFORM_MATCH",
  TASK_TRIGGER: "TASK_TRIGGER_MATCH",
  DOMAIN: "DOMAIN_MATCH",
  NAME_DESCRIPTION: "DESCRIPTION_MATCH",
  PROJECT_PREFERENCE: "PROJECT_PREFERENCE",
  LEXICAL: "LEXICAL_MATCH",
};

function reasonsFor(evidence: readonly RoutingEvidence[], tokenEfficient: boolean): string[] {
  const reasons = new Set<string>();
  for (const record of evidence) reasons.add(REASON_BY_CATEGORY[record.category]);
  if (tokenEfficient) reasons.add("TOKEN_EFFICIENT");
  return POSITIVE_REASONS.filter((reason) => reasons.has(reason));
}

/**
 * Assign tiers + evidence and rank A/B/C blocks by the frozen tie-break.
 * Tier C rows (including evidence-free rows) are classified, never selected:
 * composition decides membership.
 */
export function assignTiers(input: TierAssignmentInput): { ranked: TieredCandidate[] } {
  const taskTerms = normalizeTaskTerms(input.task);
  const normalizedTask = normalizeIdentifierPhrase(input.task);
  const prefer = input.prefer ?? [];
  const ftsOrder = input.ftsOrder ?? [];

  const rows = input.candidates.map((candidate) => {
    const evidence = collectEvidence(
      candidate,
      taskTerms,
      normalizedTask,
      input.projectFrameworks,
      input.projectPlatforms,
      prefer,
      ftsOrder,
    );
    const projectStrong = hasProjectStrength(evidence);
    const taskStrong = hasTaskStrength(evidence);
    const tier: RoutingTier = projectStrong && taskStrong ? "A" : taskStrong ? "B" : "C";
    const ftsIndex = ftsOrder.indexOf(candidate.canonicalId);
    return {
      candidate,
      evidence,
      tier,
      tokens: recommendedTokens(candidate),
      ftsRank: ftsIndex >= 0 ? ftsIndex : null,
      preferListed: prefer.includes(candidate.canonicalId) && evidence.some((record) => record.category !== "PROJECT_PREFERENCE"),
      strongCount: distinctStrongValues(evidence),
    };
  });

  const tierRank = (tier: RoutingTier): number => (tier === "A" ? 0 : tier === "B" ? 1 : 2);
  const ranked = [...rows].sort((a, b) => {
    if (tierRank(a.tier) !== tierRank(b.tier)) return tierRank(a.tier) - tierRank(b.tier);
    if (a.preferListed !== b.preferListed) return a.preferListed ? -1 : 1;
    if (a.strongCount !== b.strongCount) return b.strongCount - a.strongCount;
    const aRank = a.ftsRank ?? Number.POSITIVE_INFINITY;
    const bRank = b.ftsRank ?? Number.POSITIVE_INFINITY;
    if (aRank !== bRank) return aRank - bRank;
    if (a.tokens !== b.tokens) return a.tokens - b.tokens;
    if (a.candidate.canonicalId !== b.candidate.canonicalId) {
      return a.candidate.canonicalId < b.candidate.canonicalId ? -1 : 1;
    }
    return a.candidate.versionHash < b.candidate.versionHash ? -1 : a.candidate.versionHash > b.candidate.versionHash ? 1 : 0;
  });

  // TOKEN_EFFICIENT only when rule 4 actually resolves a same-tier tie:
  // members of a rules1-3-tied group that are not its highest-token member.
  const groupKey = (row: (typeof rows)[number]): string =>
    `${tierRank(row.tier)}|${row.preferListed ? 1 : 0}|${row.strongCount}|${row.ftsRank ?? "inf"}`;
  const groups = new Map<string, (typeof rows)[number][]>();
  for (const row of ranked) {
    const key = groupKey(row);
    const group = groups.get(key);
    if (group !== undefined) group.push(row);
    else groups.set(key, [row]);
  }
  const efficient = new Set<(typeof rows)[number]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const maxTokens = Math.max(...group.map((row) => row.tokens));
    if (!group.every((row) => row.tokens === maxTokens)) {
      for (const row of group) {
        if (row.tokens < maxTokens) efficient.add(row);
      }
    }
  }

  return {
    ranked: ranked.map((row) => ({
      id: row.candidate.canonicalId,
      tier: row.tier,
      evidence: row.evidence,
      reasons: reasonsFor(row.evidence, efficient.has(row)),
      recommendedContentTokens: row.tokens,
      ftsRank: row.ftsRank,
    })),
  };
}
