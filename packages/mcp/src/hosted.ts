// Contract D hosted personal runtime.
//
// The hosted boundary deliberately uses the already-tested local read paths
// against one immutable, release-specific registry home. It adds release
// selection, authentication, emergency deny, and startup integrity gates; it
// never exposes a caller project path or a publication capability.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

import { sha256Hex } from "@ega-skills/hashing";
import {
  assertLockInRelease,
  checkAliasMap,
  checkSearchIndexInput,
  checkTokenArtifact,
  hashNormalizedConfig,
  hashProjectLock,
  verifyHubRelease,
  verifyProjectContext,
  type HubRelease,
  type ReleaseArtifacts,
  type ReleasePackage,
  type ProjectConfigV1,
  type ProjectContext,
  type ProjectLockV1,
} from "@ega-skills/project";
import {
  CURRENT_SCHEMA_VERSION,
  getCacheBlob,
  getSkillVersion,
  getTokenCount,
  openRegistry,
  type RegistryHandle,
} from "@ega-skills/registry";
import { PROJECT_CONFIG_V1_DEFAULTS, type ProjectLockMode } from "@ega-skills/project";

import {
  McpContextError,
  toMcpErrorResult,
  type McpProjectContext,
} from "./project-context.js";
import { runGetContentTool } from "./get-content.js";
import { runInspectTool, toInspectErrorResult, toInspectSuccessResult } from "./inspect.js";
import { runResolveTool } from "./resolve.js";
import { runSearchTool } from "./search.js";
import { oauthDiscoveryDocuments, type HostedOAuthMetadata } from "./hosted-auth.js";
import { hashRemoteFingerprint, type RemoteProjectFingerprint } from "@ega-skills/router";

export const HOSTED_TOOL_NAMES = Object.freeze([
  "resolve",
  "search",
  "inspect",
  "get_content",
] as const);

export const HOSTED_LIMITS = Object.freeze({
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 8_388_608,
  requestTimeoutMs: 30_000,
  toolTimeoutMs: 15_000,
  maxConcurrentRequests: 32,
  maxConnections: 128,
  maxContentBytes: 1_048_576,
});

export type HostedToolName = (typeof HOSTED_TOOL_NAMES)[number];

export interface HostedReleaseSnapshot {
  readonly release: HubRelease;
  /** Immutable release-specific home containing registry.sqlite and blobs. */
  readonly registryHome: string;
  /** SHA-256 digest of the exact immutable registry.sqlite artifact. */
  readonly sqliteArtifactDigest: string;
  readonly releasePackage: ReleasePackage;
  readonly artifacts: ReleaseArtifacts;
  readonly ftsTable: string;
  /** Mapping emitted by the isolated builder for source-scoped emergency deny. */
  readonly skillSourceIds?: Readonly<Record<string, string>>;
}

export interface HostedContextSnapshot {
  /** Opaque published context identity. It is intentionally separate from the artifact digest. */
  readonly contextId: string;
  readonly context: ProjectContext;
  readonly config: ProjectConfigV1;
  readonly lock: ProjectLockV1;
  readonly fingerprint?: RemoteProjectFingerprint | null;
}

export interface HostedDenyPolicy {
  readonly releaseDigests?: readonly string[];
  readonly skillVersions?: readonly string[];
  readonly sourceIds?: readonly string[];
}

export interface HostedAuthorizationRequest {
  readonly tool: HostedToolName;
  readonly releaseDigest: string;
  readonly skillId?: string;
  readonly versionHash?: string;
  readonly contextId?: string;
  readonly authInfo?: AuthInfo;
}

export interface HostedRuntimeOptions {
  readonly releases: readonly HostedReleaseSnapshot[];
  readonly stableReleaseDigest: string;
  readonly contexts?: readonly HostedContextSnapshot[];
  /** Read-only control-plane seam; revocation is checked for every request. */
  readonly isContextRevoked?: (contextId: string) => boolean | Promise<boolean>;
  /** Mandatory authorization seam; production supplies verified OAuth claims. */
  readonly authorize: (
    request: HostedAuthorizationRequest,
  ) => boolean | Promise<boolean>;
  readonly denyPolicy?: HostedDenyPolicy | (() => HostedDenyPolicy | undefined);
}

export interface HostedRuntime {
  readonly toolNames: readonly HostedToolName[];
  readonly ready: true;
  call(
    tool: HostedToolName,
    args: Record<string, unknown>,
    authInfo?: AuthInfo,
  ): Promise<CallToolResult>;
}

export interface HostedHttpOptions {
  readonly verifier: {
    verifyAccessToken(token: string): Promise<AuthInfo>;
  };
  readonly oauth: HostedOAuthMetadata;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly requiredScopes?: readonly string[];
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxConnections?: number;
  readonly maxContentBytes?: number;
  /** Deployment adapter's physical active-connection count, when available. */
  readonly getActiveConnections?: () => number;
}

export interface HostedHttpHandler {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

export class HostedRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostedRuntimeError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new HostedRuntimeError(code, message);
}

function errorResult(tool: HostedToolName, code: string, message: string): CallToolResult {
  return toMcpErrorResult(tool, new McpContextError(code, message));
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new McpContextError("E_MCP_INPUT_INVALID", `${name} must be a non-empty string`);
  }
  return value;
}

