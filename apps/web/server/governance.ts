/**
 * Governance routes: quota policy and usage, recorded security denies, audit
 * events.
 *
 * ## The two rules this module exists to honour
 *
 * **1. The caller's own credential, and nothing else.** Every read here goes
 * through `apps/web/server/supabase-read.ts` via
 * {@link import("./api.ts").controlPlaneRoute}. The privileged Supabase secret
 * environment variable does not appear in this file — not even in a comment — and
 * neither does any credential field, because the adapter has no parameter that
 * would accept one. The only credential that reaches PostgREST is the caller's own
 * bearer token, so PostgreSQL row-level security evaluates the real caller and
 * this console cannot widen a read that RLS refused.
 * `apps/web/server/api.ts:32` already documents the seam; this module adds routes
 * and no authority.
 *
 * **2. A never-written table is not a zero.** This is the whole point of these
 * three surfaces, and it is easy to get wrong in a way that looks correct.
 *
 * Verified against this checkout: there is **no production writer** for
 * `quota_policies`, `quota_usage`, `security_denies`, or `audit_events`. The
 * only `insert into` statements for those tables in the whole repository are in
 * `tests/rls/seed.sql` and `tests/web/cross-workspace-isolation.test.mjs` — test
 * fixtures. Nothing in `packages/` or `apps/` writes them.
 *
 * So an empty result set is the *expected* state of a real deployment, and
 * rendering it as `0 requests` or `0 events` would state a measurement that was
 * never taken. Every empty case below therefore produces a sentence that says
 * "nothing has been recorded" and names why, and {@link EMPTY_USAGE_REASON},
 * {@link EMPTY_AUDIT_REASON}, {@link EMPTY_DENY_REASON} and
 * {@link NULL_POLICY_REASON} are exported so a test can assert the exact copy
 * rather than a substring of it.
 *
 * ## `quota_policies` is not what enforces the limits
 *
 * This is the second thing easy to get wrong, and it is a *truthfulness* error
 * rather than a rendering one.
 *
 * `quota_policies.requests_per_minute`, `.concurrent_requests` and
 * `.bandwidth_bytes` are displayed here, and they are read from the database.
 * But nothing **enforces** them: `grep -rn "quota_polic"` over `packages/` and
 * `apps/` outside the migrations and tests returns only this console's own
 * allow-list entry and the DTO. The hosted MCP runtime's actual bounds come
 * from process-level environment values it reads at startup —
 * `EGA_HOSTED_MAX_BODY_BYTES`, `EGA_HOSTED_MAX_RESPONSE_BYTES`,
 * `EGA_HOSTED_MAX_CONCURRENT_REQUESTS`, `EGA_HOSTED_REQUEST_TIMEOUT_MS`
 * (`packages/mcp/src/hosted-runtime.ts:39-42`, `303-318`). There is no
 * `requests_per_minute` enforcement anywhere in this repository.
 *
 * A page that showed the three policy numbers with no such statement would imply
 * an enforcement mechanism that does not exist. {@link POLICY_ENFORCEMENT_NOTE}
 * therefore travels on every successful quota response, and `QuotasPage.tsx`
 * renders it above the numbers.
 *
 * ## Why `workspace_id` is required for quotas and optional elsewhere
 *
 * `WorkspaceQuotaView.workspace_id` is a single required string, so that DTO
 * describes **one** workspace. RLS alone cannot answer "which workspace?" — it
 * filters, it does not label — and guessing would either fabricate an id or
 * silently merge two workspaces' numbers into one page. So `/workspace/quotas`
 * requires an explicit `workspace_id`, used strictly as a **filter**
 * (CONTRACT-F §1: ids are filters, never capabilities): if the caller names a
 * workspace they may not read, they get zero rows and a stated reason, never a
 * 403 that would confirm the workspace exists.
 *
 * `/workspace/security/denies` and `/audit` return flat arrays with no
 * workspace field, so their `workspace_id` filter is optional and omitting it
 * means "every row RLS admits for this caller".
 *
 * ## `audit_events` cannot expose a credential
 *
 * The table has no credential column and this module adds none: it projects
 * exactly the ten allow-listed `audit_events` columns and joins nothing. The
 * allow-list in `supabase-read.ts` is closed, so a future migration adding a
 * secret column cannot be read here without a reviewable edit to that file.
 * `source_credentials` is not allow-listed at all.
 *
 * ## Read-only, bounded, and honest about order
 *
 * Every route is `GET`-only. `authenticated` holds `SELECT` and no write policy
 * exists on any of these tables, so a mutation is impossible by privilege as
 * well as by design. Every read carries an explicit `limit`, and a
 * caller-oversized `limit` or `offset` is **refused** with a 400 before any
 * network call rather than clamped — a silently truncated audit log reads as a
 * complete one.
 *
 * Ordering is left to the database. `readAsCaller` builds a PostgREST URL with
 * no `order` parameter, so rows arrive in whatever order PostgREST returns. The
 * audit page sorts client-side for display and says nothing about server
 * ordering, because the console cannot guarantee one.
 */

