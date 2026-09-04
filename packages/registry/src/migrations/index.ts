import type { DatabaseConnection } from "better-sqlite3";

import { RegistryError } from "../errors.js";
import { INITIAL_SCHEMA_SQL, INITIAL_SCHEMA_VERSION } from "./001-initial-schema.js";

interface RegistryMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const REGISTRY_MIGRATIONS: readonly RegistryMigration[] = [
  {
    version: INITIAL_SCHEMA_VERSION,
    name: "001-initial-schema",
    sql: INITIAL_SCHEMA_SQL,
  },
];

export const CURRENT_SCHEMA_VERSION = INITIAL_SCHEMA_VERSION;

export function runRegistryMigrations(db: DatabaseConnection, fromVersion: number): void {
  for (const migration of REGISTRY_MIGRATIONS) {
    if (migration.version <= fromVersion) continue;

    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
      db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the migration failure as the startup error.
        }
      }
      throw new RegistryError(
        "E_REGISTRY_MIGRATION",
        `Registry migration ${migration.name} failed`,
        error,
      );
    }
  }
}