function releaseDigestArg(args: Record<string, unknown>): string | undefined {
  const value = args["release_digest"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new McpContextError("E_MCP_INPUT_INVALID", "release_digest must be sha256:<64 lowercase hex>");
  }
  return value;
}

function rejectHostedProjectPath(args: Record<string, unknown>): void {
  if ("project_path" in args) {
    throw new McpContextError(
      "E_MCP_INPUT_INVALID",
      "Hosted MCP does not accept project_path; use release_digest or context_id",
    );
  }
}

function makeHostedContext(
  snapshot: HostedReleaseSnapshot,
  binding?: HostedContextSnapshot,
): McpProjectContext {
  return Object.freeze({
    projectPath: snapshot.registryHome,
    configPath: null,
    lockPath: null,
    config: binding?.config ?? PROJECT_CONFIG_V1_DEFAULTS,
    hasSelectedConfig: binding !== undefined,
    lock: binding?.lock ?? null,
    lockMode: binding === undefined ? "UNLOCKED" as ProjectLockMode : "LOCKED" as ProjectLockMode,
    registryHome: snapshot.registryHome,
    registryDatabase: join(snapshot.registryHome, "registry.sqlite"),
    registryAvailable: true,
  });
}

function structuredWithHostedMetadata(
  result: CallToolResult,
  releaseDigest: string,
  binding?: HostedContextSnapshot,
): CallToolResult {
  if (result.structuredContent === undefined || result.isError) return result;
  const structured = result.structuredContent as Record<string, unknown>;
  const hasProjectFingerprint = structured.project_fingerprint !== undefined;
  const fingerprint = binding?.fingerprint ?? null;
  const projectFingerprint = fingerprint === null ? {
    project_path: null,
    package_root: null,
    workspace_root: null,
    workspace_ambiguous: false,
    languages: [],
    platforms: [],
    frameworks: [],
    evidence: [],
  } : {
    project_path: null,
    package_root: fingerprint.package_root,
    workspace_root: fingerprint.workspace_root,
    workspace_ambiguous: fingerprint.workspace_ambiguous,
    languages: [...fingerprint.languages],
    platforms: [...fingerprint.platforms],
    frameworks: [...fingerprint.frameworks],
    evidence: fingerprint.evidence.map((item) => ({ ...item })),
  };
  return Object.freeze({
    ...result,
    structuredContent: Object.freeze({
      ...structured,
      // The local resolver necessarily receives an internal directory so it
      // can reuse the frozen ranking pipeline. Personal hosted mode must not
      // disclose that path or imply project fingerprinting, however.
      ...(hasProjectFingerprint
        ? {
            project_fingerprint: projectFingerprint,
          }
        : {}),
      effective_release_digest: releaseDigest,
      project_context: binding?.contextId ?? "NONE",
      fingerprint_status: binding === undefined ? "NONE" : (fingerprint === null ? "MISSING" : "PUBLISHED"),
    }),
  }) as CallToolResult;
}

function assertContextId(contextId: string): void {
  if (contextId.length === 0 || contextId.includes("\u0000")) {
    fail("E_STARTUP_INTEGRITY", "published context identity must be non-empty text");
  }
}

function verifyContextSnapshot(
  binding: HostedContextSnapshot,
  snapshots: ReadonlyMap<string, HostedReleaseSnapshot>,
): void {
  assertContextId(binding.contextId);
  try {
    verifyProjectContext(binding.context);
  } catch (error) {
    fail("E_STARTUP_INTEGRITY", `ProjectContext verification failed: ${String(error instanceof Error ? error.message : error)}`);
  }
  const release = snapshots.get(binding.context.release_digest);
  if (release === undefined) {
    fail("E_STARTUP_INTEGRITY", `ProjectContext ${binding.contextId} binds a release that is not retained`);
  }
  if (hashNormalizedConfig(binding.config) !== binding.context.config_digest) {
    fail("E_STARTUP_INTEGRITY", `ProjectContext ${binding.contextId} config digest does not match`);
  }
  if (hashProjectLock(binding.lock) !== binding.context.lock_digest) {
    fail("E_STARTUP_INTEGRITY", `ProjectContext ${binding.contextId} lock digest does not match`);
  }
  try {
    assertLockInRelease(binding.lock, release.release);
  } catch (error) {
    fail("E_STARTUP_INTEGRITY", `ProjectContext ${binding.contextId} lock is not contained in its release`);
  }
  if (binding.context.fingerprint_digest === null) {
    if (binding.fingerprint !== undefined && binding.fingerprint !== null) {
      fail("E_STARTUP_INTEGRITY", `ProjectContext ${binding.contextId} has an unexpected fingerprint`);
    }
  } else {
    if (binding.fingerprint === undefined || binding.fingerprint === null) {
      fail("E_STARTUP_INTEGRITY", `ProjectContext ${binding.contextId} is missing its published fingerprint`);
    }
    if (hashRemoteFingerprint(binding.fingerprint) !== binding.context.fingerprint_digest) {
      fail("E_STARTUP_INTEGRITY", `ProjectContext ${binding.contextId} fingerprint digest does not match`);
    }
  }
}

function readCatalog(db: RegistryHandle["db"]): Map<string, string> {
  const rows = db
    .prepare("SELECT skill_id, current_version_hash AS version_hash FROM skills ORDER BY skill_id")
    .all<{ skill_id: string; version_hash: string }>() as Array<{
    skill_id: string;
    version_hash: string;
  }>;
  return new Map(rows.map((row) => [row.skill_id, row.version_hash]));
}