import {
  API_MAX_QUERY_PARAM_VALUE_LENGTH,
  API_MAX_QUERY_PARAMS,
  ConsoleApiError,
  controlPlaneRoute,
  loadRequestBounds,
  type RequestBounds,
} from "./api.ts";
import {
  CONTROL_PLANE_DEFAULT_LIMIT,
  CONTROL_PLANE_DEFAULT_OFFSET,
  CONTROL_PLANE_MAX_LIMIT,
  CONTROL_PLANE_MAX_OFFSET,
  type CallerIdentity,
  type ControlPlaneFilter,
  type ControlPlaneReader,
} from "./supabase-read.ts";

import type { ApiRoute, ApiRouteContext } from "../server.mts";
import type {
  AuditRow,
  QuotaPolicyRow,
  QuotaUsageRow,
  SecurityDenyRow,
  WorkspaceQuotaView,
} from "../src/api/contracts.ts";

/* -------------------------------------------------------------------------- */
/* The copy, exported so it can be asserted rather than approximated           */
/* -------------------------------------------------------------------------- */

/**
 * Shown when `quota_usage` returned no rows.
 *
 * Names the absence, names the reason, and explicitly denies that it is a zero —
 * because it is not one, and "0 requests" is the specific false statement this
 * page must never make.
 */
export const EMPTY_USAGE_REASON =
  "No quota usage has been recorded. Nothing in this deployment writes public.quota_usage, " +
  "so an empty series is the expected state here — it is not a measurement of zero requests.";

/**
 * Shown when `audit_events` returned no rows.
 *
 * Two distinct causes collapse to an empty array and are not distinguishable
 * from the console: nothing has written an event, or the caller's role does not
 * admit them to any event. Both are named so a viewer who legitimately sees
 * nothing is told why.
 */
export const EMPTY_AUDIT_REASON =
  "No audit events have been recorded for the workspaces this caller may read. " +
  "Either no control-plane writer has produced an event yet, or your workspace role " +
  "does not admit you to any event — audit rows are scoped to owner and admin, and a " +
  "viewer, maintainer or member correctly sees none. This is an absence of records, not a count of zero events.";

/**
 * Shown when `security_denies` returned no rows.
 *
 * Deliberately does **not** claim "nothing is denied". The runtime enforces a
 * separate, process-level `EGA_HOSTED_AUTHZ_JSON` policy that this table does not
 * mirror, so an empty `security_denies` is not evidence that no identity is
 * refused.
 */
export const EMPTY_DENY_REASON =
  "No deny rows are recorded for the workspaces this caller may read. Either none has " +
  "been written, or your role does not admit you to any. This table is not the whole " +
  "enforced policy: the hosted runtime additionally enforces a separate EGA_HOSTED_AUTHZ_JSON " +
  "policy that these rows do not describe, so an empty table is not a statement that " +
  "nothing is denied.";

