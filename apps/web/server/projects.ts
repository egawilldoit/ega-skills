/**
 * Console read routes for `/projects` and `/projects/:projectId`.
 *
 * ## The question this page exists to answer
 *
 * **"Which exact release is this context pinned to?"**
 *
 * The answer is the `release_digest` stored on the `project_contexts` row, and
 * this module treats that value as load-bearing in a way the rest of the console
 * does not:
 *
 * 1. It is **never substituted**. Nothing in this file reads `hub_stable_pointers`
 *    and nothing resolves "the current release" in order to stand in for a pin.
 *    A context pins an exact digest at publish time; that pin is what the runtime
 *    resolves against, and it routinely differs from whatever this deployment
 *    happens to serve today. The served digest *is* reported — once, on its own
 *    field, explicitly labelled — so an operator can see the two side by side
 *    without either being mistaken for the other.
 * 2. It is **reported as stored, or not at all**. `toContextRow` refuses the
 *    whole response if a `release_digest` is not canonical
 *    `sha256:<64 lowercase hex>`. A garbled pin is not shown as a pin, because a
 *    pin that cannot be compared against anything is worse than an explicit
 *    refusal.
 * 3. It is **resolved against reality, not against the pin**. For each context
 *    the module asks `releases.ts` whether this deployment has verified a release
 *    with that digest, and reports one of three answers — `resolvable`,
 *    `not-resolvable`, or `unknown`. `unknown` is a first-class outcome: a
 *    deployment with no verified artifact cannot say either way, and saying
 *    "not resolvable" there would be a false statement about a workspace.
 *
 * ## Revoked contexts
 *
 * `private.can_read_context` (supabase/migrations/202609090004_contract_f_rls.sql:153)
 * requires `revoked_at IS NULL` **and** no `context_revocations` row **and** an
 * active workspace membership. A revoked context therefore fails the read for
 * *everyone*, including its own workspace's owner, and this console cannot list
 * it, name it, or quote its pin.
 *
 * That is a policy fact, not a data outage, so the page must say so explicitly
 * instead of rendering an empty table that an operator would read as "this project
 * has no contexts". {@link CONTEXT_POLICY_NOTE} is that sentence, and it travels
 * with every response so the page cannot drift from the policy it describes.
 *
 * The module still reads `context_revocations`, keyed on the context ids it could
 * actually read. Two independent RLS policies make that read structurally empty
 * today: `can_read_context` already excludes any context that *has* a revocation
 * row, and `can_manage_context_revocations` limits revocation rows to workspace
 * owners and admins. The read is performed anyway rather than assumed empty —
 * it is the only source of a revocation reason, it is cheap, and a policy change
 * that made it non-empty must not require a code change to be visible. When it
 * does return a row, it is merged onto the matching context so
 * `revoked_at` / `revocation_reason` / `revoked_by` are answered from the
 * revocation record rather than from the context row alone.
 *
 * ## Digests that are deliberately absent
 *
 * `config_digest`, `lock_digest`, and `fingerprint_digest` exist only inside the
 * `ega.project-context` envelope, which is **never persisted**: the table stores
 * `context_digest` and `release_digest` and nothing else. This module reads
 * exactly the four `projects` columns, the six `project_contexts` columns, and
 * the four `context_revocations` columns that the console allow-list names, so
 * there is no code path by which those three names could reach a response. They
 * are not rendered, not summarised, and not inferred.
 *
 * ## The caller's token is the only credential
 *
 * Every table read goes through {@link ControlPlaneReader.readAsCaller}, which
 * forwards the caller's own access token and lets PostgreSQL row-level security
 * evaluate the real caller. This module holds no credential of any kind, reads no
 * environment variable of its own, and adds no authorization of its own: whatever
 * RLS returns is what the page shows, including zero rows. Ids arrive as *filters*
 * (CONTRACT-F §1) — a caller-supplied `projectId` selects rows and confers
 * nothing.
 *
 * A `projectId` that matches nothing is answered **404**, which is also what a
 * project id that does not exist returns. RLS filters silently, so those two cases
 * are indistinguishable; answering them differently would disclose resource
 * existence, which CONTRACT-D §6 forbids.
 *
 * ## Nothing unreadable is rendered as zero
 *
 * `projects` and `project_contexts` have **no writer anywhere in this
 * repository**, so an empty table is the normal state of every real deployment
 * and says nothing about whether a workspace has projects. Consequently:
 *
 * - a failed read is a typed 4xx/5xx the page renders as an explicit state, never
 *   as an empty list;
 * - an empty list carries a `*_unavailable_reason` sentence from this module, so
 *   the page cannot substitute its own wording;
 * - `active_context_count` is a *measured* count over a read that succeeded. It is
 *   computed from context rows fetched for exactly the projects on the page, in
 *   bounded chunks, and a read that reaches its ceiling refuses the response rather
 *   than reporting a floor as an exact count.
 */

import {
  CONTROL_PLANE_MAX_FILTER_VALUES,
  CONTROL_PLANE_MAX_LIMIT,
  assertTableAllowed,
  defaultControlPlaneReader,
  type CallerIdentity,
  type ControlPlaneFilter,
  type ControlPlaneReader,
  type ControlPlaneRequest,
} from "./supabase-read.ts";
import {
  API_MAX_QUERY_PARAMS,
  controlPlaneRoute,
  loadRequestBounds,
  sanitizeMessage,
  type RequestBounds,
} from "./api.ts";
import { getReleases } from "./releases.ts";
import { loadServerConfig } from "./env.ts";

