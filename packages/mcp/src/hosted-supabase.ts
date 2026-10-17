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
 * Live membership authorization for UNSCOPED hosted reads (`search`,
 * `resolve`).
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
