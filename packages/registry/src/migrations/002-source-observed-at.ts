// Registry migration 002: real source-observation timestamps (AMEND-07, EGA-612).
//
// SPEC-003 §5.1.15 (as amended) requires every skill_sources row to carry
// `observed_at`: the ISO-8601 UTC instant the observation was recorded.
// Registries created by migration 001 have no such column, so this migration:
//
//   1. adds the nullable TEXT column (SQLite forbids non-constant ADD COLUMN
//      defaults, so nullability here is a storage detail, not a contract —
//      every writer fills the value, see recordSourceObservation/importer);
//   2. backfills pre-existing rows with the migration instant
//      (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'): ISO-8601 UTC with millisecond
//      precision, the same shape as Date.toISOString()). The backfill instant
//      is documented as a migration-time approximation; order among backfilled
//      rows remains source_id order via the SPEC-006 tie-break.
//
// Explicitly out of identity scope: observed_at never enters the canonical
// manifest, version hashes, or blob identities (SPEC-002 untouched), so this
// migration cannot alter any existing version identity.

export const SOURCE_OBSERVED_AT_VERSION = 2 as const;

export const SOURCE_OBSERVED_AT_SQL = `
ALTER TABLE skill_sources ADD COLUMN observed_at TEXT;
UPDATE skill_sources SET observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE observed_at IS NULL;
`;
