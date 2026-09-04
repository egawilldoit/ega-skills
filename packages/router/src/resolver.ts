// SPEC-004 §5.1.1 end-to-end resolver pipeline + §5.2 result (EGA-579).
//
// Pipeline: request validation → effective budgets → fingerprint →
// eligible L0 load (current-only unlocked / exact-lock locked) → explicit
// resolution → automatic pool (minus explicit IDs) → hard filters →
// tiers/tie-break → redundancy → budget composition → confidence/LOW
// normalization → ResolutionResult assembly.
//
// Config/lock inputs are AMEND-05-shaped fixtures (§5.3 Wave-4 note:
// fixtures until SPEC-005 lands per EGA-587). No instruction bodies ever
// enter routing metadata. No-match is a normal LOW result.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  openRegistry,
  searchSkills,
  type RegistryHandle,
} from "@ega-skills/registry";

import { applyAutomaticFilters } from "./filters.js";
import { assessConfidence, type ConfidenceRow } from "./confidence.js";
import { composeAutomatic, type ComposeAutomaticRow } from "./composition.js";
import { resolveExplicitSkills, type EligibleSkill, type ExplicitPolicyInput } from "./explicit.js";
import { normalizeTaskTerms } from "./match.js";
import { suppressRedundant } from "./redundancy.js";
import { assignTiers, type TierCandidate } from "./tiers.js";
import { resolveProjectFingerprint } from "./workspace.js";
import { RouterError } from "./errors.js";
import type {
  BudgetStatus,
  Confidence,
  ContentLevel,
  LockStatus,
  RejectedSkill,
  ResolvedSkill,
  RoutingEvidence,
  RoutingTier,
} from "./types.js";
import type { ProjectFingerprint } from "./fingerprint.js";

const MAX_TASK_CODE_POINTS = 16384;
const BUILT_IN_MAX_SKILLS = 3;
const BUILT_IN_MAX_TOKENS = 5000;

export interface ResolveBudgetInput {
  readonly maxSkills?: number;
  readonly maxTokens?: number;
}

export interface ResolvePolicyInput {
  readonly deniedNamespaces?: readonly string[];
  readonly allowedNamespaces?: readonly string[];
  readonly deniedSkills?: readonly string[];
  readonly lockedVersions?: ReadonlyMap<string, string> | null;
  readonly prefer?: readonly string[];
  readonly defaultMaxSkills?: number;
  readonly defaultMaxTokens?: number;
}

export interface ResolveInput {
  readonly task: string;
  /** Real project directory (CLI applies the cwd default). */
  readonly projectPath: string;
  readonly explicitSkills?: readonly string[];
  readonly budget?: ResolveBudgetInput;
  readonly policy?: ResolvePolicyInput;
  /** Environment carrying EGA_SKILLS_HOME for the registry. */
  readonly env: Record<string, string | undefined>;
}

export interface ResolutionResult {
  readonly resolutionId: string;
  readonly routerContractVersion: 1;
  readonly routerImplementationVersion: string;
  readonly mode: "suggest";
  readonly confidence: Confidence;
  readonly projectFingerprint: ProjectFingerprint;
  readonly explicit: ResolvedSkill[];
  readonly selected: ResolvedSkill[];
  readonly candidates: ResolvedSkill[];
  readonly rejected: RejectedSkill[];
  readonly automaticSelectedTokens: number;
  readonly explicitSelectedTokens: number;
  readonly maxTokens: number;
  readonly maxSkills: number;
  readonly lockStatus: LockStatus;
  readonly budgetStatus: BudgetStatus;
}

interface L0Row {
  readonly canonicalId: string;
  readonly portableName: string;
  readonly aliases: readonly string[];
  readonly versionHash: string;
  readonly l1Status: "AUTHORED" | "MISSING";
  readonly l1Tokens: number | null;
  readonly l2Tokens: number | null;
  readonly l2SizeClass: "NORMAL" | "LARGE" | "OVERSIZED";
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly triggers: readonly string[];
  readonly domains: readonly string[];
  readonly antiTriggers: readonly string[];
  readonly description: string;
}

function failInvalid(message: string): never {
  throw new RouterError("E_RESOLVE_REQUEST_INVALID", message);
}

function checkBudgetRange(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    failInvalid(`${name} must be an integer in ${min}–${max}.`);
  }
}

function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.split("\n").filter((line) => line.length > 0);
}

function queryAll<T>(db: unknown, sql: string, ...params: unknown[]): T[] {
  const prepared = (
    db as { prepare(sql: string): { all<T>(...params: unknown[]): T[] } }
  ).prepare(sql);
  return prepared.all<T>(...params);
}

