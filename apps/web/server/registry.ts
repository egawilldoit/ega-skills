/**
 * The single read-only registry handle, plus the bounded query helpers Builder
 * 2b uses instead of writing its own SQL.
 *
 * ## One handle, opened once
 *
 * `openReadOnlyRegistry` (`packages/mcp/src/project-context.ts:231`) is called
 * exactly once per deployment, from `getRegistry()`. It opens SQLite without
 * creating, migrating or writing the file, probes that FTS5 is available, then
 * sets `pragma query_only = ON` and verifies the pragma actually took. That is
 * a capability, not a convention: a write attempt through this handle fails at
 * the SQLite layer, and a second open would not change that. The handle is kept
 * open for the process lifetime so every route reads the same bytes; `close()`
 * exists for tests.
 *
 * ## Why SQL construction is constrained here, not at each call site
 *
 * No value from a request is ever concatenated into SQL. Every user-supplied
 * value — skill id, version hash, limit, FTS query — is a bound `?` parameter.
 * The only identifiers interpolated into SQL text are the two FTS corpus table
 * names, and those are **not** free text: `openReleaseFtsCorpus` accepts only a
 * name that matches `^release_fts_[0-9a-f]{64}$` and is additionally required
 * to equal the table name the verified snapshot produced
 * (`HostedReleaseSnapshot.ftsTable`). A request can never reach that argument,
 * and a name that did not come from a verified artifact is rejected outright.
 *
 * ## Fail-closed, not silently-empty
 *
 * `getReleasedSkillVersion` and `listReleasedSkillFiles` throw
 * {@link RegistryReadError} when a release skill has no row, rather than
 * returning `null`/an empty array. An omitted skill is indistinguishable from a
 * catalog gap to an operator, and the architecture explicitly requires failing
 * closed instead. Builder 2b should render that error, not swallow it.
 */

import {
  openReadOnlyRegistry,
  type HostedReleaseSnapshot,
  type ReadOnlyRegistryHandle,
} from "@ega-skills/mcp";

import {
  assertCatalogServable,
  getReleaseIdentityBinding,
} from "./release-identity.ts";
import type { ServerConfig } from "./env.ts";

/** One skill's released row, as stored in the verified snapshot. */
export interface ReleasedSkillRow {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly namespace: string;
  readonly name: string;
  /** `AUTHORED` or `MISSING`. All 114 shipped skills are `MISSING`. */
  readonly l1_status: "AUTHORED" | "MISSING";
  readonly l2_size_class: "NORMAL" | "LARGE" | "OVERSIZED";
  readonly trust_level: "OWNED" | "EXTERNAL" | "UNKNOWN";
  /** Parsed `skill_versions.manifest_json`. Callers read `routing` from here. */
  readonly manifest: Record<string, unknown>;
}

/** One file inside a released skill. */
export interface ReleasedFileRow {
  readonly path: string;
  readonly role: string;
  readonly blob_hash: string;
  readonly byte_size: number;
  readonly content_kind: "TEXT" | "BINARY";
}

/** Provenance row for a released skill version. */
export interface ReleasedSourceRow {
  readonly source_id: number;
  readonly source_type: string;
  readonly local_path: string | null;
  readonly repository: string | null;
  readonly commit_sha: string | null;
  readonly repository_path: string | null;
  readonly observed_at: string | null;
}

/**
 * One recorded token count, for one released version's file blob.
 *
 * `token_counts` is keyed by `(blob_hash, estimator_id)` and carries no
 * `skill_id`, so this row is the released-version join that makes the count
 * attributable to a skill. `role` is the file role the blob belongs to
 * (`core` = L1 `SKILL.core.md`, `skill-body` = L2 `SKILL.md`), which is what
 * makes an L1/L2 split possible without guessing.
 */
export interface ReleasedTokenRow {
  readonly skill_id: string;
  readonly version_hash: string;
  /** File role of the counted blob: `core` (L1) or `skill-body` (L2). */
  readonly role: string;
  readonly blob_hash: string;
  readonly estimator_id: string;
  readonly token_count: number;
}

