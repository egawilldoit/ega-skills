// SPEC-003 §5.1.4–§5.1.6 deterministic FTS5 search (EGA-569).
//
// Indexed columns are EXACTLY: skill_id UNINDEXED, version_hash UNINDEXED,
// name, description, domains, platforms, frameworks, triggers, aliases.
// Anti-triggers, L1/L2 bodies, references, assets and scripts are NEVER
// indexed — the row type has no such fields by construction.
//
// Query normalization (AMEND-03 exact contract): trim → maximal Unicode
// letter/number runs (/[\p{L}\p{N}]+/gu) → locale-independent lowercase →
// drop empties → first-occurrence dedupe → per-term FTS escaping + double
// quotes → OR join. Raw user syntax NEVER reaches MATCH: all SQL is
// parameterized. Absolute BM25 values are private; only relative order
// (bm25, skill_id, version_hash) is contract.
//
// Visibility: unlocked search exposes ONLY current_version_hash rows; locked
// search exposes ONLY exact locked-version rows. Historical rows may remain
// internally but never compete in ordinary search.

import type { DatabaseConnection } from "better-sqlite3";

export interface FtsVersionRow {
  readonly skillId: string;
  readonly versionHash: string;
  readonly name: string;
  readonly description: string;
  readonly domains: readonly string[];
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly triggers: readonly string[];
  readonly aliases: readonly string[];
}

export interface SearchHit {
  readonly skillId: string;
  readonly versionHash: string;
}

export interface SearchOptions {
  /** Locked project versions: exact (skill_id, version_hash) pairs only. */
  readonly locked?: ReadonlyMap<string, string>;
}

const TERM_RE = /[\p{L}\p{N}]+/gu;

/** AMEND-03 steps 1–4: trim, extract, lowercase, dedupe (first occurrence). */
export function normalizeSearchQuery(rawQuery: string): string[] {
  const terms = rawQuery.trim().match(TERM_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const lower = term.toLowerCase();
    if (lower.length === 0 || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

function escapeFtsTerm(term: string): string {
  return term.replace(/"/g, '""');
}

/** AMEND-03 steps 5–6: quote/escape each term, OR-join. Null when termless. */
export function buildMatchInput(terms: readonly string[]): string | null {
  if (terms.length === 0) return null;
  return terms.map((term) => `"${escapeFtsTerm(term)}"`).join(" OR ");
}

/** Routing arrays serialize newline-joined in canonical order (§5.1.5.5). */
export function serializeFtsArray(values: readonly string[]): string {
  return values.join("\n");
}

/**
 * Insert-or-replace the EXACT version row (DELETE + INSERT). Caller MUST own
 * the transaction: normal imports call this inside the per-skill transaction
 * so only the exact version row mutates (§5.1.6.4).
 */
export function upsertVersionFts(db: DatabaseConnection, row: FtsVersionRow): void {
  db.prepare("DELETE FROM skill_fts WHERE skill_id = ? AND version_hash = ?").run(
    row.skillId,
    row.versionHash,
  );
  db.prepare(
    "INSERT INTO skill_fts (skill_id, version_hash, name, description, domains, platforms, frameworks, triggers, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.skillId,
    row.versionHash,
    row.name,
    row.description,
    serializeFtsArray(row.domains),
    serializeFtsArray(row.platforms),
    serializeFtsArray(row.frameworks),
    serializeFtsArray(row.triggers),
    serializeFtsArray(row.aliases),
  );
}

/**
 * Full rebuild: DELETE all, re-INSERT sorted by (skill_id, version_hash) in
 * ONE transaction owned here, so rebuild order is deterministic (§5.1.5.7).
 */
export function rebuildSkillFts(db: DatabaseConnection, rows: readonly FtsVersionRow[]): void {
  const sorted = [...rows].sort((a, b) =>
    a.skillId < b.skillId
      ? -1
      : a.skillId > b.skillId
        ? 1
        : a.versionHash < b.versionHash
          ? -1
          : a.versionHash > b.versionHash
            ? 1
            : 0,
  );
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM skill_fts");
    for (const row of sorted) upsertVersionFts(db, row);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original rebuild failure.
    }
    throw error;
  }
}

/**
 * Deterministic L0 search. Returns visible (skill_id, version_hash) pairs in
 * relative (bm25, skill_id, version_hash) order. Empty term set matches
 * nothing. Absolute BM25 is never selected or surfaced.
 */
export function searchSkills(
  db: DatabaseConnection,
  rawQuery: string,
  options: SearchOptions = {},
): SearchHit[] {
  const matchInput = buildMatchInput(normalizeSearchQuery(rawQuery));
  if (matchInput === null) return [];

  if (options.locked !== undefined) {
    if (options.locked.size === 0) return [];
    const pairs = [...options.locked];
    const placeholders = pairs.map(() => "(?, ?)").join(", ");
    const params: string[] = [matchInput];
    for (const [skillId, versionHash] of pairs) params.push(skillId, versionHash);
    const rows = db
      .prepare(
        `SELECT f.skill_id AS skillId, f.version_hash AS versionHash FROM skill_fts AS f WHERE skill_fts MATCH ? AND (f.skill_id, f.version_hash) IN (${placeholders}) ORDER BY bm25(skill_fts), f.skill_id, f.version_hash`,
      )
      .all<{ skillId: string; versionHash: string }>(...params) as Array<{
      skillId: string;
      versionHash: string;
    }>;
    return rows.map((row) => ({ skillId: row.skillId, versionHash: row.versionHash }));
  }

  const rows = db
    .prepare(
      "SELECT f.skill_id AS skillId, f.version_hash AS versionHash FROM skill_fts AS f JOIN skills AS s ON s.skill_id = f.skill_id AND s.current_version_hash = f.version_hash WHERE skill_fts MATCH ? ORDER BY bm25(skill_fts), f.skill_id, f.version_hash",
    )
    .all<{ skillId: string; versionHash: string }>(matchInput) as Array<{
    skillId: string;
    versionHash: string;
  }>;
  return rows.map((row) => ({ skillId: row.skillId, versionHash: row.versionHash }));
}
