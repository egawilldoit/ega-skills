// Pure source preparation and explicit registry commit boundary.
//
// Preparation reads and validates a source tree, canonicalizes every file,
// and derives its immutable identity without touching the registry or cache.
// Commit is the only operation in this module allowed to persist that result.

import { basename } from "node:path";

import {
  EGA_O200K_V1_ESTIMATOR_ID,
  assertL1TokenBudget,
  buildCanonicalSkillId,
  classifyL2SizeClass,
  parseEgaMetadata,
  parsePortableSkill,
  resolveL1Status,
  tokenEstimator,
  validateNamespace,
  SchemaValidationError,
  type EgaRoutingMetadata,
  type L1Status,
  type L2SizeClass,
  type PortableSkill,
} from "@ega-skills/schema";
import {
  buildCanonicalSkillVersionManifest,
  canonicalByteSize,
  canonicalBytes,
  canonicalPackagePath,
  canonicalizeJson,
  canonicalizeText,
  classifyContent,
  enumerateCanonicalFileRecords,
  hashBlobBytes,
  hashCanonicalManifest,
  resolveTraversalRoot,
  type CanonicalFileRecord,
} from "@ega-skills/hashing";

import { applySkillAliases } from "./aliases.js";
import { putCacheBlob } from "./cache.js";
import { upsertVersionFts } from "./search.js";
import {
  applyVersionLifecycle,
  recordTokenCount,
  type ImportOutcome,
} from "./versions.js";
import type { RegistryHandle } from "./index.js";

export interface PreparedFile {
  readonly record: CanonicalFileRecord;
  readonly bytes: Uint8Array;
}

export interface PreparedSkill {
  readonly sourceRoot: string;
  readonly skillId: string;
  readonly versionHash: string;
  readonly manifestJson: string;
  readonly portable: PortableSkill;
  readonly routing: EgaRoutingMetadata;
  readonly files: readonly PreparedFile[];
  readonly l1Status: L1Status;
  readonly l1Tokens: number | null;
  readonly l2Tokens: number;
  readonly l2SizeClass: L2SizeClass;
}

export interface CommittedPreparedSkill {
  readonly skillId: string;
  readonly versionHash: string;
  readonly outcome: ImportOutcome;
  readonly root: string;
}

interface PreparedSnapshot {
  readonly sourceRoot: string;
  readonly skillId: string;
  readonly versionHash: string;
  readonly manifestJson: string;
  readonly l1Status: L1Status;
  readonly l1Tokens: number | null;
  readonly l2Tokens: number;
  readonly l2SizeClass: L2SizeClass;
  readonly records: readonly CanonicalFileRecord[];
}

const snapshots = new WeakMap<PreparedSkill, PreparedSnapshot>();

function manifestFor(
  skillId: string,
  portable: PortableSkill,
  routing: EgaRoutingMetadata,
  records: readonly CanonicalFileRecord[],
) {
  return buildCanonicalSkillVersionManifest({
    skillId,
    portable: {
      name: portable.name,
      description: portable.description,
      ...(portable.license !== undefined ? { license: portable.license } : {}),
      ...(portable.compatibility !== undefined ? { compatibility: portable.compatibility } : {}),
      ...(portable.metadata !== undefined ? { metadata: portable.metadata } : {}),
      ...(portable.allowedTools !== undefined ? { allowedTools: portable.allowedTools } : {}),
      ...(portable.disableModelInvocation !== undefined
        ? { disableModelInvocation: portable.disableModelInvocation }
        : {}),
      ...(portable.argumentHint !== undefined ? { argumentHint: portable.argumentHint } : {}),
    },
    routing: {
      domains: routing.domains,
      platforms: routing.platforms,
      frameworks: routing.frameworks,
      triggers: routing.triggers,
      antiTriggers: routing.antiTriggers,
      aliases: routing.aliases,
    },
    files: records,
  });
}

function copyRecord(record: CanonicalFileRecord): CanonicalFileRecord {
  return Object.freeze({ ...record });
}