/**
 * The one token estimator the registry stores.
 *
 * Canonical source of truth is `EGA_O200K_V1_ESTIMATOR_ID` in
 * `packages/schema/src/token-estimator-internal.ts:1`. `@ega-skills/mcp` does
 * not re-export it, and `apps/web/server` may only import `@ega-skills/mcp`,
 * `@ega-skills/project` and `@ega-skills/registry`
 * (`tests/web/project-boundary.test.mjs:232`), so the literal is repeated here
 * rather than imported from a fourth package. It is bound as a query
 * parameter, never interpolated, and every returned row echoes it back so a
 * caller can assert the value it actually read.
 */
const EGA_O200K_V1_ESTIMATOR_ID = "ega-o200k-v1";

/**
 * One recorded version row for a skill, for the history view.
 *
 * Deliberately omits `manifest_json`: the history view reports which versions
 * exist and how they are classified, not their contents, so parsing 114
 * manifests to render an empty list would be wasted work. `skill_versions` has
 * no timestamp column, which is why there is no date here either — the schema
 * records none, so none can be reported.
 */
export interface ReleasedVersionRow {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly l1_status: "AUTHORED" | "MISSING";
  readonly l2_size_class: "NORMAL" | "LARGE" | "OVERSIZED";
  readonly trust_level: "OWNED" | "EXTERNAL" | "UNKNOWN";
}

/** Optional limit argument shared by every bounded read. */
export interface QueryOptions {
  /**
   * Maximum rows to return. Clamped to the helper's ceiling; a value that is
   * not a positive safe integer is rejected rather than silently coerced.
   */
  readonly limit?: number;
}

const NO_OPTIONS: QueryOptions = Object.freeze({});

/** Raised when a read cannot be served honestly. Never carries SQL text. */
export class RegistryReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RegistryReadError";
    this.code = code;
  }
}

/**
 * Hard ceiling on any single result set.
 *
 * The catalog is 114 rows today but the schema allows more, and a route must
 * never be able to ask the database for an unbounded set and stream it to a
 * browser. Callers pass a limit; this is the maximum it can be.
 */
export const MAX_RESULT_ROWS = 5_000;

/** Ceiling for per-skill child collections. */
export const MAX_CHILD_ROWS = 2_000;

const FTS_TABLE_RE = /^release_fts_[0-9a-f]{64}$/;

function boundedLimit(limit: number | undefined, ceiling: number): number {
  if (limit === undefined) return ceiling;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RegistryReadError("E_WEB_QUERY_INVALID", "limit must be a positive safe integer");
  }
  return Math.min(limit, ceiling);
}

/**
 * Validate an FTS corpus identifier.
 *
 * Two independent conditions must hold: the name must be shaped like a release
 * corpus, and it must be the corpus the *verified snapshot* named. The shape
 * check alone would be enough to prevent injection; requiring equality with the
 * snapshot means the console can only ever search the release it verified.
 */
export function assertReleaseFtsTable(snapshot: HostedReleaseSnapshot, candidate: string): string {
  if (!FTS_TABLE_RE.test(candidate)) {
    throw new RegistryReadError(
      "E_WEB_QUERY_INVALID",
      "release corpus identifier is not a release FTS table name",
    );
  }
  if (candidate !== snapshot.ftsTable) {
    throw new RegistryReadError(
      "E_WEB_QUERY_INVALID",
      "release corpus identifier does not match the verified snapshot",
    );
  }
  return candidate;
}

