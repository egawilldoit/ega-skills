/**
 * Builder A's control-plane routes: `/workspace` and `/workspace/members`.
 *
 * ## What these two routes are
 *
 * The only read-only answers to "which workspace am I in, who owns it, and who
 * else is in it". They read three of the sixteen RLS-governed tables —
 * `personal_workspaces`, `workspace_memberships`, and (for nothing, see below)
 * nothing else — and they read them through Builder S's adapter with the
 * **caller's own token** so PostgreSQL evaluates the real caller.
 *
 * ## The two rules this module is shaped by
 *
 * ### 1. RLS is the only authority, and it filters silently
 *
 * `membership_self_or_admin_read` (`supabase/migrations/202609090004_contract_f_rls.sql:243`)
 * admits a row when `subject = auth.jwt() ->> 'sub'` **or**
 * `private.has_workspace_role(workspace_id, array['owner','admin'])`, and
 * `has_workspace_role` additionally requires `active`. So:
 *
 * - an `owner` or an **active** `admin` sees every membership row in the workspace;
 * - every other subject — including an *inactive* admin — sees exactly one row:
 *   its own. An inactive admin still satisfies the `subject = sub` branch, which
 *   carries no `active` condition.
 *
 * That is the correct, policy-faithful answer for four of the five roles. This
 * module therefore **never filters by `subject` on the members route**: adding
 * that filter would hide rows from an owner, and removing it would reveal rows
 * from a non-admin. The only filters sent are `workspace_id` (a row selector,
 * never a capability) and the caller's own subject on the `/workspace` route,
 * where the caller's own row is genuinely the only input needed.
 *
 * `handleWorkspaceMembers` reads **unfiltered by subject** and returns whatever
 * RLS returned. The page renders a short row when one row comes back, with the
 * reason, rather than an empty table.
 *
 * ### 2. A column that cannot be read is never filled in
 *
 * `personal_workspace_owner_read` (`202609090004_contract_f_rls.sql:218`) is
 * `owner_subject = auth.jwt() ->> 'sub'`. The workspace record — its
 * `owner_subject` and its `created_at` — is therefore readable **only by the
 * owner**. `WorkspaceSummary` declares both as required, non-nullable, so the
 * DTO is satisfiable for exactly one role. For every other role this module
 * answers **403** with the policy named, instead of:
 *
 * - substituting the caller's own subject for the owner's, which would assert a
 *   false owner;
 * - substituting `workspace_memberships.created_at` for the workspace's
 *   `created_at`, which would attribute one column's value to another; or
 * - answering 200 with an empty list, which would read as "this workspace has no
 *   owner", a false statement about a workspace that exists.
 *
 * See the module's exported report notes; `WORKSPACE_RECORD_NOT_READABLE` is the
 * code the page turns into the stated reason.
 *
 * ## `hubs` is deliberately not read
 *
 * The brief asks for Hub visibility on `/workspace`. `WorkspaceSummary` has no
 * field for it and `apps/web/src/api/contracts.ts` is Builder S's file, so this
 * module does not invent a field, and it does not read `hubs` for a value it
 * cannot place. Reading a table only to discard its result would also cost a
 * round trip on every load. The gap is reported rather than worked around.
 *
 * ## Bounded, GET-only, sanitized, mutation-free
 *
 * Every read passes an explicit `limit` and never a `subject` filter except the
 * caller-identity read. The two workspace-scope reads use the adapter's own
 * ceiling. A caller-supplied `limit` outside the adapter's range is **refused**,
 * never clamped, and an unknown query parameter is refused so a typo cannot be
 * mistaken for a capability. Every message that can reach the wire is assembled
 * from constants plus a canonical uuid, and passes through `sanitizeMessage`.
 *
 * There are no mutation controls and no write path: `authenticated` holds
 * `SELECT` only on all sixteen tables
 * (`202609090004_contract_f_rls.sql:289-306`) and every route here is
 * `methods: ["GET"]`, so a write is impossible by privilege *and* by design.
 */

import {
  ConsoleApiError,
  controlPlaneRoute,
  loadRequestBounds,
  sanitizeMessage,
  type ControlPlaneHandler,
} from "./api.ts";
import {
  CONTROL_PLANE_MAX_LIMIT,
  assertTableAllowed,
  defaultControlPlaneReader,
  type CallerIdentity,
  type ControlPlaneReader,
} from "./supabase-read.ts";