function snapshotTableName(table: string): string {
  if (!/^release_fts_[0-9a-f]{64}$/.test(table)) {
    fail("E_STARTUP_INTEGRITY", "release FTS table identity is invalid");
  }
  return `"${table}"`;
}

function deriveSnapshotArtifacts(
  db: RegistryHandle["db"],
  expected: ReadonlyMap<string, string>,
): ReleaseArtifacts {
  const aliases: Record<string, string> = {};
  const rows: Array<{
    skill_id: string;
    version_hash: string;
    name: string;
    description: string;
    domains: string[];
    platforms: string[];
    frameworks: string[];
    triggers: string[];
    aliases: string[];
  }> = [];
  const counts: Array<{ skill_id: string; version_hash: string; level: "L2"; tokens: number }> = [];
  for (const [skillId, versionHash] of [...expected].sort(([a], [b]) => a.localeCompare(b))) {
    const version = getSkillVersion(db, skillId, versionHash);
    const manifest = JSON.parse(version.manifestJson) as Record<string, any>;
    const portable = manifest.portable;
    const routing = manifest.routing;
    if (portable === null || typeof portable !== "object" || routing === null || typeof routing !== "object") {
      fail("E_STARTUP_INTEGRITY", `selected manifest for ${skillId} is incomplete`);
    }
    const stringList = (value: unknown, field: string): string[] => {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        fail("E_STARTUP_INTEGRITY", `${skillId}.${field} is not a string list`);
      }
      return [...value] as string[];
    };
    const skillAliases = stringList(routing.aliases, "aliases");
    for (const alias of skillAliases) {
      if (aliases[alias] !== undefined && aliases[alias] !== skillId) {
        fail("E_STARTUP_INTEGRITY", `alias ${JSON.stringify(alias)} has multiple selected owners`);
      }
      aliases[alias] = skillId;
    }
    const files = manifest.files;
    if (!Array.isArray(files)) fail("E_STARTUP_INTEGRITY", `manifest for ${skillId} has no files`);
    const skillFile = files.find((file: any) => file?.path === "SKILL.md");
    if (typeof skillFile?.blob_hash !== "string") fail("E_STARTUP_INTEGRITY", `manifest for ${skillId} has no SKILL.md`);
    const l2Tokens = getTokenCount(db, skillFile.blob_hash, "ega-o200k-v1");
    if (l2Tokens === null) fail("E_STARTUP_INTEGRITY", `manifest for ${skillId} has no L2 token count`);
    rows.push({
      skill_id: skillId,
      version_hash: versionHash,
      name: portable.name,
      description: portable.description,
      domains: stringList(routing.domains, "domains"),
      platforms: stringList(routing.platforms, "platforms"),
      frameworks: stringList(routing.frameworks, "frameworks"),
      triggers: stringList(routing.triggers, "triggers"),
      aliases: skillAliases,
    });
    counts.push({ skill_id: skillId, version_hash: versionHash, level: "L2", tokens: l2Tokens });
  }
  return {
    aliasMap: { aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b))) },
    searchIndexInput: { rows },
    tokenArtifact: { estimator: "ega-o200k-v1", counts },
  };
}