/** A parsed `manifest_json`, validated to be an object. */
function parseManifest(raw: string, skillId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RegistryReadError(
      "E_WEB_MANIFEST_INVALID",
      `manifest_json for a released skill is not valid JSON: ${skillId}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RegistryReadError(
      "E_WEB_MANIFEST_INVALID",
      `manifest_json for a released skill is not an object: ${skillId}`,
    );
  }
  return parsed as Record<string, unknown>;
}

interface SkillVersionJoinRow {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly namespace: string;
  readonly name: string;
  readonly l1_status: string;
  readonly l2_size_class: string;
  readonly trust_level: string;
  readonly manifest_json: string;
}

function toReleasedSkillRow(row: SkillVersionJoinRow): ReleasedSkillRow {
  return Object.freeze({
    skill_id: row.skill_id,
    version_hash: row.version_hash,
    namespace: row.namespace,
    name: row.name,
    l1_status: row.l1_status as ReleasedSkillRow["l1_status"],
    l2_size_class: row.l2_size_class as ReleasedSkillRow["l2_size_class"],
    trust_level: row.trust_level as ReleasedSkillRow["trust_level"],
    manifest: parseManifest(row.manifest_json, row.skill_id),
  });
}

/** The console's read surface over one verified release snapshot. */
export interface RegistryReader {
  /** The snapshot this reader is bound to. Its digest is the release served. */
  readonly snapshot: HostedReleaseSnapshot;
  /** Verified `query_only` state, `true` when SQLite reports 1. */
  readonly queryOnly: boolean;
  /** The FTS corpus table name from the verified snapshot. */
  readonly ftsTable: string;

  close(): void;

  /** Every `skill_id -> version_hash` in the release, sorted by id. */
  listReleasedSkillIds(): readonly string[];

  /** `version_hash` the release pins for `skillId`, or `null` if not released. */
  releasedVersionHash(skillId: string): string | null;

  /** Joined `skill_versions`/`skills` rows, bounded, sorted by skill_id. */
  listReleasedSkills(options?: QueryOptions): readonly ReleasedSkillRow[];

  /** One released skill. Throws when the release does not contain it. */
  getReleasedSkill(skillId: string): ReleasedSkillRow;

  /** Files of one released skill version, bounded, sorted by path. */
  listReleasedSkillFiles(skillId: string, options?: QueryOptions): readonly ReleasedFileRow[];

  /** Provenance rows of one released skill version, bounded. */
  listReleasedSkillSources(skillId: string, options?: QueryOptions): readonly ReleasedSourceRow[];

  /**
   * Every version row recorded for a skill, bounded, ordered by `version_hash`.
   *
   * Added for `apps/web/server/skills.ts`, which must report whether this
   * deployment retains any history for a skill. That claim can only be honest if
   * it is *read* rather than assumed, and no existing helper can answer it: the
   * release-gated ones (`listReleasedSkills`, `listReleasedSkillFiles`,
   * `listReleasedSkillSources`, `listReleasedSkillTokens`) all resolve a single
   * `version_hash` from the release map, so each returns nothing at all for a
   * version the release does not pin.
   *
   * Consequently this one read is deliberately NOT release-gated: history is
   * about what the registry recorded, which may legitimately be a superset of the
   * release. Every value is a bound `?` parameter; nothing is interpolated.
   */
  listSkillVersions(skillId: string, options?: QueryOptions): readonly ReleasedVersionRow[];

  /**
   * Recorded token counts for one released skill version's blobs, bounded.
   *
   * Added for the catalog's metadata row (`apps/web/server/catalog.ts`), which
   * must show L1/L2 token counts and cannot derive them from
   * {@link ReleasedSkillRow}: `skill_versions` stores `l1_status` but no token
   * numbers, and `token_counts` has no `skill_id` to join on. Returns one row
   * per counted blob; roles with no recorded count are simply absent, which is
   * how a genuinely unwritten L1 is represented.
   */
  listReleasedSkillTokens(skillId: string, options?: QueryOptions): readonly ReleasedTokenRow[];

  /** Alias -> owning skill_id for the whole release, bounded, sorted. */
  listReleaseAliases(options?: QueryOptions): readonly { readonly alias: string; readonly skill_id: string }[];

  /** Aliases owned by one skill, bounded. */
  listSkillAliases(skillId: string, options?: QueryOptions): readonly string[];

  /** Ranked skill_ids for a MATCH query against this release's corpus only. */
  searchReleaseFts(query: string, options?: QueryOptions): readonly string[];

  /** Row count of the release corpus. Equals `ReleaseIdentity.snapshot_rows`. */
  countReleaseRows(): number;
}

/**
 * Wrap an already-open read-only handle as a {@link RegistryReader}.
 *
 * Exported so tests can drive the reader over a tampered copy of the artifact
 * without going through the whole config path, and so Builder 2b can construct
 * a reader over an explicitly verified snapshot.
 */
export function createRegistryReader(
  snapshot: HostedReleaseSnapshot,
  handle: ReadOnlyRegistryHandle,
): RegistryReader {
  // Re-assert the snapshot's own corpus name rather than trusting the caller.
  assertReleaseFtsTable(snapshot, snapshot.ftsTable);
  const { db } = handle;
  const ftsTable = snapshot.ftsTable;
  const queryOnly = db.pragma<number>("query_only", { simple: true }) === 1;

  const selectSkills = db.prepare(
    `SELECT v.skill_id AS skill_id, v.version_hash AS version_hash, s.namespace AS namespace,
            s.name AS name, v.l1_status AS l1_status, v.l2_size_class AS l2_size_class,
            v.trust_level AS trust_level, v.manifest_json AS manifest_json
       FROM skill_versions v
       JOIN skills s ON s.skill_id = v.skill_id
      WHERE v.skill_id = ? AND v.version_hash = ?`,
  );
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    openHandles.delete(close);
    handle.close();
  };
  openHandles.add(close);

  const reader: RegistryReader = Object.freeze({
    snapshot,
    queryOnly,
    ftsTable,

    close,

    listReleasedSkillIds: (): readonly string[] => Object.freeze(
      Object.keys(snapshot.release.payload.skill_versions).sort(),
    ),

    releasedVersionHash: (skillId: string): string | null =>
      snapshot.release.payload.skill_versions[skillId] ?? null,

    listReleasedSkills: (options: QueryOptions = NO_OPTIONS): readonly ReleasedSkillRow[] => {
      const limit = boundedLimit(options.limit, MAX_RESULT_ROWS);
      // Driven from the release's own `skill_id -> version_hash` map, not from
      // whatever rows the SQLite file happens to contain, and ordered exactly
      // as the release declares so pagination is stable.
      const ids = Object.keys(snapshot.release.payload.skill_versions).sort().slice(0, limit);
      const rows: ReleasedSkillRow[] = [];
      for (const skillId of ids) {
        const versionHash = snapshot.release.payload.skill_versions[skillId];
        if (versionHash === undefined) continue;
        const row = selectSkills.get(skillId, versionHash) as SkillVersionJoinRow | undefined;
        // Fail closed: a release skill with no row is a broken snapshot, not an
        // absent skill.
        if (row === undefined) {
          throw new RegistryReadError(
            "E_WEB_SKILL_MISSING",
            `The verified release declares a skill with no row in the snapshot: ${skillId}`,
          );
        }
        rows.push(toReleasedSkillRow(row));
      }
      return Object.freeze(rows);
    },

    getReleasedSkill: (skillId: string): ReleasedSkillRow => {
      const versionHash = snapshot.release.payload.skill_versions[skillId];
      if (versionHash === undefined) {
        throw new RegistryReadError(
          "E_WEB_SKILL_NOT_RELEASED",
          "The requested skill is not part of the verified release.",
        );
      }
      const row = selectSkills.get(skillId, versionHash) as SkillVersionJoinRow | undefined;
      if (row === undefined) {
        throw new RegistryReadError(
          "E_WEB_SKILL_MISSING",
          `The verified release declares a skill with no row in the snapshot: ${skillId}`,
        );
      }
      return toReleasedSkillRow(row);
    },

    listReleasedSkillFiles: (skillId: string, options: QueryOptions = NO_OPTIONS) => {
      const versionHash = snapshot.release.payload.skill_versions[skillId];
      if (versionHash === undefined) {
        throw new RegistryReadError(
          "E_WEB_SKILL_NOT_RELEASED",
          "The requested skill is not part of the verified release.",
        );
      }
      const limit = boundedLimit(options.limit, MAX_CHILD_ROWS);
      const rows = db
        .prepare(
          `SELECT path AS path, role AS role, blob_hash AS blob_hash,
                  byte_size AS byte_size, content_kind AS content_kind
             FROM skill_files
            WHERE skill_id = ? AND version_hash = ?
            ORDER BY path
            LIMIT ?`,
        )
        .all(skillId, versionHash, limit) as ReleasedFileRow[];
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    },

    listReleasedSkillSources: (skillId: string, options: QueryOptions = NO_OPTIONS) => {
      const versionHash = snapshot.release.payload.skill_versions[skillId];
      if (versionHash === undefined) {
        throw new RegistryReadError(
          "E_WEB_SKILL_NOT_RELEASED",
          "The requested skill is not part of the verified release.",
        );
      }
      const limit = boundedLimit(options.limit, MAX_CHILD_ROWS);
      const rows = db
        .prepare(
          `SELECT source_id AS source_id, source_type AS source_type,
                  local_path AS local_path, repository AS repository,
                  commit_sha AS commit_sha, repository_path AS repository_path,
                  observed_at AS observed_at
             FROM skill_sources
            WHERE skill_id = ? AND version_hash = ?
            ORDER BY source_id
            LIMIT ?`,
        )
        .all(skillId, versionHash, limit) as ReleasedSourceRow[];
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    },

    // Deliberately not release-gated: see `listSkillVersions` on the interface.
    listSkillVersions: (skillId: string, options: QueryOptions = NO_OPTIONS) => {
      const limit = boundedLimit(options.limit, MAX_CHILD_ROWS);
      const rows = db
        .prepare(
          `SELECT skill_id AS skill_id, version_hash AS version_hash,
                  l1_status AS l1_status, l2_size_class AS l2_size_class,
                  trust_level AS trust_level
             FROM skill_versions
            WHERE skill_id = ?
            ORDER BY version_hash
            LIMIT ?`,
        )
        .all(skillId, limit) as ReleasedVersionRow[];
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    },

    listReleasedSkillTokens: (skillId: string, options: QueryOptions = NO_OPTIONS) => {
      const versionHash = snapshot.release.payload.skill_versions[skillId];
      if (versionHash === undefined) {
        throw new RegistryReadError(
          "E_WEB_SKILL_NOT_RELEASED",
          "The requested skill is not part of the verified release.",
        );
      }
      const limit = boundedLimit(options.limit, MAX_CHILD_ROWS);
      // Every value is a bound parameter: the estimator id, both identity
      // columns, and the limit. Nothing is interpolated into this statement.
      const rows = db
        .prepare(
          `SELECT f.skill_id AS skill_id, f.version_hash AS version_hash, f.role AS role,
                  f.blob_hash AS blob_hash, t.estimator_id AS estimator_id,
                  t.token_count AS token_count
             FROM skill_files f
             JOIN token_counts t
               ON t.blob_hash = f.blob_hash AND t.estimator_id = ?
            WHERE f.skill_id = ? AND f.version_hash = ?
            ORDER BY f.role, f.path
            LIMIT ?`,
        )
        .all(EGA_O200K_V1_ESTIMATOR_ID, skillId, versionHash, limit) as ReleasedTokenRow[];
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    },

    listReleaseAliases: (options: QueryOptions = NO_OPTIONS) => {
      const limit = boundedLimit(options.limit, MAX_RESULT_ROWS);
      const rows = db
        .prepare("SELECT alias AS alias, skill_id AS skill_id FROM skill_aliases ORDER BY alias LIMIT ?")
        .all(limit) as { alias: string; skill_id: string }[];
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    },

    listSkillAliases: (skillId: string, options: QueryOptions = NO_OPTIONS) => {
      const limit = boundedLimit(options.limit, MAX_CHILD_ROWS);
      const rows = db
        .prepare("SELECT alias AS alias FROM skill_aliases WHERE skill_id = ? ORDER BY alias LIMIT ?")
        .all(skillId, limit) as { alias: string }[];
      return Object.freeze(rows.map((row) => row.alias));
    },

    searchReleaseFts: (query: string, options: QueryOptions = NO_OPTIONS) => {
      const trimmed = query.trim();
      if (trimmed === "") {
        throw new RegistryReadError(
          "E_WEB_QUERY_INVALID",
          "search query must not be empty; this console does not implement MCP search semantics",
        );
      }
      const limit = boundedLimit(options.limit, MAX_RESULT_ROWS);
      // `ftsTable` is interpolated, and it passed `assertReleaseFtsTable`
      // against the verified snapshot. The query itself is a bound parameter,
      // so FTS syntax in user input is data, never SQL.
      const rows = db
        .prepare(
          `SELECT skill_id AS id FROM "${ftsTable}" WHERE "${ftsTable}" MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(trimmed, limit) as { id: string }[];
      return Object.freeze(rows.map((row) => row.id));
    },

    countReleaseRows: (): number => {
      const row = db.prepare(`SELECT count(*) AS n FROM "${ftsTable}"`).get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
  });

  return reader;
}