import type { ApiRoute, ApiRouteContext } from "../server.mts";
import type { MemberRow, WorkspaceSummary } from "../src/api/contracts.ts";
import type { WorkspaceRole } from "../src/console-model.ts";

/* -------------------------------------------------------------------------- */
/* Registration-time assertions                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Assert the three tables this module reads at module load.
 *
 * A typo becomes a startup refusal rather than a 400 a user discovers, which is
 * what `assertTableAllowed` is exported for. `hubs` is deliberately absent: see
 * the module comment.
 */
assertTableAllowed("personal_workspaces");
assertTableAllowed("workspace_memberships");

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The five roles, exactly as the `workspace_memberships` `check` constraint
 * allows (`202609090002_multi_user_authorization.sql:4`).
 *
 * Declared locally rather than imported: `apps/web/src/console-model.ts` owns the
 * same list for the SPA, but `apps/web/server` may only **type**-import from
 * `apps/web/src` (asserted by `tests/web/project-boundary.test.mjs`), so a value
 * import is not available. The duplication is deliberate and is the only way to
 * keep the server free of a runtime dependency on the SPA tree.
 */
const WORKSPACE_ROLES: readonly WorkspaceRole[] = Object.freeze([
  "owner",
  "admin",
  "maintainer",
  "member",
  "viewer",
] as const);

/** Presentation order for the member list. Ordering is never visibility. */
const ROLE_ORDER: Readonly<Record<WorkspaceRole, number>> = Object.freeze({
  owner: 0,
  admin: 1,
  maintainer: 2,
  member: 3,
  viewer: 4,
});

/**
 * Largest page `/workspace/members` will serve.
 *
 * The adapter's own ceiling, so the route can never ask for a page the adapter
 * would refuse. The response is **one bounded page** and the page says so; this
 * route never claims the roster is complete.
 */
export const MEMBERS_PAGE_LIMIT = CONTROL_PLANE_MAX_LIMIT;

/** Largest accepted `Authorization`-shaped subject, matching the adapter. */
const MAX_SUBJECT_LENGTH = 256;

/** Canonical lowercase uuid, identical to the adapter's `uuid` filter kind. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Bounded subject shape, identical to the adapter's `short-text` filter kind.
 *
 * No whitespace, slash, backslash, quote, or any other character that could make
 * a subject read as a path, a URL, or a filter fragment. A row whose subject does
 * not match is **refused**, not rendered: rule 6 forbids a path or credential in
 * any rendered value, and a shape check is how that is structural rather than
 * aspirational.
 */
const SUBJECT = /^[A-Za-z0-9._:@+-]{1,256}$/;

/** Query parameters these routes understand. Anything else is refused. */
const WORKSPACE_PARAMS: readonly string[] = Object.freeze(["workspace", "limit"]);
const MEMBERS_PARAMS: readonly string[] = Object.freeze(["workspace", "limit"]);

/* -------------------------------------------------------------------------- */
/* Error codes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The caller can see no workspace at all: their own membership read returned no
 * rows and they own no `personal_workspaces` row. **Not** "this workspace has no
 * members" and **not** an empty list.
 */
export const WORKSPACE_NOT_VISIBLE_CODE = "E_WEB_WORKSPACE_NOT_VISIBLE";

/** The caller can see more than one workspace and named none to disambiguate. */
export const WORKSPACE_AMBIGUOUS_CODE = "E_WEB_WORKSPACE_AMBIGUOUS";

/**
 * A workspace is visible but its `personal_workspaces` row is not, so
 * `owner_subject` and `created_at` cannot be read. Answers 403.
 */
export const WORKSPACE_RECORD_NOT_READABLE_CODE = "E_WEB_WORKSPACE_RECORD_NOT_READABLE";

/**
 * The workspace is visible but the caller has no `workspace_memberships` row in
 * it, so no role can be read for them. A role is never inferred from ownership.
 * Answers 403.
 */
export const WORKSPACE_MEMBERSHIP_NOT_READABLE_CODE = "E_WEB_WORKSPACE_MEMBERSHIP_NOT_READABLE";

/** An upstream row did not match the shape the schema declares. Answers 502. */
export const WORKSPACE_ROW_INVALID_CODE = "E_WEB_WORKSPACE_ROW_INVALID";

/** A query parameter was absent-but-required, malformed, or not allow-listed. */
export const WORKSPACE_QUERY_INVALID_CODE = "E_WEB_WORKSPACE_QUERY_INVALID";

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

