/** Private, owner-scoped skill preferences. Writes use a DB role that cannot
 * read tables or call any operation beyond the revision-checked SQL function. */

import type { Pool } from "pg";

import {
  authorizeArtifactRequest,
  ConsoleApiError,
  createBoundedHandler,
  loadRequestBounds,
  toControlPlaneApiError,
  type RequestBounds,
} from "./api.ts";
import { getRegistry } from "./registry.ts";
import { loadServerConfig, sanitizeVerifiedTlsConnectionString } from "./env.ts";
import {
  type CallerIdentity,
  type ControlPlaneReader,
  defaultControlPlaneReader,
} from "./supabase-read.ts";

import type { ApiRoute, ApiRouteContext } from "../server.mts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const MAX_FAVORITES = 5000;
const MAX_BODY_BYTES = 1_048_576;
const EMPTY_PREFERENCES: PreferenceRecord = Object.freeze({
  revision: 0,
  favorite_skill_ids: Object.freeze([]),
  default_skill_ids: Object.freeze([]),
  updated_at: null,
});

export interface PreferenceRecord {
  readonly revision: number;
  readonly favorite_skill_ids: readonly string[];
  readonly default_skill_ids: readonly string[];
  readonly updated_at: string | null;
}

export interface PreferenceStore {
  update(input: {
    readonly workspaceId: string;
    readonly subject: string;
    readonly favorites: readonly string[];
    readonly defaults: readonly string[];
    readonly expectedRevision: number;
  }): Promise<PreferenceRecord | null>;
}

function fail(status: number, code: string, message: string): never {
  throw new ConsoleApiError(status, code, message);
}

function preferencesError(error: unknown): never {
  if (error instanceof ConsoleApiError) throw error;
  const status = (error as { readonly status?: unknown } | null)?.status;
  const typedCode = (error as { readonly code?: unknown } | null)?.code;
  if (typeof status === "number" && status >= 400 && status <= 599 && typeof typedCode === "string") {
    throw toControlPlaneApiError(error);
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === "42501") fail(403, "E_WEB_PREFERENCES_FORBIDDEN", "Active workspace Owner membership is required.");
  if (code === "22023" || code === "23514") fail(400, "E_WEB_PREFERENCES_INVALID", "The preference values are invalid.");
  fail(503, "E_WEB_PREFERENCES_UNAVAILABLE", "Skill preferences are unavailable.");
}

let defaultPool: Promise<Pool> | undefined;
async function defaultStore(): Promise<PreferenceStore> {
  const config = loadServerConfig();
  if (config.skillPreferencesDatabaseUrl === null) {
    fail(503, "E_WEB_PREFERENCES_UNAVAILABLE", "Skill preference writes are not configured.");
  }
  defaultPool ??= import("pg").then(({ Pool }) => {
    const pool = new Pool({
      connectionString: sanitizeVerifiedTlsConnectionString(config.skillPreferencesDatabaseUrl!),
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 3_000,
      query_timeout: 4_000,
      ssl: { rejectUnauthorized: true },
    });
    pool.on("error", () => {
      // Pool errors can contain connection details; never log the driver error.
    });
    return pool;
  });
  const pool = await defaultPool;
  return {
    async update(input) {
      try {
        const result = await pool.query<{
          revision: string | number;
          favorite_skill_ids: string[];
          default_skill_ids: string[];
          updated_at: Date | string;
        }>(
          "select * from private.write_skill_preferences($1::uuid, $2::text, $3::text[], $4::text[], $5::bigint)",
          [input.workspaceId, input.subject, input.favorites, input.defaults, input.expectedRevision],
        );
        const row = result.rows[0];
        return row === undefined ? null : Object.freeze({
          revision: Number(row.revision),
          favorite_skill_ids: Object.freeze([...row.favorite_skill_ids]),
          default_skill_ids: Object.freeze([...row.default_skill_ids]),
          updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        });
      } catch (error) {
        preferencesError(error);
      }
    },
  };
}

function assertAuthorizedWorkspace(
  caller: CallerIdentity,
  rows: readonly Record<string, unknown>[],
  workspaceId: string,
): void {
  const owner = rows.find((row) =>
    row["workspace_id"] === workspaceId &&
    row["subject"] === caller.subject &&
    row["role"] === "owner" &&
    row["active"] === true
  );
  if (owner === undefined) {
    fail(403, "E_WEB_PREFERENCES_FORBIDDEN", "Active workspace Owner membership is required.");
  }
}

