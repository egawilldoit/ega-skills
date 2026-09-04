// SPEC-003 §5.1.13 + SPEC-001 §5.1.11 transactional alias ownership (EGA-567).
//
// skill_aliases.alias is globally unique (PRIMARY KEY); the database enforces
// single ownership. This module reconciles one skill's alias claims INSIDE the
// importer's per-skill transaction (EGA-566 owns the transaction boundaries):
// same-skill re-import is idempotent, new versions may ADD aliases, omission
// in later source never releases an owned alias, and a cross-skill claim
// raises E_ALIAS_CONFLICT so the caller rolls back with no partial rows.
// SQLite driver failures are translated to the domain error without leaking
// driver-specific text. No alias GC or reassignment in V1.

import type { DatabaseConnection } from "better-sqlite3";

import { RegistryError } from "./errors.js";

export interface ApplyAliasesResult {
  readonly owned: readonly string[];
  readonly added: readonly string[];
}

export function getAliasOwner(db: DatabaseConnection, alias: string): string | null {
  const row = db
    .prepare("SELECT skill_id AS skillId FROM skill_aliases WHERE alias = ?")
    .get<{ skillId: string }>(alias) as { skillId: string } | undefined;
  return row?.skillId ?? null;
}

export function listSkillAliases(db: DatabaseConnection, skillId: string): string[] {
  const rows = db
    .prepare("SELECT alias FROM skill_aliases WHERE skill_id = ? ORDER BY alias ASC")
    .all<{ alias: string }>(skillId) as Array<{ alias: string }>;
  return rows.map((row) => row.alias);
}

function conflictError(alias: string, owner: string, claimant: string): RegistryError {
  return new RegistryError(
    "E_ALIAS_CONFLICT",
    `Alias ${JSON.stringify(alias)} is already owned by ${JSON.stringify(owner)} and cannot map to ${JSON.stringify(claimant)}.`,
  );
}

export function applySkillAliases(
  db: DatabaseConnection,
  skillId: string,
  aliases: readonly string[],
): ApplyAliasesResult {
  const added: string[] = [];
  for (const alias of [...new Set(aliases)].sort()) {
    try {
      db.prepare("INSERT INTO skill_aliases (alias, skill_id) VALUES (?, ?)").run(alias, skillId);
      added.push(alias);
    } catch (error) {
      const owner = getAliasOwner(db, alias);
      if (owner === skillId) {
        continue;
      }
      if (owner !== null) {
        throw conflictError(alias, owner, skillId);
      }
      throw error;
    }
  }
  return { owned: listSkillAliases(db, skillId), added };
}