function notVisible(workspaceId: string | null): ConsoleApiError {
  const suffix =
    workspaceId === null
      ? ""
      : ` Workspace ${sanitizeMessage(workspaceId)} is not one of the workspaces this session can read.`;
  return new ConsoleApiError(
    404,
    WORKSPACE_NOT_VISIBLE_CODE,
    `No workspace is visible to this session.${suffix} This is not an empty workspace: the membership read scoped to your own subject returned no rows, and no workspace is owned by your subject.`,
  );
}

function ambiguous(count: number): ConsoleApiError {
  return new ConsoleApiError(
    400,
    WORKSPACE_AMBIGUOUS_CODE,
    `This session can read ${count} workspaces, so the one to describe is ambiguous. Pass workspace=<uuid> to select one. The console has no workspace selector wired, so it will not pick for you.`,
  );
}

function recordNotReadable(workspaceId: string): ConsoleApiError {
  return new ConsoleApiError(
    403,
    WORKSPACE_RECORD_NOT_READABLE_CODE,
    `The workspace record for workspace ${sanitizeMessage(workspaceId)} is not readable by this session: policy personal_workspace_owner_read admits only the row whose owner_subject is your own subject, so its owner subject and creation timestamp are available to the workspace owner alone. Neither value is substituted here. Your own membership row is readable and is served by /workspace/members.`,
  );
}

function membershipNotReadable(workspaceId: string): ConsoleApiError {
  return new ConsoleApiError(
    403,
    WORKSPACE_MEMBERSHIP_NOT_READABLE_CODE,
    `No workspace_memberships row exists for your subject in workspace ${sanitizeMessage(workspaceId)}, so no role can be read for you. A role is only ever read from your own membership row and is never inferred from ownership or from any other row.`,
  );
}

function rowInvalid(detail: string): ConsoleApiError {
  return new ConsoleApiError(
    502,
    WORKSPACE_ROW_INVALID_CODE,
    `A control-plane row did not match the shape the schema declares, so it is not rendered: ${sanitizeMessage(detail)}`,
  );
}

function queryInvalid(detail: string): ConsoleApiError {
  return new ConsoleApiError(400, WORKSPACE_QUERY_INVALID_CODE, sanitizeMessage(detail));
}

/* -------------------------------------------------------------------------- */
/* Row validation                                                              */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readUuidField(row: Record<string, unknown>, key: string, table: string): string {
  const value = row[key];
  if (typeof value !== "string" || !UUID.test(value)) {
    throw rowInvalid(`${table}.${key} did not arrive as a canonical uuid`);
  }
  return value;
}

function readSubjectField(row: Record<string, unknown>, key: string, table: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SUBJECT_LENGTH) {
    throw rowInvalid(`${table}.${key} did not arrive as a bounded subject identifier`);
  }
  if (!SUBJECT.test(value)) {
    throw rowInvalid(
      `${table}.${key} did not arrive as a subject with no whitespace, path, or filter characters`,
    );
  }
  return value;
}

function readRoleField(row: Record<string, unknown>, table: string): WorkspaceRole {
  const value = row["role"];
  if (typeof value !== "string" || !WORKSPACE_ROLES.includes(value as WorkspaceRole)) {
    throw rowInvalid(
      `${table}.role did not arrive as one of the five workspace roles the schema check constraint allows`,
    );
  }
  return value as WorkspaceRole;
}

function readBooleanField(row: Record<string, unknown>, key: string, table: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw rowInvalid(`${table}.${key} did not arrive as a boolean`);
  }
  return value;
}

/**
 * A `timestamptz` as text.
 *
 * Both a parse check and the bounded-shape check. PostgreSQL renders
 * `timestamptz` in ISO-8601, which `Date.parse` accepts, so requiring a parseable
 * timestamp is a real check rather than a formality — and it is also what keeps
 * an arbitrary string (a path, say) out of a rendered value.
 */
function readTimestampField(row: Record<string, unknown>, key: string, table: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw rowInvalid(`${table}.${key} did not arrive as a bounded timestamp string`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw rowInvalid(`${table}.${key} did not arrive as a parseable timestamp`);
  }
  return value;
}

/** One validated `workspace_memberships` row. */
interface MembershipRowView {
  readonly workspace_id: string;
  readonly subject: string;
  readonly role: WorkspaceRole;
  readonly active: boolean;
  readonly created_at: string;
}

/** One validated `personal_workspaces` row. */
interface WorkspaceRowView {
  readonly id: string;
  readonly owner_subject: string;
  readonly created_at: string;
}