/**
 * Shown when `quota_policies` returned no row for the requested workspace.
 *
 * The two indistinguishable causes are a policy that was never recorded and RLS
 * withholding the row. The trailing clause is load-bearing: "no policy row" must
 * never be read as "no limit applies".
 */
export const NULL_POLICY_REASON =
  "No quota_policies row is readable for this workspace. Either no policy has been " +
  "recorded for it, or row-level security does not admit this caller to one — the two are " +
  "indistinguishable from the console. Neither means the runtime applies no limit: see the " +
  "enforcement note below this table.";

/**
 * The truthfulness note that travels with every quota response.
 *
 * Named for the three `EGA_HOSTED_MAX_*` values the hosted runtime actually
 * reads, plus the request deadline, so the operator can go look at the real
 * configuration. Verified absent from every enforcement path in this repository:
 * see the module comment.
 */
export const POLICY_ENFORCEMENT_NOTE =
  "These three numbers are recorded policy rows in public.quota_policies. Nothing in this " +
  "deployment enforces them: the hosted runtime does not read quota_policies. The limits the " +
  "runtime actually applies come from process-level environment values — " +
  "EGA_HOSTED_MAX_BODY_BYTES, EGA_HOSTED_MAX_RESPONSE_BYTES, " +
  "EGA_HOSTED_MAX_CONCURRENT_REQUESTS and EGA_HOSTED_REQUEST_TIMEOUT_MS — read once at " +
  "startup. There is no requests-per-minute enforcement anywhere in this codebase. Editing a " +
  "row here would not change a single served request.";

/**
 * The banner that keeps `/audit` from reading as usage analytics.
 *
 * Audit is control and security history: who did what to which identity, and
 * whether it was allowed. It is not traffic volume, and a page that charted it
 * would invite the reading that these rows measure usage.
 */
export const AUDIT_NOT_ANALYTICS_NOTE =
  "Control and security history: who attempted which operation against which identity, " +
  "and whether it was allowed or denied. This is not usage analytics — request volume and " +
  "bandwidth belong to the quota surfaces, and no credential, token, or secret value is " +
  "recorded in or reachable from these rows.";

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Largest accepted `identity` / `old_identity` / `new_identity` value.
 *
 * The columns are unbounded `text` in the schema. A row longer than this is
 * **refused** (502) rather than truncated, because a truncated identity is a
 * different identity and this page renders security-relevant values.
 */
const MAX_IDENTITY_LENGTH = 512;

/** Largest accepted `actor_subject`. Matches the adapter's own subject bound. */
const MAX_ACTOR_LENGTH = 256;

/** Largest accepted `operation` and `request_id`. */
const MAX_OPERATION_LENGTH = 128;

/** Largest accepted `result`. */
const MAX_RESULT_LENGTH = 64;

/** Largest accepted `reason` on a deny row. */
const MAX_DENY_REASON_LENGTH = 1_024;

/* -------------------------------------------------------------------------- */
/* Query parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Canonical lowercase UUID, the form the database primary keys use.
 *
 * Duplicated from the adapter's `UUID` on purpose rather than exported from
 * there: the adapter's copy is its internal filter-validation detail, and a
 * route is entitled to check its own input to produce a route-level 400 with a
 * message an operator can act on. The adapter re-validates regardless, so this
 * can only ever refuse something the adapter would also refuse.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The five `security_denies.kind` values the schema `check` constraint allows. */
const DENY_KINDS: readonly string[] = Object.freeze(["hub", "release", "skill", "source", "blob"]);

/**
 * Bound the query string before any validator loop runs.
 *
 * Uses the constants `api.ts` exports rather than restating their values, so the
 * two cannot drift. `assertBoundedQuery` is module-private there; re-implementing
 * these three lines is preferable to widening `api.ts`'s public surface from a
 * route module three parallel builders are also editing.
 */