import type {
  ProjectContextSummary,
  ProjectDetail,
  ProjectSummary,
} from "../src/api/contracts.ts";
import type { ApiRoute, ApiRouteContext } from "../server.mts";

/* -------------------------------------------------------------------------- */
/* Tables and bounds                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The three tables this role owns, asserted at module load.
 *
 * {@link assertTableAllowed} exists precisely so a route module can check its
 * table once at registration instead of discovering a typo as a 400 a user
 * eventually hits. The projections below are then subsets of the allow-list, so
 * the allow-list and the DTO cannot drift apart without a type error.
 */
assertTableAllowed("projects");
assertTableAllowed("project_contexts");
assertTableAllowed("context_revocations");

/** Every `projects` column. The table has four, and all four are displayed. */
const PROJECT_COLUMNS = ["id", "workspace_id", "name", "created_at"] as const;

/** Every `project_contexts` column. `release_digest` is the pin; see the header. */
const CONTEXT_COLUMNS = [
  "id",
  "project_id",
  "context_digest",
  "release_digest",
  "revoked_at",
  "published_at",
] as const;

/** Every `context_revocations` column. */
const REVOCATION_COLUMNS = ["context_id", "reason", "revoked_by", "revoked_at"] as const;

/** Projects returned by `/projects` when the caller asks for no page size. */
export const PROJECTS_PAGE_DEFAULT_LIMIT = 50;

/**
 * Largest page `/projects` will serve.
 *
 * Capped at the adapter's own {@link CONTROL_PLANE_MAX_LIMIT} rather than at a
 * number invented here, so a caller cannot ask this route for more rows than a
 * single control-plane read is willing to return. An oversized `limit` is a 400,
 * never a truncated page.
 */
export const PROJECTS_PAGE_MAX_LIMIT = CONTROL_PLANE_MAX_LIMIT;

/**
 * Ceiling for a single `project_contexts` read on the detail route.
 *
 * Equal to the adapter maximum. Reaching it means the project has more readable
 * contexts than one bounded read returns, at which point the count of *active*
 * contexts would be a floor rather than a measurement — so the route refuses
 * instead. See {@link ProjectReadError} and {@link readComplete}.
 */
const CONTEXT_PAGE_LIMIT = CONTROL_PLANE_MAX_LIMIT;

/**
 * Values per `in.(...)` filter.
 *
 * {@link CONTROL_PLANE_MAX_FILTER_VALUES} is the adapter's own cap; chunking to
 * it rather than to a number chosen here keeps the two in step if the adapter's
 * cap ever changes.
 */
const FILTER_CHUNK_SIZE = CONTROL_PLANE_MAX_FILTER_VALUES;

/* -------------------------------------------------------------------------- */
/* Error type                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A typed refusal raised by this module.
 *
 * Publishes `code` and `status`, which is the whole contract
 * `apps/web/server/api.ts`'s `toControlPlaneApiError` reads, so there is no
 * per-code mapping table anywhere and the router encodes this exactly like any
 * other console error. Messages are assembled from constants in this file and
 * passed through `sanitizeMessage` on the way out.
 */
export class ProjectReadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(sanitizeMessage(message));
    this.name = "ProjectReadError";
    this.status = status;
    this.code = code;
  }
}

/** A project id that no policy admits, or one this deployment cannot resolve. */
export const PROJECT_NOT_VISIBLE_CODE = "E_WEB_PROJECT_NOT_VISIBLE";

/** A bounded read hit its ceiling, so the result is a floor rather than a page. */
export const PROJECT_PAGE_INCOMPLETE_CODE = "E_WEB_PROJECT_PAGE_INCOMPLETE";

/** A row did not have the shape its own `check` constraints guarantee. */
export const PROJECT_ROW_MALFORMED_CODE = "E_WEB_PROJECT_ROW_MALFORMED";

/* -------------------------------------------------------------------------- */
/* Copy                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The RLS statement every `/projects/:projectId` response carries.
 *
 * Server-owned on purpose: the page renders this sentence verbatim, so the
 * explanation of *why* a revoked context is missing cannot drift from the policy
 * that hides it, and cannot be softened by a future edit to a page component.
 */
export const CONTEXT_POLICY_NOTE =
  "A project context is readable only while private.can_read_context(id) holds, which requires " +
  "revoked_at IS NULL, no context_revocations row, and an active workspace membership. A revoked " +
  "context is therefore excluded from this view for every role, including the owner of its own " +
  "workspace, so this console cannot list it or quote its pinned release digest. Nothing here is " +
  "substituted for it: this console never shows the release it currently serves in place of a pin.";

/**
 * Why `contexts` is empty.
 *
 * Deliberately does not say "this project has no contexts", which is a claim
 * about data this read cannot make: a revoked context is invisible, and a caller
 * who is not an active member of the project's workspace sees nothing either.
 */
export const CONTEXTS_EMPTY_REASON =
  "No project context is readable for this project. That is what the control plane returned; it " +
  "is not a statement that the project has never published a context, and it is not a measurement " +
  "of zero.";

/**
 * Why `revocations` is empty.
 *
 * Names both policies that make the read empty today, so an operator who knows a
 * revocation happened can see exactly why the record is not here instead of
 * concluding the console lost it.
 */
export const REVOCATIONS_EMPTY_REASON =
  "No context_revocations row is readable for the contexts listed above. Two policies make that " +
  "the normal answer: private.can_read_context already excludes any context that has a revocation " +
  "row, so a revoked context never reaches this page, and " +
  "private.can_manage_context_revocations limits revocation rows to workspace owners and admins. " +
  "Revocation records are read only for contexts this session could actually read.";

