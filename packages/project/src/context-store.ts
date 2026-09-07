// Contract E publication lifecycle seam.
//
// The store is intentionally an in-memory control-plane primitive: publishing
// retains an immutable artifact, while revocation is a separate mutable marker.
// It never reads or writes .egaskills.yaml/.egaskills.lock.

import {
  REMOTE_PROJECT_ERROR_CODES,
  RemoteProjectError,
  verifyProjectContext,
  type ProjectContext,
} from "./remote.js";

export interface PublishedProjectContext {
  readonly contextId: string;
  readonly context: ProjectContext;
}

export interface ProjectContextStoreRecord extends PublishedProjectContext {
  readonly revoked: boolean;
}

function fail(code: typeof REMOTE_PROJECT_ERROR_CODES[keyof typeof REMOTE_PROJECT_ERROR_CODES], message: string): never {
  throw new RemoteProjectError(code, message);
}

function assertContextId(contextId: string): void {
  if (typeof contextId !== "string" || contextId.length === 0 || contextId.includes("\u0000")) {
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "contextId must be a non-empty text identity");
  }
}

export class ProjectContextStore {
  readonly #contexts = new Map<string, ProjectContext>();
  readonly #revoked = new Set<string>();

  publish(input: PublishedProjectContext): ProjectContextStoreRecord {
    assertContextId(input.contextId);
    verifyProjectContext(input.context);
    if (this.#contexts.has(input.contextId)) {
      fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `context ${input.contextId} is already published`);
    }
    // Context artifacts are immutable records. Retain a fresh frozen record so
    // a caller cannot mutate a structurally valid object after publication.
    const context = Object.freeze({ ...input.context });
    this.#contexts.set(input.contextId, context);
    return this.get(input.contextId)!;
  }

  get(contextId: string): ProjectContextStoreRecord | undefined {
    const context = this.#contexts.get(contextId);
    if (context === undefined) return undefined;
    return Object.freeze({
      contextId,
      context,
      revoked: this.#revoked.has(contextId),
    });
  }

  list(): readonly ProjectContextStoreRecord[] {
    return Object.freeze([...this.#contexts.keys()].sort().map((contextId) => this.get(contextId)!));
  }

  revoke(contextId: string): ProjectContextStoreRecord {
    if (!this.#contexts.has(contextId)) {
      fail(REMOTE_PROJECT_ERROR_CODES.CONTEXT_NOT_FOUND, `context ${contextId} is not published`);
    }
    this.#revoked.add(contextId);
    return this.get(contextId)!;
  }

  isRevoked(contextId: string): boolean {
    return this.#revoked.has(contextId);
  }
}

export function createProjectContextStore(): ProjectContextStore {
  return new ProjectContextStore();
}

export interface ContextControlPlaneAuthorization {
  readonly token: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

export interface ContextControlPlaneOptions {
  readonly store: ProjectContextStore;
  readonly authenticate: (token: string) => boolean | Promise<boolean>;
  readonly authorize: (input: ContextControlPlaneAuthorization) => boolean | Promise<boolean>;
  readonly maxBodyBytes?: number;
}

export interface PublishedContextResponse {
  readonly context_id: string;
  readonly context: ProjectContext;
  readonly revoked: boolean;
}

function responseFor(record: ProjectContextStoreRecord): PublishedContextResponse {
  return Object.freeze({
    context_id: record.contextId,
    context: record.context,
    revoked: record.revoked,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (value === null || !value.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length);
  return token.length === 0 || token.includes("\u0000") ? undefined : token;
}

async function boundedJson(request: Request, maxBodyBytes: number): Promise<unknown> {
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBodyBytes) throw new Error("request body exceeds control-plane limit");
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

/**
 * Local authenticated control-plane seam used by the CLI and integration
 * tests. It is deliberately transport-shaped, so a deployment can replace
 * it with the hosted service without giving MCP tools publication powers.
 */
export function createContextControlPlaneHandler(options: ContextControlPlaneOptions): (request: Request) => Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  return async (request) => {
    const token = bearerToken(request);
    if (token === undefined || !(await options.authenticate(token))) return jsonResponse(401, { code: "E_AUTH_REQUIRED" });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    try {
      if (request.method === "POST" && path === "/v1/contexts") {
        const value = await boundedJson(request, maxBodyBytes);
        if (typeof value !== "object" || value === null || Array.isArray(value)) return jsonResponse(422, { code: REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT });
        const record = value as Record<string, unknown>;
        const contextId = record["context_id"];
        const context = record["context"];
        if (typeof contextId !== "string" || typeof context !== "object" || context === null || Array.isArray(context)) {
          return jsonResponse(422, { code: REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT });
        }
        const projectContext = context as ProjectContext;
        verifyProjectContext(projectContext);
        if (!(await options.authorize({
          token,
          workspaceId: projectContext.workspace_id,
          projectId: projectContext.project_id,
        }))) return jsonResponse(403, { code: "E_CONTEXT_FORBIDDEN" });
        const published = options.store.publish({ contextId, context: projectContext });
        return jsonResponse(201, responseFor(published));
      }
      const revokeMatch = path.match(/^\/v1\/contexts\/([^/]+)$/);
      if (revokeMatch !== null && request.method === "DELETE") {
        const current = options.store.get(decodeURIComponent(revokeMatch[1]!));
        if (current === undefined) return jsonResponse(404, { code: REMOTE_PROJECT_ERROR_CODES.CONTEXT_NOT_FOUND });
        if (!(await options.authorize({
          token,
          workspaceId: current.context.workspace_id,
          projectId: current.context.project_id,
        }))) return jsonResponse(403, { code: "E_CONTEXT_FORBIDDEN" });
        return jsonResponse(200, responseFor(options.store.revoke(current.contextId)));
      }
      return jsonResponse(404, { code: "E_CONTROL_PLANE_NOT_FOUND" });
    } catch (error) {
      if (error instanceof SyntaxError) return jsonResponse(422, { code: REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT });
      if (error instanceof RemoteProjectError) return jsonResponse(422, { code: error.code, message: error.message });
      if (error instanceof Error && error.message === "request body exceeds control-plane limit") return jsonResponse(413, { code: "E_REQUEST_TOO_LARGE" });
      return jsonResponse(500, { code: "E_CONTROL_PLANE_ERROR" });
    }
  };
}

export interface PublishContextClientResult extends PublishedContextResponse {}

/** Publish through the authenticated control-plane boundary. */
export async function publishProjectContext(
  endpoint: string,
  token: string,
  contextId: string,
  context: ProjectContext,
  fetcher: typeof fetch = fetch,
): Promise<PublishContextClientResult> {
  if (endpoint.length === 0 || token.length === 0) throw new Error("control-plane endpoint and token are required");
  const response = await fetcher(new URL("/v1/contexts", endpoint), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ context_id: contextId, context }),
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    throw new Error(`Context publication failed (${String(record["code"] ?? response.status)})`);
  }
  return body as PublishContextClientResult;
}
