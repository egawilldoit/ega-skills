import { homedir } from "node:os";
import process from "node:process";

import Database, { type DatabaseConnection } from "better-sqlite3";

import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  isRegistryError,
  type RegistryErrorCode,
} from "./errors.js";
import { assertFts5Available } from "./fts5.js";
import {
  ensureRegistryHome,
  resolveRegistryHome,
  resolveRegistryPaths,
  type RegistryPaths,
} from "./home.js";
import {
  CURRENT_SCHEMA_VERSION,
  REGISTRY_MIGRATIONS,
  runRegistryMigrations,
} from "./migrations/index.js";
import {
  applySkillAliases,
  getAliasOwner,
  listSkillAliases,
} from "./aliases.js";
import {
  BLOB_HASH_PREFIX,
  cacheBlobPath,
  cacheBlobPathForHash,
  getCacheBlob,
  parseBlobDigest,
  putCacheBlob,
  sha256DigestHex,
} from "./cache.js";
import {
  applyVersionLifecycle,
  getCurrentVersion,
  getCurrentVersionHash,
  getSkillVersion,
  getTokenCount,
  listSkillVersions,
  listVersionSources,
  recordSourceObservation,
  recordTokenCount,
  recordVersion,
} from "./versions.js";
import {
  buildMatchInput,
  normalizeSearchQuery,
  rebuildSkillFts,
  searchSkills,
  serializeFtsArray,
  upsertVersionFts,
} from "./search.js";
import { discoverSkillRoots } from "./discovery.js";
import { importSkills } from "./importer.js";

export { DEFAULT_DISCOVERY_DEPTH, DISCOVERY_EXCLUDED_DIRECTORIES } from "./discovery.js";

export {
  BLOB_HASH_PREFIX,
  CURRENT_SCHEMA_VERSION,
  REGISTRY_ERROR_CODES,
  REGISTRY_MIGRATIONS,
  RegistryError,
  applySkillAliases,
  applyVersionLifecycle,
  buildMatchInput,
  cacheBlobPath,
  cacheBlobPathForHash,
  discoverSkillRoots,
  getAliasOwner,
  getCacheBlob,
  getCurrentVersion,
  getCurrentVersionHash,
  getSkillVersion,
  getTokenCount,
  importSkills,
  listSkillAliases,
  listSkillVersions,
  listVersionSources,
  normalizeSearchQuery,
  parseBlobDigest,
  putCacheBlob,
  recordSourceObservation,
  recordTokenCount,
  recordVersion,
  rebuildSkillFts,
  resolveRegistryHome,
  resolveRegistryPaths,
  searchSkills,
  serializeFtsArray,
  sha256DigestHex,
  upsertVersionFts,
};
export type { RegistryErrorCode, RegistryPaths };
export type { ApplyAliasesResult } from "./aliases.js";
export type { PutBlobResult } from "./cache.js";
export type { FtsVersionRow, SearchHit, SearchOptions } from "./search.js";
export type {
  ImportSkillOptions,
  ImportSummary,
  ImportedSkill,
  SkillImportFailure,
} from "./importer.js";
export type {
  ApplyVersionLifecycleResult,
  ImportOutcome,
  RecordVersionInput,
  SourceObservation,
  SourceRecord,
  TokenCountInput,
  VersionRecord,
} from "./versions.js";

export interface OpenRegistryOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
  /**
   * Capability-enforced read-only open (SPEC-006 §5.3): resolves paths
   * WITHOUT creating directories, opens SQLite with `readonly: true` (the
   * file must already exist), and NEVER runs migrations — a stale schema
   * fails with `E_REGISTRY_MIGRATION` instead of being upgraded as a side
   * effect. Resolve paths use this; import/refresh keep read-write opens.
   */
  readonly readonly?: boolean;
}

export interface RegistryHandle {
  readonly db: DatabaseConnection;
  readonly paths: RegistryPaths;
  close(): void;
}

function readSchemaVersion(db: DatabaseConnection): number {
  const version = db.pragma<number>("user_version", { simple: true });
  if (!Number.isInteger(version) || version < 0) {
    throw new RegistryError(
      "E_REGISTRY_DB_OPEN",
      "Registry database reported an invalid schema version",
    );
  }
  return version;
}

function enableForeignKeys(db: DatabaseConnection): void {
  db.pragma("foreign_keys = ON");
  const enabled = db.pragma<number>("foreign_keys", { simple: true });
  if (enabled !== 1) {
    throw new RegistryError(
      "E_REGISTRY_DB_OPEN",
      "Registry database could not enable foreign-key enforcement",
    );
  }
}

export function openRegistry(options: OpenRegistryOptions = {}): RegistryHandle {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const readonly = options.readonly ?? false;
  // Read-only opens must never materialize the home tree (no mkdir side
  // effects); read-write opens keep the legacy ensure behavior for
  // import/refresh flows.
  const paths = readonly ? resolveRegistryPaths(env, userHome) : ensureRegistryHome(env, userHome);

  let db: DatabaseConnection;
  try {
    db = readonly ? new Database(paths.database, { readonly: true }) : new Database(paths.database);
  } catch (error) {
    throw new RegistryError("E_REGISTRY_DB_OPEN", "Failed to open registry.sqlite", error);
  }

  try {
    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new RegistryError(
        "E_REGISTRY_SCHEMA_NEWER",
        `Registry schema ${schemaVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    if (readonly) {
      // A read-only open must never upgrade the file: stale (or
      // uninitialized) schemas fail closed so the caller runs an explicit
      // read-write flow (import/refresh) first.
      if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
        throw new RegistryError(
          "E_REGISTRY_MIGRATION",
          `Registry schema ${schemaVersion} requires migration to ${CURRENT_SCHEMA_VERSION}; refusing read-only open`,
        );
      }
    } else {
      runRegistryMigrations(db, schemaVersion);
    }

    enableForeignKeys(db);
    assertFts5Available(db);

    let closed = false;
    return {
      db,
      paths,
      close(): void {
        if (closed) return;
        db.close();
        closed = true;
      },
    };
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the original startup failure.
    }
    if (isRegistryError(error)) throw error;
    throw new RegistryError("E_REGISTRY_DB_OPEN", "Registry startup failed", error);
  }
}
