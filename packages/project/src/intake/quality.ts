// Contract Q1: deterministic intake quality diagnostics.
//
// This report is an inspection artifact only. It reuses the registry's
// canonical preparation path and never writes source, registry, or cache
// state. AI suggestions, if added later, must remain separate from this
// deterministic result.

import { join, resolve } from "node:path";

import {
  createImportPlan,
  prepareSkillRoot,
  type IntakeDiagnostic,
  type ImportPlanDocument,
  type PreparedFile,
} from "@ega-skills/registry";
import { createEnvelope, hashBytes, type ArtifactEnvelope } from "@ega-skills/hashing";
import {
  L1_HARD_MAX_TOKENS,
  L1_TARGET_MAX_TOKENS,
  L1_TARGET_MIN_TOKENS,
  tokenEstimator,
  type L1Status,
} from "@ega-skills/schema";

export const QUALITY_OBJECT_TYPE = "ega.intake-quality-report" as const;
export const QUALITY_SCHEMA_VERSION = 1 as const;
export const QUALITY_POLICY_REVISION = "quality-policy-v1" as const;

export type QualityDiagnosticSeverity = "INFO" | "WARNING" | "ERROR";

export interface QualityDiagnostic {
  readonly code: string;
  readonly severity: QualityDiagnosticSeverity;
  readonly relative_file: string | null;
  readonly field: string | null;
  readonly candidate_id: string | null;
  readonly related_ids: readonly string[];
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly suggested_action: string;
}

export interface QualityCandidate {
  readonly relative_root: string;
  readonly skill_id: string | null;
  readonly version_hash: string | null;
  readonly l1_status: L1Status | null;
  readonly l1_tokens: number | null;
  readonly l2_tokens: number | null;
  readonly aliases: readonly string[];
  readonly platforms: readonly string[];
  readonly triggers: readonly string[];
  readonly anti_triggers: readonly string[];
  readonly diagnostics: readonly QualityDiagnostic[];
}

export interface QualitySummary {
  readonly candidate_count: number;
  readonly blocked_count: number;
  readonly warning_count: number;
  readonly info_count: number;
}

export interface QualityReportPayload {
  readonly quality_contract: "Q1";
  readonly policy_revision: "quality-policy-v1";
  readonly namespace: string;
  readonly source_digest: string;
  readonly candidates: readonly QualityCandidate[];
  readonly summary: QualitySummary;
}

export type QualityReportDocument = ArtifactEnvelope & {
  readonly object_type: "ega.intake-quality-report";
  readonly schema_version: 1;
  readonly payload: QualityReportPayload;
};

export interface QualityOptions {
  readonly sourcePath: string;
  readonly namespace: string;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compare);
}

function diagnosticSort(left: QualityDiagnostic, right: QualityDiagnostic): number {
  const leftKey = [left.code, left.severity, left.relative_file ?? "", left.field ?? "", left.candidate_id ?? "", left.related_ids.join(",")].join("\u0000");
  const rightKey = [right.code, right.severity, right.relative_file ?? "", right.field ?? "", right.candidate_id ?? "", right.related_ids.join(",")].join("\u0000");
  return compare(leftKey, rightKey);
}

function diagnostic(input: {
  readonly code: string;
  readonly severity: QualityDiagnosticSeverity;
  readonly relativeFile?: string | null;
  readonly field?: string | null;
  readonly candidateId?: string | null;
  readonly relatedIds?: readonly string[];
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly suggestedAction: string;
}): QualityDiagnostic {
  return Object.freeze({
    code: input.code,
    severity: input.severity,
    relative_file: input.relativeFile ?? null,
    field: input.field ?? null,
    candidate_id: input.candidateId ?? null,
    related_ids: Object.freeze(sorted(input.relatedIds ?? [])),
    details: Object.freeze({ ...(input.details ?? {}) }),
    suggested_action: input.suggestedAction,
  });
}

function fromImportDiagnostic(value: IntakeDiagnostic): QualityDiagnostic {
  return diagnostic({
    code: value.code,
    severity: value.severity === "ERROR" ? "ERROR" : "WARNING",
    relativeFile: value.relative_file,
    field: value.field,
    candidateId: value.candidate_id,
    relatedIds: value.related_ids,
    details: value.details,
    suggestedAction: value.suggested_action,
  });
}

function textFiles(prepared: Awaited<ReturnType<typeof prepareSkillRoot>>): readonly PreparedFile[] {
  return prepared.files.filter((file) => file.record.content_kind === "TEXT");
}

function pathFromLink(sourcePath: string, href: string): string | null {
  if (href.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(href)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/u, 1)[0] ?? "");
  } catch {
    return sourcePath;
  }
  if (decoded.length === 0) return null;
  const pieces: string[] = sourcePath.includes("/") ? sourcePath.split("/").slice(0, -1) : [];
  for (const piece of decoded.replaceAll("\\", "/").split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      if (pieces.length === 0) return sourcePath;
      pieces.pop();
    } else {
      pieces.push(piece);
    }
  }
  if (decoded.startsWith("/") || pieces.length === 0) return "\u0000invalid";
  const normalized = pieces.join("/");
  return normalized;
}

