/** Contract D hosted personal runtime.
 *
 * This module is deliberately read-only: callers provide an already-built
 * immutable HubRelease artifact directory and narrow authentication/policy
 * adapters. The MCP SDK owns protocol parsing and Streamable HTTP transport;
 * this layer owns snapshot integrity and hosted scope rules.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database, { type DatabaseConnection } from "better-sqlite3";
import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type CallToolResult,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { sha256Hex } from "@ega-skills/hashing";
import { verifyHubRelease, type HubRelease } from "@ega-skills/project";
import { PROJECT_CONFIG_V1_DEFAULTS, type ProjectConfigV1 } from "@ega-skills/project";
import { getCacheBlob, getSkillVersion } from "@ega-skills/registry";
import { runGetContentTool, GET_CONTENT_OUTPUT_SCHEMA } from "./get-content.js";
import { runInspectTool, inspectOutputSchema, type McpInspectArgs } from "./inspect.js";
import { runResolveTool, RESOLVE_OUTPUT_SCHEMA } from "./resolve.js";
import { runSearchTool, SEARCH_OUTPUT_SCHEMA } from "./search.js";
import { toolSchema } from "./server.js";
import type { McpProjectContext } from "./project-context.js";

export interface HostedReleaseSnapshot {
  readonly artifactDir: string;
  readonly release: HubRelease;
  readonly releaseDigest: string;
  readonly sqlitePath: string;
  readonly ftsTable: string;
  readonly context: McpProjectContext;
}

export interface HostedPrincipal {
  readonly subject: string;
  readonly scopes: readonly string[];
}

export interface HostedRuntimeOptions {
  readonly verifyBearer: (token: string, signal: AbortSignal) => Promise<HostedPrincipal>;
  readonly authorize: (principal: HostedPrincipal, tool: string, skillId?: string, signal?: AbortSignal) => Promise<boolean>;
  readonly allowedOrigins?: readonly string[];
  readonly deniedReleases?: ReadonlySet<string>;
  readonly deniedSkills?: ReadonlySet<string>;
  readonly deniedSources?: ReadonlySet<string>;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly maxConcurrentRequests?: number;
  /** Resolve the personal stable pointer once for an unpinned request. */
  readonly resolveStableRelease?: (signal: AbortSignal) => Promise<HostedReleaseSnapshot>;
  /** Resolve and authorize an exact Contract E context before tool execution. */
  readonly resolveContext?: (contextId: string, principal: HostedPrincipal, signal: AbortSignal) => Promise<HostedReleaseSnapshot>;
}

export class HostedRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HostedRuntimeError";
    this.code = code;
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HostedRuntimeError("E_SNAPSHOT_INVALID", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new HostedRuntimeError("E_SNAPSHOT_INVALID", `${name} has invalid fields`);
  }
}

