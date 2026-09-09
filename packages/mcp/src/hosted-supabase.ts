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

function unavailable(): HostedRuntimeError {
  return new HostedRuntimeError("E_CONTEXT_UNAVAILABLE", "Context is unavailable");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function createSupabaseContextResolver(options: SupabaseContextResolverOptions): (
  contextId: string,
  principal: HostedPrincipal,
  signal: AbortSignal,
) => Promise<HostedReleaseSnapshot> {
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
  const headers = Object.freeze({
    accept: "application/json",
    apikey: options.secretKey,
    authorization: `Bearer ${options.secretKey}`,
  });

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
