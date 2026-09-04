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
  getAliasOwner,
  getCacheBlob,
  getCurrentVersion,
  getCurrentVersionHash,
  getSkillVersion,
  getTokenCount,
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
  const paths = ensureRegistryHome(env, userHome);

  let db: DatabaseConnection;
  try {
    db = new Database(paths.database);
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

    enableForeignKeys(db);
    assertFts5Available(db);
    runRegistryMigrations(db, schemaVersion);

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
