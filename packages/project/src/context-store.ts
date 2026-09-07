// Contract E publication lifecycle seam.
//
// The store retains an immutable artifact, while revocation is a separate
// mutable marker. Its persistence adapter is control-plane-owned and never
// reads or writes .egaskills.yaml/.egaskills.lock.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  REMOTE_PROJECT_ERROR_CODES,
  RemoteProjectError,
  hashProjectLock,
  verifyProjectContext,
  type ProjectContext,
} from "./remote.js";
import type { ProjectConfigV1 } from "./config.js";
import type { ProjectLockV1 } from "./lock.js";
import { hashNormalizedConfig, validateLockfile } from "./lock.js";

/**
 * Immutable authority retained by the control plane for hosted context
 * resolution. The fingerprint is intentionally transport-shaped here so the
 * project package does not depend on the router package; the hosted runtime
 * performs the stronger fingerprint schema/digest verification at selection.
 */
export interface ProjectContextAuthority {
  readonly config: ProjectConfigV1;
  readonly lock: ProjectLockV1;
  readonly fingerprint: Readonly<object> | null;
}

export interface PublishedProjectContext {
  readonly contextId: string;
  readonly context: ProjectContext;
  readonly authority?: ProjectContextAuthority;
}

export interface ProjectContextStoreRecord extends PublishedProjectContext {
  readonly revoked: boolean;
}

/** Durable control-plane seam. Implementations may be a database adapter or
 * the file adapter below; the MCP runtime never receives this capability. */
export interface ProjectContextPersistence {
  load(): readonly ProjectContextStoreRecord[];
  save(record: ProjectContextStoreRecord): void;
}

function fail(code: typeof REMOTE_PROJECT_ERROR_CODES[keyof typeof REMOTE_PROJECT_ERROR_CODES], message: string): never {
  throw new RemoteProjectError(code, message);
}

function assertContextId(contextId: string): void {
  if (typeof contextId !== "string" || contextId.length === 0 || contextId.includes("\u0000")) {
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "contextId must be a non-empty text identity");
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function freezeAuthority(authority: ProjectContextAuthority): ProjectContextAuthority {
  return freezeDeep({
    config: authority.config,
    lock: authority.lock,
    fingerprint: authority.fingerprint,
  });
}

function verifyAuthority(context: ProjectContext, authority: ProjectContextAuthority): ProjectContextAuthority {
  if (typeof authority !== "object" || authority === null || Array.isArray(authority)) {
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "published context authority must be an object");
  }
  const authorityKeys = Object.keys(authority).sort();
  if (authorityKeys.length !== 3 || authorityKeys.some((key, index) => key !== ["config", "fingerprint", "lock"][index])) {
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "published context authority has unexpected or missing fields");
  }
  if (typeof authority.config !== "object" || authority.config === null || Array.isArray(authority.config)) {
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "published context authority config is invalid");
  }
  if (typeof authority.lock !== "object" || authority.lock === null || Array.isArray(authority.lock)) {
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "published context authority lock is invalid");
  }
  if (hashNormalizedConfig(authority.config) !== context.config_digest) {
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "published context authority config does not match context identity");
  }
  try {
    const normalized = validateLockfile(authority.lock, context.config_digest);
    if (hashProjectLock(normalized) !== context.lock_digest) {
      fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "published context authority lock does not match context identity");
    }
  } catch (error) {
    if (error instanceof RemoteProjectError) throw error;
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `published context authority lock is invalid: ${String(error instanceof Error ? error.message : error)}`);
  }
  if (context.fingerprint_digest === null) {
    if (authority.fingerprint !== null) {
      fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "published context authority has an unexpected fingerprint");
    }
  } else if (typeof authority.fingerprint !== "object" || authority.fingerprint === null || Array.isArray(authority.fingerprint)) {
    fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, "published context authority fingerprint is missing");
  }
  return freezeAuthority(authority);
}

export class ProjectContextStore {
  readonly #contexts = new Map<string, ProjectContext>();
  readonly #authorities = new Map<string, ProjectContextAuthority>();
  readonly #revoked = new Set<string>();
  readonly #persistence: ProjectContextPersistence | undefined;