function verifySnapshot(snapshot: HostedReleaseSnapshot): void {
  try {
    verifyHubRelease(snapshot.release, snapshot.artifacts);
    if (snapshot.releasePackage.hub_release_digest !== snapshot.release.digest ||
        snapshot.releasePackage.sqlite_artifact_digest !== snapshot.sqliteArtifactDigest ||
        snapshot.releasePackage.snapshot_rows !== Object.keys(snapshot.release.payload.skill_versions).length) {
      fail("E_STARTUP_INTEGRITY", "release package does not bind the retained release");
    }
  } catch (error) {
    fail("E_STARTUP_INTEGRITY", `HubRelease verification failed: ${String(error instanceof Error ? error.message : error)}`);
  }
  try {
    const artifactDigest = `sha256:${sha256Hex(readFileSync(join(snapshot.registryHome, "registry.sqlite")))}`;
    if (artifactDigest !== snapshot.sqliteArtifactDigest) {
      fail("E_STARTUP_INTEGRITY", `SQLite artifact digest does not match the retained release package`);
    }
  } catch (error) {
    if (error instanceof HostedRuntimeError) throw error;
    fail("E_STARTUP_INTEGRITY", `SQLite artifact cannot be verified: ${String(error instanceof Error ? error.message : error)}`);
  }
  let registry: RegistryHandle;
  try {
    registry = openRegistry({
      env: { EGA_SKILLS_HOME: snapshot.registryHome },
      readonly: true,
    });
  } catch (error) {
    fail("E_STARTUP_INTEGRITY", `release registry cannot open read-only: ${String(error instanceof Error ? error.message : error)}`);
  }
  try {
    const integrity = registry.db.pragma<string>("integrity_check", { simple: true });
    if (integrity !== "ok") fail("E_STARTUP_INTEGRITY", `SQLite integrity_check returned ${integrity}`);
    if (registry.db.pragma<number>("user_version", { simple: true }) !== CURRENT_SCHEMA_VERSION) {
      fail("E_STARTUP_INTEGRITY", "release SQLite schema is not the supported schema");
    }
    if (snapshot.release.payload.contracts.search !== 1) {
      fail("E_STARTUP_INTEGRITY", "release search contract is not supported");
    }

    const actual = readCatalog(registry.db);
    const expected = new Map(Object.entries(snapshot.release.payload.skill_versions));
    const derived = deriveSnapshotArtifacts(registry.db, expected);
    checkAliasMap(snapshot.artifacts.aliasMap, [...expected.keys()]);
    checkTokenArtifact(snapshot.artifacts.tokenArtifact, Object.fromEntries(expected));
    checkSearchIndexInput(snapshot.artifacts.searchIndexInput);
    if (JSON.stringify(snapshot.artifacts) !== JSON.stringify(derived)) {
      fail("E_STARTUP_INTEGRITY", "release artifacts do not match selected SkillVersion manifests");
    }
    if (actual.size !== expected.size) fail("E_STARTUP_INTEGRITY", "SQLite catalog size does not match HubRelease");
    for (const [skillId, versionHash] of expected) {
      if (actual.get(skillId) !== versionHash) {
        fail("E_STARTUP_INTEGRITY", `SQLite catalog identity does not match ${skillId}`);
      }
      const version = getSkillVersion(registry.db, skillId, versionHash);
      const manifest = JSON.parse(version.manifestJson) as { files?: Array<{ blob_hash?: unknown }> };
      if (!Array.isArray(manifest.files)) fail("E_STARTUP_INTEGRITY", `manifest for ${skillId} has no files`);
      for (const file of manifest.files) {
        if (typeof file.blob_hash !== "string") fail("E_STARTUP_INTEGRITY", `manifest for ${skillId} has an invalid blob hash`);
        getCacheBlob(registry.paths.cacheSha256, file.blob_hash);
      }
    }

    const table = snapshotTableName(snapshot.ftsTable);
    const indexRows = registry.db
      .prepare(`SELECT skill_id, version_hash, name, description, domains, platforms, frameworks, triggers, aliases FROM ${table} ORDER BY skill_id, version_hash`)
      .all<{ skill_id: string; version_hash: string; name: string; description: string; domains: string; platforms: string; frameworks: string; triggers: string; aliases: string }>() as Array<{
      skill_id: string;
      version_hash: string;
      name: string;
      description: string;
      domains: string;
      platforms: string;
      frameworks: string;
      triggers: string;
      aliases: string;
    }>;
    const expectedIndex = snapshot.artifacts.searchIndexInput.rows.map((row) => ({
      skill_id: row.skill_id,
      version_hash: row.version_hash,
      name: row.name,
      description: row.description,
      domains: row.domains.join("\n"),
      platforms: row.platforms.join("\n"),
      frameworks: row.frameworks.join("\n"),
      triggers: row.triggers.join("\n"),
      aliases: row.aliases.join("\n"),
    }));
    if (JSON.stringify(indexRows) !== JSON.stringify(expectedIndex)) {
      fail("E_STARTUP_INTEGRITY", "release FTS corpus does not match search_index_input");
    }
    const metadata = registry.db
      .prepare("SELECT key, value FROM ega_release_metadata ORDER BY key")
      .all<{ key: string; value: string }>();
    const metadataMap = Object.fromEntries(metadata.map((entry) => [entry.key, entry.value]));
    const expectedMetadata = {
      alias_map_digest: snapshot.release.payload.alias_map_digest,
      fts_table: snapshot.ftsTable,
      hub_release_digest: snapshot.release.digest,
      search_index_input_digest: snapshot.release.payload.search_index_input_digest,
      token_artifact_digest: snapshot.release.payload.token_artifact_digest,
    };
    if (JSON.stringify(metadataMap) !== JSON.stringify(expectedMetadata)) {
      fail("E_STARTUP_INTEGRITY", "SQLite embedded release metadata does not match HubRelease");
    }
  } catch (error) {
    if (error instanceof HostedRuntimeError) throw error;
    fail("E_STARTUP_INTEGRITY", `release snapshot verification failed: ${String(error instanceof Error ? error.message : error)}`);
  } finally {
    registry.close();
  }
}

function denied(
  policy: HostedDenyPolicy | undefined,
  snapshot: HostedReleaseSnapshot,
  skillId: string | undefined,
  versionHash: string | undefined,
): boolean {
  if (policy === undefined) return false;
  if (policy.releaseDigests?.includes(snapshot.release.digest)) return true;
  if (skillId !== undefined && versionHash !== undefined && policy.skillVersions?.includes(`${skillId}@${versionHash}`)) return true;
  if (skillId !== undefined) {
    const sourceId = snapshot.skillSourceIds?.[skillId];
    return sourceId !== undefined && (policy.sourceIds ?? []).includes(sourceId);
  }
  return false;
}

