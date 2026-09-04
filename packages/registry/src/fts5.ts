import type { DatabaseConnection } from "better-sqlite3";

import { RegistryError } from "./errors.js";

const FTS5_MODULE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const FTS5_PROBE_TABLE = "temp.__ega_skills_fts5_probe";

export function assertFts5Available(
  db: DatabaseConnection,
  moduleName: string = "fts5",
): void {
  if (!FTS5_MODULE_NAME.test(moduleName)) {
    throw new RegistryError(
      "E_REGISTRY_FTS5_UNAVAILABLE",
      "SQLite FTS5 capability probe was rejected",
    );
  }

  try {
    db.exec(`DROP TABLE IF EXISTS ${FTS5_PROBE_TABLE}`);
    db.exec(
      `CREATE VIRTUAL TABLE ${FTS5_PROBE_TABLE} USING ${moduleName}(probe, tokenize = 'unicode61 remove_diacritics 1')`,
    );
    db.exec(`DROP TABLE ${FTS5_PROBE_TABLE}`);
  } catch (error) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${FTS5_PROBE_TABLE}`);
    } catch {
      // Preserve the capability failure as the startup error.
    }
    throw new RegistryError(
      "E_REGISTRY_FTS5_UNAVAILABLE",
      "SQLite FTS5 is required by the V1 registry",
      error,
    );
  }
}
