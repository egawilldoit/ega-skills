import {
  authorizeWorkspace,
  type HubVisibility,
  type WorkspaceRole,
} from "@ega-skills/control-plane";
import {
  HostedRuntimeError,
  type HostedPrincipal,
  type HostedReleaseSnapshot,
} from "./hosted.js";

interface SupabaseJsonResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

type SupabaseFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  },
) => Promise<SupabaseJsonResponse>;

export interface SupabaseContextResolverOptions {
  readonly supabaseUrl: string;
  readonly secretKey: string;
  readonly fetch?: SupabaseFetch;
  readonly resolveRelease: (releaseDigest: string, signal: AbortSignal) => Promise<HostedReleaseSnapshot>;
}

const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_ROLES = new Set(["owner", "admin", "maintainer", "member", "viewer"]);
const WORKSPACE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

function isJwtShaped(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0 && JWT_SEGMENT.test(part));
}

/**
 * Supabase accepts two privileged key classes. A legacy `service_role` key is a
 * JWT and the gateway authenticates it on `Authorization: Bearer`; `apikey` alone
 * is rejected. A modern `sb_secret_` key is an opaque, non-JWT string, and the
 * gateway parses whatever arrives on `Authorization` as a JWT, so sending one
 * there fails with 401.
 *
 * The key is therefore only ever placed in a header, never parsed: the
 * JWT-shape test reads only the segment structure and extracts no claim.
 */
function credentialHeaders(secretKey: string): Readonly<Record<string, string>> {
  const base: Record<string, string> = { accept: "application/json", apikey: secretKey };
  return Object.freeze(isJwtShaped(secretKey)
    ? { ...base, authorization: `Bearer ${secretKey}` }
    : base);
}

function unavailable(): HostedRuntimeError {
  return new HostedRuntimeError("E_CONTEXT_UNAVAILABLE", "Context is unavailable");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

type ReadRows = (
  table: string,
  select: string,
  filters: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<unknown[]>;

interface SupabaseReadOptions {
  readonly supabaseUrl: string;
  readonly secretKey: string;
  readonly fetch?: SupabaseFetch;
}

/** Shared validated Supabase REST reader. */
function createSupabaseRows(options: SupabaseReadOptions): ReadRows {
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.supabaseUrl);
  } catch {
    throw new Error("supabaseUrl must be a valid URL");
  }
  if (baseUrl.protocol !== "https:") throw new Error("supabaseUrl must use HTTPS");
  if (!options.secretKey) throw new Error("secretKey is required");
  const fetcher = options.fetch ?? (globalThis["fetch"] as unknown as SupabaseFetch | undefined);
  if (!fetcher) throw new Error("fetch is unavailable");
  const headers = credentialHeaders(options.secretKey);

  return async (table, select, filters, signal) => {
    const url = new URL(`/rest/v1/${table}`, baseUrl);
    url.searchParams.set("select", select);
    for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
    url.searchParams.set("limit", "1");
    const response = await fetcher(url.toString(), { method: "GET", headers, signal });
    if (!response.ok) throw new Error("Supabase request failed");
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("Supabase response is invalid");
    return body;
  };
}

export function createSupabaseContextResolver(options: SupabaseContextResolverOptions): (
  contextId: string,
  principal: HostedPrincipal,
  signal: AbortSignal,
) => Promise<HostedReleaseSnapshot> {
  const readRows = createSupabaseRows(options);

  return async (contextId, principal, signal) => {
    try {
      if (!contextId || !principal.subject || signal.aborted) throw unavailable();

      const contexts = await readRows("project_contexts", "id,project_id,release_digest,revoked_at", {
        id: `eq.${contextId}`,
      }, signal);
      if (contexts.length !== 1) throw unavailable();
      const context = record(contexts[0]);
      if (!context || context.id !== contextId || typeof context.project_id !== "string" ||
          typeof context.release_digest !== "string" || !RELEASE_DIGEST.test(context.release_digest) ||
          (context.revoked_at !== null && typeof context.revoked_at !== "string")) throw unavailable();
      if (context.revoked_at !== null) throw unavailable();

      const revocations = await readRows("context_revocations", "context_id", {
        context_id: `eq.${contextId}`,
      }, signal);
      if (revocations.length !== 0) throw unavailable();

      const projects = await readRows("projects", "id,workspace_id", {
        id: `eq.${context.project_id}`,
      }, signal);
      if (projects.length !== 1) throw unavailable();
      const project = record(projects[0]);
      if (!project || project.id !== context.project_id || typeof project.workspace_id !== "string") throw unavailable();

      const memberships = await readRows("workspace_memberships", "workspace_id,subject,role,active", {
        workspace_id: `eq.${project.workspace_id}`,
        subject: `eq.${principal.subject}`,
        active: "eq.true",
      }, signal);
      if (memberships.length !== 1) throw unavailable();
      const membership = record(memberships[0]);
      if (!membership || membership.workspace_id !== project.workspace_id || membership.subject !== principal.subject ||
          membership.active !== true || typeof membership.role !== "string" || !WORKSPACE_ROLES.has(membership.role)) throw unavailable();

      const snapshot = await options.resolveRelease(context.release_digest, signal);
      if (snapshot.releaseDigest !== context.release_digest) throw unavailable();
      return snapshot;
    } catch (error) {
      if (signal.aborted) {
        if (signal.reason instanceof Error) throw signal.reason;
        throw new Error("request aborted");
      }
      if (error instanceof HostedRuntimeError && error.code === "E_CONTEXT_UNAVAILABLE") throw error;
      throw unavailable();
    }
  };
}