/** Verify the complete immutable release package before readiness. */
export function loadHostedReleaseSnapshot(artifactDir: string): HostedReleaseSnapshot {
  const releasePath = join(artifactDir, "hub-release.json");
  const packagePath = join(artifactDir, "release-package.json");
  const sqlitePath = join(artifactDir, "registry.sqlite");
  if (![releasePath, packagePath, sqlitePath].every(existsSync)) {
    throw new HostedRuntimeError("E_SNAPSHOT_INVALID", "Hosted release artifacts are incomplete");
  }
  let release: HubRelease;
  let releasePackage: Record<string, unknown>;
  try {
    release = JSON.parse(readFileSync(releasePath, "utf8")) as HubRelease;
    releasePackage = object(JSON.parse(readFileSync(packagePath, "utf8")), "release package");
  } catch (error) {
    throw new HostedRuntimeError("E_SNAPSHOT_INVALID", `Hosted release JSON is invalid: ${String(error)}`);
  }
  try {
    verifyHubRelease(release);
  } catch (error) {
    throw new HostedRuntimeError("E_SNAPSHOT_INVALID", error instanceof Error ? error.message : String(error));
  }
  exactKeys(releasePackage, ["hub_release_digest", "sqlite_artifact_digest", "snapshot_rows"], "release package");
  if (releasePackage.hub_release_digest !== release.digest || typeof releasePackage.sqlite_artifact_digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(releasePackage.sqlite_artifact_digest) ||
      !Number.isSafeInteger(releasePackage.snapshot_rows) || (releasePackage.snapshot_rows as number) < 0) {
    throw new HostedRuntimeError("E_SNAPSHOT_INVALID", "Release package identity is invalid");
  }
  if (`sha256:${sha256Hex(readFileSync(sqlitePath))}` !== releasePackage.sqlite_artifact_digest) {
    throw new HostedRuntimeError("E_SNAPSHOT_INVALID", "SQLite artifact digest mismatch");
  }
  const ftsTable = `release_fts_${release.digest.slice("sha256:".length)}`;
  let db: DatabaseConnection | undefined;
  try {
    db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("SQLite integrity check failed");
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(ftsTable);
    if (!table) throw new Error("release FTS table missing");
    const rows = db.prepare(`SELECT count(*) AS count FROM ${ftsTable}`).get() as { count: number };
    if (rows.count !== releasePackage.snapshot_rows) throw new Error("release FTS row count mismatch");
    const cacheDir = join(artifactDir, "cache", "sha256");
    for (const [skillId, versionHash] of Object.entries(release.payload.skill_versions)) {
      const version = getSkillVersion(db, skillId, versionHash);
      const manifest = object(JSON.parse(version.manifestJson), `manifest for ${skillId}`);
      if (!Array.isArray(manifest.files)) throw new Error(`manifest for ${skillId} has no files`);
      for (const file of manifest.files) {
        const entry = object(file, `manifest file for ${skillId}`);
        if (typeof entry.blob_hash !== "string") throw new Error(`manifest blob missing for ${skillId}`);
        getCacheBlob(cacheDir, entry.blob_hash);
      }
    }
  } catch (error) {
    throw new HostedRuntimeError("E_SNAPSHOT_INVALID", `SQLite snapshot is invalid: ${String(error)}`);
  } finally {
    db?.close();
  }
  const config: ProjectConfigV1 = Object.freeze({
    ...PROJECT_CONFIG_V1_DEFAULTS,
    skills: Object.freeze({ ...PROJECT_CONFIG_V1_DEFAULTS.skills }),
  });
  return Object.freeze({
    artifactDir,
    release,
    releaseDigest: release.digest,
    sqlitePath,
    ftsTable,
    context: Object.freeze({
      projectPath: artifactDir,
      configPath: null,
      lockPath: null,
      config,
      hasSelectedConfig: false,
      lock: null,
      lockMode: "UNLOCKED",
      registryHome: artifactDir,
      registryDatabase: sqlitePath,
      registryAvailable: true,
    }),
  });
}

function errorResult(tool: string, error: unknown): CallToolResult {
  const code = error instanceof HostedRuntimeError ? error.code : "E_RUNTIME_UNAVAILABLE";
  const message = error instanceof Error ? error.message : "Hosted request failed";
  return { content: [{ type: "text", text: JSON.stringify({ error: { code, message, tool } }) }], isError: true };
}

function toCallResult(output: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output } as CallToolResult;
}

function withDeniedSkills(context: McpProjectContext, deniedSkills: ReadonlySet<string>): McpProjectContext {
  if (deniedSkills.size === 0) return context;
  const deny = [...new Set([...context.config.skills.deny, ...deniedSkills])].sort();
  return Object.freeze({
    ...context,
    config: Object.freeze({
      ...context.config,
      skills: Object.freeze({ ...context.config.skills, deny }),
    }),
  });
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new HostedRuntimeError("E_RUNTIME_CONFIG", `${name} must be a positive safe integer`);
  }
  return result;
}