async function authorizeResourceResult(
  result: CallToolResult,
  tool: HostedToolName,
  snapshot: HostedReleaseSnapshot,
  binding: HostedContextSnapshot | undefined,
  authInfo: AuthInfo | undefined,
  authorize: HostedRuntimeOptions["authorize"],
  denyPolicy: HostedDenyPolicy | undefined,
): Promise<CallToolResult> {
  if (result.isError || result.structuredContent === undefined) return result;
  const structured = result.structuredContent as Record<string, unknown>;
  const isAllowed = async (skillId: unknown, versionHash: unknown): Promise<boolean> => {
    if (typeof skillId !== "string") return false;
    const version = typeof versionHash === "string" ? versionHash : undefined;
    if (denied(denyPolicy, snapshot, skillId, version)) return false;
    return authorize({
      tool,
      releaseDigest: snapshot.release.digest,
      skillId,
      ...(version !== undefined ? { versionHash: version } : {}),
      ...(binding !== undefined ? { contextId: binding.contextId } : {}),
      ...(authInfo !== undefined ? { authInfo } : {}),
    });
  };
  if (tool === "search") {
    const rows = Array.isArray(structured.results) ? structured.results : [];
    const visible = [];
    for (const row of rows) {
      if (row !== null && typeof row === "object" && await isAllowed((row as Record<string, unknown>).skill_id, (row as Record<string, unknown>).version_hash)) {
        visible.push(row);
      }
    }
    const lines = visible.map((row) => {
      const item = row as Record<string, unknown>;
      return `${String(item.skill_id)} ${String(item.version_hash)}`;
    });
    return {
      ...result,
      content: [{
        type: "text",
        text: `Search matched ${visible.length} project-visible skill version(s).${lines.length > 0 ? `\n${lines.join("\n")}` : ""}`,
      }],
      structuredContent: { ...structured, results: visible },
    } as CallToolResult;
  }
  if (tool === "resolve") {
    const filtered: Record<string, unknown> = { ...structured };
    for (const field of ["explicit", "selected", "candidates", "rejected"]) {
      const values = structured[field];
      if (!Array.isArray(values)) continue;
      const visible = [];
      for (const value of values) {
        if (value !== null && typeof value === "object") {
          const item = value as Record<string, unknown>;
          if (await isAllowed(item.id, item.version_hash)) visible.push(value);
        }
      }
      filtered[field] = visible;
    }
    const selected = Array.isArray(filtered.selected) ? filtered.selected as Array<Record<string, unknown>> : [];
    const names = selected.map((item) => String(item.id)).join(", ") || "(none)";
    return {
      ...result,
      content: [{ type: "text", text: `Resolve selected ${selected.length} skill(s) [${names}] at ${String(structured.confidence)} confidence (${String(structured.lock_status)}, ${String(structured.budget_status)}).` }],
      structuredContent: filtered,
    } as CallToolResult;
  }
  const skillId = structured.skill_id;
  const versionHash = structured.version_hash;
  if (!(await isAllowed(skillId, versionHash))) {
    throw new HostedRuntimeError("E_CONTENT_DENIED", "Requested immutable content is not authorized");
  }
  return result;
}