/**
 * Resolve the workspace that owns an authorized execution (CONTRACT-T1 §3.1).
 *
 * Telemetry records a `workspace_id`, and the column is a foreign key to
 * `personal_workspaces`. It must therefore be the workspace the server actually
 * verified for THIS execution, derived through a chain the caller cannot
 * influence:
 *
 *   - **context-bound call**: `project_context -> project -> workspace`
 *   - **release-bound call**: `hub_release -> hub -> workspace`
 *
 * Both then require an ACTIVE membership for the authenticated subject, so the
 * result is always a workspace this caller demonstrably belongs to.
 *
 * The alternative the previous instrumentation used — reading a workspace id off
 * the principal, the request, or a zero-UUID constant — is wrong twice over: a
 * caller-supplied id is not authority, and a fabricated UUID attributes an
 * execution to a workspace that may not exist.
 *
 * ## Why a lookup failure yields `null`
 *
 * `null` means "no attributable workspace" and the caller OMITS the event. That
 * covers three genuinely different cases which must never be conflated with a
 * zero count: no context and no release digest (the stable-pointer path, which
 * names no hub); a release whose hub the caller cannot read; and a public hub the
 * caller reads WITHOUT being a member — an anonymous-ish read of a public
 * resource has no workspace to attribute it to, and attributing it to the
 * owning workspace would disclose that ownership. Every lookup is bounded by the
 * caller's signal, and a failure returns `null` rather than propagating, because
 * a failed identity lookup must never change an MCP result (CONTRACT-T1 §6).
 */
export interface SupabaseWorkspaceResolver {
  (
    principal: HostedPrincipal,
    request: { readonly contextId?: string | undefined; readonly releaseDigest?: string | undefined },
    signal: AbortSignal,
  ): Promise<string | null>;
}

export function createSupabaseWorkspaceResolver(
  options: { readonly supabaseUrl: string; readonly secretKey: string; readonly fetch?: SupabaseFetch },
): SupabaseWorkspaceResolver {
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.supabaseUrl);
  } catch {
    throw new Error("supabaseUrl must be a valid URL");
  }
  if (baseUrl.protocol !== "https:") throw new Error("supabaseUrl must use HTTPS");
  if (!options.secretKey) throw new Error("secretKey is required");
  const fetcher = options.fetch ?? (globalThis["fetch"] as unknown as SupabaseFetch | undefined);
  if (!fetcher) throw new Error("fetch is unavailable");
  const headers = credentialHeaders(options.secretKey);

  const readRows = async (
    table: string,
    select: string,
    filters: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<unknown[]> => {
    const url = new URL(`/rest/v1/${table}`, baseUrl);
    url.searchParams.set("select", select);
    for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
    url.searchParams.set("limit", "1");
    const response = await fetcher(url.toString(), { method: "GET", headers, signal });
    if (!response.ok) throw new Error("Supabase request failed");
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("Supabase response is invalid");
    return body;
  };

  /** The workspace, but only if this subject is an ACTIVE member of it. */
  const workspaceIfMember = async (
    workspaceId: unknown,
    subject: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    if (typeof workspaceId !== "string" || !WORKSPACE_UUID.test(workspaceId)) return null;
    const memberships = await readRows(
      "workspace_memberships",
      "workspace_id,subject,active",
      { workspace_id: `eq.${workspaceId}`, subject: `eq.${subject}`, active: "eq.true" },
      signal,
    );
    if (memberships.length !== 1) return null;
    const membership = record(memberships[0]);
    if (
      !membership ||
      membership.workspace_id !== workspaceId ||
      membership.subject !== subject ||
      membership.active !== true
    ) {
      return null;
    }
    return workspaceId;
  };

  return async (principal, request, signal) => {
    try {
      if (!principal.subject || signal.aborted) return null;
      const subject = principal.subject;

      // 1. Context-bound: the tightest chain, and the one a caller cannot forge
      //    because the context must itself be authorized.
      if (typeof request.contextId === "string" && request.contextId.length > 0) {
        const contexts = await readRows(
          "project_contexts",
          "id,project_id,revoked_at",
          { id: `eq.${request.contextId}` },
          signal,
        );
        if (contexts.length !== 1) return null;
        const context = record(contexts[0]);
        if (!context || context.id !== request.contextId) return null;
        if (typeof context.project_id !== "string") return null;
        // A revoked context authorized nothing, so it attributes nothing.
        if (context.revoked_at !== null) return null;

        const projects = await readRows(
          "projects",
          "id,workspace_id",
          { id: `eq.${context.project_id}` },
          signal,
        );
        if (projects.length !== 1) return null;
        const project = record(projects[0]);
        if (!project || project.id !== context.project_id) return null;
        return await workspaceIfMember(project.workspace_id, subject, signal);
      }

      // 2. Release-bound: `hub_release -> hub -> workspace`. The digest is the
      //    value the runtime already verified; it is not a client-chosen
      //    workspace, and membership is still required below.
      if (typeof request.releaseDigest === "string" && RELEASE_DIGEST.test(request.releaseDigest)) {
        const releases = await readRows(
          "hub_releases",
          "hub_id,release_digest",
          { release_digest: `eq.${request.releaseDigest}` },
          signal,
        );
        if (releases.length !== 1) return null;
        const release = record(releases[0]);
        if (!release || release.release_digest !== request.releaseDigest) return null;
        if (typeof release.hub_id !== "string" || !WORKSPACE_UUID.test(release.hub_id)) return null;

        const hubs = await readRows("hubs", "id,workspace_id", { id: `eq.${release.hub_id}` }, signal);
        if (hubs.length !== 1) return null;
        const hub = record(hubs[0]);
        if (!hub || hub.id !== release.hub_id) return null;
        return await workspaceIfMember(hub.workspace_id, subject, signal);
      }

      // 3. Neither: the stable-pointer path names no hub, so there is nothing
      //    verified to attribute the execution to. Omitted rather than guessed.
      return null;
    } catch {
      // Every failure collapses to "no identity" so a lookup error can never
      // change an MCP result or emit a row attributed to the wrong workspace.
      return null;
    }
  };
}