/** Whether a context's pinned release is one this deployment can resolve. */
export type PinnedReleaseResolution = "resolvable" | "not-resolvable" | "unknown";

/* -------------------------------------------------------------------------- */
/* Response shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One context, plus what can honestly be said about its pin.
 *
 * Every {@link ProjectContextSummary} field is present and unchanged;
 * `ProjectDetailView` widens `ProjectDetail.contexts` to this row.
 */
export interface ProjectContextRow extends ProjectContextSummary {
  /**
   * Whether `release_digest` names a release this deployment has verified.
   *
   * `unknown` is a real answer, not a failure: a deployment with no verified
   * artifact cannot resolve anything, and reporting `not-resolvable` there would
   * be a false statement about the deployment rather than about the pin.
   */
  readonly release_resolution: PinnedReleaseResolution;
  /** Operator sentence for {@link release_resolution}. Never null, never empty. */
  readonly release_resolution_reason: string;
}

/** One readable `context_revocations` row. */
export interface ContextRevocationView {
  readonly context_id: string;
  readonly revoked_at: string;
  readonly revoked_by: string;
  readonly reason: string;
}

/**
 * `/projects/:projectId` response.
 *
 * `Omit<ProjectDetail, "contexts">` rather than a fresh shape: every field the
 * shared DTO declares is served unchanged, so this route is a widening of the
 * documented contract and not a competing one.
 */
export interface ProjectDetailView extends Omit<ProjectDetail, "contexts"> {
  readonly contexts: readonly ProjectContextRow[];
  /** Revocation records, keyed on the contexts actually readable above. */
  readonly revocations: readonly ContextRevocationView[];
  /** Explains an empty `contexts`. `null` when contexts are present. */
  readonly contexts_unavailable_reason: string | null;
  /** Explains an empty `revocations`. `null` when a record is present. */
  readonly revocations_unavailable_reason: string | null;
  /**
   * The release this deployment currently serves, reported **as a contrast** and
   * never as a stand-in for a pin. `null` when no release resolves.
   */
  readonly served_release_digest: string | null;
  /** Explains a `null` `served_release_digest`. */
  readonly served_release_unavailable_reason: string | null;
  /** {@link CONTEXT_POLICY_NOTE}. */
  readonly context_policy_note: string;
}

/** Options for {@link createProjectRoutes}. Every field is test-only. */
export interface ProjectRouteOptions {
  /**
   * Reader to use. Defaults to a reader built from `EGA_SUPABASE_URL` on **every
   * request** rather than once at module load — see
   * {@link lazyDefaultControlPlaneReader}.
   */
  readonly reader?: ControlPlaneReader | undefined;
  /** Response-size, deadline, and concurrency bounds. Defaults to the process env. */
  readonly bounds?: RequestBounds | undefined;
}

/* -------------------------------------------------------------------------- */
/* The reader                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A reader that resolves its configuration per request.
 *
 * `defaultControlPlaneReader()` calls `loadServerConfig()`, which *throws* on a
 * malformed `EGA_WEB_ARTIFACT_DIR` or a non-canonical
 * `EGA_WEB_EXPECTED_RELEASE_DIGEST`. Building the reader at module scope — which
 * is what `controlPlaneRoute`'s default argument does — would therefore turn a
 * configuration defect into an import-time crash of the whole console, instead of
 * a 503 on the routes that need it.
 *
 * Deferring keeps the failure where it belongs: inside a request, where
 * `toControlPlaneApiError` turns it into a typed 503. It also means a test can
 * change the environment without re-importing the module.
 */
