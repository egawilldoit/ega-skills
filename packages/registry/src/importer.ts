// SPEC-003 §5.1.10–§5.1.14 transactional importer pipeline (EGA-566).
//
// Exact pipeline order: discover → parse/normalize/hash → write blobs → ONE
// DB transaction per skill (versions, files, sources, aliases, FTS, current
// pointer). Batch siblings commit INDEPENDENTLY: one bad sibling never rolls
// back valid siblings. Every import REQUIRES an explicit namespace (AMEND-02);
// trust is always UNKNOWN (AMEND-03, never guessed); no networking, source
// trees are only ever read.
//
// L1/L2 content (SPEC-002 §5.1.16): L1 = canonical SKILL.core.md text,
// L2 = canonical SKILL.md text; token counts use ega-o200k-v1 over those
// exact canonical texts. An authored L1 over the hard budget demotes to
// MISSING (SPEC-001 §5.1.7 error guidance) while the valid L2 still imports.

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
  type CanonicalFileRole,
} from "@ega-skills/hashing";
import type { DatabaseConnection } from "better-sqlite3";

import { putCacheBlob } from "./cache.js";
import { discoverSkillRoots } from "./discovery.js";
import { applySkillAliases } from "./aliases.js";
import { upsertVersionFts } from "./search.js";
import {
  applyVersionLifecycle,
  recordTokenCount,
  type ImportOutcome,
} from "./versions.js";
import type { RegistryHandle } from "./index.js";

export interface ImportSkillOptions {
  /** Directory to import: one skill root or a collection. */
  readonly path: string;
  /** Explicit author namespace (AMEND-02). Never guessed. */
  readonly namespace: string;
}

export interface SkillImportFailure {
  readonly path: string;
  readonly error: string;
}

export interface ImportSummary {
  readonly imported: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly failures: readonly SkillImportFailure[];
}

export interface ImportedSkill {
  readonly skillId: string;
  readonly versionHash: string;
  readonly outcome: ImportOutcome;
  readonly root: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyFileRole(canonicalPath: string): CanonicalFileRole {
  if (canonicalPath === "SKILL.md") return "skill-body";
  if (canonicalPath === "SKILL.core.md") return "core";
  if (canonicalPath === "ega.yaml") return "ega-metadata";
  if (canonicalPath.startsWith("references/")) return "reference";
  if (canonicalPath.startsWith("assets/")) return "asset";
  if (canonicalPath.startsWith("scripts/")) return "script";
  return "other";
}

function hasSourceObservation(
  db: DatabaseConnection,
  skillId: string,
  versionHash: string,
  sourceType: string,
  localPath: string | null,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS one FROM skill_sources WHERE skill_id = ? AND version_hash = ? AND source_type = ? AND local_path IS ? AND repository IS NULL AND commit_sha IS NULL AND repository_path IS NULL",
    )
    .get(skillId, versionHash, sourceType, localPath) as { one: number } | undefined;
  return row !== undefined;
}