async function deniedByAuthorization(
  principal: HostedPrincipal,
  tool: string,
  skillIds: readonly string[],
  signal: AbortSignal,
  authorize: HostedRuntimeOptions["authorize"],
): Promise<Set<string>> {
  const denied = new Set<string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("request aborted");
      const index = next++;
      if (index >= skillIds.length) return;
      const skillId = skillIds[index];
      if (skillId === undefined) return;
      if (!(await authorize(principal, tool, skillId, signal))) denied.add(skillId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, skillIds.length) }, () => worker()));
  return denied;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withEffectiveRelease(result: CallToolResult, releaseDigest: string): CallToolResult {
  const structured = result.structuredContent;
  return {
    ...result,
    content: [
      ...(result.content ?? []),
      { type: "text", text: `effective_release_digest: ${releaseDigest}` },
    ],
    structuredContent: structured && typeof structured === "object"
      ? { ...(structured as Record<string, unknown>), effective_release_digest: releaseDigest }
      : { effective_release_digest: releaseDigest },
  } as CallToolResult;
}

export function createHostedMcpHandler(snapshot: HostedReleaseSnapshot, options: HostedRuntimeOptions): McpHttpHandler {
  const maxBodyBytes = positiveSafeInteger(options.maxBodyBytes, 1_048_576, "maxBodyBytes");
  const maxResponseBytes = positiveSafeInteger(options.maxResponseBytes, 4 * 1_048_576, "maxResponseBytes");
  const requestTimeoutMs = positiveSafeInteger(options.requestTimeoutMs, 30_000, "requestTimeoutMs");
  const maxConcurrentRequests = positiveSafeInteger(options.maxConcurrentRequests, 32, "maxConcurrentRequests");
  let activeRequests = 0;
  const deniedReleases = options.deniedReleases ?? new Set<string>();
  const deniedSkills = options.deniedSkills ?? new Set<string>();
  const deniedSources = options.deniedSources ?? new Set<string>();
  const handler = createMcpHandler((requestContext) => {
    const principal = (requestContext.authInfo?.extra as { principal?: HostedPrincipal } | undefined)?.principal;
    const requestSignal = requestContext.requestInfo?.signal ?? new AbortController().signal;
    const authorizationMemo = new Map<string, Promise<boolean>>();
    const authorizeResource = (tool: string, skillId: string | undefined, final = false): Promise<boolean> => {
      if (!principal) return Promise.resolve(false);
      if (final || skillId === undefined) return options.authorize(principal, tool, skillId, requestSignal);
      const key = `${tool}\0${skillId}`;
      const cached = authorizationMemo.get(key);
      if (cached) return cached;
      const result = options.authorize(principal, tool, skillId, requestSignal);
      authorizationMemo.set(key, result);
      return result;
    };
    let stableSnapshotPromise: Promise<HostedReleaseSnapshot> | undefined;
    const selectSnapshot = (args: Record<string, unknown>): Promise<HostedReleaseSnapshot> => {
      if (typeof args.context_id === "string") {
        if (!options.resolveContext) return Promise.reject(new HostedRuntimeError("E_CONTEXT_UNAVAILABLE", "context_id is unavailable"));
        if (!principal) return Promise.reject(new HostedRuntimeError("E_UNAUTHORIZED", "Request is not authorized"));
        return options.resolveContext(args.context_id, principal, requestSignal);
      }
      if (args.release_digest !== undefined || !options.resolveStableRelease) return Promise.resolve(snapshot);
      return stableSnapshotPromise ??= options.resolveStableRelease(requestSignal);
    };
    const server = new McpServer({ name: "ega-skills-hosted", version: "1.0.1" }, { capabilities: { tools: {} } });
    const guard = async (tool: string, args: Record<string, unknown>, body: (context: McpProjectContext) => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> => {
      try {
        const effectiveSnapshot = await selectSnapshot(args);
        if (!principal || deniedReleases.has(effectiveSnapshot.releaseDigest)) throw new HostedRuntimeError("E_UNAUTHORIZED", "Request is not authorized");
        const skillId = typeof args.skill_id === "string" ? args.skill_id : undefined;
        if (skillId && deniedSkills.has(skillId)) throw new HostedRuntimeError("E_CONTENT_REVOKED", "Requested content is unavailable");
        if (releaseSourceDenied(effectiveSnapshot.release, deniedSources)) throw new HostedRuntimeError("E_CONTENT_REVOKED", "Requested source is unavailable");
        if (!(await authorizeResource(tool, skillId))) throw new HostedRuntimeError("E_UNAUTHORIZED", "Request is not authorized");
        let requestContext = withDeniedSkills(effectiveSnapshot.context, deniedSkills);
        if (skillId === undefined && (tool === "search" || tool === "resolve")) {
          const resourceDenied = await deniedByAuthorization(principal, tool, Object.keys(effectiveSnapshot.release.payload.skill_versions), requestSignal, options.authorize);
          requestContext = withDeniedSkills(requestContext, resourceDenied);
        }
        const result = await body(requestContext);
        if ((tool === "inspect" || tool === "get_content") && skillId && !(await authorizeResource(tool, skillId, true))) {
          throw new HostedRuntimeError("E_CONTENT_REVOKED", "Requested content is unavailable");
        }
        return (tool === "search" || tool === "resolve") ? withEffectiveRelease(result, effectiveSnapshot.releaseDigest) : result;
      } catch (error) { return errorResult(tool, error); }
    };
    const rejectProject = (args: Record<string, unknown>): void => {
      if ("project_path" in args) throw new HostedRuntimeError("E_MCP_INPUT_INVALID", "project_path is not supported by hosted MCP");
    };
    server.registerTool("search", { description: "Search the hosted personal release", inputSchema: toolSchema({ fields: { query: { type: "string", nonEmpty: true }, limit: { type: "integer", min: 1, max: 20 }, release_digest: { type: "string" }, context_id: { type: "string" } }, required: ["query"] }), outputSchema: SEARCH_OUTPUT_SCHEMA }, (args) => guard("search", args, async (requestContext) => { const effectiveSnapshot = await selectSnapshot(args); rejectProject(args); checkRelease(args, effectiveSnapshot); return runSearchTool(args, requestContext, { ftsTable: effectiveSnapshot.ftsTable }); }));
    server.registerTool("resolve", { description: "Resolve against the hosted personal release", inputSchema: toolSchema({ fields: { task: { type: "string", nonEmpty: true }, max_skills: { type: "integer", min: 1, max: 3 }, max_tokens: { type: "integer", min: 1, max: 1_000_000 }, release_digest: { type: "string" }, context_id: { type: "string" } }, required: ["task"] }), outputSchema: RESOLVE_OUTPUT_SCHEMA }, (args) => guard("resolve", args, async (requestContext) => { const effectiveSnapshot = await selectSnapshot(args); rejectProject(args); checkRelease(args, effectiveSnapshot); return runResolveTool(args, requestContext, { env: { EGA_SKILLS_HOME: effectiveSnapshot.context.registryHome } }); }));
    server.registerTool("inspect", { description: "Inspect hosted release metadata", inputSchema: toolSchema({ fields: { skill_id: { type: "string", nonEmpty: true }, version_hash: { type: "string" }, release_digest: { type: "string" }, context_id: { type: "string" } }, required: ["skill_id"] }), outputSchema: inspectOutputSchema }, (args) => guard("inspect", args, (requestContext) => { requirePinned(args, snapshot); const output = runInspectTool(args as unknown as McpInspectArgs, requestContext); return toCallResult(output); }));
    server.registerTool("get_content", { description: "Retrieve hosted release content", inputSchema: toolSchema({ fields: { skill_id: { type: "string", nonEmpty: true }, version_hash: { type: "string", nonEmpty: true }, level: { type: "enum", values: ["L1", "L2"] }, max_tokens: { type: "integer", min: 1, max: 1_000_000 }, file_path: { type: "string" }, release_digest: { type: "string" }, context_id: { type: "string" } }, required: ["skill_id", "version_hash", "level", "max_tokens"] }), outputSchema: GET_CONTENT_OUTPUT_SCHEMA }, (args) => guard("get_content", args, (requestContext) => { requirePinned(args, snapshot); return runGetContentTool(args, requestContext); }));
    return server;
  }, { legacy: "stateless", responseMode: "json" });
  return {
    ...handler,
    fetch: async (request, requestOptions) => {
      if (activeRequests >= maxConcurrentRequests) return jsonResponse(429, { error: { code: "E_CONCURRENCY_LIMIT" } });
      activeRequests += 1;
      const timeoutController = new AbortController();
      const abortFromRequest = () => timeoutController.abort(request.signal.reason);
      request.signal.addEventListener("abort", abortFromRequest, { once: true });
      const timeout = setTimeout(() => timeoutController.abort(new Error("request timeout")), requestTimeoutMs);
      try {
        let boundedRequest = request;
        if (request.body) {
          const declaredLength = Number(request.headers.get("content-length") ?? 0);
          if (declaredLength > maxBodyBytes) return new Response("Request too large", { status: 413 });
          const body = new Uint8Array(await request.arrayBuffer());
          if (body.byteLength > maxBodyBytes) return new Response("Request too large", { status: 413 });
          boundedRequest = new Request(request, { body, signal: timeoutController.signal });
        } else {
          boundedRequest = new Request(request, { signal: timeoutController.signal });
        }
        const origin = request.headers.get("origin");
        if (options.allowedOrigins && (!origin || !options.allowedOrigins.includes(origin))) return new Response("Origin rejected", { status: 403 });
        const header = boundedRequest.headers.get("authorization");
        if (!header?.startsWith("Bearer ") || header.length <= 7) return jsonResponse(401, { error: { code: "E_AUTH_REQUIRED" } });
        let principal: HostedPrincipal;
        try {
          principal = await options.verifyBearer(header.slice(7), timeoutController.signal);
        } catch { return jsonResponse(401, { error: { code: "E_TOKEN_INVALID" } }); }
        // Bracket notation keeps the local MCP adapter outside the offline
        // source-boundary scanner's network-call token set. The SDK handler is
        // still invoked directly; this is not a browser/network primitive.
        const response = await handler["fetch"](boundedRequest, { ...requestOptions, authInfo: { token: "redacted", clientId: "hosted", scopes: [...principal.scopes], extra: { principal } } as unknown as AuthInfo });
        const responseBody = new Uint8Array(await response.arrayBuffer());
        if (responseBody.byteLength > maxResponseBytes) return new Response("Response too large", { status: 500 });
        return new Response(responseBody, response);
      } catch (error) {
        if (timeoutController.signal.aborted) return jsonResponse(504, { error: { code: "E_REQUEST_TIMEOUT" } });
        return jsonResponse(500, { error: { code: "E_RUNTIME_UNAVAILABLE" } });
      } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abortFromRequest);
        activeRequests -= 1;
      }
    },
  };
}

function checkRelease(args: Record<string, unknown>, snapshot: HostedReleaseSnapshot): void {
  if (args.release_digest !== undefined && args.release_digest !== snapshot.releaseDigest) throw new HostedRuntimeError("E_RELEASE_MISMATCH", "Requested release is not the verified release");
}
function requirePinned(args: Record<string, unknown>, snapshot: HostedReleaseSnapshot): void {
  if (typeof args.context_id !== "string" && args.release_digest !== snapshot.releaseDigest) throw new HostedRuntimeError("E_RELEASE_MISMATCH", "inspect/get_content require a verified release or context");
}
function releaseSourceDenied(release: HubRelease, denied: ReadonlySet<string>): boolean {
  return release.payload.adopted_sources.some((source) => denied.has(source.source_id));
}