/**
 * Open (or return) the process-wide reader.
 *
 * `assertCatalogServable` runs *before* the handle is opened, so a mismatched
 * or unverifiable release never gets a database handle at all — the failure is
 * not "the catalog query returned nothing", it is "no catalog".
 */
let defaultReader: RegistryReader | null = null;
/**
 * Handles for explicitly-supplied configs, keyed on the config object.
 *
 * Keying on the config object means a second config (a test pointing at a
 * tampered copy, say) can never be served through a handle opened for the
 * first one. Production passes no config and uses {@link defaultReader}, which
 * is why there is still exactly one handle per process in real use.
 */
let readersByConfig = new WeakMap<object, RegistryReader>();
/**
 * Every handle this module opened, so `closeRegistry` can really close them.
 *
 * A `WeakMap` alone cannot be iterated or cleared, and dropping a reference to
 * a `better-sqlite3` handle without calling `close()` leaks the file
 * descriptor. Tests open several configs per run, so the leak would be real.
 */
const openHandles = new Set<() => void>();

/**
 * Open (or return) the process-wide reader.
 *
 * `assertCatalogServable` runs *before* the handle is opened **and before any
 * memo hit**, so a mismatched or unverifiable release never gets a database
 * handle at all — the failure is not "the catalog query returned nothing", it
 * is "no catalog".
 */