function assertBoundedQuery(query: URLSearchParams): void {
  let count = 0;
  for (const [name, value] of query) {
    count += 1;
    if (count > API_MAX_QUERY_PARAMS) {
      throw new ConsoleApiError(
        400,
        "E_WEB_QUERY_INVALID",
        `A console API request may carry at most ${API_MAX_QUERY_PARAMS} query parameters`,
      );
    }
    if (name.length > 64) {
      throw new ConsoleApiError(400, "E_WEB_QUERY_INVALID", "query parameter names are bounded");
    }
    if (value.length > API_MAX_QUERY_PARAM_VALUE_LENGTH) {
      throw new ConsoleApiError(
        400,
        "E_WEB_QUERY_INVALID",
        `query parameter ${name} must be at most ${API_MAX_QUERY_PARAM_VALUE_LENGTH} characters`,
      );
    }
  }
}

/** A trimmed non-blank parameter, or `null` when absent or blank. */
function readParam(query: URLSearchParams, name: string): string | null {
  if (!query.has(name)) return null;
  const raw = query.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A required canonical UUID parameter.
 *
 * A required parameter that is absent is a 400 naming the parameter — never a
 * default, and never a read whose scope the console had to invent.
 */
function requireUuidParam(query: URLSearchParams, name: string): string {
  const value = readParam(query, name);
  if (value === null) {
    throw new ConsoleApiError(
      400,
      "E_WEB_QUERY_INVALID",
      `${name} is required: this view reports one workspace at a time, so the console must be told which one. It is a filter only; row-level security still decides what is readable.`,
    );
  }
  if (!UUID.test(value)) {
    throw new ConsoleApiError(400, "E_WEB_QUERY_INVALID", `${name} must be a canonical lowercase uuid`);
  }
  return value;
}

/** An optional canonical UUID parameter. */
function optionalUuidParam(query: URLSearchParams, name: string): string | null {
  const value = readParam(query, name);
  if (value === null) return null;
  if (!UUID.test(value)) {
    throw new ConsoleApiError(400, "E_WEB_QUERY_INVALID", `${name} must be a canonical lowercase uuid`);
  }
  return value;
}

/**
 * A bounded integer parameter, or `undefined` when absent.
 *
 * A malformed value is a 400 rather than a coerced default, and an out-of-range
 * value is **refused** rather than clamped. Clamping is the one behaviour this
 * route family must never have: a caller asking for 5000 rows and silently
 * receiving 200 would render a truncated page as a complete one.
 */
function readBoundedIntParam(
  query: URLSearchParams,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = readParam(query, name);
  if (value === null) return undefined;
  if (!/^-?\d+$/.test(value)) {
    throw new ConsoleApiError(
      400,
      "E_WEB_QUERY_INVALID",
      `${name} must be a base-ten integer; it is not coerced to a default`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConsoleApiError(400, "E_WEB_QUERY_INVALID", `${name} must be a safe integer`);
  }
  if (parsed < minimum || parsed > maximum) {
    throw new ConsoleApiError(
      400,
      "E_WEB_QUERY_INVALID",
      `${name} must be an integer between ${minimum} and ${maximum}; an unbounded or oversized page is refused rather than truncated`,
    );
  }
  return parsed;
}

/** `limit`, defaulted and refused when oversized. */
function readLimit(query: URLSearchParams): number {
  return readBoundedIntParam(query, "limit", 1, CONTROL_PLANE_MAX_LIMIT) ?? CONTROL_PLANE_DEFAULT_LIMIT;
}

/** `offset`, defaulted and refused when beyond the ceiling. */
function readOffset(query: URLSearchParams): number {
  return (
    readBoundedIntParam(query, "offset", 0, CONTROL_PLANE_MAX_OFFSET) ?? CONTROL_PLANE_DEFAULT_OFFSET
  );
}

/* -------------------------------------------------------------------------- */
/* Row decoding                                                                */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A malformed upstream row is a 502, never a coerced render.
 *
 * The message names the table and column but **never** the value: a projected
 * column could in principle carry something sensitive, and an error message
 * reaches a response body.
 */
function rowInvalid(table: string, column: string): never {
  throw new ConsoleApiError(
    502,
    "E_WEB_GOVERNANCE_ROW_INVALID",
    `A row in ${table}.${column} did not match the shape this console renders; the value is not reported. The read is refused rather than rendered from an unvalidated value.`,
  );
}

/** A required string column, bounded. Rejects non-strings and overlong values. */
function rowString(table: string, column: string, row: Record<string, unknown>, max: number): string {
  const value = row[column];
  if (typeof value !== "string" || value.length > max) rowInvalid(table, column);
  return value;
}

/** A nullable string column. `null`/absent becomes `null`, never `""`. */
function rowNullableString(
  table: string,
  column: string,
  row: Record<string, unknown>,
  max: number,
): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > max) rowInvalid(table, column);
  return value;
}