function toMembershipRow(raw: Readonly<Record<string, unknown>>): MembershipRowView {
  if (!isRecord(raw)) throw rowInvalid("workspace_memberships returned a non-object row");
  return Object.freeze({
    workspace_id: readUuidField(raw, "workspace_id", "workspace_memberships"),
    subject: readSubjectField(raw, "subject", "workspace_memberships"),
    role: readRoleField(raw, "workspace_memberships"),
    active: readBooleanField(raw, "active", "workspace_memberships"),
    created_at: readTimestampField(raw, "created_at", "workspace_memberships"),
  });
}

function toWorkspaceRow(raw: Readonly<Record<string, unknown>>): WorkspaceRowView {
  if (!isRecord(raw)) throw rowInvalid("personal_workspaces returned a non-object row");
  return Object.freeze({
    id: readUuidField(raw, "id", "personal_workspaces"),
    owner_subject: readSubjectField(raw, "owner_subject", "personal_workspaces"),
    created_at: readTimestampField(raw, "created_at", "personal_workspaces"),
  });
}

/* -------------------------------------------------------------------------- */
/* Query parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Reject any parameter this route does not understand.
 *
 * Fail-closed on purpose. The alternative — ignore an unknown parameter — means
 * `?lmit=1000` or `?owner=true` is silently dropped and the operator believes a
 * bound or a filter was applied. Both this and the `workspace` value are row
 * *selectors*; neither is authority, and neither is honoured by anything but
 * RLS.
 */
function assertKnownParams(context: ApiRouteContext, allowed: readonly string[]): void {
  for (const name of context.query.keys()) {
    if (!allowed.includes(name)) {
      throw queryInvalid(
        `${name} is not a parameter of this read. This route understands ${allowed.join(", ")}. An unrecognised parameter is refused rather than ignored, so a typo cannot be mistaken for a filter.`,
      );
    }
  }
}