export function getRegistry(config?: Readonly<ServerConfig>): RegistryReader {
  assertCatalogServable(config);
  if (config === undefined) {
    if (defaultReader !== null) return defaultReader;
    defaultReader = openVerifiedReader();
    return defaultReader;
  }
  const cached = readersByConfig.get(config);
  if (cached !== undefined) return cached;
  const opened = openVerifiedReader(config);
  readersByConfig.set(config, opened);
  return opened;
}

/** Open a handle over the verified snapshot named by `config`. */
function openVerifiedReader(config?: Readonly<ServerConfig>): RegistryReader {
  const binding = getReleaseIdentityBinding(config);
  const snapshot = binding.snapshot;
  if (snapshot === null) {
    // Unreachable while `assertCatalogServable` holds, but a null snapshot here
    // would mean opening a handle against an unknown file. Fail closed.
    throw new RegistryReadError(
      "E_WEB_RELEASE_UNVERIFIED",
      "No verified release snapshot is available to open a read-only handle.",
    );
  }
  const handle = openReadOnlyRegistry(snapshot.context);
  const created = createRegistryReader(snapshot, handle);
  if (!created.queryOnly) {
    handle.close();
    throw new RegistryReadError(
      "E_WEB_REGISTRY_NOT_READ_ONLY",
      "The registry handle did not report query_only enforcement; refusing to serve reads.",
    );
  }
  return created;
}

/** Close every handle this module opened. Tests call it between scenarios. */
export function closeRegistry(): void {
  defaultReader = null;
  readersByConfig = new WeakMap<object, RegistryReader>();
  for (const close of [...openHandles]) close();
}