/**
 * A `bigint` count column as a JSON number.
 *
 * PostgREST serializes PostgreSQL `bigint` as a JSON number, so this arrives
 * already a number. Two defensiveness rules, both refusing rather than
 * rounding:
 *
 *  - a **decimal string** is accepted, because that is how several PostgREST
 *    configurations and the Supabase JS client render `bigint`, and coercing it
 *    loses nothing;
 *  - a value that is not a safe integer is refused. `bandwidth_bytes` past 2^53
 *    cannot be represented exactly in a JavaScript number, and rounding it
 *    would put a wrong byte count on an operator's screen.
 */
function rowCount(table: string, column: string, row: Record<string, unknown>): number {
  const value = row[column];
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
    rowInvalid(table, column);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) rowInvalid(table, column);
  return value;
}

/**
 * A `bigint identity` primary key as a decimal string.
 *
 * `audit_events.id` is `bigint generated always as identity`
 * (`202609090001_hosted_control_plane.sql:44`), and `JSON.stringify` throws on a
 * `BigInt`. It therefore has to cross the wire as a string, which is also what
 * `AuditRow.id: string` declares. A value that is already a number (PostgREST's
 * JSON rendering) is stringified; a decimal string passes through unchanged.
 */
function rowBigIntId(table: string, column: string, row: Record<string, unknown>): string {
  const value = row[column];
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  rowInvalid(table, column);
}

/* -------------------------------------------------------------------------- */
/* Quotas                                                                      */
/* -------------------------------------------------------------------------- */

function quotaPolicyRow(row: Record<string, unknown>): QuotaPolicyRow {
  return Object.freeze({
    workspace_id: rowString("quota_policies", "workspace_id", row, 36),
    requests_per_minute: rowCount("quota_policies", "requests_per_minute", row),
    concurrent_requests: rowCount("quota_policies", "concurrent_requests", row),
    bandwidth_bytes: rowCount("quota_policies", "bandwidth_bytes", row),
  });
}

function quotaUsageRow(row: Record<string, unknown>): QuotaUsageRow {
  return Object.freeze({
    workspace_id: rowString("quota_usage", "workspace_id", row, 36),
    window_started: rowString("quota_usage", "window_started", row, MAX_IDENTITY_LENGTH),
    request_count: rowCount("quota_usage", "request_count", row),
    bandwidth_bytes: rowCount("quota_usage", "bandwidth_bytes", row),
  });
}

/* -------------------------------------------------------------------------- */
/* Security denies                                                             */
/* -------------------------------------------------------------------------- */