async function importSkillRoot(
  registry: RegistryHandle,
  root: string,
  namespace: string,
): Promise<ImportedSkill> {
  // SPEC-002 safe traversal owns root selection semantics (explicit symlink
  // roots resolve here; TOCTOU revalidation happens on every file read).
  const traversalRoot = await resolveTraversalRoot(root);

  const canonicalByPath = new Map<string, Uint8Array>();
  const records = await enumerateCanonicalFileRecords(traversalRoot, async (file) => {
    const raw = await file.read();
    const kind = classifyContent(raw);
    const canonical = kind === "TEXT" ? canonicalBytes(raw) : Uint8Array.from(raw);
    canonicalByPath.set(canonicalPackagePath(file.relativePath), canonical);
    return {
      role: classifyFileRole(canonicalPackagePath(file.relativePath)),
      blob_hash: hashBlobBytes(canonical),
      byte_size: canonicalByteSize(raw),
      content_kind: kind,
    };
  });
  const byPath = new Map(records.map((record) => [record.path, record]));

  const skillMdRecord = byPath.get("SKILL.md");
  const skillMdBytes =
    skillMdRecord !== undefined ? canonicalByPath.get("SKILL.md") : undefined;
  const skillCoreBytes = canonicalByPath.get("SKILL.core.md");
  const egaYamlBytes = canonicalByPath.get("ega.yaml");

  // Missing SKILL.md surfaces the frozen E_SKILL_FILE_MISSING through the
  // same parser every other validation flows through.
  const portable = parsePortableSkill({
    directoryName: basename(traversalRoot.lexicalRoot),
    ...(skillMdBytes !== undefined ? { skillMd: skillMdBytes } : {}),
    ...(skillCoreBytes !== undefined ? { skillCoreMd: skillCoreBytes } : {}),
    ...(egaYamlBytes !== undefined ? { egaYaml: egaYamlBytes } : {}),
  });
  const skillId = buildCanonicalSkillId(namespace, portable.name);
  const routing = parseEgaMetadata(egaYamlBytes);

  if (skillMdRecord === undefined || skillMdBytes === undefined) {
    throw new Error(`Internal import error: SKILL.md bytes missing for ${root}.`);
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
      // Oversized L1 demotes to MISSING; the valid L2 still imports.
      if (error instanceof SchemaValidationError && error.code === "E_L1_TOO_LARGE") {
        l1Status = "MISSING";
        l1Tokens = null;
      } else {
        throw error;
      }
    }
  }
  const l2SizeClass = classifyL2SizeClass(l2Tokens);

  const manifest = buildCanonicalSkillVersionManifest({
    skillId,
    portable: {
      name: portable.name,
      description: portable.description,
      ...(portable.license !== undefined ? { license: portable.license } : {}),
      ...(portable.compatibility !== undefined ? { compatibility: portable.compatibility } : {}),
      ...(portable.metadata !== undefined ? { metadata: portable.metadata } : {}),
      ...(portable.allowedTools !== undefined ? { allowedTools: portable.allowedTools } : {}),
    },
    routing: {
      domains: routing.domains,
      platforms: routing.platforms,
      frameworks: routing.frameworks,
      triggers: routing.triggers,
      antiTriggers: routing.antiTriggers,
      aliases: routing.aliases,
    },
    files: records.map((record) => ({
      path: record.path,
      role: record.role,
      blob_hash: record.blob_hash,
      byte_size: record.byte_size,
      content_kind: record.content_kind,
    })),
  });
  const versionHash = hashCanonicalManifest(manifest);
  const manifestJson = new TextDecoder().decode(canonicalizeJson(manifest));

  // Blobs finalize BEFORE the DB transaction: the transaction may reference
  // only finalized blobs (orphans on tx failure are acceptable, broken
  // committed references are forbidden).
  for (const record of records) {
    const canonical = canonicalByPath.get(record.path);
    if (canonical === undefined) {
      throw new Error(`Internal import error: bytes missing for ${record.path}.`);
    }
    putCacheBlob(registry.paths.cacheSha256, canonical, record.blob_hash);
  }

  const db = registry.db;
  db.exec("BEGIN");
  try {
    const lifecycle = applyVersionLifecycle(db, {
      skillId,
      versionHash,
      manifestJson,
      l1Status,
      l2SizeClass,
      trustLevel: "UNKNOWN",
    });
    for (const record of records) {
      db.prepare(
        "INSERT OR IGNORE INTO skill_files (skill_id, version_hash, path, role, blob_hash, byte_size, content_kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        skillId,
        versionHash,
        record.path,
        record.role,
        record.blob_hash,
        record.byte_size,
        record.content_kind,
      );
    }
    // Token counts persist for the L2 blob always and the L1 blob when
    // authored; BINARY blobs never gain a row (only TEXT control bodies are
    // counted here, and only TEXT records can be SKILL.md/core).
    recordTokenCount(db, {
      blobHash: skillMdRecord.blob_hash,
      estimatorId: EGA_O200K_V1_ESTIMATOR_ID,
      tokenCount: l2Tokens,
    });
    const coreBlob = coreRecord !== undefined ? coreRecord : undefined;
    if (l1Status === "AUTHORED" && l1Tokens !== null && coreBlob !== undefined) {
      recordTokenCount(db, {
        blobHash: coreBlob.blob_hash,
        estimatorId: EGA_O200K_V1_ESTIMATOR_ID,
        tokenCount: l1Tokens,
      });
    }
    // Cross-skill alias claims fail the EXACT skill's transaction with
    // E_ALIAS_CONFLICT, leaving no partial rows (rollback below).
    applySkillAliases(db, skillId, routing.aliases);
    upsertVersionFts(db, {
      skillId,
      versionHash,
      name: portable.name,
      description: portable.description,
      domains: routing.domains,
      platforms: routing.platforms,
      frameworks: routing.frameworks,
      triggers: routing.triggers,
      aliases: routing.aliases,
    });
    // Local observations are idempotent per location: re-importing the same
    // path records no duplicate row, while new locations add observations.
    if (!hasSourceObservation(db, skillId, versionHash, "local", traversalRoot.lexicalRoot)) {
      db.prepare(
        "INSERT INTO skill_sources (skill_id, version_hash, source_type, local_path, repository, commit_sha, repository_path, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        skillId,
        versionHash,
        "local",
        traversalRoot.lexicalRoot,
        null,
        null,
        null,
        new Date().toISOString(),
      );
    }
    db.exec("COMMIT");
    return { skillId, versionHash, outcome: lifecycle.outcome, root };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original per-skill failure.
    }
    throw error;
  }
}

/**
 * Import one skill root or a collection. Batch siblings commit
 * independently; the summary shape is the frozen
 * { imported, unchanged, failed, failures } contract.
 */
export async function importSkills(
  registry: RegistryHandle,
  options: ImportSkillOptions,
): Promise<ImportSummary> {
  const namespace = validateNamespace(options.namespace, { field: "namespace" });
  const roots = await discoverSkillRoots(options.path);
  let imported = 0;
  let unchanged = 0;
  let failed = 0;
  const failures: SkillImportFailure[] = [];
  for (const root of roots) {
    try {
      const result = await importSkillRoot(registry, root, namespace);
      if (result.outcome === "NEW_LOCAL_VERSION") imported += 1;
      else unchanged += 1;
    } catch (error) {
      failed += 1;
      failures.push({ path: root, error: errorMessage(error) });
    }
  }
  return { imported, unchanged, failed, failures };
}
