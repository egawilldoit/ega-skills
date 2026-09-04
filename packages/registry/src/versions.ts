// SPEC-003 §5.1.12, §5.1.14–§5.1.16 immutable version lifecycle (EGA-568).
//
// skill_versions rows are IMMUTABLE: once inserted, a (skill_id, version_hash)
// row is never updated. skills.current_version_hash is the only moving pointer.
// The same version MAY carry multiple skill_sources rows (observations) and
// token_counts rows keyed by (blob_hash, estimator_id).
//
// Transaction ownership: applyVersionLifecycle assumes the CALLER owns the
// transaction (EGA-566 wraps version + files + sources + aliases + FTS + token
// rows in ONE per-skill transaction). recordVersion is the standalone wrapper
// that BEGINs/COMMITs a single-skill lifecycle transaction for direct use.
// skills <-> skill_versions FKs are mutually deferred, so the pair MUST commit
// atomically — never insert one half outside a transaction.
//
// Binary rule (AMEND-02): binary blobs get NO token_counts row; getTokenCount
// returns null (unavailable), never a fake zero. Callers (importer) must not
// record token counts for BINARY content_kind blobs.

import type { DatabaseConnection } from "better-sqlite3";

import { RegistryError } from "./errors.js";

export type ImportOutcome = "NEW_LOCAL_VERSION" | "NO_CHANGE";

export interface VersionRecord {
  readonly skillId: string;
  readonly versionHash: string;
  readonly manifestJson: string;
  readonly l1Status: string;
  readonly l2SizeClass: string;
  readonly trustLevel: string;
}

export interface RecordVersionInput {
  readonly skillId: string;
  readonly versionHash: string;
  readonly manifestJson: string;
  readonly l1Status: string;
  readonly l2SizeClass: string;
  readonly trustLevel?: string;
}

export interface ApplyVersionLifecycleResult {
  readonly outcome: ImportOutcome;
  readonly version: VersionRecord;
  /** True when a new immutable version row was inserted (false on reuse/NO_CHANGE). */
  readonly created: boolean;
}

export interface SourceObservation {
  readonly sourceType: string;
  readonly localPath?: string | null;
  readonly repository?: string | null;
  readonly commitSha?: string | null;
  readonly repositoryPath?: string | null;
}

export interface SourceRecord {
  readonly sourceId: number;
  readonly skillId: string;
  readonly versionHash: string;
  readonly sourceType: string;
  readonly localPath: string | null;
  readonly repository: string | null;
  readonly commitSha: string | null;
  readonly repositoryPath: string | null;
}

export interface TokenCountInput {
  readonly blobHash: string;
  readonly estimatorId: string;
  readonly tokenCount: number;
}

const DEFAULT_TRUST_LEVEL = "UNKNOWN";

function splitSkillId(skillId: string): { namespace: string; name: string } {
  const slash = skillId.indexOf("/");
  if (slash <= 0 || slash === skillId.length - 1) {
    // Programmer-input error: no frozen domain code applies, fail fast.
    throw new Error(`Invalid canonical skill ID ${JSON.stringify(skillId)}: expected "namespace/name".`);
  }
  return { namespace: skillId.slice(0, slash), name: skillId.slice(slash + 1) };
}

function notFound(skillId: string, versionHash: string): RegistryError {
  return new RegistryError(
    "E_VERSION_NOT_FOUND",
    `No local version ${JSON.stringify(versionHash)} for skill ${JSON.stringify(skillId)}.`,
  );
}

function rowToVersion(row: {
  skill_id: string;
  version_hash: string;
  manifest_json: string;
  l1_status: string;
  l2_size_class: string;
  trust_level: string;
}): VersionRecord {
  return {
    skillId: row.skill_id,
    versionHash: row.version_hash,
    manifestJson: row.manifest_json,
    l1Status: row.l1_status,
    l2SizeClass: row.l2_size_class,
    trustLevel: row.trust_level,
  };
}