async function readJson(context: ApiRouteContext): Promise<unknown> {
  const contentType = context.request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") {
    fail(415, "E_WEB_PREFERENCES_CONTENT_TYPE", "Expected application/json.");
  }
  const contentLength = context.request.headers["content-length"];
  if (contentLength !== undefined && (typeof contentLength !== "string" || !/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    fail(413, "E_WEB_PREFERENCES_BODY_TOO_LARGE", "Preference request body is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of context.request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) fail(413, "E_WEB_PREFERENCES_BODY_TOO_LARGE", "Preference request body is too large.");
      chunks.push(bytes);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch (error) {
    if (error instanceof ConsoleApiError) throw error;
    fail(400, "E_WEB_PREFERENCES_BODY_INVALID", "Preference request body must be valid UTF-8 JSON.");
  }
}

function parseUpdate(value: unknown): {
  workspaceId: string;
  expectedRevision: number;
  favorites: string[];
  defaults: string[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "E_WEB_PREFERENCES_BODY_INVALID", "Preference request must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  const expectedKeys = ["workspace_id", "expected_revision", "favorite_skill_ids", "default_skill_ids"];
  if (Object.keys(body).some((key) => !expectedKeys.includes(key)) || expectedKeys.some((key) => !Object.hasOwn(body, key))) {
    fail(400, "E_WEB_PREFERENCES_BODY_INVALID", "Preference request fields are invalid.");
  }
  if (typeof body["workspace_id"] !== "string" || !UUID.test(body["workspace_id"])) {
    fail(400, "E_WEB_PREFERENCES_WORKSPACE_INVALID", "workspace_id must be a canonical UUID.");
  }
  if (typeof body["expected_revision"] !== "number" || !Number.isSafeInteger(body["expected_revision"]) || body["expected_revision"] < 0) {
    fail(400, "E_WEB_PREFERENCES_REVISION_INVALID", "expected_revision must be a non-negative safe integer.");
  }
  const parseIds = (raw: unknown, field: string, maximum: number): string[] => {
    if (!Array.isArray(raw) || raw.length > maximum || raw.some((id) => typeof id !== "string" || !SKILL_ID.test(id))) {
      fail(400, "E_WEB_PREFERENCES_IDS_INVALID", `${field} must contain distinct canonical skill IDs.`);
    }
    const ids = raw as string[];
    if (new Set(ids).size !== ids.length) fail(400, "E_WEB_PREFERENCES_IDS_INVALID", `${field} must not contain duplicates.`);
    return ids;
  };
  return {
    workspaceId: body["workspace_id"] as string,
    expectedRevision: body["expected_revision"] as number,
    favorites: parseIds(body["favorite_skill_ids"], "favorite_skill_ids", MAX_FAVORITES),
    defaults: parseIds(body["default_skill_ids"], "default_skill_ids", 3),
  };
}

async function resolveCaller(context: ApiRouteContext, reader: ControlPlaneReader): Promise<CallerIdentity> {
  try {
    return await reader.resolveCaller({ method: "GET", headers: context.request.headers, signal: context.signal });
  } catch (error) {
    preferencesError(error);
  }
}

async function requireOwner(
  context: ApiRouteContext,
  reader: ControlPlaneReader,
  caller: CallerIdentity,
  workspaceId: string,
): Promise<PreferenceRecord> {
  const memberRows = await reader.readAsCaller(caller, "workspace_memberships", {
    filters: [
      { column: "workspace_id", values: [workspaceId] },
      { column: "subject", values: [caller.subject] },
    ],
    columns: ["workspace_id", "subject", "role", "active"],
    limit: 1,
    signal: context.signal,
  });
  assertAuthorizedWorkspace(caller, memberRows, workspaceId);
  const preferenceRows = await reader.readAsCaller(caller, "skill_preferences", {
    filters: [
      { column: "workspace_id", values: [workspaceId] },
      { column: "subject", values: [caller.subject] },
    ],
    columns: ["revision", "favorite_skill_ids", "default_skill_ids", "updated_at"],
    limit: 1,
    signal: context.signal,
  });
  const row = preferenceRows[0];
  if (row === undefined) return EMPTY_PREFERENCES;
  return Object.freeze({
    revision: Number(row["revision"]),
    favorite_skill_ids: Object.freeze([...(row["favorite_skill_ids"] as string[])]),
    default_skill_ids: Object.freeze([...(row["default_skill_ids"] as string[])]),
    updated_at: typeof row["updated_at"] === "string" ? row["updated_at"] : null,
  });
}

export interface PreferenceRouteOptions {
  readonly bounds?: RequestBounds;
  readonly reader?: ControlPlaneReader;
  readonly store?: PreferenceStore;
  readonly catalogIds?: () => ReadonlySet<string>;
  readonly isPublicPolicy?: () => boolean;
  /** Test seam for non-public release authorization; defaults to the real check. */
  readonly authorizeRelease?: (
    context: ApiRouteContext,
    reader: ControlPlaneReader,
    options?: { readonly requestedDigests?: readonly string[] },
  ) => Promise<unknown>;
  /** Test seam: resolve release digest required for new defaults on Supabase-backed deployments. */
  readonly resolveAdditionReleaseDigest?: () => string;
  /** Test seam: bind one release snapshot for both digest auth and catalog IDs. */
  readonly resolveReleaseContext?: () => { readonly digest: string; readonly catalogIds: ReadonlySet<string> };
  /** Test seam: process-wide release reader (must be reused, not opened per request). */
  readonly getReleaseRegistry?: () => { readonly snapshot: { readonly release: { readonly digest: string } }; listReleasedSkillIds(): readonly string[] };
}

/** GET reads through caller-scoped PostgREST; PUT uses the narrow DB function. */
export function buildSkillPreferenceRoutes(options: PreferenceRouteOptions = {}): ApiRoute[] {
  const bounds = options.bounds ?? loadRequestBounds();
  const reader = options.reader ?? defaultControlPlaneReader();
  const store = options.store;
  const isPublicPolicy = options.isPublicPolicy ?? (() => loadServerConfig().isPublicPolicy);
  const authorizeRelease = options.authorizeRelease ?? authorizeArtifactRequest;
  return [{
    id: "skill-preferences",
    path: "/skill-preferences",
    methods: Object.freeze(["GET", "PUT"]),
    handle: createBoundedHandler(bounds, async (context) => {
      if (context.method !== "GET" && context.method !== "PUT") {
        fail(405, "E_METHOD_NOT_ALLOWED", "Skill preferences answer GET and PUT.");
      }
      const caller = await resolveCaller(context, reader);
      if (context.method === "GET") {
        const ids = [...context.query.keys()];
        if (ids.length !== 1 || ids[0] !== "workspace_id") {
          fail(400, "E_WEB_PREFERENCES_QUERY_INVALID", "Provide one workspace_id query parameter.");
        }
        const workspaceId = context.query.get("workspace_id")!;
        if (!UUID.test(workspaceId)) fail(400, "E_WEB_PREFERENCES_WORKSPACE_INVALID", "workspace_id must be a canonical UUID.");
        return requireOwner(context, reader, caller, workspaceId);
      }

      const input = parseUpdate(await readJson(context));
      const current = await requireOwner(context, reader, caller, input.workspaceId);
      if (input.expectedRevision !== current.revision) {
        fail(409, "E_WEB_PREFERENCES_CONFLICT", "Preferences changed since they were read; reload before updating.");
      }
      const currentDefaults = new Set(current.default_skill_ids);
      const additions = input.defaults.filter((skillId) => !currentDefaults.has(skillId));
      if (additions.length > 0) {
        // Bind one verified release snapshot per request for digest authorization
        // and catalog IDs, preventing a release switch between separate reads.
        let releaseDigest: string | undefined;
        let known: ReadonlySet<string>;
        try {
          if (options.resolveReleaseContext) {
            const ctx = options.resolveReleaseContext();
            releaseDigest = ctx.digest;
            known = ctx.catalogIds;
          } else if (options.resolveAdditionReleaseDigest || options.catalogIds) {
            // Preserve explicit seam behavior for tests/callers.
            const releaseRegistry = options.getReleaseRegistry ?? (() => getRegistry());
            if (options.resolveAdditionReleaseDigest) releaseDigest = options.resolveAdditionReleaseDigest();
            known = options.catalogIds ? options.catalogIds() : new Set(releaseRegistry().listReleasedSkillIds());
          } else {
            const reg = (options.getReleaseRegistry ?? (() => getRegistry()))();
            releaseDigest = reg.snapshot.release.digest;
            known = new Set(reg.listReleasedSkillIds());
          }
        } catch (error) {
          // Preserve seam-specific error mapping: catalog seam failures stay catalog
          // errors; default/snapshot/digest resolution failures are release-unavailable.
          if (options.catalogIds && !options.resolveAdditionReleaseDigest && !options.resolveReleaseContext) {
            fail(503, "E_WEB_PREFERENCES_CATALOG_UNAVAILABLE", "The authorized skill catalog is unavailable.");
          }
          fail(503, "E_WEB_PREFERENCES_RELEASE_UNAVAILABLE", "Current release authorization is unavailable for new defaults.");
        }
        if (!isPublicPolicy()) {
          const cfg = loadServerConfig();
          if (cfg.supabaseUrl) {
            if (typeof releaseDigest !== "string" || releaseDigest.length === 0) {
              fail(503, "E_WEB_PREFERENCES_RELEASE_UNAVAILABLE", "Current release authorization is unavailable for new defaults.");
            }
            await authorizeRelease({ ...context, method: "GET" }, reader, { requestedDigests: [releaseDigest] });
          } else {
            await authorizeRelease({ ...context, method: "GET" }, reader);
          }
        }
        if (additions.some((skillId) => !known.has(skillId))) {
          fail(400, "E_WEB_PREFERENCES_DEFAULT_UNAVAILABLE", "New default skills must be present in the authorized catalog.");
        }
      }
      try {
        const result = await (store ?? await defaultStore()).update({
          workspaceId: input.workspaceId,
          subject: caller.subject,
          favorites: input.favorites,
          defaults: input.defaults,
          expectedRevision: input.expectedRevision,
        });
        if (result === null) fail(409, "E_WEB_PREFERENCES_CONFLICT", "Preferences changed since they were read; reload before updating.");
        return result;
      } catch (error) {
        preferencesError(error);
      }
    }),
  }];
}