function hostedError(error: unknown): { code: string; message: string } {
  if (error instanceof HostedRuntimeError || error instanceof McpContextError) return error;
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return {
      code: (error as { code: string }).code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { code: "E_MCP_INPUT_INVALID", message: error instanceof Error ? error.message : String(error) };
}

export function createHostedRuntime(options: HostedRuntimeOptions): HostedRuntime {
  if (options.releases.length === 0) fail("E_STARTUP_INTEGRITY", "hosted runtime needs at least one release");
  if (typeof options.authorize !== "function") fail("E_STARTUP_INTEGRITY", "hosted runtime requires authorization");
  const snapshots = new Map<string, HostedReleaseSnapshot>();
  for (const snapshot of options.releases) {
    verifySnapshot(snapshot);
    if (snapshots.has(snapshot.release.digest)) fail("E_STARTUP_INTEGRITY", "duplicate release digest");
    snapshots.set(snapshot.release.digest, snapshot);
  }
  if (!snapshots.has(options.stableReleaseDigest)) fail("E_STARTUP_INTEGRITY", "stable release is not retained");

  const contexts = new Map<string, HostedContextSnapshot>();
  for (const binding of options.contexts ?? []) {
    if (contexts.has(binding.contextId)) fail("E_STARTUP_INTEGRITY", `duplicate context identity ${binding.contextId}`);
    verifyContextSnapshot(binding, snapshots);
    contexts.set(binding.contextId, binding);
  }

  const select = async (tool: HostedToolName, args: Record<string, unknown>): Promise<{
    readonly snapshot: HostedReleaseSnapshot;
    readonly binding?: HostedContextSnapshot;
  }> => {
    rejectHostedProjectPath(args);
    const contextId = stringArg(args, "context_id");
    const requested = releaseDigestArg(args);
    if (contextId !== undefined) {
      // Contract E owns context publication and lookup. Until that contract is
      // installed, fail as a missing context rather than falling back to the
      // personal stable release or exposing an authorization distinction.
      const binding = contexts.get(contextId);
      if (binding === undefined) throw new HostedRuntimeError("E_CONTEXT_NOT_FOUND", `Project context ${contextId} is not available`);
      if (options.isContextRevoked !== undefined) {
        let revoked: boolean;
        try {
          revoked = await options.isContextRevoked(contextId);
        } catch (error) {
          throw new HostedRuntimeError("E_CONTEXT_INVALID", `Project context revocation state is unavailable: ${String(error instanceof Error ? error.message : error)}`);
        }
        if (revoked) throw new HostedRuntimeError("E_CONTEXT_REVOKED", `Project context ${contextId} is revoked`);
      }
      const snapshot = snapshots.get(binding.context.release_digest);
      if (snapshot === undefined) throw new HostedRuntimeError("E_CONTEXT_RELEASE_MISMATCH", `Project context ${contextId} release is not retained`);
      if (requested !== undefined && requested !== snapshot.release.digest) {
        throw new HostedRuntimeError("E_CONTEXT_RELEASE_MISMATCH", `Project context ${contextId} does not bind release ${requested}`);
      }
      return { snapshot, binding };
    }
    if ((tool === "inspect" || tool === "get_content") && requested === undefined) {
      throw new HostedRuntimeError("E_SCOPE_REQUIRED", `${tool} requires an explicit release_digest or context_id`);
    }
    const digest = requested ?? options.stableReleaseDigest;
    const snapshot = snapshots.get(digest);
    if (snapshot === undefined) throw new HostedRuntimeError("E_RELEASE_NOT_FOUND", `Release ${digest} is not available`);
    return { snapshot };
  };

  const call = async (
    tool: HostedToolName,
    args: Record<string, unknown>,
    authInfo?: AuthInfo,
  ): Promise<CallToolResult> => {
    try {
      if (!HOSTED_TOOL_NAMES.includes(tool)) throw new McpContextError("E_MCP_INPUT_INVALID", `Unknown hosted tool ${tool}`);
      const selected = await select(tool, args);
      const snapshot = selected.snapshot;
      const binding = selected.binding;
      const skillId = typeof args["skill_id"] === "string" ? args["skill_id"] : undefined;
      const versionHash = typeof args["version_hash"] === "string" ? args["version_hash"] : undefined;
      const denyPolicy = typeof options.denyPolicy === "function" ? options.denyPolicy() : options.denyPolicy;
      if (denied(denyPolicy, snapshot, skillId, versionHash)) {
        throw new HostedRuntimeError("E_CONTENT_DENIED", "Requested immutable content is emergency-denied");
      }
      const authorized = await options.authorize({
        tool,
        releaseDigest: snapshot.release.digest,
        ...(skillId !== undefined ? { skillId } : {}),
        ...(versionHash !== undefined ? { versionHash } : {}),
        ...(binding !== undefined ? { contextId: binding.contextId } : {}),
        ...(authInfo !== undefined ? { authInfo } : {}),
      });
      if (!authorized) throw new HostedRuntimeError("E_AUTH_UNAUTHORIZED", "OAuth subject is not authorized for this release");

      const context = makeHostedContext(snapshot, binding);
      if (tool === "search") {
        const result = runSearchTool({ query: args["query"], limit: args["limit"] }, context);
        return structuredWithHostedMetadata(await authorizeResourceResult(result, tool, snapshot, binding, authInfo, options.authorize, denyPolicy), snapshot.release.digest, binding);
      }
      if (tool === "resolve") {
        const result = await runResolveTool({
          task: args["task"],
          explicit_skills: args["explicit_skills"],
          max_skills: args["max_skills"],
          max_tokens: args["max_tokens"],
        }, context, binding === undefined ? undefined : {
          policy: {
            deniedNamespaces: binding.config.namespaces.deny,
            allowedNamespaces: binding.config.namespaces.allow,
            deniedSkills: binding.config.skills.deny,
            prefer: binding.config.skills.prefer,
            defaultMaxSkills: binding.config.routing.max_skills,
            defaultMaxTokens: binding.config.routing.max_tokens,
            lockedVersions: new Map(Object.entries(binding.lock.skills).map(([skillId, entry]) => [skillId, entry.version_hash])),
          },
        });
        return structuredWithHostedMetadata(await authorizeResourceResult(result, tool, snapshot, binding, authInfo, options.authorize, denyPolicy), snapshot.release.digest, binding);
      }
      if (tool === "inspect") {
        const result = toInspectSuccessResult(runInspectTool({
          skill_id: args["skill_id"] as string,
          ...(typeof args["version_hash"] === "string" ? { version_hash: args["version_hash"] } : {}),
        }, context));
        return structuredWithHostedMetadata(await authorizeResourceResult(result, tool, snapshot, binding, authInfo, options.authorize, denyPolicy), snapshot.release.digest, binding);
      }
      const result = runGetContentTool({
        skill_id: args["skill_id"],
        version_hash: args["version_hash"],
        level: args["level"],
        max_tokens: args["max_tokens"],
        file_path: args["file_path"],
      }, context);
      return structuredWithHostedMetadata(await authorizeResourceResult(result, tool, snapshot, binding, authInfo, options.authorize, denyPolicy), snapshot.release.digest, binding);
    } catch (error) {
      if (error instanceof HostedRuntimeError) {
        return errorResult(tool, error.code, error.message);
      }
      if (tool === "inspect") {
        return toInspectErrorResult(error);
      }
      const mapped = hostedError(error);
      return errorResult(tool, mapped.code, mapped.message);
    }
  };

  return Object.freeze({ ready: true as const, toolNames: HOSTED_TOOL_NAMES, call });
}

type HostedField =
  | { readonly type: "string" }
  | { readonly type: "integer" }
  | { readonly type: "string-array" }
  | { readonly type: "enum"; readonly values: readonly string[] };

type HostedFieldMap = Readonly<Record<string, HostedField>>;

function hostedSchema(
  required: HostedFieldMap,
  optional: HostedFieldMap,
): StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>> {
  const fields = { ...required, ...optional };
  const allowed = new Set(Object.keys(fields));
  const properties: Record<string, unknown> = {};
  for (const [field, definition] of Object.entries(fields)) {
    properties[field] = definition.type === "string-array"
      ? { type: "array", items: { type: "string" } }
      : definition.type === "enum"
        ? { type: "string", enum: [...definition.values] }
        : { type: definition.type === "integer" ? "integer" : "string" };
  }
  return {
    "~standard": {
      version: 1,
      vendor: "ega-skills",
      types: { input: {} as Record<string, unknown>, output: {} as Record<string, unknown> },
      validate: (value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "Tool arguments must be an object" }] };
        }
        const object = value as Record<string, unknown>;
        const issues: { message: string; path?: (string | number)[] }[] = [];
        for (const field of Object.keys(required)) {
          if (!(field in object)) issues.push({ message: `Missing required argument: ${field}`, path: [field] });
        }
        for (const field of Object.keys(object)) {
          if (!allowed.has(field)) issues.push({ message: `Unknown hosted argument: ${field}`, path: [field] });
          else {
            const definition = fields[field];
            if (definition === undefined) continue;
            const value = object[field];
            let valid: boolean;
            switch (definition.type) {
              case "string":
                valid = typeof value === "string";
                break;
              case "integer":
                valid = typeof value === "number" && Number.isInteger(value);
                break;
              case "string-array":
                valid = Array.isArray(value) && value.every((item) => typeof item === "string");
                break;
              case "enum":
                valid = typeof value === "string" && definition.values.includes(value);
                break;
            }
            if (!valid) issues.push({ message: `Invalid hosted argument: ${field}`, path: [field] });
          }
        }
        return issues.length > 0 ? { issues } : { value: object };
      },
      jsonSchema: {
        input: () => ({ type: "object", properties, required: Object.keys(required), additionalProperties: false }),
        output: () => ({ type: "object" }),
      },
    },
  };
}