function lazyDefaultControlPlaneReader(): ControlPlaneReader {
  const readerFor = (): ControlPlaneReader => defaultControlPlaneReader();
  return Object.freeze({
    resolveCaller(request: ControlPlaneRequest) {
      return readerFor().resolveCaller(request);
    },
    readAsCaller<T = Readonly<Record<string, unknown>>>(
      caller: CallerIdentity,
      table: string,
      options?: Parameters<ControlPlaneReader["readAsCaller"]>[2],
    ) {
      return readerFor().readAsCaller<T>(caller, table, options);
    },
    describeAvailability() {
      return readerFor().describeAvailability();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Query validation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Bound the request's query string before any module logic reads it.
 *
 * `apps/web/server/api.ts` applies `assertBoundedQuery` inside each of its own
 * handlers; a route registered through the control-plane seam does not inherit
 * that, so the bound is applied here instead. The parameter count is the bound
 * that matters — without it a URL carrying hundreds of junk values reaches the
 * validators below.
 */
function boundQuery(query: URLSearchParams): void {
  let count = 0;
  for (const _entry of query) {
    count += 1;
    if (count > API_MAX_QUERY_PARAMS) {
      throw new ProjectReadError(
        400,
        "E_WEB_PROJECT_QUERY_INVALID",
        `A console API request may carry at most ${API_MAX_QUERY_PARAMS} query parameters`,
      );
    }
  }
}

/**
 * Read `limit`, refusing rather than coercing.
 *
 * `limit=abc`, `limit=0`, and `limit=100000` are three different requests and
 * three different mistakes. A malformed value is a 400 rather than a silent
 * default, because quietly serving the default page hides the caller's bug.
 */
function readLimit(query: URLSearchParams): number {
  const raw = query.get("limit");
  if (raw === null) return PROJECTS_PAGE_DEFAULT_LIMIT;
  const trimmed = raw.trim();
  if (trimmed === "") return PROJECTS_PAGE_DEFAULT_LIMIT;
  if (!/^\d+$/.test(trimmed)) {
    throw new ProjectReadError(
      400,
      "E_WEB_PROJECT_LIMIT_INVALID",
      "limit must be a base-ten integer; it is not coerced to a default",
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > PROJECTS_PAGE_MAX_LIMIT) {
    throw new ProjectReadError(
      400,
      "E_WEB_PROJECT_LIMIT_INVALID",
      `limit must be an integer between 1 and ${PROJECTS_PAGE_MAX_LIMIT}; an oversized page is refused rather than truncated`,
    );
  }
  return value;
}

/**
 * Read the optional `workspace_id` filter.
 *
 * A **filter, never a capability** (CONTRACT-F §1): it narrows the rows a caller
 * may already see and grants nothing. An absent value means "no filter", which
 * is RLS's own scoping — a caller may read projects only in workspaces where they
 * hold an active membership. A malformed value is refused here so it never
 * reaches the adapter, where it would be refused anyway.
 */
function readWorkspaceFilter(query: URLSearchParams): ControlPlaneFilter | null {
  const raw = query.get("workspace") ?? query.get("workspace_id");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
    throw new ProjectReadError(
      400,
      "E_WEB_PROJECT_WORKSPACE_INVALID",
      "workspace_id must be a canonical uuid; it filters rows and grants no access",
    );
  }
  return { column: "workspace_id", values: [trimmed] };
}

/** The `:projectId` segment, which the router has already decoded. */
function readProjectId(context: ApiRouteContext): string {
  const value = context.params["projectId"];
  if (value === undefined || value === "") {
    throw new ProjectReadError(404, PROJECT_NOT_VISIBLE_CODE, "No project was named by this request.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new ProjectReadError(
      400,
      "E_WEB_PROJECT_ID_INVALID",
      "projectId must be a canonical uuid; it filters rows and grants no access",
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Row validation                                                               */
/* -------------------------------------------------------------------------- */

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Characters that never belong in a displayed value.
 *
 * A newline or a NUL in a project name would let one row forge the layout of the
 * next, so they are stripped rather than escaped.
 */
// eslint-disable-next-line no-control-regex -- the point is to remove these.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Longest free-text value rendered from a row.
 *
 * `name`, `reason`, and `revoked_by` are the only free-text columns this module
 * reads. All three are operator-authored, so the bound is generous enough not to
 * truncate a real sentence and small enough that one row cannot become a payload.
 */
const MAX_DISPLAY_LENGTH = 400;

/**
 * A statement-shaped SQL fragment inside free text.
 *
 * `name`, `reason`, and `revoked_by` are operator-authored and *can* legitimately
 * read "drop the legacy migration" or "delete-on-failure". A fragment that is
 * unambiguously a **statement** — a DML/DDL verb, a clause keyword, and a
 * semicolon or clause terminator — is not prose, so it is redacted. The pattern
 * requires all three, so no ordinary phrase matches.
 */
const SQL_STATEMENT =
  /\b(?:select|insert\s+into|update|delete\s+from|drop\s+table|alter\s+table|create\s+table|truncate)\b[^;]{0,120}\b(?:from|into|set|where|values|table)\b[^;]{0,120};?/gi;

/**
 * Make one database string safe to render, or refuse the response.
 *
 * Three jobs, in order:
 *
 * 1. **Bound and clean.** Control characters are removed, whitespace is
 *    collapsed, and the result is length-capped. An empty result is refused
 *    rather than rendered as a blank cell.
 * 2. **Redact structurally.** Anything JWT-shaped, credential-bearing in a URL,
 *    or an absolute filesystem path is replaced wholesale. This is deliberately a
 *    *narrower* list than `sanitizeReadMessage` uses for wire messages: that
 *    function also rewrites the bare word `token` or `secret`, which is the right
 *    call for a diagnostic and the wrong one for a project called
 *    "Token Rotation" or a revocation reason that mentions a rotated secret.
 * 3. **Keep the response honest.** A value that is not a string at all is a row
 *    that does not match its own column types, which fails the whole response
 *    with a stated code instead of rendering `String(undefined)`.
 */
function displayValue(raw: unknown, label: string): string {
  if (typeof raw !== "string") {
    throw new ProjectReadError(
      502,
      PROJECT_ROW_MALFORMED_CODE,
      `A control-plane row field (${label}) was not a string, so this response is refused rather than guessed at.`,
    );
  }
  const cleaned = raw.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  const bounded = cleaned.length > MAX_DISPLAY_LENGTH ? `${cleaned.slice(0, MAX_DISPLAY_LENGTH - 1)}…` : cleaned;
  if (bounded === "") {
    throw new ProjectReadError(
      502,
      PROJECT_ROW_MALFORMED_CODE,
      `A control-plane row field (${label}) was blank, so this response is refused rather than rendered as an empty value.`,
    );
  }
  const redacted = bounded
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@[^\s]*/gi, "<redacted-url>")
    .replace(/\b(?:apikey|secret|password|passwd|token)\s*[:=]\s*\S+/gi, "<redacted>")
    .replace(SQL_STATEMENT, "<redacted-sql>")
    .replace(/(^|[\s"'(=:[])(\/[A-Za-z0-9._@+-]+)+/g, "$1<redacted-path>")
    .replace(/(^|[\s"'(=:])([A-Za-z]:\\(?:[^\\\s"'`,;)]+\\)*[^\\\s"'`,;)]*)/g, "$1<redacted-path>");
  return redacted;
}

/**
 * Require a canonical digest, refusing the response otherwise.
 *
 * The database enforces `^sha256:[0-9a-f]{64}$` on both digest columns, so a
 * value that fails here means the row did not come from that table. That matters
 * more than usual for `release_digest`: the whole page is an answer about one
 * exact digest, and a malformed one cannot be compared against anything.
 */
function requireDigest(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !DIGEST_RE.test(raw)) {
    throw new ProjectReadError(
      502,
      PROJECT_ROW_MALFORMED_CODE,
      `A control-plane row field (${label}) was not a canonical sha256 digest, so this response is refused rather than shown as a pin.`,
    );
  }
  return raw;
}

/** Require a uuid, refusing the response otherwise. */
function requireUuid(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
    throw new ProjectReadError(
      502,
      PROJECT_ROW_MALFORMED_CODE,
      `A control-plane row field (${label}) was not a canonical uuid, so this response is refused rather than linked.`,
    );
  }
  return raw;
}

/** Require a timestamp, refusing the response otherwise. */
function requireTimestamp(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !TIMESTAMP_RE.test(raw)) {
    throw new ProjectReadError(
      502,
      PROJECT_ROW_MALFORMED_CODE,
      `A control-plane row field (${label}) was not a timestamp, so this response is refused rather than shown as a date.`,
    );
  }
  return raw;
}

/** One `projects` row, already validated. */
interface ProjectRecord {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly created_at: string;
}

/** One `project_contexts` row, already validated and without its pin verdict. */
interface ContextRecord {
  readonly context_id: string;
  readonly project_id: string;
  readonly context_digest: string;
  readonly release_digest: string;
  readonly revoked_at: string | null;
  readonly published_at: string;
}

function toProjectRecord(row: Readonly<Record<string, unknown>>): ProjectRecord {
  return Object.freeze({
    project_id: requireUuid(row["id"], "projects.id"),
    workspace_id: requireUuid(row["workspace_id"], "projects.workspace_id"),
    name: displayValue(row["name"], "projects.name"),
    created_at: requireTimestamp(row["created_at"], "projects.created_at"),
  });
}

function toContextRecord(row: Readonly<Record<string, unknown>>): ContextRecord {
  return Object.freeze({
    context_id: requireUuid(row["id"], "project_contexts.id"),
    project_id: requireUuid(row["project_id"], "project_contexts.project_id"),
    context_digest: requireDigest(row["context_digest"], "project_contexts.context_digest"),
    release_digest: requireDigest(row["release_digest"], "project_contexts.release_digest"),
    // `revoked_at` is the only nullable column on the table. It is null for every
    // row this policy admits today, but the page renders a revoked row distinctly
    // if that ever changes, so the value is carried through rather than discarded.
    revoked_at: row["revoked_at"] === null || row["revoked_at"] === undefined
      ? null
      : requireTimestamp(row["revoked_at"], "project_contexts.revoked_at"),
    published_at: requireTimestamp(row["published_at"], "project_contexts.published_at"),
  });
}

/* -------------------------------------------------------------------------- */
/* Bounded reads                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A read whose result is presented as a *complete* enumeration.
 *
 * The adapter refuses an upstream that returns more rows than the requested
 * limit, but `rows.length === limit` is still ambiguous: it is either exactly
 * `limit` rows or a truncated page. For a read whose length becomes a count or a
 * complete list, ambiguity is refused — {@link ProjectReadError} with
 * {@link PROJECT_PAGE_INCOMPLETE_CODE} — because a floor presented as a count is
 * exactly the fabricated-zero failure this console must not have.
 *
 * A **ceiling** of at least 2 is required. With `limit: 1` a single returned row
 * would be indistinguishable from a truncated page, which would make the
 * single-row primary-key lookups below refuse every project that exists.
 */
async function readComplete<T>(
  reader: ControlPlaneReader,
  caller: CallerIdentity,
  table: string,
  options: { readonly columns: readonly string[]; readonly filters?: readonly ControlPlaneFilter[]; readonly limit: number },
  subject: string,
): Promise<readonly T[]> {
  if (options.limit < 2) {
    throw new ProjectReadError(
      500,
      "E_WEB_PROJECT_INTERNAL",
      "A complete-enumeration read was planned with a ceiling of 1, which cannot distinguish one row from a truncated page.",
    );
  }
  const rows = await reader.readAsCaller<T>(caller, table, options);
  if (rows.length >= options.limit) {
    throw new ProjectReadError(
      503,
      PROJECT_PAGE_INCOMPLETE_CODE,
      `${subject} has more rows than one bounded control-plane read returns (ceiling ${options.limit}). ` +
        "This console refuses rather than publish a partial list or report an inexact count.",
    );
  }
  return rows;
}

/**
 * A primary-key lookup: at most one row, and no completeness claim.
 *
 * Distinct from {@link readComplete} because it makes no counting claim: it asks
 * "is there a row with this id?", and one row is the answer rather than a
 * truncated page. `limit: 1` is what makes it a lookup — the adapter refuses an
 * upstream that returns more, so a second row becomes a malformed-response
 * refusal at the throw site rather than a silent pick.
 */
async function readAtMostOne<T>(
  reader: ControlPlaneReader,
  caller: CallerIdentity,
  table: string,
  options: { readonly columns: readonly string[]; readonly filters: readonly ControlPlaneFilter[] },
): Promise<readonly T[]> {
  return reader.readAsCaller<T>(caller, table, { ...options, limit: 1 });
}

/** Split values into chunks the adapter's per-filter value cap will accept. */
function chunked(values: readonly string[]): readonly (readonly string[])[] {
  if (values.length === 0) return [];
  const chunks: (readonly string[])[] = [];
  for (let index = 0; index < values.length; index += FILTER_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + FILTER_CHUNK_SIZE));
  }
  return chunks;
}

/* -------------------------------------------------------------------------- */
/* Derived counts                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Active context counts for exactly the projects on this page.
 *
 * Why one read per chunk instead of a single unfiltered `project_contexts` read:
 * an unfiltered page is a page of the caller's *whole* context set, and any row
 * belonging to a project outside the current window would consume the page and
 * starve a project inside it. That undercounts — a zero invented by pagination —
 * which is the failure this console must not have. Filtering by the page's own
 * project ids cannot starve a project on the page.
 *
 * The reads are independent, so they run concurrently; the count of chunks is
 * bounded by `PROJECTS_PAGE_MAX_LIMIT / FILTER_CHUNK_SIZE`.
 */
async function activeContextCounts(
  reader: ControlPlaneReader,
  caller: CallerIdentity,
  projectIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>();
  if (projectIds.length === 0) return counts;
  const reads = await Promise.all(
    chunked(projectIds).map((ids) =>
      readComplete<Readonly<Record<string, unknown>>>(
        reader,
        caller,
        "project_contexts",
        {
          columns: ["project_id", "revoked_at"],
          filters: [{ column: "project_id", values: [...ids] }],
          limit: CONTROL_PLANE_MAX_LIMIT,
        },
        "The set of published contexts for this page",
      ),
    ),
  );
  for (const rows of reads) {
    for (const row of rows) {
      const projectId = requireUuid(row["project_id"], "project_contexts.project_id");
      // `active_context_count` counts contexts with `revoked_at is null`. A row
      // that came back revoked is counted as inactive, never as active.
      const active = row["revoked_at"] === null || row["revoked_at"] === undefined;
      counts.set(projectId, (counts.get(projectId) ?? 0) + (active ? 1 : 0));
    }
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Pin resolution                                                               */
/* -------------------------------------------------------------------------- */

/** What this deployment can serve, as far as the verified artifact is concerned. */
export interface DeploymentReleases {
  readonly served: string | null;
  readonly servedReason: string | null;
  readonly digests: readonly string[];
  /** Non-null when the release set could not be resolved at all. */
  readonly unresolvedReason: string | null;
}

/** A verdict about one pinned digest, and the sentence that explains it. */
export interface PinnedReleaseVerdict {
  readonly release_resolution: PinnedReleaseResolution;
  readonly release_resolution_reason: string;
}

/**
 * Judge one pinned release digest against what this deployment can serve.
 *
 * A **pure** function, exported so the three verdicts are directly testable
 * without a verified artifact on disk: a deployment with no configured artifact
 * always answers `unknown`, which is exactly the case a live route cannot reach a
 * `resolvable` verdict from. Every sentence it returns names the pin itself, and
 * every sentence that contrasts the pin with the served release says explicitly
 * that it is a contrast and not a replacement.
 */
export function describePinnedRelease(
  digest: string,
  deployment: DeploymentReleases,
): PinnedReleaseVerdict {
  if (deployment.unresolvedReason !== null) {
    return {
      release_resolution: "unknown",
      release_resolution_reason:
        `Whether this deployment can resolve ${digest} could not be determined: ${deployment.unresolvedReason} ` +
        "The pinned digest above is the context's own record and is unaffected by that.",
    };
  }
  if (deployment.digests.includes(digest)) {
    return {
      release_resolution: "resolvable",
      release_resolution_reason:
        `This deployment has verified ${digest} and can serve it. The pin and the served release are the same digest here, ` +
        "which is a fact about this deployment, not a rule: a context may pin a digest this deployment does not carry.",
    };
  }
  const contrast =
    deployment.served === null
      ? "This deployment resolves no single served release, so there is nothing to contrast the pin with."
      : `This deployment currently serves ${deployment.served}, which is NOT what this context is pinned to.`;
  return {
    release_resolution: "not-resolvable",
    release_resolution_reason:
      `This deployment has not verified ${digest}, so it cannot serve that pin from its own release set. ${contrast} ` +
      "The pinned digest above is shown exactly as stored in project_contexts and is never replaced by another digest.",
  };
}

/**
 * Resolve the digests this deployment has verified.
 *
 * This is the *deployment's* answer, not the pin's: it says what this console
 * can hand out today, and it is used only to annotate a pin, never to replace
 * one. When the artifact is unconfigured or fails verification the result is
 * `unresolvedReason`, which every context reports as `unknown` — a deployment
 * that cannot resolve anything must not claim a pin is unresolvable.
 */
function resolveDeploymentReleases(): DeploymentReleases {
  try {
    const list = getReleases(loadServerConfig());
    const digests: string[] = [];
    let served: string | null = null;
    for (const entry of list.releases) {
      digests.push(entry.release.release_digest);
      if (served === null && entry.is_stable) served = entry.release.release_digest;
    }
    return {
      served,
      servedReason:
        served === null
          ? "This deployment resolved a release set but none of its entries is a stable pointer, so there is no single release it currently serves to compare against."
          : null,
      digests,
      unresolvedReason: null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? sanitizeMessage(error.message) : "The deployment could not resolve a release set.";
    return {
      served: null,
      servedReason: message,
      digests: [],
      unresolvedReason: message,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                     */
/* -------------------------------------------------------------------------- */

function toSummary(record: ProjectRecord, activeContextCount: number): ProjectSummary {
  return Object.freeze({
    project_id: record.project_id,
    workspace_id: record.workspace_id,
    name: record.name,
    created_at: record.created_at,
    active_context_count: activeContextCount,
  });
}

/**
 * `GET /projects` — the projects the caller may read.
 *
 * Returns a bare array, which is what `API_ENDPOINTS.projects` and the existing
 * page contract expect. Two properties matter:
 *
 * - **The list is RLS's, not the console's.** With no `workspace_id` filter the
 *   read returns every project in every workspace where the caller holds an
 *   active membership, and nothing else.
 * - **`active_context_count` is measured.** It comes from a bounded
 *   `project_contexts` read keyed on this page's own project ids. A failure of
 *   that read fails the whole response — the page renders an explicit state — so
 *   the count can never be `0` because a read went unanswered.
 */
export async function getProjects(
  context: ApiRouteContext,
  caller: CallerIdentity,
  reader: ControlPlaneReader,
): Promise<readonly ProjectSummary[]> {
  boundQuery(context.query);
  const limit = readLimit(context.query);
  const workspaceFilter = readWorkspaceFilter(context.query);
  const filters = workspaceFilter === null ? [] : [workspaceFilter];

  // Read at the *ceiling*, not at the caller's page size, and refuse when the
  // ceiling is reached. A page holding exactly `limit` rows is a legitimate page;
  // a read holding exactly the ceiling may be a truncated one, and this console
  // will not slice an ambiguous page into something that looks complete. Once the
  // read is known to be complete, the caller's own page size is applied to it —
  // that truncation is the request, not a silent loss.
  const rows = await readComplete<Readonly<Record<string, unknown>>>(
    reader,
    caller,
    "projects",
    { columns: PROJECT_COLUMNS, filters, limit: PROJECTS_PAGE_MAX_LIMIT },
    "This page of projects",
  );
  const page = rows.slice(0, limit).map(toProjectRecord);

  const counts = await activeContextCounts(
    reader,
    caller,
    page.map((record) => record.project_id),
  );
  return Object.freeze(page.map((record) => toSummary(record, counts.get(record.project_id) ?? 0)));
}

/**
 * `GET /projects/:projectId` — the project, its readable contexts, and the pins.
 *
 * Four bounded reads, in order, each of which can fail the response rather than
 * degrade it:
 *
 * 1. `projects` filtered by `id`, limit 1. Zero rows is a 404 that is
 *    indistinguishable from "no such project", which is what RLS requires.
 * 2. `project_contexts` filtered by `project_id`, at the adapter ceiling.
 * 3. `context_revocations` filtered by the context ids from (2) — empty by
 *    construction today; see the module header.
 * 4. Nothing. The pin verdict reads this deployment's verified artifact, which is
 *    process-local and never touches the database.
 */
export async function getProjectDetail(
  context: ApiRouteContext,
  caller: CallerIdentity,
  reader: ControlPlaneReader,
): Promise<ProjectDetailView> {
  boundQuery(context.query);
  const projectId = readProjectId(context);

  const projectRows = await readAtMostOne<Readonly<Record<string, unknown>>>(
    reader,
    caller,
    "projects",
    { columns: PROJECT_COLUMNS, filters: [{ column: "id", values: [projectId] }] },
  );
  // `projects.id` is the primary key, so one row is the only possible answer. More
  // than one means the row did not come from that table, which is a refusal rather
  // than a pick. The adapter's own limit check normally catches this first.
  if (projectRows.length > 1) {
    throw new ProjectReadError(
      502,
      PROJECT_ROW_MALFORMED_CODE,
      "The control plane returned more than one project for a primary-key lookup, so this response is refused.",
    );
  }
  const first = projectRows[0];
  if (first === undefined) {
    throw new ProjectReadError(
      404,
      PROJECT_NOT_VISIBLE_CODE,
      "No project with this id is visible to your session under the current policy. A project id you cannot " +
        "read and a project id that does not exist are deliberately answered the same way, so this response " +
        "does not disclose whether any project exists.",
    );
  }
  const project = toProjectRecord(first);

  const contextRows = await readComplete<Readonly<Record<string, unknown>>>(
    reader,
    caller,
    "project_contexts",
    {
      columns: CONTEXT_COLUMNS,
      filters: [{ column: "project_id", values: [projectId] }],
      limit: CONTEXT_PAGE_LIMIT,
    },
    "This project's contexts",
  );
  const records = contextRows.map(toContextRecord);

  const revocations = await readRevocations(reader, caller, records);
  const deployment = resolveDeploymentReleases();

  const contexts = Object.freeze(
    records.map((record) => {
      const verdict = describePinnedRelease(record.release_digest, deployment);
      const revocation = revocations.byContextId.get(record.context_id);
      // A revocation record is evidence of revocation, so the merge fails toward
      // "revoked": an unreadable-looking context with a revocation row attached
      // renders as revoked, never as active.
      //
      // When both sources carry a timestamp and they disagree, the *context row's*
      // own `revoked_at` wins — it is the column the whole schema checks and the
      // one the DTO documents — and the disagreement is stated rather than resolved
      // silently, because a control plane whose two revocation timestamps differ is
      // telling an operator something and the console must not flatten it.
      const revokedAt = record.revoked_at ?? revocation?.revoked_at ?? null;
      const disagreement =
        record.revoked_at !== null &&
        revocation !== undefined &&
        revocation.revoked_at !== record.revoked_at
          ? ` The context row records revocation at ${record.revoked_at} while the revocation record says ${revocation.revoked_at}; both are shown and neither is discarded.`
          : "";
      const contextRow: ProjectContextRow = Object.freeze({
        context_id: record.context_id,
        project_id: record.project_id,
        context_digest: record.context_digest,
        release_digest: record.release_digest,
        published_at: record.published_at,
        revoked_at: revokedAt,
        // `revocation_reason` is `null` — never the string "null", and never a
        // placeholder — when no revocation record was readable. The `disagreement`
        // suffix is only ever appended to a reason that actually exists, so a
        // missing reason cannot turn into prose that implies one.
        revocation_reason:
          revokedAt === null
            ? null
            : revocation === undefined
              ? null
              : revocation.reason + disagreement,
        revoked_by: revokedAt === null ? null : (revocation?.revoked_by ?? null),
        release_resolution: verdict.release_resolution,
        release_resolution_reason: verdict.release_resolution_reason,
      });
      return contextRow;
    }),
  );

  const revocationRows = Object.freeze(
    records
      .map((record) => revocations.byContextId.get(record.context_id))
      .filter((row): row is ContextRevocationView => row !== undefined),
  );

  const activeCount = contexts.reduce(
    (total, contextRow) => (contextRow.revoked_at === null ? total + 1 : total),
    0,
  );

  return Object.freeze({
    project: toSummary(project, activeCount),
    contexts,
    revocations: revocationRows,
    contexts_unavailable_reason: contexts.length === 0 ? CONTEXTS_EMPTY_REASON : null,
    revocations_unavailable_reason:
      revocationRows.length === 0 ? REVOCATIONS_EMPTY_REASON : null,
    served_release_digest: deployment.served,
    served_release_unavailable_reason: deployment.servedReason,
    context_policy_note: CONTEXT_POLICY_NOTE,
  });
}

/** Revocation records, keyed by context id. */
interface RevocationIndex {
  readonly byContextId: ReadonlyMap<string, ContextRevocationView>;
}

/**
 * Read `context_revocations` for the contexts that were actually readable.
 *
 * The read is skipped entirely when no context came back: an empty `in.()` filter
 * is refused by the adapter, and a query that cannot express "nothing" should not
 * be sent. This is also why the module cannot show a revoked context — it has no
 * id to ask about. See the module header.
 */
async function readRevocations(
  reader: ControlPlaneReader,
  caller: CallerIdentity,
  records: readonly ContextRecord[],
): Promise<RevocationIndex> {
  const byContextId = new Map<string, ContextRevocationView>();
  const ids = records.map((record) => record.context_id);
  if (ids.length === 0) return Object.freeze({ byContextId });

  const reads = await Promise.all(
    chunked(ids).map((chunk) =>
      readComplete<Readonly<Record<string, unknown>>>(
        reader,
        caller,
        "context_revocations",
        { columns: REVOCATION_COLUMNS, filters: [{ column: "context_id", values: [...chunk] }], limit: CONTROL_PLANE_MAX_LIMIT },
        "The revocation records for this project's readable contexts",
      ),
    ),
  );
  for (const rows of reads) {
    for (const row of rows) {
      byContextId.set(
        requireUuid(row["context_id"], "context_revocations.context_id"),
        Object.freeze({
          context_id: requireUuid(row["context_id"], "context_revocations.context_id"),
          revoked_at: requireTimestamp(row["revoked_at"], "context_revocations.revoked_at"),
          revoked_by: displayValue(row["revoked_by"], "context_revocations.revoked_by"),
          reason: displayValue(row["reason"], "context_revocations.reason"),
        }),
      );
    }
  }
  return Object.freeze({ byContextId });
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the two control-plane routes.
 *
 * Exported as a factory so a test can supply a reader bound to a fixture
 * transport; {@link projectRoutes} is the production instance built from the
 * caller's own session. Every route goes through `controlPlaneRoute`, which is the
 * only supported way to register a control-plane read — GET-only, caller resolved
 * before the handler runs, same bounds as every other console route.
 */
export function createProjectRoutes(options: ProjectRouteOptions = {}): ApiRoute[] {
  const reader = options.reader ?? lazyDefaultControlPlaneReader();
  const bounds = options.bounds ?? loadRequestBounds();
  return [
    controlPlaneRoute("projects", "/projects", getProjects, bounds, reader),
    controlPlaneRoute("project-detail", "/projects/:projectId", getProjectDetail, bounds, reader),
  ];
}

/**
 * The routes to wire into `installConsoleApi`.
 *
 * Named for the file, matching the pattern the other page builders use. A lead
 * adding this to `apps/web/server/api.ts` needs one import and one spread.
 */
// Do NOT add a pre-built `projectRoutes` array here: building one at module
// scope calls `loadRequestBounds` from `./api.ts`, which imports this module,
// and the circular import throws a TDZ ReferenceError before the server can
// listen. Typecheck cannot see that hazard. Call `createProjectRoutes()` from
// a context where `./api.ts` has finished evaluating.

/**
 * The adapter's own ceiling, re-exported so a page or a test can name the bound
 * these routes enforce without re-deriving it from `supabase-read.ts`.
 *
 * `PROJECTS_PAGE_MAX_LIMIT` is this module's page ceiling and is declared above;
 * it is deliberately *not* re-exported here, because a duplicate export
 * declaration would be two sources for one number.
 */
export { CONTROL_PLANE_MAX_LIMIT };