function securityDenyRow(row: Record<string, unknown>): SecurityDenyRow {
  const kind = rowString("security_denies", "kind", row, MAX_OPERATION_LENGTH);
  // The schema `check`s this column; re-checking means a projection that ever
  // returned something else is refused rather than rendered as a deny of an
  // unknown kind, which would read as authoritative.
  if (!DENY_KINDS.includes(kind)) rowInvalid("security_denies", "kind");
  return Object.freeze({
    id: rowString("security_denies", "id", row, 36),
    kind: kind as SecurityDenyRow["kind"],
    identity: rowString("security_denies", "identity", row, MAX_IDENTITY_LENGTH),
    reason: rowString("security_denies", "reason", row, MAX_DENY_REASON_LENGTH),
    created_at: rowString("security_denies", "created_at", row, MAX_IDENTITY_LENGTH),
  });
}

/* -------------------------------------------------------------------------- */
/* Audit events                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Decode one `audit_events` row.
 *
 * ### `created_at` becomes `occurred_at`
 *
 * The column is `created_at` (`202609090001_hosted_control_plane.sql:53`); the
 * DTO field is `AuditRow.occurred_at`. The rename happens here so the wire shape
 * matches the declared contract and the page never has to know the column name.
 *
 * ### `result` is not narrowed to the declared union
 *
 * `AuditRow.result` is typed `"allowed" | "denied"`, but the column is plain
 * `text not null` with **no** `check` constraint — verified in every migration
 * in `supabase/migrations/`. A row carrying anything else is representable.
 *
 * Refusing the whole page because one row has an unrecognised `result` would
 * hide the rest of the audit log from the operator who needs it, and coercing it
 * to `denied` would invent a security judgement. So the value is validated as a
 * bounded non-empty string and passed through verbatim; the cast below is
 * documented, and `AuditPage.tsx` renders an unrecognised result as a neutral
 * badge rather than classifying it. Reporting this gap to the lead: the honest
 * fix is a `check (result in ('allowed','denied'))` on the column, or widening
 * `AuditRow.result` to `string`. Neither is in this builder's file set.
 */