function brokenReferences(prepared: Awaited<ReturnType<typeof prepareSkillRoot>>): QualityDiagnostic[] {
  const known = new Set(prepared.files.map((file) => file.record.path));
  const diagnostics: QualityDiagnostic[] = [];
  const linkPattern = /!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/gu;
  for (const file of textFiles(prepared)) {
    const text = new TextDecoder().decode(file.bytes);
    for (const match of text.matchAll(linkPattern)) {
      const href = match[1] ?? match[2];
      if (href === undefined) continue;
      const path = pathFromLink(file.record.path, href);
      if (path === null || known.has(path)) continue;
      diagnostics.push(diagnostic({
        code: "Q_BROKEN_COMPANION_REFERENCE",
        severity: "ERROR",
        relativeFile: file.record.path,
        field: "references",
        candidateId: prepared.skillId,
        details: { target: href },
        suggestedAction: "add the referenced companion file or remove the broken link",
      }));
    }
  }
  return diagnostics;
}

function l1Diagnostics(prepared: Awaited<ReturnType<typeof prepareSkillRoot>>): QualityDiagnostic[] {
  const core = prepared.files.find((file) => file.record.path === "SKILL.core.md");
  if (core === undefined) {
    return [diagnostic({
      code: "Q_L1_MISSING",
      severity: "INFO",
      relativeFile: "SKILL.core.md",
      field: "l1_status",
      candidateId: prepared.skillId,
      details: { status: "MISSING" },
      suggestedAction: "add a reviewed SKILL.core.md only when the short context is useful",
    })];
  }
  const tokens = prepared.l1Tokens ?? tokenEstimator.count(new TextDecoder().decode(core.bytes));
  if (tokens > L1_HARD_MAX_TOKENS) {
    return [diagnostic({
      code: "Q_L1_OVERSIZED",
      severity: "WARNING",
      relativeFile: "SKILL.core.md",
      field: "l1_tokens",
      candidateId: prepared.skillId,
      details: { token_count: tokens, hard_max_tokens: L1_HARD_MAX_TOKENS },
      suggestedAction: "rewrite the authored L1 below the hard maximum; do not truncate it",
    })];
  }
  if (tokens < L1_TARGET_MIN_TOKENS || tokens > L1_TARGET_MAX_TOKENS) {
    return [diagnostic({
      code: "Q_L1_OUTSIDE_TARGET",
      severity: "WARNING",
      relativeFile: "SKILL.core.md",
      field: "l1_tokens",
      candidateId: prepared.skillId,
      details: { token_count: tokens, target_min_tokens: L1_TARGET_MIN_TOKENS, target_max_tokens: L1_TARGET_MAX_TOKENS },
      suggestedAction: "review the authored L1 against the target range; preserve the exact text until explicitly revised",
    })];
  }
  return [];
}

function routingDiagnostics(prepared: Awaited<ReturnType<typeof prepareSkillRoot>>): QualityDiagnostic[] {
  const diagnostics: QualityDiagnostic[] = [];
  if (prepared.routing.platforms.includes("generic")) {
    diagnostics.push(diagnostic({
      code: "Q_PLATFORM_GENERIC",
      severity: "WARNING",
      relativeFile: "ega.yaml",
      field: "platforms",
      candidateId: prepared.skillId,
      details: { platform: "generic", replacement: "empty" },
      suggestedAction: "remove generic; an empty platform list means unrestricted compatibility",
    }));
  }
  if (prepared.routing.triggers.length === 0) {
    diagnostics.push(diagnostic({
      code: "Q_TRIGGERS_MISSING",
      severity: "INFO",
      relativeFile: "ega.yaml",
      field: "triggers",
      candidateId: prepared.skillId,
      suggestedAction: "add evidence-backed task triggers when automatic routing is intended",
    }));
  }
  if (prepared.routing.antiTriggers.length === 0) {
    diagnostics.push(diagnostic({
      code: "Q_ANTI_TRIGGERS_MISSING",
      severity: "INFO",
      relativeFile: "ega.yaml",
      field: "anti_triggers",
      candidateId: prepared.skillId,
      suggestedAction: "add lexical anti-triggers only when a concrete false-positive boundary is known",
    }));
  }
  diagnostics.push(diagnostic({
    code: "Q_L2_TOKEN_COUNT",
    severity: "INFO",
    relativeFile: "SKILL.md",
    field: "l2_tokens",
    candidateId: prepared.skillId,
    details: { token_count: prepared.l2Tokens, size_class: prepared.l2SizeClass },
    suggestedAction: "use the reported L2 size when reviewing composition budgets",
  }));
  return diagnostics;
}