function queryOne<T>(db: unknown, sql: string, ...params: unknown[]): T | undefined {
  const prepared = (
    db as { prepare(sql: string): { get<T>(...params: unknown[]): T } }
  ).prepare(sql);
  return prepared.get<T | undefined>(...params);
}

function routerImplementationVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["version"]
        : undefined;
    if (typeof version === "string" && version.length > 0) return version;
  } catch {
    // Fall through to the static fallback.
  }
  return "0.0.0";
}

function loadL0Rows(
  registry: RegistryHandle,
  locked: ReadonlyMap<string, string> | null,
): { rows: L0Row[]; knownSkills: { canonicalId: string; aliases: readonly string[] }[] } {
  const db = registry.db;
  const skills = queryAll<{ skill_id: string; namespace: string; name: string }>(
    db,
    "SELECT skill_id, namespace, name FROM skills ORDER BY skill_id ASC",
  );
  const aliasRows = queryAll<{ alias: string; skill_id: string }>(
    db,
    "SELECT alias, skill_id FROM skill_aliases ORDER BY alias ASC",
  );
  const ownedAliases = new Map<string, string[]>();
  for (const row of aliasRows) {
    const list = ownedAliases.get(row.skill_id);
    if (list !== undefined) list.push(row.alias);
    else ownedAliases.set(row.skill_id, [row.alias]);
  }

  const targets: Array<{ skillId: string; versionHash: string }> = [];
  if (locked !== null) {
    for (const [skillId, versionHash] of [...locked].sort()) {
      targets.push({ skillId, versionHash });
    }
  } else {
    for (const skill of skills) {
      const current = queryOne<{ current_version_hash: string }>(
        db,
        "SELECT current_version_hash FROM skills WHERE skill_id = ?",
        skill.skill_id,
      );
      if (current !== undefined) targets.push({ skillId: skill.skill_id, versionHash: current.current_version_hash });
    }
  }

  const rows: L0Row[] = [];
  // Reference index is registry-wide (all local skills): resolution must
  // succeed for known-but-ineligible skills so policy/lock rejection lands
  // in `rejected` instead of aborting the call (§5.1.4.5).
  const knownSkills = skills.map((skill) => ({
    canonicalId: skill.skill_id,
    aliases: ownedAliases.get(skill.skill_id) ?? [],
  }));
  for (const target of targets) {
    const version = queryOne<{
      l1_status: string;
      l2_size_class: string;
      manifest_json: string;
    }>(
      db,
      "SELECT l1_status, l2_size_class, manifest_json FROM skill_versions WHERE skill_id = ? AND version_hash = ?",
      target.skillId,
      target.versionHash,
    );
    const fts = queryOne<{
      name: string;
      description: string;
      domains: string;
      platforms: string;
      frameworks: string;
      triggers: string;
      aliases: string;
    }>(
      db,
      "SELECT name, description, domains, platforms, frameworks, triggers, aliases FROM skill_fts WHERE skill_id = ? AND version_hash = ?",
      target.skillId,
      target.versionHash,
    );
    if (version === undefined || fts === undefined) continue;
    const files = queryAll<{ path: string; blob_hash: string }>(
      db,
      "SELECT path, blob_hash FROM skill_files WHERE skill_id = ? AND version_hash = ?",
      target.skillId,
      target.versionHash,
    );
    let l1Tokens: number | null = null;
    let l2Tokens: number | null = null;
    for (const file of files) {
      const count = queryOne<{ token_count: number }>(
        db,
        "SELECT token_count FROM token_counts WHERE blob_hash = ? AND estimator_id = 'ega-o200k-v1'",
        file.blob_hash,
      );
      if (file.path === "SKILL.md" && count !== undefined) l2Tokens = count.token_count;
      if (file.path === "SKILL.core.md" && count !== undefined) l1Tokens = count.token_count;
    }
    let antiTriggers: string[] = [];
    try {
      const manifest: unknown = JSON.parse(version.manifest_json);
      const routing = (manifest as Record<string, unknown>)["routing"];
      const raw =
        typeof routing === "object" && routing !== null
          ? ((routing as Record<string, unknown>)["anti_triggers"] as unknown)
          : undefined;
      if (Array.isArray(raw)) antiTriggers = raw.filter((entry): entry is string => typeof entry === "string");
    } catch {
      antiTriggers = [];
    }
    const skill = skills.find((entry) => entry.skill_id === target.skillId);
    rows.push({
      canonicalId: target.skillId,
      portableName: skill?.name ?? target.skillId.slice(target.skillId.indexOf("/") + 1),
      aliases: ownedAliases.get(target.skillId) ?? [],
      versionHash: target.versionHash,
      l1Status: version.l1_status === "AUTHORED" ? "AUTHORED" : "MISSING",
      l1Tokens,
      l2Tokens,
      l2SizeClass:
        version.l2_size_class === "LARGE"
          ? "LARGE"
          : version.l2_size_class === "OVERSIZED"
            ? "OVERSIZED"
            : "NORMAL",
      platforms: splitLines(fts.platforms),
      frameworks: splitLines(fts.frameworks),
      triggers: splitLines(fts.triggers),
      domains: splitLines(fts.domains),
      antiTriggers,
      description: fts.description,
    });
  }
  return { rows, knownSkills };
}

