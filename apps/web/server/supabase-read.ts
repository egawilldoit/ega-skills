/**
 * Control-plane read adapter: the console's only path to Supabase PostgREST.
 *
 * ## The rule this module exists to enforce
 *
 * **The caller's own access token is forwarded. Nothing else is.**
 *
 * The console's entire security value is that PostgreSQL row-level security is
 * the only enforcement point. A caller who cannot read a row through PostgREST
 * must not be able to read it through the console either. That property holds
 * only if the request PostgREST evaluates is *the caller's* request.
 *
 * Concretely, this module has **no credential field of any kind**. There is no
 * `secretKey`, no `serviceRole`, no `apikey`, and no place a privileged
 * credential could be threaded in. {@link ControlPlaneReaderOptions} accepts a
 * `supabaseUrl` and a `transport`, nothing else. The only header carrying a
 * credential is `authorization: Bearer <the caller's token>`, assembled from
 * {@link CallerIdentity.token} and nothing else. If a future builder needs a
 * read this module cannot perform with a caller token, the correct outcome is a
 * new contract and a new endpoint — not a service-role read bolted into this
 * one.
 *
 * `apps/web/server/env.ts` parses `EGA_SUPABASE_SECRET_KEY` into `ServerConfig`
 * and it is *deliberately not consulted here*. So is the browser-substituted
 * publishable key: this module carries no `apikey` header at all, and the static
 * scan in `tests/web/project-boundary.test.mjs` already forbids the server
 * directory from reading any browser-substituted variable name.
 *
 * ## No request is an authority
 *
 * Ids are **filters, never capabilities** (CONTRACT-F §1). `readAsCaller` accepts
 * a table name, a column projection, equality/in filters, and a row limit. It
 * accepts nothing that could express *authority*: no workspace grant, no role
 * assertion, no service credential, no raw PostgREST fragment. Every filter is
 * checked against a fixed allow-list of `(table, column, value-kind)` triples
 * before a URL is built, and every value is pattern-validated against the
 * declared kind. A value that is not allow-listed never reaches the URL at all.
 *
 * That is why the filter set is built from `URLSearchParams` rather than from
 * string interpolation. A caller value can only ever land in an encoded query
 * parameter; the path, the `select` clause, and the `limit` are assembled from
 * constants and allow-listed names.
 *
 * ## GET only, bounded, and typed
 *
 * `packages/mcp/src/hosted-supabase.ts:92` is GET-only by design and so is this.
 * There is no write path to refuse at runtime and no verb parameter anywhere in
 * the surface: {@link resolveCaller} refuses a non-`GET` request with 405 before
 * it looks at any header.
 *
 * Every read is bounded twice — a caller-supplied `limit` that is absent,
 * non-integral, below 1, or above {@link CONTROL_PLANE_MAX_LIMIT} is **refused**,
 * and the value that is sent is always explicit. An oversized page is a 400 from
 * the console, never a silently truncated array that a page would render as
 * complete.
 *
 * ## Fail closed, say why, and never echo upstream
 *
 * Three rules govern every failure:
 *
 * 1. **Misconfiguration is unavailable with a reason**, never an empty array.
 *    An empty result set reads as "no data", which is a false statement about a
 *    workspace. An unconfigured Supabase is a 503 whose message names the
 *    variable.
 * 2. **No upstream body, token, URL, or path is ever surfaced.** Every message
 *    that can reach the wire is assembled from constants in this file and passed
 *    through {@link sanitizeReadMessage}, which additionally strips anything
 *    JWT-shaped, credential-bearing, or absolute-path shaped.
 * 3. **A rejected token is 401**, and the upstream response body is dropped on
 *    the floor. It may name the token, or a schema detail, or an internal host.
 *
 * ## Why RLS still does the work
 *
 * The adapter adds no authorization of its own and must not acquire any. It
 * does not filter by workspace, does not check membership, and does not know the
 * five roles exist. If it did, it would be a second, weaker implementation of a
 * policy that is already expressed once in SQL and proved by
 * `tests/rls/contract-f.rls.mjs`. The correct invariant is: *whatever RLS returns
 * is what the caller sees, including zero rows.*
 */

import { loadServerConfig } from "./env.ts";

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Largest page a control-plane read may request.
 *
 * Sized for the largest real consumer: an owner's audit log or a hub's release
 * inventory. Not sized for enumeration — a console that wanted "every row
 * forever" would be an exfiltration surface with a UI on the front, which is why
 * a caller asking for more is refused rather than served a truncated page.
 */
export const CONTROL_PLANE_MAX_LIMIT = 200;

/** Page size used when the caller does not ask for one. */
export const CONTROL_PLANE_DEFAULT_LIMIT = 50;