function duplicateBodyDiagnostics(candidates: readonly QualityCandidate[], bodies: ReadonlyMap<string, string>): Map<string, QualityDiagnostic[]> {
  const groups = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.skill_id === null) continue;
    const digest = bodies.get(candidate.skill_id);
    if (digest === undefined) continue;
    groups.set(digest, [...(groups.get(digest) ?? []), candidate.skill_id]);
  }
  const result = new Map<string, QualityDiagnostic[]>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const related = sorted(ids);
    for (const id of related) {
      result.set(id, [diagnostic({
        code: "Q_DUPLICATE_CANONICAL_BODY",
        severity: "WARNING",
        relativeFile: "SKILL.md",
        field: "body_digest",
        candidateId: id,
        relatedIds: related,
        details: { occurrences: ids.length, main_body_only: true },
        suggestedAction: "review the near-duplicate skills; companion files and identities remain distinct",
      })]);
    }
  }
  return result;
}

function rootFor(sourcePath: string, relativeRoot: string): string {
  return relativeRoot === "." ? resolve(sourcePath) : join(resolve(sourcePath), relativeRoot);
}

/** Build a deterministic, zero-mutation quality report for an intake source. */
export async function createQualityReport(options: QualityOptions): Promise<QualityReportDocument> {
  const sourcePath = resolve(options.sourcePath);
  const importPlan: ImportPlanDocument = await createImportPlan({ sourcePath, namespace: options.namespace });
  const candidates: QualityCandidate[] = [];
  const bodyDigests = new Map<string, string>();

  for (const planned of importPlan.payload.candidates) {
    const initialDiagnostics = planned.diagnostics.map(fromImportDiagnostic);
    if (planned.proposed_id === null || planned.version_hash === null) {
      candidates.push(Object.freeze({
        relative_root: planned.relative_root,
        skill_id: null,
        version_hash: null,
        l1_status: null,
        l1_tokens: null,
        l2_tokens: null,
        aliases: Object.freeze([]),
        platforms: Object.freeze([]),
        triggers: Object.freeze([]),
        anti_triggers: Object.freeze([]),
        diagnostics: Object.freeze(initialDiagnostics.sort(diagnosticSort)),
      }));
      continue;
    }
    const prepared = await prepareSkillRoot(rootFor(sourcePath, planned.relative_root), options.namespace);
    const skillMd = prepared.files.find((file) => file.record.path === "SKILL.md");
    if (skillMd !== undefined) bodyDigests.set(prepared.skillId, hashBytes(skillMd.bytes));
    const diagnostics = [
      ...initialDiagnostics,
      ...l1Diagnostics(prepared),
      ...routingDiagnostics(prepared),
      ...brokenReferences(prepared),
    ];
    candidates.push(Object.freeze({
      relative_root: planned.relative_root,
      skill_id: prepared.skillId,
      version_hash: prepared.versionHash,
      l1_status: prepared.l1Status,
      l1_tokens: prepared.l1Tokens,
      l2_tokens: prepared.l2Tokens,
      aliases: Object.freeze([...prepared.routing.aliases].sort(compare)),
      platforms: Object.freeze([...prepared.routing.platforms].sort(compare)),
      triggers: Object.freeze([...prepared.routing.triggers].sort(compare)),
      anti_triggers: Object.freeze([...prepared.routing.antiTriggers].sort(compare)),
      diagnostics: Object.freeze(diagnostics.sort(diagnosticSort)),
    }));
  }

  const duplicates = duplicateBodyDiagnostics(candidates, bodyDigests);
  const finalCandidates = candidates.map((candidate) => {
    const extra = candidate.skill_id === null ? [] : (duplicates.get(candidate.skill_id) ?? []).map((item) => Object.freeze({
      ...item,
      related_ids: Object.freeze([...item.related_ids]),
      details: Object.freeze({ ...item.details }),
    }));
    return Object.freeze({ ...candidate, diagnostics: Object.freeze([...candidate.diagnostics, ...extra].sort(diagnosticSort)) });
  });
  const allDiagnostics = finalCandidates.flatMap((candidate) => candidate.diagnostics);
  const payload: QualityReportPayload = Object.freeze({
    quality_contract: "Q1",
    policy_revision: QUALITY_POLICY_REVISION,
    namespace: options.namespace,
    source_digest: importPlan.payload.source.snapshot_digest,
    candidates: Object.freeze(finalCandidates),
    summary: Object.freeze({
      candidate_count: finalCandidates.length,
      blocked_count: allDiagnostics.filter((item) => item.severity === "ERROR").length,
      warning_count: allDiagnostics.filter((item) => item.severity === "WARNING").length,
      info_count: allDiagnostics.filter((item) => item.severity === "INFO").length,
    }),
  });
  return createEnvelope({ object_type: QUALITY_OBJECT_TYPE, schema_version: QUALITY_SCHEMA_VERSION, payload }) as QualityReportDocument;
}