function auditRow(table: string, row: Record<string, unknown>): AuditRow {
  const result = rowString(table, "result", row, MAX_RESULT_LENGTH);
  return Object.freeze({
    id: rowBigIntId(table, "id", row),
    actor_subject: rowString(table, "actor_subject", row, MAX_ACTOR_LENGTH),
    operation: rowString(table, "operation", row, MAX_OPERATION_LENGTH),
    target_identity: rowNullableString(table, "target_identity", row, MAX_IDENTITY_LENGTH),
    old_identity: rowNullableString(table, "old_identity", row, MAX_IDENTITY_LENGTH),
    new_identity: rowNullableString(table, "new_identity", row, MAX_IDENTITY_LENGTH),
    request_id: rowNullableString(table, "request_id", row, MAX_OPERATION_LENGTH),
    occurred_at: rowString(table, "created_at", row, MAX_IDENTITY_LENGTH),
    result: result as AuditRow["result"],
  });
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /workspace/quotas` — one workspace's policy row plus its usage windows.
 *
 * Two reads, both filtered by the caller's `workspace_id`, both bounded. The
 * policy read uses `limit: 1` because `quota_policies.workspace_id` is the
 * primary key (`202609090002_multi_user_authorization.sql:39`) — one row per
 * workspace is a schema guarantee, not a guess, so asking for two would be
 * asking the database to contradict its own constraint.
 *
 * A zero-row read is never turned into a zero. `policy` becomes `null` with
 * {@link NULL_POLICY_REASON} and `usage` becomes `[]` with
 * {@link EMPTY_USAGE_REASON}, and both reasons are non-`null` exactly when their
 * subject is absent.
 */
async function handleWorkspaceQuotas(
  context: ApiRouteContext,
  caller: CallerIdentity,
  reader: ControlPlaneReader,
): Promise<WorkspaceQuotaView> {
  assertBoundedQuery(context.query);
  const workspaceId = requireUuidParam(context.query, "workspace_id");
  const limit = readLimit(context.query);
  const offset = readOffset(context.query);
  const filters: readonly ControlPlaneFilter[] = Object.freeze([
    Object.freeze({ column: "workspace_id", values: Object.freeze([workspaceId]) }),
  ]);

  const [policyRows, usageRows] = await Promise.all([
    reader.readAsCaller(caller, "quota_policies", { filters, limit: 1, offset: 0 }),
    reader.readAsCaller(caller, "quota_usage", { filters, limit, offset }),
  ]);

  const policyRowsSafe = policyRows.filter(isRecord);
  if (policyRowsSafe.length > 1) {
    // Unreachable under the primary key. Refused rather than picking one, so a
    // future schema change cannot silently mislabel a workspace's policy.
    throw new ConsoleApiError(
      502,
      "E_WEB_GOVERNANCE_ROW_INVALID",
      "quota_policies returned more than one row for a workspace whose primary key is workspace_id. The read is refused rather than reporting an arbitrarily chosen policy.",
    );
  }
  const policy = policyRowsSafe[0] === undefined ? null : quotaPolicyRow(policyRowsSafe[0]);

  const usage = Object.freeze(usageRows.filter(isRecord).map(quotaUsageRow));

  return Object.freeze({
    workspace_id: workspaceId,
    policy,
    policy_unavailable_reason: policy === null ? NULL_POLICY_REASON : null,
    usage,
    usage_unavailable_reason: usage.length === 0 ? EMPTY_USAGE_REASON : null,
  });
}

/**
 * `GET /workspace/security/denies` — the recorded control-plane deny rows.
 *
 * Returns the flat array `SecurityDenyRow[]` declares. That DTO carries no
 * wrapper and therefore no reason field, which is why {@link EMPTY_DENY_REASON}
 * lives in `SecurityPage.tsx` instead: an empty array here is indistinguishable
 * from "no denies written" and from "RLS withheld every row", and the page is
 * the only place that can say so. The two are genuinely indistinguishable from
 * the server, which is the honest answer rather than a guess.
 */
async function handleSecurityDenies(
  context: ApiRouteContext,
  caller: CallerIdentity,
  reader: ControlPlaneReader,
): Promise<readonly SecurityDenyRow[]> {
  assertBoundedQuery(context.query);
  const workspaceId = optionalUuidParam(context.query, "workspace_id");
  const kind = readParam(context.query, "kind");
  if (kind !== null && !DENY_KINDS.includes(kind)) {
    throw new ConsoleApiError(
      400,
      "E_WEB_QUERY_INVALID",
      `kind must be one of ${DENY_KINDS.join(", ")}`,
    );
  }
  const filters: ControlPlaneFilter[] = [];
  if (workspaceId !== null) {
    filters.push(Object.freeze({ column: "workspace_id", values: Object.freeze([workspaceId]) }));
  }
  if (kind !== null) {
    filters.push(Object.freeze({ column: "kind", values: Object.freeze([kind]) }));
  }
  const rows = await reader.readAsCaller(caller, "security_denies", {
    filters: Object.freeze(filters),
    limit: readLimit(context.query),
    offset: readOffset(context.query),
  });
  return Object.freeze(rows.filter(isRecord).map(securityDenyRow));
}

/**
 * `GET /audit` — the control-plane audit log.
 *
 * Projects exactly the ten allow-listed `audit_events` columns and joins
 * nothing, so no credential can enter the response. `workspace_id`, `actor`,
 * `operation`, and `result` are forwarded as filters, which is
 * `CONTROL_PLANE_MAX_FILTERS` exactly.
 *
 * **No time-range filter and no `target_identity` filter exist**, because the
 * adapter's allow-list does not permit them: `audit_events` declares
 * `workspace_id`, `actor_subject`, `operation`, and `result` as filterable and
 * nothing else. Time-window and target filtering therefore happens
 * client-side in `AuditPage.tsx` over the rows this read returns, which is also
 * what the brief asks for. The limit and the bounds below are what keep that
 * honest — a filter over a truncated page would silently drop rows the operator
 * filtered for.
 *
 * `AuditRow` carries no workspace field, so this response is not workspace
 * labelled. A caller who may read several workspaces sees their audit events in
 * one list, which is the DTO's declared shape rather than a merge this module
 * invented.
 */
async function handleAuditEvents(
  context: ApiRouteContext,
  caller: CallerIdentity,
  reader: ControlPlaneReader,
): Promise<readonly AuditRow[]> {
  assertBoundedQuery(context.query);
  const filters: ControlPlaneFilter[] = [];
  const workspaceId = optionalUuidParam(context.query, "workspace_id");
  if (workspaceId !== null) {
    filters.push(Object.freeze({ column: "workspace_id", values: Object.freeze([workspaceId]) }));
  }
  const actor = readParam(context.query, "actor");
  if (actor !== null) {
    filters.push(Object.freeze({ column: "actor_subject", values: Object.freeze([actor]) }));
  }
  const operation = readParam(context.query, "operation");
  if (operation !== null) {
    filters.push(Object.freeze({ column: "operation", values: Object.freeze([operation]) }));
  }
  const result = readParam(context.query, "result");
  if (result !== null) {
    filters.push(Object.freeze({ column: "result", values: Object.freeze([result]) }));
  }
  const rows = await reader.readAsCaller(caller, "audit_events", {
    filters: Object.freeze(filters),
    limit: readLimit(context.query),
    offset: readOffset(context.query),
  });
  return Object.freeze(rows.filter(isRecord).map((row) => auditRow("audit_events", row)));
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/** Injection seam, so a test can drive these routes without a live Supabase. */
export interface GovernanceRoutesOptions {
  readonly bounds?: RequestBounds | undefined;
  readonly reader?: ControlPlaneReader | undefined;
}

/**
 * Build the three governance routes.
 *
 * Both optional parameters are threaded to `controlPlaneRoute`, which means the
 * same three routes are reachable in production and in a test without a second
 * code path that could drift.
 *
 * Registration order does not matter here: no path is a `:parameter` route, so
 * there is no literal-versus-pattern shadowing to get wrong.
 */
export function createGovernanceRoutes(options: GovernanceRoutesOptions = {}): ApiRoute[] {
  const bounds = options.bounds ?? loadRequestBounds();
  // `controlPlaneRoute`'s `reader` parameter has a default of
  // `defaultControlPlaneReader()`, and a default parameter is taken whenever the
  // argument is `undefined`. Passing the possibly-`undefined` option straight
  // through therefore injects the test reader when there is one and the real one
  // otherwise — no branch here, and therefore no second path that could skip the
  // caller-forwarding seam.
  const reader = options.reader;

  return [
    controlPlaneRoute("workspace-quotas", "/workspace/quotas", handleWorkspaceQuotas, bounds, reader),
    controlPlaneRoute(
      "security-denies",
      "/workspace/security/denies",
      handleSecurityDenies,
      bounds,
      reader,
    ),
    controlPlaneRoute("audit-events", "/audit", handleAuditEvents, bounds, reader),
  ];
}

/**
 * The lead's additive registration: one spread into the route table.
 *
 * `defaultControlPlaneReader()` is evaluated here, at module scope, and reads
 * `EGA_SUPABASE_URL` through `ServerConfig`. An unconfigured value does **not**
 * throw — `parseServerConfig` treats blank and absent alike — so importing this
 * module in a process with no Supabase configured is safe and every read
 * refuses with a 503 naming the variable.
 */
export const governanceRoutes: ApiRoute[] = createGovernanceRoutes();

/**
 * Route ids in registration order, for the lead's wiring assertion.
 *
 * Duplicating these three ids in a test is how a rename would slip through, so
 * the table is exported instead.
 */
export const GOVERNANCE_ROUTE_IDS: readonly string[] = Object.freeze(
  governanceRoutes.map((route) => route.id),
);

/** Route paths in registration order. */
export const GOVERNANCE_ROUTE_PATHS: readonly string[] = Object.freeze(
  governanceRoutes.map((route) => route.path),
);