/** Most equality/in filters one read may carry. */
export const CONTROL_PLANE_MAX_FILTERS = 4;

/** Most values one filter may carry. */
export const CONTROL_PLANE_MAX_FILTER_VALUES = 20;

/** Largest accepted `Authorization` header value, before parsing. */
export const CONTROL_PLANE_MAX_TOKEN_LENGTH = 8192;

/**
 * Largest accepted row offset.
 *
 * Pagination has to start somewhere, and an unbounded offset is a way to ask the
 * database for a single deep row an attacker cannot otherwise find cheaply. 10 000
 * is far past any real member list or audit page and well inside what PostgREST
 * will serve.
 */
export const CONTROL_PLANE_MAX_OFFSET = 10_000;

/** Offset used when the caller does not ask for one. */
export const CONTROL_PLANE_DEFAULT_OFFSET = 0;

/** Largest accepted subject (`sub`) after verification. */
const MAX_SUBJECT_LENGTH = 256;

/** Largest accepted value for a `short-text` or `identifier` filter value. */
const MAX_TEXT_FILTER_VALUE_LENGTH = 128;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every failure the adapter raises, with the HTTP status the console route
 * answers and a stable code.
 *
 * `status` is `401` for an absent or rejected caller, `405` for a non-`GET`
 * request, `400` for a request the allow-list refuses, `503` for an unconfigured
 * or unreachable Supabase, and `502` for an upstream response the adapter cannot
 * make sense of. The set is closed on purpose: no branch throws a bare `Error`,
 * because `apps/web/server/api.ts` maps an unrecognised failure to a generic 503
 * and that fallback must never be the *normal* path for a policy refusal.
 */
export class ControlPlaneReadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ControlPlaneReadError";
    this.status = status;
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Message hygiene                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Structural patterns that must never reach the wire.
 *
 * Three JWT-shaped segments, anything that looks like a credential in a URL, an
 * absolute POSIX or Windows path, and a `Bearer` token. A message that matched
 * any of these is replaced wholesale rather than edited, because a partial edit
 * of a leaked token is still a leak.
 */