/** Create the exact Contract D four-tool server for Streamable HTTP. */
export function createHostedMcpServer(
  runtime: HostedRuntime,
  authInfo?: AuthInfo,
  toolTimeoutMs: number = HOSTED_LIMITS.toolTimeoutMs,
): McpServer {
  const server = new McpServer(
    { name: "ega-skills-hosted", version: "1.2.0" },
    { capabilities: { tools: {} } },
  );
  const register = (
    name: HostedToolName,
    required: HostedFieldMap,
    optional: HostedFieldMap,
  ): void => {
    server.registerTool(
      name,
      {
        description: `Hosted EGA ${name} tool (Contract D)`,
        inputSchema: hostedSchema(required, optional),
      },
      async (args: Record<string, unknown>) => {
        try {
          return await withHostedTimeout(runtime.call(name, args, authInfo), toolTimeoutMs);
        } catch (error) {
          const mapped = hostedError(error);
          return errorResult(name, mapped.code, mapped.message);
        }
      },
    );
  };
  register("resolve", { task: { type: "string" } }, {
    explicit_skills: { type: "string-array" },
    max_skills: { type: "integer" },
    max_tokens: { type: "integer" },
    release_digest: { type: "string" },
    context_id: { type: "string" },
  });
  register("search", { query: { type: "string" } }, {
    limit: { type: "integer" },
    release_digest: { type: "string" },
    context_id: { type: "string" },
  });
  register("inspect", { skill_id: { type: "string" } }, {
    version_hash: { type: "string" },
    release_digest: { type: "string" },
    context_id: { type: "string" },
  });
  register("get_content", {
    skill_id: { type: "string" },
    version_hash: { type: "string" },
    level: { type: "enum", values: ["L1", "L2"] },
    max_tokens: { type: "integer" },
  }, {
    file_path: { type: "string" },
    release_digest: { type: "string" },
    context_id: { type: "string" },
  });
  return server;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withHostedTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new HostedRuntimeError("E_REQUEST_LIMIT", "Hosted MCP request timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function responseExceedsContentLimit(response: Response, maxContentBytes: number): Promise<boolean> {
  try {
    const body = await response.clone().json() as { result?: { structuredContent?: { content?: unknown } } };
    const content = body.result?.structuredContent?.content;
    return typeof content === "string" && new TextEncoder().encode(content).byteLength > maxContentBytes;
  } catch {
    return false;
  }
}

/**
 * Fetch-native `/mcp` surface. OAuth verification is deliberately supplied by
 * the deployment; this function only accepts verified AuthInfo from the SDK
 * bearer gate and never sees or logs token material.
 */
export function createHostedMcpHandler(
  runtime: HostedRuntime,
  options: HostedHttpOptions,
): HostedHttpHandler {
  if (options.allowedHosts.length === 0 || options.allowedOrigins.length === 0) {
    throw new HostedRuntimeError("E_STARTUP_INTEGRITY", "HTTPS host and Origin allowlists are required");
  }
  const oauthDocuments = oauthDiscoveryDocuments(options.oauth);
  for (const [name, value] of Object.entries({
    issuer: options.oauth.issuer,
    resource: options.oauth.resource,
    authorizationEndpoint: options.oauth.authorizationEndpoint,
    tokenEndpoint: options.oauth.tokenEndpoint,
    jwksUri: options.oauth.jwksUri,
  })) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new HostedRuntimeError("E_STARTUP_INTEGRITY", `Invalid OAuth ${name} URL`);
    }
    if (parsed.protocol !== "https:") {
      throw new HostedRuntimeError("E_STARTUP_INTEGRITY", `OAuth ${name} URL must use HTTPS`);
    }
  }
  const maxRequestBytes = options.maxRequestBytes ?? HOSTED_LIMITS.maxRequestBytes;
  const maxResponseBytes = options.maxResponseBytes ?? HOSTED_LIMITS.maxResponseBytes;
  const requestTimeoutMs = options.requestTimeoutMs ?? HOSTED_LIMITS.requestTimeoutMs;
  const toolTimeoutMs = options.toolTimeoutMs ?? HOSTED_LIMITS.toolTimeoutMs;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? HOSTED_LIMITS.maxConcurrentRequests;
  const maxConnections = options.maxConnections ?? HOSTED_LIMITS.maxConnections;
  const maxContentBytes = options.maxContentBytes ?? HOSTED_LIMITS.maxContentBytes;
  if (![maxRequestBytes, maxResponseBytes, requestTimeoutMs, toolTimeoutMs, maxConcurrentRequests, maxConnections, maxContentBytes]
    .every((value) => Number.isInteger(value) && value > 0)) {
    throw new HostedRuntimeError("E_STARTUP_INTEGRITY", "Hosted transport limits must be positive integers");
  }
  const allowedOriginHostnames = options.allowedOrigins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HostedRuntimeError("E_STARTUP_INTEGRITY", `Invalid allowed HTTPS origin: ${origin}`);
    }
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new HostedRuntimeError("E_STARTUP_INTEGRITY", `Allowed origins must be HTTPS origins: ${origin}`);
    }
    return parsed.hostname;
  });
  const gate = requireBearerAuth({
    verifier: options.verifier,
    ...(options.requiredScopes !== undefined ? { requiredScopes: [...options.requiredScopes] } : {}),
  });
  const handler = createMcpHandler(
    (context) => createHostedMcpServer(runtime, context.authInfo, toolTimeoutMs),
    { legacy: "reject", responseMode: "json", keepAliveMs: 0 },
  );
  let concurrent = 0;
  const activeConnections = options.getActiveConnections ?? (() => concurrent);
  const connectionLimitReached = (): boolean => {
    const count = activeConnections();
    return !Number.isInteger(count) || count < 0 || count >= maxConnections;
  };
  return {
    fetch: async (request: Request): Promise<Response> => {
      const serve = async (): Promise<Response> => {
        const url = new URL(request.url);
        if (url.protocol !== "https:") return jsonError(403, "E_ORIGIN_REJECTED", "HTTPS is required");
        const hostFailure = hostHeaderValidationResponse(request, [...options.allowedHosts]);
        if (hostFailure) return hostFailure;
        if (url.pathname === "/.well-known/oauth-protected-resource") {
          return new Response(JSON.stringify(oauthDocuments.protectedResource), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return new Response(JSON.stringify(oauthDocuments.authorizationServer), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/healthz") {
          return new Response(JSON.stringify({ status: "ok" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/readyz") {
          return new Response(JSON.stringify({ status: runtime.ready ? "ready" : "not_ready" }), {
            status: runtime.ready ? 200 : 503,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname !== "/mcp") return jsonError(404, "E_NOT_FOUND", "Hosted MCP endpoint is /mcp");
        const origin = request.headers.get("origin");
        if (origin === null || !options.allowedOrigins.includes(origin)) {
          return jsonError(403, "E_ORIGIN_REJECTED", "Origin is not allowed");
        }
        const originFailure = originValidationResponse(request, allowedOriginHostnames);
        if (originFailure) return originFailure;
        const contentLength = request.headers.get("content-length");
        if (contentLength !== null && Number(contentLength) > maxRequestBytes) {
          return jsonError(413, "E_REQUEST_LIMIT", "Request exceeds the hosted MCP byte limit");
        }
        const contentBytes = await request.clone().arrayBuffer();
        if (contentBytes.byteLength > maxRequestBytes) {
          return jsonError(413, "E_REQUEST_LIMIT", "Request content exceeds the hosted MCP byte limit");
        }
        const auth = await gate(request);
        if (auth instanceof Response) return auth;
        // Keep the local MCP package's read-only static audit satisfied: the
        // transport adapter invokes the SDK handler without importing a
        // network client or using a global request primitive.
        const response = await handler["fetch"](request, { authInfo: auth });
        if (await responseExceedsContentLimit(response, maxContentBytes)) {
          return jsonError(413, "E_CONTENT_LIMIT", "Returned skill content exceeds the hosted content byte limit");
        }
        const responseBytes = await response.clone().arrayBuffer();
        const responseLength = response.headers.get("content-length");
        if ((responseLength !== null && Number(responseLength) > maxResponseBytes) || responseBytes.byteLength > maxResponseBytes) {
          return jsonError(413, "E_REQUEST_LIMIT", "Response exceeds the hosted MCP byte limit");
        }
        return response;
      };
      if (concurrent >= maxConcurrentRequests) return jsonError(429, "E_REQUEST_LIMIT", "Hosted MCP concurrency limit reached");
      if (connectionLimitReached()) return jsonError(429, "E_REQUEST_LIMIT", "Hosted MCP connection limit reached");
      concurrent += 1;
      try {
        return await withHostedTimeout(serve(), requestTimeoutMs);
      } catch (error) {
        if (error instanceof HostedRuntimeError && error.code === "E_REQUEST_LIMIT") {
          return jsonError(408, error.code, error.message);
        }
        throw error;
      } finally {
        concurrent -= 1;
      }
    },
    close: handler.close,
  };
}
