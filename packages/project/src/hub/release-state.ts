// 1.1[F] release-scoped semantic state (EGA-628). Contract C sections 4-6.
//
// Consumes the 1.1[E] BuildResult (fresh isolated registry + verified
// catalog) read-only and derives the three semantic artifacts the HubRelease
// binds in 1.1[G]:
//   alias map          (Contract C section 4: derived EXCLUSIVELY from the
//                        selected SkillVersions; no historical inheritance)
//   token artifact     (Contract C section 6: ega-o200k-v1 counts for EXACTLY
//                        the release catalog, one L2 row per skill)
//   SearchIndexInput   (Contract C section 6: exact normalized FTS rows, one
//                        per selected SkillVersion, sorted by skill_id)
// plus the release-specific FTS corpus (Contract C section 5: one corpus per
// release as its OWN table — never a visibility filter on shared rows).
//
// The check* functions are the pure runtime form of the Contract C validator
// rules so 1.1[G] can verify artifacts before emitting a HubRelease.

import { tmpdir } from "node:os";
import { getSkillVersion, getTokenCount, listSkillAliases, openRegistry } from "@ega-skills/registry";
import { HubError } from "./errors.js";
import type { HubBuildResult } from "./builder.js";

/** Frozen token estimator (Contract C section 6; canonical ID owned by schema). */
export const RELEASE_TOKEN_ESTIMATOR = "ega-o200k-v1" as const;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

/** Minimal structural handle: any better-sqlite3 connection satisfies this. */
export interface ReleaseFtsDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get<T>(...params: unknown[]): T | undefined;
    all<T>(...params: unknown[]): T[];
  };
}

export interface AliasMapDoc {
  readonly aliases: Readonly<Record<string, string>>;
}

export interface TokenCountRow {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly level: "L1" | "L2";
  readonly tokens: number;
}

export interface TokenArtifactDoc {
  readonly estimator: typeof RELEASE_TOKEN_ESTIMATOR;
  readonly counts: readonly TokenCountRow[];
}

export interface SearchIndexRow {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly name: string;
  readonly description: string;
  readonly domains: readonly string[];
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly triggers: readonly string[];
  readonly aliases: readonly string[];
}

export interface SearchIndexInputDoc {
  readonly rows: readonly SearchIndexRow[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedIds(build: HubBuildResult): string[] {
  return build.skills.map((s) => s.skillId).sort((a, b) => (a < b ? -1 : 1));
}

function openBuildRegistry(registryHome: string) {
  try {
    return openRegistry({ env: { EGA_SKILLS_HOME: registryHome }, userHome: tmpdir() });
  } catch (error) {
    throw new HubError("E_BUILD_ATTESTATION", `release state requires the build registry: ${String((error as Error)?.message ?? error)}`);
  }
}

/**
 * Derive the release alias map exclusively from the selected SkillVersions.
 * Keys are stored sorted (Contract C section 4).
 */
export function deriveAliasMap(build: HubBuildResult): AliasMapDoc {
  const registry = openBuildRegistry(build.registryHome);
  try {
    const owned = new Map<string, string>();
    for (const skillId of sortedIds(build)) {
      for (const alias of listSkillAliases(registry.db, skillId)) {
        const prior = owned.get(alias);
        if (prior !== undefined && prior !== skillId) {
          throw new HubError("E_ALIAS_SCOPE", `alias ${JSON.stringify(alias)} claimed by ${prior} and ${skillId}`);
        }
        owned.set(alias, skillId);
      }
    }
    const aliases: Record<string, string> = {};
    for (const key of [...owned.keys()].sort((a, b) => (a < b ? -1 : 1))) {
      aliases[key] = owned.get(key) as string;
    }
    return { aliases };
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError("E_BUILD_ATTESTATION", `alias derivation failed: ${String((error as Error)?.message ?? error)}`);
  } finally {
    registry.close();
  }
}

/**
 * Derive the token artifact: one L2 row per selected SkillVersion, bound to
 * the exact release catalog (Contract C section 6).
 */
export function deriveTokenArtifact(build: HubBuildResult): TokenArtifactDoc {
  const registry = openBuildRegistry(build.registryHome);
  try {
    const versions = new Map(build.skills.map((s) => [s.skillId, s.versionHash]));
    const counts: TokenCountRow[] = [];
    for (const skillId of sortedIds(build)) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(getSkillVersion(registry.db, skillId, versions.get(skillId) as string).manifestJson);
      } catch (error) {
        if (error instanceof HubError) throw error;
        throw new HubError("E_BUILD_ATTESTATION", `cannot read built version for ${skillId}`);
      }
      const files = (isPlainObject(manifest) ? (manifest["files"] as unknown) : undefined) as
        | Array<{ path?: unknown; blob_hash?: unknown }>
        | undefined;
      const skillMd = Array.isArray(files) ? files.find((f) => isPlainObject(f) && f["path"] === "SKILL.md") : undefined;
      const blobHash = skillMd !== undefined && isPlainObject(skillMd) ? skillMd["blob_hash"] : undefined;
      if (typeof blobHash !== "string" || blobHash.length === 0) {
        throw new HubError("E_TOKEN_ARTIFACT", `built version for ${skillId} has no SKILL.md blob`);
      }
      const tokens = getTokenCount(registry.db, blobHash, RELEASE_TOKEN_ESTIMATOR);
      if (tokens === null || !Number.isInteger(tokens) || tokens < 0) {
        throw new HubError("E_TOKEN_ARTIFACT", `missing ${RELEASE_TOKEN_ESTIMATOR} count for ${skillId}`);
      }
      counts.push({ skill_id: skillId, version_hash: versions.get(skillId) as string, level: "L2", tokens });
    }
    return { estimator: RELEASE_TOKEN_ESTIMATOR, counts };
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError("E_BUILD_ATTESTATION", `token derivation failed: ${String((error as Error)?.message ?? error)}`);
  } finally {
    registry.close();
  }
}