function toEligibleSkill(row: L0Row): EligibleSkill {
  return {
    canonicalId: row.canonicalId,
    portableName: row.portableName,
    aliases: row.aliases,
    versionHash: row.versionHash,
    l1Status: row.l1Status,
    l1Tokens: row.l1Tokens,
    l2Tokens: row.l2Tokens,
    l2SizeClass: row.l2SizeClass,
    platforms: row.platforms,
    antiTriggers: row.antiTriggers,
  };
}

function toTierCandidate(row: L0Row): TierCandidate {
  return {
    canonicalId: row.canonicalId,
    portableName: row.portableName,
    aliases: row.aliases,
    versionHash: row.versionHash,
    l1Status: row.l1Status,
    l1Tokens: row.l1Tokens,
    l2Tokens: row.l2Tokens,
    platforms: row.platforms,
    frameworks: row.frameworks,
    triggers: row.triggers,
    domains: row.domains,
    description: row.description,
  };
}

/** Resolve a full ResolutionResult. No instruction bodies enter the output. */
export async function resolveSkills(input: ResolveInput): Promise<ResolutionResult> {
  const task = input.task.trim();
  if (task.length === 0) failInvalid("task must be non-empty.");
  if ([...input.task].length > MAX_TASK_CODE_POINTS) {
    failInvalid(`task must be at most ${MAX_TASK_CODE_POINTS} Unicode code points.`);
  }
  const references = input.explicitSkills ?? [];
  const policy = input.policy ?? {};
  checkBudgetRange("budget.maxSkills", input.budget?.maxSkills, 1, 3);
  checkBudgetRange("budget.maxTokens", input.budget?.maxTokens, 1, 1000000);
  checkBudgetRange("config.maxSkills", policy.defaultMaxSkills, 1, 3);
  checkBudgetRange("config.maxTokens", policy.defaultMaxTokens, 1, 1000000);
  const maxSkills = input.budget?.maxSkills ?? policy.defaultMaxSkills ?? BUILT_IN_MAX_SKILLS;
  const maxTokens = input.budget?.maxTokens ?? policy.defaultMaxTokens ?? BUILT_IN_MAX_TOKENS;
  const locked = policy.lockedVersions ?? null;
  const lockStatus: LockStatus = locked !== null ? "LOCKED" : "UNLOCKED";

  const fingerprint = resolveProjectFingerprint(input.projectPath);
  const taskTerms = normalizeTaskTerms(input.task);

  const registry = openRegistry({ env: input.env });
  try {
    const loaded = loadL0Rows(registry, locked);
    const rows = loaded.rows;
    const knownSkills = loaded.knownSkills;
    const eligible = new Map(rows.map((row) => [row.canonicalId, toEligibleSkill(row)]));
    const explicitPolicy: ExplicitPolicyInput = {
      ...(policy.deniedNamespaces !== undefined ? { deniedNamespaces: policy.deniedNamespaces } : {}),
      ...(policy.allowedNamespaces !== undefined ? { allowedNamespaces: policy.allowedNamespaces } : {}),
      ...(policy.deniedSkills !== undefined ? { deniedSkills: policy.deniedSkills } : {}),
      ...(locked !== null ? { lockedVersions: locked } : {}),
    };

    const explicit = resolveExplicitSkills({
      references,
      knownSkills,
      eligible,
      policy: explicitPolicy,
      projectPlatforms: fingerprint.platforms,
      taskTerms,
      maxTokens,
    });
    const explicitIds = new Set(explicit.explicit.map((skill) => skill.id));

    const pool = rows.filter((row) => !explicitIds.has(row.canonicalId));
    const filtered = applyAutomaticFilters({
      candidates: pool.map(toEligibleSkill),
      policy: explicitPolicy,
      projectPlatforms: fingerprint.platforms,
      taskTerms,
    });

    const byId = new Map(rows.map((row) => [row.canonicalId, row]));
    const ftsHits = searchSkills(registry.db, input.task, locked !== undefined && locked !== null ? { locked } : {});
    const ftsOrder = ftsHits.map((hit) => hit.skillId).filter((id) => byId.has(id));
    const tiered = assignTiers({
      candidates: filtered.passed.map((row) => {
        const full = byId.get(row.canonicalId);
        if (full === undefined) throw new Error(`Internal resolver error: missing L0 for ${row.canonicalId}.`);
        return toTierCandidate(full);
      }),
      task: input.task,
      projectFrameworks: fingerprint.frameworks,
      projectPlatforms: fingerprint.platforms,
      prefer: policy.prefer ?? [],
      ftsOrder,
    });

    const redundancy = suppressRedundant({
      rows: tiered.ranked.map((row) => {
        const full = byId.get(row.id);
        if (full === undefined) throw new Error(`Internal resolver error: missing L0 for ${row.id}.`);
        return { id: row.id, name: full.portableName, versionHash: full.versionHash, tier: row.tier === "E" ? "C" : row.tier, evidence: row.evidence };
      }),
    });

    const composition = composeAutomatic({
      rows: redundancy.kept.map((row) => {
        const full = byId.get(row.id);
        const tieredRow = tiered.ranked.find((entry) => entry.id === row.id);
        if (full === undefined || tieredRow === undefined) {
          throw new Error(`Internal resolver error: missing data for ${row.id}.`);
        }
        const useL1 = full.l1Status === "AUTHORED" && full.l1Tokens !== null;
        return {
          id: row.id,
          name: full.portableName,
          versionHash: full.versionHash,
          tier: row.tier,
          evidence: tieredRow.evidence,
          reasons: tieredRow.reasons,
          recommendedContentLevel: useL1 ? "L1" : "L2",
          recommendedContentTokens: tieredRow.recommendedContentTokens,
          l2SizeClass: full.l2SizeClass,
        };
      }),
      maxSkills,
      maxTokens,
      locked: locked !== null,
    });

    const toConfidenceRow = (row: {
      id: string;
      tier: RoutingTier;
      evidence: readonly RoutingEvidence[];
      reasons: readonly string[];
    }): ConfidenceRow => ({
      id: row.id,
      tier: row.tier === "E" ? "C" : row.tier,
      evidence: row.evidence,
      reasons: [...row.reasons],
    });
    const confidence = assessConfidence({
      selected: composition.selected.map(toConfidenceRow),
      candidates: composition.candidates.map(toConfidenceRow),
      automaticSelectedTokens: composition.automaticSelectedTokens,
      workspaceAmbiguous: fingerprint.workspaceAmbiguous,
    });

    const selectedById = new Map(composition.selected.map((row) => [row.id, row]));
    const candidatesById = new Map(composition.candidates.map((row) => [row.id, row]));
    const toResolved = (row: {
      id: string;
      name: string;
      versionHash: string;
      tier: RoutingTier;
      evidence: readonly RoutingEvidence[];
      reasons: readonly string[];
      recommendedContentLevel: ContentLevel;
      recommendedContentTokens: number | null;
    }): ResolvedSkill => ({
      id: row.id,
      name: row.name,
      versionHash: row.versionHash,
      tier: row.tier === "E" ? "C" : row.tier,
      recommendedContentLevel: row.recommendedContentLevel,
      recommendedContentTokens: row.recommendedContentTokens ?? 0,
      evidence: row.evidence.map((record) => ({ category: record.category, value: record.value })),
      reasons: [...row.reasons],
      warnings: [],
    });
    const selected = confidence.selected.map((row) => toResolved(selectedById.get(row.id) ?? candidatesById.get(row.id) ?? (() => { throw new Error(`Internal resolver error: missing composition row for ${row.id}.`); })()));
    const candidates = confidence.candidates
      .map((row) => candidatesById.get(row.id) ?? selectedById.get(row.id))
      .filter((row) => row !== undefined)
      .slice(0, 3)
      .map((row) => toResolved(row));
    const autoRejects = [...filtered.rejected, ...redundancy.suppressed]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 3);

    return {
      resolutionId: randomUUID(),
      routerContractVersion: 1,
      routerImplementationVersion: routerImplementationVersion(),
      mode: "suggest",
      confidence: confidence.confidence,
      projectFingerprint: fingerprint,
      explicit: explicit.explicit,
      selected,
      candidates,
      rejected: [...explicit.rejected, ...autoRejects],
      automaticSelectedTokens: confidence.automaticSelectedTokens,
      explicitSelectedTokens: explicit.explicitSelectedTokens,
      maxTokens,
      maxSkills,
      lockStatus,
      budgetStatus: explicit.budgetStatus,
    };
  } finally {
    registry.close();
  }
}