function selectVersion(
  db: DatabaseConnection,
  skillId: string,
  versionHash: string,
): VersionRecord | null {
  const row = db
    .prepare(
      "SELECT skill_id, version_hash, manifest_json, l1_status, l2_size_class, trust_level FROM skill_versions WHERE skill_id = ? AND version_hash = ?",
    )
    .get<{ skill_id: string; version_hash: string; manifest_json: string; l1_status: string; l2_size_class: string; trust_level: string }>(
      skillId,
      versionHash,
    ) as
    | {
        skill_id: string;
        version_hash: string;
        manifest_json: string;
        l1_status: string;
        l2_size_class: string;
        trust_level: string;
      }
    | undefined;
  return row ? rowToVersion(row) : null;
}

/** Exact historical lookup. Never substitutes the current version. */
export function getSkillVersion(
  db: DatabaseConnection,
  skillId: string,
  versionHash: string,
): VersionRecord {
  const version = selectVersion(db, skillId, versionHash);
  if (!version) throw notFound(skillId, versionHash);
  return version;
}

/** Current-pointer hash. Unknown skills report E_VERSION_NOT_FOUND. */
export function getCurrentVersionHash(db: DatabaseConnection, skillId: string): string {
  const row = db
    .prepare("SELECT current_version_hash AS current FROM skills WHERE skill_id = ?")
    .get<{ current: string }>(skillId) as { current: string } | undefined;
  if (!row) {
    throw new RegistryError(
      "E_VERSION_NOT_FOUND",
      `Unknown skill ${JSON.stringify(skillId)}: no current version.`,
    );
  }
  return row.current;
}

/** Resolve the current pointer to its immutable version row. */
export function getCurrentVersion(db: DatabaseConnection, skillId: string): VersionRecord {
  const current = getCurrentVersionHash(db, skillId);
  return getSkillVersion(db, skillId, current);
}

/** All immutable rows for a skill in insertion order. */
export function listSkillVersions(db: DatabaseConnection, skillId: string): VersionRecord[] {
  const rows = db
    .prepare(
      "SELECT skill_id, version_hash, manifest_json, l1_status, l2_size_class, trust_level FROM skill_versions WHERE skill_id = ? ORDER BY rowid ASC",
    )
    .all<{
      skill_id: string;
      version_hash: string;
      manifest_json: string;
      l1_status: string;
      l2_size_class: string;
      trust_level: string;
    }>(skillId) as Array<{
    skill_id: string;
    version_hash: string;
    manifest_json: string;
    l1_status: string;
    l2_size_class: string;
    trust_level: string;
  }>;
  return rows.map(rowToVersion);
}

/**
 * Core lifecycle step. Caller MUST own the transaction (this runs the skill +
 * version + pointer writes without BEGIN/COMMIT so EGA-566 can compose it with
 * files/sources/aliases/FTS/token rows in one per-skill transaction).
 */
export function applyVersionLifecycle(
  db: DatabaseConnection,
  input: RecordVersionInput,
): ApplyVersionLifecycleResult {
  const { namespace, name } = splitSkillId(input.skillId);
  const trustLevel = input.trustLevel ?? DEFAULT_TRUST_LEVEL;

  const skill = db
    .prepare("SELECT current_version_hash AS current FROM skills WHERE skill_id = ?")
    .get<{ current: string }>(input.skillId) as { current: string } | undefined;

  if (!skill) {
    db.prepare(
      "INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES (?, ?, ?, ?)",
    ).run(input.skillId, namespace, name, input.versionHash);
    db.prepare(
      "INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class, trust_level) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      input.skillId,
      input.versionHash,
      input.manifestJson,
      input.l1Status,
      input.l2SizeClass,
      trustLevel,
    );
    const version = selectVersion(db, input.skillId, input.versionHash);
    if (!version) throw notFound(input.skillId, input.versionHash);
    return { outcome: "NEW_LOCAL_VERSION", version, created: true };
  }

  // NO_CHANGE means "hash equals current hash" — not merely "known history".
  if (skill.current === input.versionHash) {
    const version = selectVersion(db, input.skillId, input.versionHash);
    if (!version) throw notFound(input.skillId, input.versionHash);
    return { outcome: "NO_CHANGE", version, created: false };
  }

  // H != current: NEW_LOCAL_VERSION. Reuse the historical row when present
  // (INSERT OR IGNORE keeps the stored immutable values), else insert.
  const inserted = db
    .prepare(
      "INSERT OR IGNORE INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class, trust_level) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.skillId,
      input.versionHash,
      input.manifestJson,
      input.l1Status,
      input.l2SizeClass,
      trustLevel,
    );
  db.prepare("UPDATE skills SET current_version_hash = ? WHERE skill_id = ?").run(
    input.versionHash,
    input.skillId,
  );
  const version = selectVersion(db, input.skillId, input.versionHash);
  if (!version) throw notFound(input.skillId, input.versionHash);
  return {
    outcome: "NEW_LOCAL_VERSION",
    version,
    created: (inserted.changes ?? 0) > 0,
  };
}