export interface SupabaseMembershipAuthorizerOptions {
  readonly supabaseUrl: string;
  readonly secretKey: string;
  readonly fetch?: SupabaseFetch;
  /** Workspace whose hub is being read (the hosted authorization document's workspace). */
  readonly workspaceId: string;
  /** Hub visibility; resource shape stays owned by the static authorization document. */
  readonly visibility: HubVisibility;
  readonly ownerSubject: string;
  readonly authorizedSubjects?: readonly string[];
  /** Static emergency deny for the resource id. */
  readonly denied: boolean;
}

/** Evaluate the active workspace role in the schema's canonical order. */
function membershipRole(role: string): WorkspaceRole | null {
  return WORKSPACE_ROLES.has(role) ? (role as WorkspaceRole) : null;
}

/**
 * Live membership authorization for hosted reads (`search`, `resolve`,
 * `inspect`, `get_content`).
 *
 * The static authorization document remains the source of the resource shape
 * (workspace, visibility, owner, explicit private grants, emergency denies),
 * but membership is read from the live store on every call, so a real
 * `workspace_memberships` revocation takes effect immediately for a token that
 * is still valid. Lookup failure, malformed rows, and duplicates all fail
 * closed, matching the context resolver's contract.
 */
export function createSupabaseMembershipAuthorizer(options: SupabaseMembershipAuthorizerOptions): (
  subject: string,
  signal?: AbortSignal,
) => Promise<boolean> {
  const readRows = createSupabaseRows(options);
  const resource = {
    workspaceId: options.workspaceId,
    visibility: options.visibility,
    ownerSubject: options.ownerSubject,
    ...(options.authorizedSubjects ? { authorizedSubjects: [...options.authorizedSubjects] } : {}),
  };
  return async (subject, signal) => {
    try {
      if (!subject || !options.workspaceId || signal?.aborted) return false;
      if (options.denied) return false;
      const rows = await readRows("workspace_memberships", "workspace_id,subject,role,active", {
        workspace_id: `eq.${options.workspaceId}`,
        subject: `eq.${subject}`,
        active: "eq.true",
      }, signal ?? new AbortController().signal);
      if (rows.length > 1) return false;
      const row = rows.length === 1 ? record(rows[0]) : null;
      if (row && (row.workspace_id !== options.workspaceId || row.subject !== subject || row.active !== true)) return false;
      const role = row && typeof row.role === "string" ? membershipRole(row.role) : null;
      if (row && role === null) return false;
      return authorizeWorkspace({
        subject,
        membership: role === null ? undefined : { subject, role, active: true },
        resource,
        permission: "read_hub",
      });
    } catch {
      return false;
    }
  };
}