/**
 * Derive the SearchIndexInput: exact normalized rows for the release catalog,
 * sorted by skill_id (Contract C section 6).
 */
export function deriveSearchIndexInput(build: HubBuildResult): SearchIndexInputDoc {
  const registry = openBuildRegistry(build.registryHome);
  try {
    const versions = new Map(build.skills.map((s) => [s.skillId, s.versionHash]));
    const rows: SearchIndexRow[] = [];
    for (const skillId of sortedIds(build)) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(getSkillVersion(registry.db, skillId, versions.get(skillId) as string).manifestJson);
      } catch (error) {
        if (error instanceof HubError) throw error;
        throw new HubError("E_BUILD_ATTESTATION", `cannot read built version for ${skillId}`);
      }
      if (!isPlainObject(manifest) || !isPlainObject(manifest["portable"]) || !isPlainObject(manifest["routing"])) {
        throw new HubError("E_SEARCH_INPUT", `built manifest for ${skillId} has no portable/routing section`);
      }
      const portable = manifest["portable"] as Record<string, unknown>;
      const routing = manifest["routing"] as Record<string, unknown>;
      if (typeof portable["name"] !== "string" || typeof portable["description"] !== "string") {
        throw new HubError("E_SEARCH_INPUT", `built manifest for ${skillId} needs name/description strings`);
      }
      const arrays: Record<string, readonly string[]> = {};
      for (const field of ["domains", "platforms", "frameworks", "triggers"] as const) {
        const value = routing[field];
        if (!Array.isArray(value) || value.some((e) => typeof e !== "string")) {
          throw new HubError("E_SEARCH_INPUT", `built manifest for ${skillId}.${field} must be a string list`);
        }
        arrays[field] = value as string[];
      }
      rows.push({
        skill_id: skillId,
        version_hash: versions.get(skillId) as string,
        name: portable["name"] as string,
        description: portable["description"] as string,
        domains: arrays["domains"] as string[],
        platforms: arrays["platforms"] as string[],
        frameworks: arrays["frameworks"] as string[],
        triggers: arrays["triggers"] as string[],
        aliases: listSkillAliases(registry.db, skillId),
      });
    }
    return { rows };
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError("E_BUILD_ATTESTATION", `search-input derivation failed: ${String((error as Error)?.message ?? error)}`);
  } finally {
    registry.close();
  }
}