/** Standalone single-skill lifecycle transaction (BEGIN/COMMIT owned here). */
export function recordVersion(
  db: DatabaseConnection,
  input: RecordVersionInput,
): ApplyVersionLifecycleResult {
  db.exec("BEGIN");
  try {
    const result = applyVersionLifecycle(db, input);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original lifecycle failure.
    }
    throw error;
  }
}

/**
 * Record one source observation for a KNOWN version. Multiple observations per
 * version are expected (same content imported from multiple locations).
 * Provenance is administrative: it never changes version identity and never
 * moves the current pointer.
 */
export function recordSourceObservation(
  db: DatabaseConnection,
  skillId: string,
  versionHash: string,
  observation: SourceObservation,
): { sourceId: number } {
  if (!selectVersion(db, skillId, versionHash)) throw notFound(skillId, versionHash);
  const result = db
    .prepare(
      "INSERT INTO skill_sources (skill_id, version_hash, source_type, local_path, repository, commit_sha, repository_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      skillId,
      versionHash,
      observation.sourceType,
      observation.localPath ?? null,
      observation.repository ?? null,
      observation.commitSha ?? null,
      observation.repositoryPath ?? null,
    );
  return { sourceId: Number(result.lastInsertRowid) };
}

/** Observations for one version in insertion order. */
export function listVersionSources(
  db: DatabaseConnection,
  skillId: string,
  versionHash: string,
): SourceRecord[] {
  const rows = db
    .prepare(
      "SELECT source_id, skill_id, version_hash, source_type, local_path, repository, commit_sha, repository_path FROM skill_sources WHERE skill_id = ? AND version_hash = ? ORDER BY source_id ASC",
    )
    .all<{
      source_id: number;
      skill_id: string;
      version_hash: string;
      source_type: string;
      local_path: string | null;
      repository: string | null;
      commit_sha: string | null;
      repository_path: string | null;
    }>(skillId, versionHash) as Array<{
    source_id: number;
    skill_id: string;
    version_hash: string;
    source_type: string;
    local_path: string | null;
    repository: string | null;
    commit_sha: string | null;
    repository_path: string | null;
  }>;
  return rows.map((row) => ({
    sourceId: row.source_id,
    skillId: row.skill_id,
    versionHash: row.version_hash,
    sourceType: row.source_type,
    localPath: row.local_path,
    repository: row.repository,
    commitSha: row.commit_sha,
    repositoryPath: row.repository_path,
  }));
}

/**
 * Store a derived token count. First-wins dedupe on (blob_hash, estimator_id):
 * the frozen estimator is deterministic so recounts agree; recounts MUST NOT
 * alter version hashes (they touch only this table). Never call for BINARY
 * blobs — binary has no row and projects as null.
 */
export function recordTokenCount(
  db: DatabaseConnection,
  input: TokenCountInput,
): { inserted: boolean } {
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO token_counts (blob_hash, estimator_id, token_count) VALUES (?, ?, ?)",
    )
    .run(input.blobHash, input.estimatorId, input.tokenCount);
  return { inserted: (result.changes ?? 0) > 0 };
}

/** Derived count, or null when unavailable (binary blobs, uncounted blobs). Never 0-as-sentinel. */
export function getTokenCount(
  db: DatabaseConnection,
  blobHash: string,
  estimatorId: string,
): number | null {
  const row = db
    .prepare("SELECT token_count AS count FROM token_counts WHERE blob_hash = ? AND estimator_id = ?")
    .get<{ count: number }>(blobHash, estimatorId) as { count: number } | undefined;
  return row?.count ?? null;
}