/** A present, non-blank parameter value, or `null` when absent or blank. */
function readParam(context: ApiRouteContext, name: string): string | null {
  if (!context.query.has(name)) return null;
  const raw = context.query.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The caller's `workspace` selector, validated as a canonical uuid before any
 * read happens.
 *
 * Validated here as well as in the adapter so a malformed selector is refused
 * with a request-scoped 400 and **no request reaches the transport**. The value
 * is then checked against the caller's own visible set, which is what makes it a
 * filter rather than a capability: an id for another workspace is simply not in
 * the set, and RLS would return nothing for it anyway.
 */
function readWorkspaceSelector(context: ApiRouteContext): string | null {
  const raw = readParam(context, "workspace");
  if (raw === null) return null;
  if (raw.length > 36) {
    throw queryInvalid("workspace must be a canonical lowercase uuid and is not reported back");
  }
  if (!UUID.test(raw)) {
    throw queryInvalid("workspace must be a canonical lowercase uuid");
  }
  return raw;
}

/**
 * An explicit page size, or {@link MEMBERS_PAGE_LIMIT}.
 *
 * A caller asking for more than the adapter can serve is **refused**, not
 * clamped: clamping would return a short array that a page would render as a
 * complete roster. A non-integer is a 400 rather than a silent default, for the
 * same reason `apps/web/server/api.ts` treats `limit=abc` that way.
 */
function readLimit(context: ApiRouteContext, defaultLimit: number): number {
  const raw = readParam(context, "limit");
  if (raw === null) return defaultLimit;
  if (!/^\d+$/.test(raw)) {
    throw queryInvalid("limit must be a base-ten positive integer; it is not coerced to a default");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > CONTROL_PLANE_MAX_LIMIT) {
    throw queryInvalid(
      `limit must be an integer between 1 and ${CONTROL_PLANE_MAX_LIMIT}; an oversized page is refused rather than truncated`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Caller-visible workspace scope                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything this session can reach, derived from RLS-filtered reads only.
 *
 * `owned` comes from an **unfiltered** `personal_workspaces` read. That is not a
 * widening: `personal_workspace_owner_read` admits exactly the rows whose
 * `owner_subject` is the caller's subject, and `owner_subject` is `not null
 * unique` (`202609090001_hosted_control_plane.sql:6`), so this read returns the
 * caller's own workspace or nothing. Filtering it by the membership workspaces
 * instead would *lose* a workspace the caller owns but has no membership row in,
 * which is a schema-permitted state.
 */
export interface CallerWorkspaceScope {
  /** The caller's own `workspace_memberships` rows, validated. */
  readonly ownMemberships: readonly MembershipRowView[];
  /** `personal_workspaces` rows this session may read, validated. */
  readonly owned: readonly WorkspaceRowView[];
  /** Union of the two id sets, deduplicated and sorted. */
  readonly visibleWorkspaceIds: readonly string[];
}

async function resolveCallerWorkspaceScope(
  caller: CallerIdentity,
  reader: ControlPlaneReader,
): Promise<CallerWorkspaceScope> {
  // The caller's own rows. The `subject` filter here is the caller's own
  // identity, used to find which workspaces they belong to — it is the one read
  // where narrowing by subject is the point, because the console must never
  // guess which of several memberships the operator meant.
  const ownRaw = await reader.readAsCaller<Readonly<Record<string, unknown>>>(
    caller,
    "workspace_memberships",
    {
      columns: ["workspace_id", "subject", "role", "active", "created_at"],
      filters: [{ column: "subject", values: [caller.subject] }],
      limit: CONTROL_PLANE_MAX_LIMIT,
    },
  );
  const ownMemberships = ownRaw.map(toMembershipRow);

  const ownedRaw = await reader.readAsCaller<Readonly<Record<string, unknown>>>(
    caller,
    "personal_workspaces",
    {
      columns: ["id", "owner_subject", "created_at"],
      limit: CONTROL_PLANE_MAX_LIMIT,
    },
  );
  const owned = ownedRaw.map(toWorkspaceRow);

  const ids = new Set<string>();
  for (const row of ownMemberships) ids.add(row.workspace_id);
  for (const row of owned) ids.add(row.id);

  return Object.freeze({
    ownMemberships: Object.freeze(ownMemberships),
    owned: Object.freeze(owned),
    visibleWorkspaceIds: Object.freeze([...ids].sort()),
  });
}

/**
 * Choose the one workspace these routes describe.
 *
 * Refuses rather than guesses: no visible workspace is a 404 that says so, more
 * than one without a selector is a 400 that asks for one, and a selector outside
 * the caller's visible set is the same 404 as no selector at all — so the status
 * never confirms that some *other* workspace exists.
 */
function selectWorkspaceId(
  context: ApiRouteContext,
  scope: CallerWorkspaceScope,
  selector: string | null,
): string {
  if (selector !== null) {
    if (!scope.visibleWorkspaceIds.includes(selector)) throw notVisible(selector);
    return selector;
  }
  const first = scope.visibleWorkspaceIds[0];
  if (scope.visibleWorkspaceIds.length === 0) throw notVisible(null);
  if (scope.visibleWorkspaceIds.length > 1) throw ambiguous(scope.visibleWorkspaceIds.length);
  // `noUncheckedIndexedAccess` makes this an explicit narrowing rather than a
  // silent `string | undefined` that could reach a filter.
  if (first === undefined) throw notVisible(null);
  return first;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/workspace` → `WorkspaceSummary`.
 *
 * Served 200 for exactly one role — the workspace owner — because
 * `WorkspaceSummary.owner_subject` and `WorkspaceSummary.created_at` come from
 * `personal_workspaces`, which `personal_workspace_owner_read` admits only to the
 * owner. Every other role gets a typed 403 or 404 naming the reason, never a
 * substituted value.
 */
const handleWorkspaceOverview: ControlPlaneHandler = async (context, caller, reader) => {
  assertKnownParams(context, WORKSPACE_PARAMS);
  // Parsed before the scope read so a malformed selector is refused without
  // asking the database anything at all. Its *membership* in the visible set is
  // still checked afterwards, because only the read can establish that.
  const selector = readWorkspaceSelector(context);
  const scope = await resolveCallerWorkspaceScope(caller, reader);
  const workspaceId = selectWorkspaceId(context, scope, selector);

  const ownRow =
    scope.ownMemberships.find((row) => row.workspace_id === workspaceId) ?? null;
  if (ownRow === null) throw membershipNotReadable(workspaceId);

  const ownedRow = scope.owned.find((row) => row.id === workspaceId) ?? null;
  if (ownedRow === null) throw recordNotReadable(workspaceId);

  const summary: WorkspaceSummary = Object.freeze({
    workspace_id: workspaceId,
    owner_subject: ownedRow.owner_subject,
    created_at: ownedRow.created_at,
    viewer_role: ownRow.role,
  });
  return summary;
};

/**
 * `GET /api/workspace/members` → `readonly MemberRow[]`.
 *
 * The single filter sent is `workspace_id = eq.<selected>`. There is deliberately
 * **no `subject` filter**: an owner must see the roster and a non-admin must see
 * only themselves, and only RLS can decide which of those this session is. The
 * route returns exactly what RLS returned — one row for a non-admin — and the
 * page renders that as a scoped view with the reason, never as a broken table.
 */
const handleWorkspaceMembers: ControlPlaneHandler = async (context, caller, reader) => {
  assertKnownParams(context, MEMBERS_PARAMS);
  // Both parameters are validated before any read: a request the route will
  // refuse anyway must not cost a round trip, and must not reach the database
  // with a value the route has not accepted.
  const limit = readLimit(context, MEMBERS_PAGE_LIMIT);
  const selector = readWorkspaceSelector(context);
  const scope = await resolveCallerWorkspaceScope(caller, reader);
  const workspaceId = selectWorkspaceId(context, scope, selector);

  const raw = await reader.readAsCaller<Readonly<Record<string, unknown>>>(
    caller,
    "workspace_memberships",
    {
      columns: ["workspace_id", "subject", "role", "active", "created_at"],
      filters: [{ column: "workspace_id", values: [workspaceId] }],
      limit,
    },
  );

  const rows: MemberRow[] = raw.map((row) => {
    const view = toMembershipRow(row);
    // The filter asked for one workspace; a row from another one would mean the
    // response is not what was requested, so it is refused rather than rendered.
    if (view.workspace_id !== workspaceId) {
      throw rowInvalid("a membership row arrived for a workspace other than the one requested");
    }
    return Object.freeze({
      subject: view.subject,
      role: view.role,
      active: view.active,
      created_at: view.created_at,
    });
  });

  // Presentation order only: strongest role first, then subject. Sorting is
  // never a widening or a narrowing — the row set above is already exactly what
  // RLS returned.
  rows.sort((left, right) => {
    const byRole = (ROLE_ORDER[left.role] ?? ROLE_ORDER.viewer) - (ROLE_ORDER[right.role] ?? ROLE_ORDER.viewer);
    return byRole !== 0 ? byRole : left.subject.localeCompare(right.subject);
  });

  return Object.freeze(rows);
};

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The two Builder A routes, built against an explicit bounds and reader.
 *
 * `bounds` and `reader` are parameters so a test can supply a fixture transport
 * through `createControlPlaneReader`, which is the only supported way to drive
 * this module without a live database.
 */
export function buildWorkspaceRoutes(
  bounds = loadRequestBounds(),
  reader: ControlPlaneReader = defaultControlPlaneReader(),
): ApiRoute[] {
  return [
    controlPlaneRoute("workspace", "/workspace", handleWorkspaceOverview, bounds, reader),
    controlPlaneRoute("workspace-members", "/workspace/members", handleWorkspaceMembers, bounds, reader),
  ];
}

/**
 * Route paths this module exports, matching `API_ENDPOINTS` in
 * `apps/web/src/api/client.ts`.
 *
 * `/workspace` is a literal and must be matched before
 * `/workspace/members` only in the sense that the router prefers exact literals
 * over patterns; neither path is a pattern here, so the two cannot collide.
 */
export const WORKSPACE_ROUTE_PATHS: readonly string[] = Object.freeze([
  "/workspace",
  "/workspace/members",
]);

/**
 * The additive registration the lead wires into `apps/web/server/api.ts`.
 *
 * Both entries are `GET`-only and built through `controlPlaneRoute`, so both go
 * through `createControlPlaneHandler` and a caller is resolved before either
 * handler runs. `EGA_SUPABASE_URL` comes from `ServerConfig` through
 * `defaultControlPlaneReader`; no privileged credential is referenced anywhere in
 * this module.
 */
/**
 * Do NOT add a pre-built `WORKSPACE_ROUTES` array here.
 *
 * Building one at module scope calls `loadRequestBounds` from `./api.ts`, and
 * `api.ts` imports this module. Whichever is imported first, the other side sees
 * an uninitialized binding and the process dies before it can listen:
 *   ReferenceError: Cannot access 'API_MAX_RESPONSE_BYTES_DEFAULT' before initialization
 * Typecheck cannot see that TDZ hazard; only starting the server does. Call
 * `buildWorkspaceRoutes()` instead, from a context where `./api.ts` has finished
 * evaluating.
 */