  constructor(persistence?: ProjectContextPersistence) {
    this.#persistence = persistence;
    for (const record of persistence?.load() ?? []) {
      assertContextId(record.contextId);
      if (typeof record.revoked !== "boolean") {
        fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `context ${record.contextId} has an invalid revocation state`);
      }
      verifyProjectContext(record.context);
      const authority = record.authority === undefined ? undefined : verifyAuthority(record.context, record.authority);
      if (this.#contexts.has(record.contextId)) {
        fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `context ${record.contextId} is duplicated in persistence`);
      }
      this.#contexts.set(record.contextId, Object.freeze({ ...record.context }));
      if (authority !== undefined) this.#authorities.set(record.contextId, authority);
      if (record.revoked) this.#revoked.add(record.contextId);
    }
  }

  publish(input: PublishedProjectContext): ProjectContextStoreRecord {
    assertContextId(input.contextId);
    verifyProjectContext(input.context);
    if (this.#contexts.has(input.contextId)) {
      fail(REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, `context ${input.contextId} is already published`);
    }
    // Context artifacts are immutable records. Retain a fresh frozen record so
    // a caller cannot mutate a structurally valid object after publication.
    const context = Object.freeze({ ...input.context });
    const authority = input.authority === undefined ? undefined : verifyAuthority(context, input.authority);
    const record = Object.freeze({
      contextId: input.contextId,
      context,
      ...(authority === undefined ? {} : { authority }),
      revoked: false,
    });
    // Persistence is the visibility boundary. A failed durable write must not
    // leave a context addressable in this process.
    this.#persistence?.save(record);
    this.#contexts.set(input.contextId, context);
    if (authority !== undefined) this.#authorities.set(input.contextId, authority);
    return record;
  }

  get(contextId: string): ProjectContextStoreRecord | undefined {
    const context = this.#contexts.get(contextId);
    if (context === undefined) return undefined;
    const authority = this.#authorities.get(contextId);
    return Object.freeze({
      contextId,
      context,
      ...(authority === undefined ? {} : { authority }),
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
    const context = this.#contexts.get(contextId)!;
    const authority = this.#authorities.get(contextId);
    const record = Object.freeze({
      contextId,
      context,
      ...(authority === undefined ? {} : { authority }),
      revoked: true,
    });
    // Do not expose the revocation until its durable marker is written.
    this.#persistence?.save(record);
    this.#revoked.add(contextId);
    return record;
  }

  isRevoked(contextId: string): boolean {
    return this.#revoked.has(contextId);
  }
}

export function createProjectContextStore(persistence?: ProjectContextPersistence): ProjectContextStore {
  return new ProjectContextStore(persistence);
}

/** Small single-writer local/dev adapter for staging/integration tests.
 * Production may replace it with the authenticated database control-plane
 * implementation. Cross-process coordination is intentionally not provided by
 * this file adapter. */
export class FileProjectContextPersistence implements ProjectContextPersistence {
  constructor(
    readonly path: string,
    private readonly renameFile: typeof renameSync = renameSync,
  ) {}

  load(): readonly ProjectContextStoreRecord[] {
    if (!existsSync(this.path)) return [];
    const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(value)) throw new Error("context persistence must contain an array");
    return value as ProjectContextStoreRecord[];
  }

  save(record: ProjectContextStoreRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryDirectory = mkdtempSync(join(dirname(this.path), ".ega-context-store-"));
    const temporaryPath = join(temporaryDirectory, "contexts.json");
    try {
      const records = this.load().filter((current) => current.contextId !== record.contextId);
      records.push(record);
      records.sort((a, b) => a.contextId < b.contextId ? -1 : a.contextId > b.contextId ? 1 : 0);
      writeFileSync(temporaryPath, `${JSON.stringify(records, null, 2)}\n`);
      try {
        this.renameFile(temporaryPath, this.path);
      } catch (error) {
        // Windows does not replace an existing destination with renameSync.
        // Move the old file aside before replacement so a second rename failure
        // can restore the last durable store. Never delete the only durable
        // copy before a complete replacement exists.
        if (!existsSync(this.path)) throw error;
        const backupPath = join(temporaryDirectory, "previous-contexts.json");
        this.renameFile(this.path, backupPath);
        try {
          this.renameFile(temporaryPath, this.path);
        } catch (replacementError) {
          if (existsSync(this.path)) rmSync(this.path, { force: true });
          this.renameFile(backupPath, this.path);
          throw replacementError;
        }
        rmSync(backupPath, { force: true });
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
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
  readonly authority?: ProjectContextAuthority;
  readonly revoked: boolean;
}

export interface ListContextClientResult {
  readonly contexts: readonly PublishedContextResponse[];
}

function responseFor(record: ProjectContextStoreRecord): PublishedContextResponse {
  return Object.freeze({
    context_id: record.contextId,
    context: record.context,
    ...(record.authority === undefined ? {} : { authority: record.authority }),
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
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBodyBytes) {
      throw new Error("request body exceeds control-plane limit");
    }
  }
  if (request.body === null) return JSON.parse("") as unknown;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel("request body exceeds control-plane limit").catch(() => undefined);
        throw new Error("request body exceeds control-plane limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
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
        const authority = record["authority"];
        if (typeof contextId !== "string" || typeof context !== "object" || context === null || Array.isArray(context)) {
          return jsonResponse(422, { code: REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT });
        }
        if (typeof authority !== "object" || authority === null || Array.isArray(authority)) {
          return jsonResponse(422, { code: REMOTE_PROJECT_ERROR_CODES.INVALID_CONTEXT, message: "context authority is required" });
        }
        const projectContext = context as ProjectContext;
        verifyProjectContext(projectContext);
        if (!(await options.authorize({
          token,
          workspaceId: projectContext.workspace_id,
          projectId: projectContext.project_id,
        }))) return jsonResponse(403, { code: "E_CONTEXT_FORBIDDEN" });
        const published = options.store.publish({ contextId, context: projectContext, authority: authority as ProjectContextAuthority });
        return jsonResponse(201, responseFor(published));
      }
      if (request.method === "GET" && path === "/v1/contexts") {
        const visible: PublishedContextResponse[] = [];
        for (const current of options.store.list()) {
          if (await options.authorize({
            token,
            workspaceId: current.context.workspace_id,
            projectId: current.context.project_id,
          })) {
            visible.push(responseFor(current));
          }
        }
        return jsonResponse(200, { contexts: visible });
      }
      const revokeMatch = path.match(/^\/v1\/contexts\/([^/]+)$/);
      if (revokeMatch !== null && request.method === "GET") {
        const current = options.store.get(decodeURIComponent(revokeMatch[1]!));
        if (current === undefined) return jsonResponse(404, { code: REMOTE_PROJECT_ERROR_CODES.CONTEXT_NOT_FOUND });
        if (!(await options.authorize({
          token,
          workspaceId: current.context.workspace_id,
          projectId: current.context.project_id,
        }))) return jsonResponse(403, { code: "E_CONTEXT_FORBIDDEN" });
        return jsonResponse(200, responseFor(current));
      }
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

function controlPlaneUrl(endpoint: string, path: string): URL {
  const url = new URL(path, endpoint);
  const loopback = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("HTTPS is required for remote control-plane endpoints");
  }
  return url;
}

/** Publish through the authenticated control-plane boundary. */
export async function publishProjectContext(
  endpoint: string,
  token: string,
  contextId: string,
  context: ProjectContext,
  authority: ProjectContextAuthority,
  fetcher: typeof fetch = fetch,
): Promise<PublishContextClientResult> {
  if (endpoint.length === 0 || token.length === 0) throw new Error("control-plane endpoint and token are required");
  const response = await fetcher(controlPlaneUrl(endpoint, "/v1/contexts"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ context_id: contextId, context, authority }),
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    throw new Error(`Context publication failed (${String(record["code"] ?? response.status)})`);
  }
  return body as PublishContextClientResult;
}

/** Retrieve immutable context metadata through the authenticated boundary. */
export async function getProjectContext(
  endpoint: string,
  token: string,
  contextId: string,
  fetcher: typeof fetch = fetch,
): Promise<PublishContextClientResult> {
  if (endpoint.length === 0 || token.length === 0 || contextId.length === 0) {
    throw new Error("control-plane endpoint, token, and context id are required");
  }
  const response = await fetcher(controlPlaneUrl(endpoint, `/v1/contexts/${encodeURIComponent(contextId)}`), {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    throw new Error(`Context retrieval failed (${String(record["code"] ?? response.status)})`);
  }
  return body as PublishContextClientResult;
}

/** List only contexts visible to the authenticated control-plane subject. */
export async function listProjectContexts(
  endpoint: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<ListContextClientResult> {
  if (endpoint.length === 0 || token.length === 0) {
    throw new Error("control-plane endpoint and token are required");
  }
  const response = await fetcher(controlPlaneUrl(endpoint, "/v1/contexts"), {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    throw new Error(`Context listing failed (${String(record["code"] ?? response.status)})`);
  }
  if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>)["contexts"])) {
    throw new Error("Context listing returned an invalid response");
  }
  return body as ListContextClientResult;
}

/** Revoke an immutable context through the authenticated control plane. */
export async function revokeProjectContext(
  endpoint: string,
  token: string,
  contextId: string,
  fetcher: typeof fetch = fetch,
): Promise<PublishContextClientResult> {
  if (endpoint.length === 0 || token.length === 0 || contextId.length === 0) {
    throw new Error("control-plane endpoint, token, and context id are required");
  }
  const response = await fetcher(controlPlaneUrl(endpoint, `/v1/contexts/${encodeURIComponent(contextId)}`), {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    throw new Error(`Context revocation failed (${String(record["code"] ?? response.status)})`);
  }
  return body as PublishContextClientResult;
}