/** Alias map must be exactly {aliases} with sorted keys resolving to selected skills. */
export function checkAliasMap(doc: unknown, catalogSkillIds: readonly string[]): void {
  if (!isPlainObject(doc) || !isPlainObject(doc["aliases"]) || Object.keys(doc).length !== 1) {
    throw new HubError("E_ALIAS_SCOPE", "alias map must be exactly {aliases: {...}}");
  }
  const aliases = doc["aliases"] as Record<string, unknown>;
  const keys = Object.keys(aliases);
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort((a, b) => (a < b ? -1 : 1)))) {
    throw new HubError("E_ALIAS_SCOPE", "alias map keys must be sorted");
  }
  const selected = new Set(catalogSkillIds);
  for (const [alias, target] of Object.entries(aliases)) {
    if (typeof target !== "string" || !selected.has(target)) {
      throw new HubError("E_ALIAS_SCOPE", `alias ${alias} targets unselected skill ${String(target)} (no historical inheritance)`);
    }
  }
}

/** Token artifact must use ega-o200k-v1 and cover exactly the release catalog. */
export function checkTokenArtifact(doc: unknown, versions: Readonly<Record<string, string>>): void {
  if (!isPlainObject(doc) || doc["estimator"] !== RELEASE_TOKEN_ESTIMATOR || !Array.isArray(doc["counts"])) {
    throw new HubError("E_TOKEN_ARTIFACT", `token artifact must be {estimator: ${RELEASE_TOKEN_ESTIMATOR}, counts: [...]}`);
  }
  if (Object.keys(doc).length !== 2) {
    throw new HubError("E_TOKEN_ARTIFACT", 'token artifact must contain only "estimator" and "counts"');
  }
  const ids = Object.keys(versions);
  const counts = doc["counts"] as unknown[];
  if (counts.length !== ids.length) {
    throw new HubError("E_TOKEN_ARTIFACT", "token artifact must cover exactly the release catalog (no ambient history)");
  }
  const seen = new Set<string>();
  for (const entry of counts) {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 4) {
      throw new HubError("E_TOKEN_ARTIFACT", "token counts entries must be exactly {skill_id, version_hash, level, tokens}");
    }
    const { skill_id, version_hash, level, tokens } = entry as Record<string, unknown>;
    if (typeof skill_id !== "string" || versions[skill_id] !== version_hash) {
      throw new HubError("E_TOKEN_ARTIFACT", `token count for ${String(skill_id)} must match the release version`);
    }
    if (seen.has(skill_id)) {
      throw new HubError("E_TOKEN_ARTIFACT", `duplicate token count for ${skill_id}`);
    }
    seen.add(skill_id);
    if (level !== "L1" && level !== "L2") {
      throw new HubError("E_TOKEN_ARTIFACT", `token count ${skill_id} level must be L1/L2`);
    }
    if (!Number.isInteger(tokens) || (tokens as number) < 0) {
      throw new HubError("E_TOKEN_ARTIFACT", `token count ${skill_id} tokens must be a non-negative integer`);
    }
  }
}

const SEARCH_ROW_FIELDS = [
  "skill_id",
  "version_hash",
  "name",
  "description",
  "domains",
  "platforms",
  "frameworks",
  "triggers",
  "aliases",
];