function recordsMatch(
  actual: readonly CanonicalFileRecord[],
  expected: readonly CanonicalFileRecord[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((record, index) => {
    const saved = expected[index];
    return (
      saved !== undefined &&
      record.path === saved.path &&
      record.role === saved.role &&
      record.blob_hash === saved.blob_hash &&
      record.byte_size === saved.byte_size &&
      record.content_kind === saved.content_kind
    );
  });
}

function validatePreparedSkill(prepared: PreparedSkill): void {
  const snapshot = snapshots.get(prepared);
  if (snapshot === undefined) {
    throw new TypeError("Prepared skill was not created by prepareSkillRoot.");
  }

  const records = prepared.files.map((file) => file.record);
  if (
    prepared.sourceRoot !== snapshot.sourceRoot ||
    prepared.skillId !== snapshot.skillId ||
    prepared.l1Status !== snapshot.l1Status ||
    prepared.l1Tokens !== snapshot.l1Tokens ||
    prepared.l2Tokens !== snapshot.l2Tokens ||
    prepared.l2SizeClass !== snapshot.l2SizeClass ||
    !recordsMatch(records, snapshot.records)
  ) {
    throw new Error("Prepared skill was mutated after preparation.");
  }

  for (const file of prepared.files) {
    if (file.bytes.byteLength !== file.record.byte_size) {
      throw new Error(`Prepared bytes size changed for ${file.record.path}.`);
    }
    if (hashBlobBytes(file.bytes) !== file.record.blob_hash) {
      throw new Error(`Prepared bytes hash changed for ${file.record.path}.`);
    }
  }

  const manifest = manifestFor(prepared.skillId, prepared.portable, prepared.routing, records);
  const manifestJson = new TextDecoder().decode(canonicalizeJson(manifest));
  if (manifestJson !== snapshot.manifestJson || hashCanonicalManifest(manifest) !== snapshot.versionHash) {
    throw new Error("Prepared skill identity changed after preparation.");
  }
}

function classifyFileRole(canonicalPath: string): CanonicalFileRecord["role"] {
  if (canonicalPath === "SKILL.md") return "skill-body";
  if (canonicalPath === "SKILL.core.md") return "core";
  if (canonicalPath === "ega.yaml") return "ega-metadata";
  if (canonicalPath.startsWith("references/")) return "reference";
  if (canonicalPath.startsWith("assets/")) return "asset";
  if (canonicalPath.startsWith("scripts/")) return "script";
  return "other";
}

/** Prepare one explicit skill root without creating registry or cache state. */
export async function prepareSkillRoot(
  root: string,
  namespace: string,
): Promise<PreparedSkill> {
  const validatedNamespace = validateNamespace(namespace, { field: "namespace" });
  const traversalRoot = await resolveTraversalRoot(root);
  const canonicalByPath = new Map<string, Uint8Array>();
  const records = await enumerateCanonicalFileRecords(traversalRoot, async (file) => {
    const raw = await file.read();
    const kind = classifyContent(raw);
    const canonical = kind === "TEXT" ? canonicalBytes(raw) : Uint8Array.from(raw);
    const path = canonicalPackagePath(file.relativePath);
    canonicalByPath.set(path, canonical);
    return {
      role: classifyFileRole(path),
      blob_hash: hashBlobBytes(canonical),
      byte_size: canonicalByteSize(raw),
      content_kind: kind,
    };
  });
  const byPath = new Map(records.map((record) => [record.path, record]));
  const skillMdRecord = byPath.get("SKILL.md");
  const skillMdBytes = skillMdRecord === undefined ? undefined : canonicalByPath.get("SKILL.md");
  const skillCoreBytes = canonicalByPath.get("SKILL.core.md");
  const egaYamlBytes = canonicalByPath.get("ega.yaml");

  const portable = parsePortableSkill({
    directoryName: basename(traversalRoot.lexicalRoot),
    ...(skillMdBytes !== undefined ? { skillMd: skillMdBytes } : {}),
    ...(skillCoreBytes !== undefined ? { skillCoreMd: skillCoreBytes } : {}),
    ...(egaYamlBytes !== undefined ? { egaYaml: egaYamlBytes } : {}),
  });
  const skillId = buildCanonicalSkillId(validatedNamespace, portable.name);
  const routing = parseEgaMetadata(egaYamlBytes);

  if (skillMdRecord === undefined || skillMdBytes === undefined) {
    throw new Error(`Internal preparation error: SKILL.md bytes missing for ${root}.`);
  }
  if (skillMdRecord.content_kind !== "TEXT") {
    throw new Error(`SKILL.md must be UTF-8 text in ${root}.`);
  }
  const l2Tokens = tokenEstimator.count(canonicalizeText(skillMdBytes));

  let l1Status = resolveL1Status(skillCoreBytes);
  let l1Tokens: number | null = null;
  const coreRecord = byPath.get("SKILL.core.md");
  if (l1Status === "AUTHORED" && skillCoreBytes !== undefined) {
    if (coreRecord?.content_kind !== "TEXT") {
      throw new Error(`SKILL.core.md must be UTF-8 text in ${root}.`);
    }
    const counted = tokenEstimator.count(canonicalizeText(skillCoreBytes));
    try {
      assertL1TokenBudget(counted);
      l1Tokens = counted;
    } catch (error) {
      if (error instanceof SchemaValidationError && error.code === "E_L1_TOO_LARGE") {
        l1Status = "MISSING";
        l1Tokens = null;
      } else {
        throw error;
      }
    }
  }

  const manifest = manifestFor(skillId, portable, routing, records);
  const prepared: PreparedSkill = Object.freeze({
    sourceRoot: traversalRoot.lexicalRoot,
    skillId,
    versionHash: hashCanonicalManifest(manifest),
    manifestJson: new TextDecoder().decode(canonicalizeJson(manifest)),
    portable,
    routing,
    files: Object.freeze(
      records.map((record) => {
        const bytes = canonicalByPath.get(record.path);
        if (bytes === undefined) {
          throw new Error(`Internal preparation error: bytes missing for ${record.path}.`);
        }
        return Object.freeze({ record: copyRecord(record), bytes });
      }),
    ),
    l1Status,
    l1Tokens,
    l2Tokens,
    l2SizeClass: classifyL2SizeClass(l2Tokens),
  });
  snapshots.set(prepared, {
    sourceRoot: prepared.sourceRoot,
    skillId: prepared.skillId,
    versionHash: prepared.versionHash,
    manifestJson: prepared.manifestJson,
    l1Status: prepared.l1Status,
    l1Tokens: prepared.l1Tokens,
    l2Tokens: prepared.l2Tokens,
    l2SizeClass: prepared.l2SizeClass,
    records: Object.freeze(records.map(copyRecord)),
  });
  return prepared;
}

function hasSourceObservation(registry: RegistryHandle, prepared: PreparedSkill): boolean {
  const row = registry.db
    .prepare(
      "SELECT 1 AS one FROM skill_sources WHERE skill_id = ? AND version_hash = ? AND source_type = ? AND local_path IS ? AND repository IS NULL AND commit_sha IS NULL AND repository_path IS NULL",
    )
    .get(prepared.skillId, prepared.versionHash, "local", prepared.sourceRoot) as { one: number } | undefined;
  return row !== undefined;
}

/** Persist exactly one previously prepared identity in one per-skill transaction. */
export function commitPreparedSkill(
  registry: RegistryHandle,
  prepared: PreparedSkill,
): CommittedPreparedSkill {
  validatePreparedSkill(prepared);
  for (const file of prepared.files) {
    putCacheBlob(registry.paths.cacheSha256, file.bytes, file.record.blob_hash);
  }

  const db = registry.db;
  db.exec("BEGIN");
  try {
    const lifecycle = applyVersionLifecycle(db, {
      skillId: prepared.skillId,
      versionHash: prepared.versionHash,
      manifestJson: prepared.manifestJson,
      l1Status: prepared.l1Status,
      l2SizeClass: prepared.l2SizeClass,
      trustLevel: "UNKNOWN",
    });
    for (const file of prepared.files) {
      const record = file.record;
      db.prepare(
        "INSERT OR IGNORE INTO skill_files (skill_id, version_hash, path, role, blob_hash, byte_size, content_kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        prepared.skillId,
        prepared.versionHash,
        record.path,
        record.role,
        record.blob_hash,
        record.byte_size,
        record.content_kind,
      );
    }
    const skillMd = prepared.files.find((file) => file.record.path === "SKILL.md");
    if (skillMd === undefined) throw new Error("Prepared skill has no SKILL.md record.");
    recordTokenCount(db, {
      blobHash: skillMd.record.blob_hash,
      estimatorId: EGA_O200K_V1_ESTIMATOR_ID,
      tokenCount: prepared.l2Tokens,
    });
    const core = prepared.files.find((file) => file.record.path === "SKILL.core.md");
    if (prepared.l1Status === "AUTHORED" && prepared.l1Tokens !== null && core !== undefined) {
      recordTokenCount(db, {
        blobHash: core.record.blob_hash,
        estimatorId: EGA_O200K_V1_ESTIMATOR_ID,
        tokenCount: prepared.l1Tokens,
      });
    }
    applySkillAliases(db, prepared.skillId, prepared.routing.aliases);
    upsertVersionFts(db, {
      skillId: prepared.skillId,
      versionHash: prepared.versionHash,
      name: prepared.portable.name,
      description: prepared.portable.description,
      domains: prepared.routing.domains,
      platforms: prepared.routing.platforms,
      frameworks: prepared.routing.frameworks,
      triggers: prepared.routing.triggers,
      aliases: prepared.routing.aliases,
    });
    if (!hasSourceObservation(registry, prepared)) {
      db.prepare(
        "INSERT INTO skill_sources (skill_id, version_hash, source_type, local_path, repository, commit_sha, repository_path, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        prepared.skillId,
        prepared.versionHash,
        "local",
        prepared.sourceRoot,
        null,
        null,
        null,
        new Date().toISOString(),
      );
    }
    db.exec("COMMIT");
    return {
      skillId: prepared.skillId,
      versionHash: prepared.versionHash,
      outcome: lifecycle.outcome,
      root: prepared.sourceRoot,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original per-skill failure.
    }
    throw error;
  }
}

export function preparationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