const MESSAGE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted>"],
  [/\b(?:Bearer|Token|apikey|secret|token)\b\s*[:=]?\s*\S+/gi, "<redacted>"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@[^\s]*/gi, "<redacted-url>"],
  [/(^|[\s"'(=:[])(\/[A-Za-z0-9._@+-]+)+/g, "$1<redacted-path>"],
  [/(^|[\s"'(=:])([A-Za-z]:\\(?:[^\\\s"'`,;)]+\\)*[^\\\s"'`,;)]*)/g, "$1<redacted-path>"],
]);

/**
 * Final pass before a message can reach a response body.
 *
 * The adapter's own messages are assembled from constants and need none of this;
 * it exists for the *untrusted* inputs that can reach a message through an
 * upstream failure or a caller-supplied table name. It is idempotent, never
 * throws, and caps the length so an upstream sentence cannot become a payload.
 */
export function sanitizeReadMessage(message: string): string {
  let redacted = message;
  for (const [pattern, replacement] of MESSAGE_REDACTIONS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.length > 512 ? `${redacted.slice(0, 509)}...` : redacted;
}

function fail(status: number, code: string, message: string): never {
  throw new ControlPlaneReadError(status, code, sanitizeReadMessage(message));
}

/* -------------------------------------------------------------------------- */
/* The allow-list                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How a filter value is validated before it may enter a URL.
 *
 * The kind is part of the allow-list rather than a per-call assertion, so a
 * caller cannot widen it: asking to filter `security_denies.identity` on
 * `subject` is refused because no such column/value pairing exists in code.
 *
 * - `uuid`         canonical 8-4-4-4-12 lowercase hex
 * - `digest`       `sha256:<64 lowercase hex>`, the database `check` form
 * - `workspace-role` one of the five roles the schema `check` constraint allows
 * - `deny-kind`    one of the five `security_denies.kind` values
 * - `hub-visibility` one of the three `hubs.visibility` values
 * - `boolean`      `true` / `false`, rendered verbatim
 * - `short-text`   a subject: bounded, and free of PostgREST filter syntax
 * - `identifier`   a bounded opaque identifier (operation, result, name)
 */
export type ControlPlaneValueKind =
  | "uuid"
  | "digest"
  | "workspace-role"
  | "deny-kind"
  | "hub-visibility"
  | "boolean"
  | "short-text"
  | "identifier";

const WORKSPACE_ROLES = Object.freeze(["owner", "admin", "maintainer", "member", "viewer"] as const);
const DENY_KINDS = Object.freeze(["hub", "release", "skill", "source", "blob"] as const);
const HUB_VISIBILITIES = Object.freeze(["private", "workspace", "public"] as const);

/**
 * Deliberately narrow: no comma, quote, parenthesis, whitespace, backslash, or
 * PostgREST operator character. This is what makes a value safe to place inside
 * an `in.(...)` list without quoting games.
 */
const FILTER_TEXT = /^[A-Za-z0-9._:@+-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function validateValue(kind: ControlPlaneValueKind, value: string, table: string, column: string): string {
  switch (kind) {
    case "uuid":
      if (!UUID.test(value)) {
        fail(400, "E_WEB_READ_FILTER_INVALID", `${table}.${column} requires a canonical uuid value`);
      }
      return value;
    case "digest":
      if (!DIGEST.test(value)) {
        fail(
          400,
          "E_WEB_READ_FILTER_INVALID",
          `${table}.${column} requires a canonical sha256:<64 lowercase hex> value`,
        );
      }
      return value;
    case "workspace-role":
      if (!(WORKSPACE_ROLES as readonly string[]).includes(value)) {
        fail(400, "E_WEB_READ_FILTER_INVALID", `${table}.${column} requires one of the five workspace roles`);
      }
      return value;
    case "deny-kind":
      if (!(DENY_KINDS as readonly string[]).includes(value)) {
        fail(400, "E_WEB_READ_FILTER_INVALID", `${table}.${column} requires one of the five deny kinds`);
      }
      return value;
    case "hub-visibility":
      if (!(HUB_VISIBILITIES as readonly string[]).includes(value)) {
        fail(400, "E_WEB_READ_FILTER_INVALID", `${table}.${column} requires one of the three hub visibilities`);
      }
      return value;
    case "boolean":
      if (value !== "true" && value !== "false") {
        fail(400, "E_WEB_READ_FILTER_INVALID", `${table}.${column} requires true or false`);
      }
      return value;
    case "short-text":
      if (value.length > MAX_SUBJECT_LENGTH || !FILTER_TEXT.test(value)) {
        fail(
          400,
          "E_WEB_READ_FILTER_INVALID",
          `${table}.${column} requires a bounded subject with no filter metacharacters`,
        );
      }
      return value;
    case "identifier":
      if (value.length > MAX_TEXT_FILTER_VALUE_LENGTH || !FILTER_TEXT.test(value)) {
        fail(
          400,
          "E_WEB_READ_FILTER_INVALID",
          `${table}.${column} requires a bounded identifier with no filter metacharacters`,
        );
      }
      return value;
  }
}

/** One filterable column and the kind of value it accepts. */
export interface ControlPlaneFilterColumn {
  readonly kind: ControlPlaneValueKind;
}

/**
 * One allow-listed table: the columns a read may project, and the columns a read
 * may filter, each with the value kind it accepts.
 *
 * Both lists are exhaustive *and* closed. A column absent from `columns` cannot
 * be selected, so a future migration that adds a column carrying a secret cannot
 * be read through the console by accident — it becomes readable only by an
 * explicit, reviewable edit here.
 */
export interface ControlPlaneTableSpec {
  /** Allow-listed projection. Omitting `columns` in a read selects all of these. */
  readonly columns: readonly string[];
  /** Allow-listed filter columns, with their value kinds. */
  readonly filterable: Readonly<Record<string, ControlPlaneFilterColumn>>;
}

/**
 * Deep-freeze one table spec and copy it.
 *
 * The allow-list is the module's authorization boundary, so a mutation at
 * runtime would be an authorization change with no code review. Copying through
 * this helper also means each nested `Object.freeze` result is a *fresh* object:
 * the same spec cannot be shared between two tables by accident and then widened
 * through one of them.
 */
function freezeTableSpec(spec: ControlPlaneTableSpec): ControlPlaneTableSpec {
  const filterable: Record<string, ControlPlaneFilterColumn> = {};
  for (const [column, entry] of Object.entries(spec.filterable)) {
    filterable[column] = Object.freeze({ kind: entry.kind });
  }
  return Object.freeze({
    columns: Object.freeze([...spec.columns]),
    filterable: Object.freeze(filterable),
  });
}

/**
 * The eleven control-plane surfaces the console reads, and nothing else.
 *
 * Membership matches the later page builders exactly:
 * `personal_workspaces`, `workspace_memberships` (members page);
 * `projects`, `project_contexts`, `context_revocations` (projects/contexts);
 * `quota_policies`, `quota_usage`, `security_denies`, `audit_events`
 * (quotas/security/audit); `hubs`, `hub_releases`, `hub_stable_pointers` (the
 * control-plane hub/release pointer).
 *
 * Four of the sixteen RLS-governed tables are **absent on purpose**:
 * `immutable_objects`, `hub_release_artifacts`, `source_credentials`, and
 * `public_hub_publications`. The console's release data comes from the verified
 * artifact bundle, not from the database; blob byte lengths and object digests
 * would duplicate it with less provenance; and `source_credentials.secret_reference`
 * is a vault pointer the console has no reason to display.
 *
 * The outer record is a plain object literal, so `assertTableAllowed` uses
 * `Object.prototype.hasOwnProperty.call` rather than a truthiness lookup: a table
 * named `constructor` or `toString` would otherwise find an inherited function
 * where a spec belongs.
 */
/**
 * The table literals. Declared separately so {@link CONTROL_PLANE_TABLES} can be
 * a deep-frozen copy: the export is the authorization boundary, so it must not
 * share array identity with a mutable literal.
 */
const CONTROL_PLANE_TABLE_LITERALS: Readonly<Record<string, ControlPlaneTableSpec>> = {
  personal_workspaces: {
    columns: ["id", "owner_subject", "created_at"],
    filterable: { id: { kind: "uuid" }, owner_subject: { kind: "short-text" } },
  },
  workspace_memberships: {
    columns: ["workspace_id", "subject", "role", "active", "created_at"],
    filterable: {
      workspace_id: { kind: "uuid" },
      subject: { kind: "short-text" },
      role: { kind: "workspace-role" },
      active: { kind: "boolean" },
    },
  },
  projects: {
    columns: ["id", "workspace_id", "name", "created_at"],
    filterable: { id: { kind: "uuid" }, workspace_id: { kind: "uuid" } },
  },
  project_contexts: {
    columns: ["id", "project_id", "context_digest", "release_digest", "revoked_at", "published_at"],
    filterable: { id: { kind: "uuid" }, project_id: { kind: "uuid" }, release_digest: { kind: "digest" } },
  },
  context_revocations: {
    columns: ["context_id", "reason", "revoked_by", "revoked_at"],
    filterable: { context_id: { kind: "uuid" } },
  },
  quota_policies: {
    columns: ["workspace_id", "requests_per_minute", "concurrent_requests", "bandwidth_bytes"],
    filterable: { workspace_id: { kind: "uuid" } },
  },
  quota_usage: {
    columns: ["workspace_id", "window_started", "request_count", "bandwidth_bytes"],
    filterable: { workspace_id: { kind: "uuid" } },
  },
  security_denies: {
    columns: ["id", "workspace_id", "kind", "identity", "reason", "created_at"],
    filterable: { workspace_id: { kind: "uuid" }, kind: { kind: "deny-kind" } },
  },
  audit_events: {
    columns: [
      "id",
      "workspace_id",
      "actor_subject",
      "operation",
      "target_identity",
      "old_identity",
      "new_identity",
      "result",
      "request_id",
      "created_at",
    ],
    filterable: {
      workspace_id: { kind: "uuid" },
      actor_subject: { kind: "short-text" },
      operation: { kind: "identifier" },
      result: { kind: "identifier" },
    },
  },
  hubs: {
    columns: ["id", "workspace_id", "visibility", "created_at"],
    filterable: {
      id: { kind: "uuid" },
      workspace_id: { kind: "uuid" },
      visibility: { kind: "hub-visibility" },
    },
  },
  hub_releases: {
    columns: ["hub_id", "release_digest", "sqlite_artifact_digest", "published_at"],
    filterable: { hub_id: { kind: "uuid" }, release_digest: { kind: "digest" } },
  },
  hub_stable_pointers: {
    columns: ["hub_id", "release_digest", "updated_at"],
    filterable: { hub_id: { kind: "uuid" }, release_digest: { kind: "digest" } },
  },
};

/** The eleven allow-listed tables, deep-frozen. This is the exported boundary. */
export const CONTROL_PLANE_TABLES: Readonly<Record<string, ControlPlaneTableSpec>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CONTROL_PLANE_TABLE_LITERALS).map(([name, spec]) => [name, freezeTableSpec(spec)]),
  ),
);

/** Names on {@link CONTROL_PLANE_TABLES}, in a stable order for display and tests. */
export const CONTROL_PLANE_TABLE_NAMES: readonly string[] = Object.freeze(
  Object.keys(CONTROL_PLANE_TABLES).sort(),
);

/**
 * Throw unless `table` is on {@link CONTROL_PLANE_TABLES}.
 *
 * Exported so a route module can assert its table at registration time — a
 * typo becomes a startup refusal rather than a 400 discovered by a user.
 */
export function assertTableAllowed(table: string): ControlPlaneTableSpec {
  const spec = Object.prototype.hasOwnProperty.call(CONTROL_PLANE_TABLES, table)
    ? CONTROL_PLANE_TABLES[table]
    : undefined;
  if (spec === undefined) {
    fail(
      400,
      "E_WEB_READ_TABLE_NOT_ALLOWED",
      `${sanitizeReadMessage(table)} is not an allow-listed control-plane table`,
    );
  }
  return spec;
}

/* -------------------------------------------------------------------------- */
/* Request / response plumbing                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The slice of an `IncomingMessage` this module reads.
 *
 * Structural rather than a concrete `IncomingMessage` so a test can present a
 * request without a socket. `apps/web/server.mts` already passes the real
 * `IncomingMessage`, whose `headers` index signature is compatible.
 */
export interface ControlPlaneRequest {
  readonly method?: string | undefined;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface ControlPlaneHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * The HTTP seam, injectable so a test can present a subject without a live
 * Supabase. Mirrors the `SupabaseFetch` shape in
 * `packages/mcp/src/hosted-supabase.ts:12`.
 *
 * An injected transport is a **test** affordance. In production the adapter
 * installs `globalThis.fetch`, and a transport is still given no credential: it
 * receives the URL and a header map whose only credential is the caller's token.
 */
export type ControlPlaneTransport = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal | undefined;
  },
) => Promise<ControlPlaneHttpResponse>;

export interface ControlPlaneReaderOptions {
  /** Absolute Supabase project URL, or `null` when unconfigured. */
  readonly supabaseUrl: string | null;
  /** Defaults to `globalThis.fetch`. */
  readonly transport?: ControlPlaneTransport | undefined;
}

/**
 * The caller, proven.
 *
 * `token` is the bearer string that will be forwarded verbatim to PostgREST, and
 * it is carried on this object *only* so a route can pass the same caller to
 * several reads. It is never logged, never serialised, and never included in an
 * error message. `subject` is what `GET /auth/v1/user` reported for it.
 */
export interface CallerIdentity {
  readonly subject: string;
  readonly token: string;
}

/** One equality / membership filter. Column and every value are allow-listed. */
export interface ControlPlaneFilter {
  readonly column: string;
  readonly values: readonly string[];
}

export interface ControlPlaneReadOptions {
  /** Projection. Omit for every allow-listed column of the table. */
  readonly columns?: readonly string[] | undefined;
  readonly filters?: readonly ControlPlaneFilter[] | undefined;
  /** Explicit page size. Omit for {@link CONTROL_PLANE_DEFAULT_LIMIT}. */
  readonly limit?: number | undefined;
  /** Explicit row offset. Omit for {@link CONTROL_PLANE_DEFAULT_OFFSET}. */
  readonly offset?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** An allow-listed projection, and the filter columns a caller asked for. */
export interface PlannedControlPlaneQuery {
  readonly table: string;
  readonly columns: readonly string[];
  readonly filters: readonly ControlPlaneFilter[];
  readonly limit: number;
  readonly offset: number;
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Validate a read request against the allow-list and produce the exact query the
 * adapter will send.
 *
 * Split out from the transport so every refusal can be asserted without a
 * network, and so a route can validate a request at registration time. Nothing
 * here touches the network and nothing here consults configuration.
 */
export function planControlPlaneRead(
  table: string,
  options: ControlPlaneReadOptions = {},
): PlannedControlPlaneQuery {
  const spec = assertTableAllowed(table);

  const requested = options.columns ?? spec.columns;
  if (requested.length === 0) {
    fail(400, "E_WEB_READ_PROJECTION_INVALID", `a read of ${table} must project at least one column`);
  }
  if (requested.length > spec.columns.length) {
    fail(
      400,
      "E_WEB_READ_PROJECTION_INVALID",
      `a read of ${table} may project at most ${spec.columns.length} allow-listed columns`,
    );
  }
  const columns: string[] = [];
  for (const column of requested) {
    if (!spec.columns.includes(column)) {
      fail(
        400,
        "E_WEB_READ_COLUMN_NOT_ALLOWED",
        `${column} is not an allow-listed column of ${table}`,
      );
    }
    if (!columns.includes(column)) columns.push(column);
  }

  const filters = options.filters ?? [];
  if (filters.length > CONTROL_PLANE_MAX_FILTERS) {
    fail(
      400,
      "E_WEB_READ_FILTER_NOT_ALLOWED",
      `a read may carry at most ${CONTROL_PLANE_MAX_FILTERS} filters`,
    );
  }
  const planned: ControlPlaneFilter[] = [];
  const seenColumns = new Set<string>();
  for (const filter of filters) {
    const declared = Object.prototype.hasOwnProperty.call(spec.filterable, filter.column)
      ? spec.filterable[filter.column]
      : undefined;
    if (declared === undefined) {
      fail(
        400,
        "E_WEB_READ_FILTER_NOT_ALLOWED",
        `${sanitizeReadMessage(String(filter.column))} is not a filterable column of ${table}`,
      );
    }
    if (seenColumns.has(filter.column)) {
      fail(
        400,
        "E_WEB_READ_FILTER_NOT_ALLOWED",
        `${filter.column} is filtered more than once in one read`,
      );
    }
    seenColumns.add(filter.column);
    if (filter.values.length === 0) {
      fail(400, "E_WEB_READ_FILTER_INVALID", `${filter.column} was given no values`);
    }
    if (filter.values.length > CONTROL_PLANE_MAX_FILTER_VALUES) {
      fail(
        400,
        "E_WEB_READ_FILTER_INVALID",
        `${filter.column} may carry at most ${CONTROL_PLANE_MAX_FILTER_VALUES} values`,
      );
    }
    planned.push(
      Object.freeze({
        column: filter.column,
        values: Object.freeze(
          filter.values.map((value) => validateValue(declared.kind, value, table, filter.column)),
        ),
      }),
    );
  }

  const limit = options.limit ?? CONTROL_PLANE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTROL_PLANE_MAX_LIMIT) {
    fail(
      400,
      "E_WEB_READ_LIMIT_INVALID",
      `limit must be an integer between 1 and ${CONTROL_PLANE_MAX_LIMIT}; an unbounded or oversized page is refused rather than truncated`,
    );
  }

  const offset = options.offset ?? CONTROL_PLANE_DEFAULT_OFFSET;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > CONTROL_PLANE_MAX_OFFSET) {
    fail(
      400,
      "E_WEB_READ_OFFSET_INVALID",
      `offset must be an integer between 0 and ${CONTROL_PLANE_MAX_OFFSET}`,
    );
  }

  return Object.freeze({
    table,
    columns: Object.freeze(columns),
    filters: Object.freeze(planned),
    limit,
    offset,
  });
}

/* -------------------------------------------------------------------------- */
/* URL assembly                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the PostgREST URL for a planned read.
 *
 * The path and the `select` clause come from allow-list constants; every
 * caller-supplied value goes through `URLSearchParams.set`, which percent-encodes
 * it. `limit` is always explicit, so no read is ever unbounded on the wire even
 * though it was validated above.
 */
export function buildControlPlaneUrl(baseUrl: URL, plan: PlannedControlPlaneQuery): string {
  const url = new URL(`/rest/v1/${plan.table}`, baseUrl);
  url.searchParams.set("select", plan.columns.join(","));
  for (const filter of plan.filters) {
    const values = filter.values;
    url.searchParams.set(
      filter.column,
      values.length === 1 ? `eq.${values[0] as string}` : `in.(${values.join(",")})`,
    );
  }
  url.searchParams.set("limit", String(plan.limit));
  // Only sent when non-zero, so the common first page carries no offset at all.
  if (plan.offset > 0) url.searchParams.set("offset", String(plan.offset));
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Caller resolution                                                           */
/* -------------------------------------------------------------------------- */

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

/**
 * Extract the bearer token from an `Authorization` header.
 *
 * Four refusals, all 401, none of which falls through to an anonymous read:
 *
 * - **absent** — no header at all;
 * - **repeated** — Node joins duplicate `authorization` headers with `, `, so a
 *   value containing a comma is two credentials arriving at once. It is refused
 *   rather than parsed as the first one, because "pick one" is a client bug this
 *   module should not resolve on the caller's behalf;
 * - **not `Bearer`** — including `Basic`, the legacy Supabase apikey form, and a
 *   bare token;
 * - **malformed** — an empty credential, one with whitespace, or one longer than
 *   {@link CONTROL_PLANE_MAX_TOKEN_LENGTH}.
 *
 * The credential charset is checked here so a value containing a newline or a
 * comma can never reach a header value assembled downstream.
 */
export function extractBearerToken(request: ControlPlaneRequest): string {
  const raw = request.headers["authorization"];
  if (raw === undefined) {
    fail(401, "E_WEB_UNAUTHENTICATED", "This surface requires an authenticated caller and no session was presented");
  }
  const value = Array.isArray(raw) ? raw.join(", ") : raw;
  if (typeof value !== "string") {
    fail(401, "E_WEB_UNAUTHENTICATED", "This surface requires an authenticated caller");
  }
  if (value.includes(",")) {
    fail(401, "E_WEB_UNAUTHENTICATED", "Exactly one Authorization credential may be presented");
  }
  if (value.length > CONTROL_PLANE_MAX_TOKEN_LENGTH) {
    fail(401, "E_WEB_UNAUTHENTICATED", "The presented credential is too long to be a session token");
  }
  const matched = BEARER.exec(value.trim());
  if (matched === null) {
    fail(401, "E_WEB_UNAUTHENTICATED", "This surface requires a Bearer session token and none was presented");
  }
  const token = matched[1] as string;
  if (token === "") {
    fail(401, "E_WEB_UNAUTHENTICATED", "The presented credential is empty");
  }
  return token;
}

/* -------------------------------------------------------------------------- */
/* Reader                                                                      */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A reader bound to one Supabase deployment and one transport. */
export interface ControlPlaneReader {
  /** Resolve and verify the caller. Never returns an anonymous identity. */
  resolveCaller(request: ControlPlaneRequest): Promise<CallerIdentity>;
  /** Read an allow-listed table as the caller. */
  readAsCaller<T = Readonly<Record<string, unknown>>>(
    caller: CallerIdentity,
    table: string,
    options?: ControlPlaneReadOptions,
  ): Promise<readonly T[]>;
  /** Operator-safe sentence describing whether Supabase is configured. */
  describeAvailability(): string;
}

function parseBaseUrl(supabaseUrl: string | null): URL | null {
  if (supabaseUrl === null) return null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    parsed = null;
  }
  // A malformed URL is a configuration fault, not a caller fault. The value is
  // never echoed: a Supabase URL may embed a password.
  if (parsed === null) {
    fail(503, "E_WEB_READ_UNAVAILABLE", "EGA_SUPABASE_URL is configured but is not a valid URL");
  }
  // The same HTTPS requirement `packages/mcp/src/hosted-supabase.ts:76` enforces
  // on its own copy. A control-plane read over plaintext HTTP would put the
  // caller's access token on the wire in the clear.
  if (parsed.protocol !== "https:") {
    fail(503, "E_WEB_READ_UNAVAILABLE", "EGA_SUPABASE_URL must use HTTPS");
  }
  return parsed;
}

/**
 * Build a reader.
 *
 * Deliberately has no credential parameter. See the module comment: the only
 * credential this adapter can ever send is the caller's own token.
 *
 * An unconfigured `supabaseUrl` does **not** throw here. It makes every read
 * refuse with a 503 that names `EGA_SUPABASE_URL`, which is the honest answer;
 * throwing at construction would take the whole console down for a deployment
 * that may be running only the release catalog.
 */
export function createControlPlaneReader(options: ControlPlaneReaderOptions): ControlPlaneReader {
  const baseUrl = parseBaseUrl(options.supabaseUrl);
  const transport =
    options.transport ?? (globalThis["fetch"] as unknown as ControlPlaneTransport | undefined);
  if (transport === undefined) {
    throw new ControlPlaneReadError(
      503,
      "E_WEB_READ_UNAVAILABLE",
      "No HTTP transport is available for the control-plane read path",
    );
  }

  const requireBaseUrl = (): URL => {
    if (baseUrl === null) {
      fail(
        503,
        "E_WEB_READ_UNAVAILABLE",
        "Control-plane data is unavailable: EGA_SUPABASE_URL is not configured for this deployment",
      );
    }
    return baseUrl;
  };

  /**
   * The one credential-bearing header map in this module.
   *
   * Both the session probe and every table read build their headers here, from
   * the caller's token, so there is exactly one place a credential could be and
   * exactly one place a reviewer can check it.
   */
  const callerHeaders = (token: string): Readonly<Record<string, string>> =>
    Object.freeze({ accept: "application/json", authorization: `Bearer ${token}` });

  const resolveCaller = async (request: ControlPlaneRequest): Promise<CallerIdentity> => {
    // GET-only, decided before the header is even read. There is no write path,
    // so a verb other than GET is not an unauthenticated read; it is not a read.
    if (request.method !== undefined && request.method !== "GET") {
      fail(
        405,
        "E_WEB_READ_METHOD_NOT_ALLOWED",
        "The control-plane read surface answers GET and nothing else",
      );
    }
    const url = requireBaseUrl();
    const token = extractBearerToken(request);

    let response: ControlPlaneHttpResponse;
    try {
      response = await transport(new URL("/auth/v1/user", url).toString(), {
        method: "GET",
        headers: callerHeaders(token),
        signal: undefined,
      });
    } catch {
      // The cause is discarded rather than wrapped: a fetch rejection message can
      // embed the request URL, and the URL is the deployment's.
      fail(503, "E_WEB_READ_UNAVAILABLE", "The control-plane session endpoint could not be reached");
    }

    if (response.status === 401 || response.status === 403) {
      fail(401, "E_WEB_UNAUTHENTICATED", "The presented session was rejected");
    }
    if (!response.ok) {
      fail(502, "E_WEB_READ_UPSTREAM", "The control-plane session endpoint returned an unexpected status");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      fail(502, "E_WEB_READ_UPSTREAM_MALFORMED", "The control-plane session endpoint returned an unreadable body");
    }
    const record = isRecord(body) ? body : null;
    const subject = record?.["id"];
    if (typeof subject !== "string" || subject === "" || subject.length > MAX_SUBJECT_LENGTH) {
      fail(502, "E_WEB_READ_UPSTREAM_MALFORMED", "The session endpoint did not report a usable subject");
    }
    // Frozen, and carrying the token so several reads can share one caller. The
    // token never leaves this object except as a forwarded header.
    return Object.freeze({ subject, token });
  };

  const readAsCaller = async <T>(
    caller: CallerIdentity,
    table: string,
    readOptions: ControlPlaneReadOptions = {},
  ): Promise<readonly T[]> => {
    const url = requireBaseUrl();
    // Validate before the network: an un-allow-listed table must not produce a
    // request at all, which is what makes the refusal observable in a test that
    // counts transport calls.
    const plan = planControlPlaneRead(table, readOptions);
    const target = buildControlPlaneUrl(url, plan);

    let response: ControlPlaneHttpResponse;
    try {
      response = await transport(
        target,
        readOptions.signal === undefined
          ? { method: "GET", headers: callerHeaders(caller.token) }
          : { method: "GET", headers: callerHeaders(caller.token), signal: readOptions.signal },
      );
    } catch {
      fail(503, "E_WEB_READ_UNAVAILABLE", "The control-plane read endpoint could not be reached");
    }

    // 404 here means the table is not exposed to the deployment, which is a
    // deployment fault rather than a caller fault: the console offers a surface
    // it cannot serve. 401/403 mean the gateway rejected the caller's own
    // credential; neither the status line nor the body is surfaced.
    if (response.status === 401 || response.status === 403) {
      fail(401, "E_WEB_UNAUTHENTICATED", "The presented session was rejected");
    }
    if (response.status === 404) {
      fail(503, "E_WEB_READ_UNAVAILABLE", "The requested control-plane surface is not available on this deployment");
    }
    if (!response.ok) {
      fail(502, "E_WEB_READ_UPSTREAM", "The control-plane read endpoint returned an unexpected status");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      fail(502, "E_WEB_READ_UPSTREAM_MALFORMED", "The control-plane read endpoint returned an unreadable body");
    }
    // PostgREST returns a JSON array for a `select`. An object or a scalar means
    // the response is not the shape this adapter reasons about, and guessing
    // would mean rendering rows the console never validated.
    if (!Array.isArray(body)) {
      fail(502, "E_WEB_READ_UPSTREAM_MALFORMED", "The control-plane read endpoint returned an unexpected shape");
    }
    const rows: T[] = [];
    for (const row of body) {
      if (!isRecord(row)) {
        fail(502, "E_WEB_READ_UPSTREAM_MALFORMED", "The control-plane read endpoint returned an unexpected row shape");
      }
      rows.push(row as T);
    }
    // A row-count check is deliberate and not a truncation: if the gateway
    // ignored the limit, the console would silently drop rows at the far end of a
    // page. Refusing is the honest alternative.
    if (rows.length > plan.limit) {
      fail(
        502,
        "E_WEB_READ_UPSTREAM_MALFORMED",
        `The control-plane read endpoint returned more rows than the requested limit of ${plan.limit}`,
      );
    }
    return Object.freeze(rows);
  };

  return Object.freeze({
    resolveCaller,
    readAsCaller,
    describeAvailability: () =>
      baseUrl === null
        ? "Control-plane data is unavailable: EGA_SUPABASE_URL is not configured for this deployment."
        : "Control-plane data is served from Supabase with the caller's own session; no privileged credential is held by this process.",
  });
}

/**
 * The reader for a configured deployment: `EGA_SUPABASE_URL` from
 * `ServerConfig`, and nothing else.
 *
 * `ServerConfig.supabaseSecretKey` is deliberately not referenced here. This is
 * the seam a reviewer should read to confirm the rule: there is no code path from
 * `EGA_SUPABASE_SECRET_KEY` to a PostgREST request.
 */
export function defaultControlPlaneReader(): ControlPlaneReader {
  return createControlPlaneReader({ supabaseUrl: loadServerConfig().supabaseUrl });
}