/** SearchIndexInput must be exactly {rows} sorted by skill_id with exact row shapes. */
export function checkSearchIndexInput(doc: unknown): void {
  if (!isPlainObject(doc) || !Array.isArray(doc["rows"]) || Object.keys(doc).length !== 1) {
    throw new HubError("E_SEARCH_INPUT", "search index input must be exactly {rows: [...]}");
  }
  const rows = doc["rows"] as unknown[];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isPlainObject(row)) {
      throw new HubError("E_SEARCH_INPUT", "search index rows must be objects");
    }
    for (const key of Object.keys(row)) {
      if (!SEARCH_ROW_FIELDS.includes(key)) {
        throw new HubError("E_SEARCH_INPUT", `search index row unknown field ${JSON.stringify(key)}`);
      }
    }
    const { skill_id, version_hash, name, description } = row as Record<string, unknown>;
    if (typeof skill_id !== "string" || skill_id.length === 0) {
      throw new HubError("E_SEARCH_INPUT", "search index rows need skill_id");
    }
    if (seen.has(skill_id)) {
      throw new HubError("E_SEARCH_INPUT", `search index duplicate skill_id ${skill_id}`);
    }
    seen.add(skill_id);
    if (typeof version_hash !== "string" || !SHA256_RE.test(version_hash)) {
      throw new HubError("E_SEARCH_INPUT", `search index row ${skill_id} version_hash must match sha256:<64hex>`);
    }
    if (typeof name !== "string" || typeof description !== "string") {
      throw new HubError("E_SEARCH_INPUT", `search index row ${skill_id} needs name/description strings`);
    }
    for (const field of ["domains", "platforms", "frameworks", "triggers", "aliases"] as const) {
      const value = (row as Record<string, unknown>)[field];
      if (!Array.isArray(value) || value.some((e) => typeof e !== "string")) {
        throw new HubError("E_SEARCH_INPUT", `search index row ${skill_id}.${field} must be a string list`);
      }
    }
  }
  const order = rows.map((r) => (r as SearchIndexRow).skill_id);
  if (JSON.stringify(order) !== JSON.stringify([...order].sort((a, b) => (a < b ? -1 : 1)))) {
    throw new HubError("E_SEARCH_INPUT", "search index rows must be sorted by skill_id");
  }
}

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function releaseTable(db: ReleaseFtsDb, table: string): string {
  if (!TABLE_RE.test(table)) {
    throw new HubError("E_SEARCH_INPUT", `release corpus table must be a plain identifier, got ${JSON.stringify(table)}`);
  }
  return `"${table}"`;
}

function serializeFtsArray(values: readonly string[]): string {
  return values.join("\n");
}

/**
 * Create one release corpus as its OWN FTS5 table (Contract C section 5).
 * Same columns and tokenizer as the registry index so release search matches
 * V1 ranking behavior; rows are inserted sorted for determinism.
 */
export function createReleaseFtsTable(db: ReleaseFtsDb, table: string, rows: readonly SearchIndexRow[]): void {
  const name = releaseTable(db, table);
  db.exec(
    `CREATE VIRTUAL TABLE ${name} USING fts5(skill_id UNINDEXED, version_hash UNINDEXED, name, description, domains, platforms, frameworks, triggers, aliases, tokenize = 'unicode61 remove_diacritics 1')`,
  );
  const insert = db.prepare(
    `INSERT INTO ${name}(skill_id, version_hash, name, description, domains, platforms, frameworks, triggers, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of [...rows].sort((a, b) => (a.skill_id < b.skill_id ? -1 : 1))) {
    insert.run(
      row.skill_id,
      row.version_hash,
      row.name,
      row.description,
      serializeFtsArray(row.domains),
      serializeFtsArray(row.platforms),
      serializeFtsArray(row.frameworks),
      serializeFtsArray(row.triggers),
      serializeFtsArray(row.aliases),
    );
  }
}

/** Ranked skill_ids for a MATCH query against exactly one release corpus. */
export function queryReleaseFts(db: ReleaseFtsDb, table: string, matchQuery: string, limit = 20): string[] {
  const name = releaseTable(db, table);
  const rows = db.prepare(`SELECT skill_id AS id FROM ${name} WHERE ${name} MATCH ? ORDER BY rank LIMIT ?`).all<{ id: string }>(matchQuery, limit);
  return rows.map((row) => row.id);
}

/** The corpus must hold exactly the release catalog — no retained history leaks in. */
export function verifyReleaseCorpus(db: ReleaseFtsDb, table: string, expectedRows: number): void {
  const name = releaseTable(db, table);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get<{ n: number }>();
  if (!row || row.n !== expectedRows) {
    throw new HubError("E_SEARCH_ISOLATION", `release corpus holds ${row?.n ?? "unknown"} rows, release catalog has ${expectedRows}`);
  }
}
