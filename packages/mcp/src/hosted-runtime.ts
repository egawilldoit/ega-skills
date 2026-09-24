/** Shared hosted runtime bootstrap (Contract D + Contract F).
 *
 * ONE construction path serves BOTH:
 * - `bin/ega-mcp-hosted.mjs` (local smoke adapter)
 * - `server.ts` (Vercel Node server entrypoint, Root Directory `packages/mcp`)
 *
 * Startup is atomic and fail-closed: env validation, authorization-source
 * resolution, immutable release verification (`loadHostedReleaseSnapshot`),
 * policy validation, and control-plane construction all complete before a
 * handler is published. Any failure throws with a sanitized message — never
 * policy contents, never secrets.
 *
 * Authorization source precedence (explicit, deterministic):
 * - `EGA_HOSTED_AUTHZ_JSON` wins when both JSON and FILE are configured.
 * - `EGA_HOSTED_AUTHZ_FILE` remains supported for local/VM usage.
 * - Malformed JSON or an invalid policy fails startup.
 *
 * The request path stays read-only and stateless: the bundled SQLite/release
 * files are opened read-only/verified, no local mutation, no git, no package
 * installation, no release generation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { InMemoryControlPlane, WORKSPACE_ROLES, type WorkspaceRole } from "@ega-skills/control-plane";
import {
  createHostedMcpHandler,
  loadHostedReleaseSnapshot,
  type HostedPrincipal,
  type HostedReleaseSnapshot,
} from "./hosted.js";
import { createJwksBearerVerifier } from "./hosted-auth.js";
import { buildProtectedResourceMetadata, parseHostedOAuthConfig, type HostedOAuthConfig } from "./hosted-oauth.js";
import { createSupabaseContextResolver } from "./hosted-supabase.js";
import { loadRetainedReleaseSet, resolveRetainedRelease, type RetainedReleaseSet } from "./retained.js";

export const DEFAULT_HOSTED_MAX_BODY_BYTES = 1_048_576;
export const DEFAULT_HOSTED_MAX_RESPONSE_BYTES = 4 * 1_048_576;
export const DEFAULT_HOSTED_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_HOSTED_MAX_CONCURRENT_REQUESTS = 32;

const ALLOWED_POLICY_KEYS = [
  "authorized_subjects",
  "denied_releases",
  "denied_skills",
  "denied_sources",
  "denies",
  "memberships",
  "owner_subject",
  "visibility",
  "workspace_id",
].sort();

const WORKSPACE_ROLE_SET: ReadonlySet<string> = new Set<string>(WORKSPACE_ROLES);

export interface HostedAuthzPolicy {
  readonly workspace_id: string;
  readonly visibility: "private" | "workspace" | "public";
  readonly owner_subject: string;
  readonly memberships: readonly {
    readonly subject: string;
    readonly role: string;
    readonly active: boolean;
  }[];
  readonly denies: readonly string[];
  readonly authorized_subjects?: readonly string[];
  readonly denied_releases?: readonly string[];
  readonly denied_skills?: readonly string[];
  readonly denied_sources?: readonly string[];
}

export interface HostedRuntimeHandle {
  readonly snapshot: HostedReleaseSnapshot;
  readonly handler: McpHttpHandler;
  readonly maxBodyBytes: number;
  readonly maxResponseBytes: number;
  /** Public OAuth Protected Resource Metadata (RFC 9728), when configured. */
  readonly protectedResourceMetadata: unknown;
}

function requiredEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** Validate and normalize the trusted Origin allow-list once, at startup.
 *
 * Entries must be bare origins: scheme + host (+ optional port), HTTPS in
 * production (loopback HTTP allowed for local development), no path, query,
 * fragment, credentials, or wildcard. Invalid configuration fails startup.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("EGA_HOSTED_ALLOWED_ORIGINS is required; hosted Origin policy must fail closed");
  }
  const origins: string[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("EGA_HOSTED_ALLOWED_ORIGINS contains a malformed origin");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
      throw new Error("EGA_HOSTED_ALLOWED_ORIGINS entries must use HTTPS");
    }
    if (url.username !== "" || url.password !== "") throw new Error("EGA_HOSTED_ALLOWED_ORIGINS entries must not contain credentials");
    if (url.search !== "" || url.hash !== "") throw new Error("EGA_HOSTED_ALLOWED_ORIGINS entries must not contain a query or fragment");
    if (url.pathname !== "" && url.pathname !== "/") throw new Error("EGA_HOSTED_ALLOWED_ORIGINS entries must not contain a path");
    if (value.includes("*")) throw new Error("EGA_HOSTED_ALLOWED_ORIGINS must not contain wildcards");
    origins.push(url.origin);
  }
  const unique = [...new Set(origins)];
  if (unique.length === 0) {
    throw new Error("EGA_HOSTED_ALLOWED_ORIGINS is required; hosted Origin policy must fail closed");
  }
  return unique;
}

/** Resolve a configured artifact directory deterministically.
 *
 * As-given first (relative paths resolve against the process working
 * directory, e.g. the package root locally). Function bundles may run with a
 * different working directory, so a relative path that is missing under the
 * cwd falls back to the artifact directory shipped alongside the built
 * output (dist/../artifact). Absolute paths are used verbatim. When neither
 * candidate exists the configured value is returned unchanged and the
 * existing snapshot verification still fails closed.
 */
export function resolveArtifactDir(configured: string): string {
  if (isAbsolutePath(configured) || existsSync(configured)) return configured;
  const moduleBase = (import.meta as unknown as { dirname?: unknown }).dirname;
  if (typeof moduleBase === "string") {
    const sibling = join(moduleBase, "..", "artifact");
    if (existsSync(sibling)) return sibling;
  }
  return configured;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

/** Resolve the authorization document source. JSON env wins deterministically. */
export function readHostedAuthzSource(env: Readonly<Record<string, string | undefined>>): {
  readonly kind: "json-env" | "file";
  readonly raw: string;
} {
  const jsonRaw = env["EGA_HOSTED_AUTHZ_JSON"];
  const fileRaw = env["EGA_HOSTED_AUTHZ_FILE"];
  if (jsonRaw !== undefined) {
    if (jsonRaw.trim() === "") {
      throw new Error("EGA_HOSTED_AUTHZ_JSON is set but empty; hosted authorization must fail closed");
    }
    return { kind: "json-env", raw: jsonRaw };
  }
  if (fileRaw !== undefined) {
    const file = fileRaw.trim();
    if (file === "") {
      throw new Error("EGA_HOSTED_AUTHZ_FILE is set but empty; hosted authorization must fail closed");
    }
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      throw new Error("hosted authorization file cannot be read");
    }
    return { kind: "file", raw };
  }
  throw new Error("EGA_HOSTED_AUTHZ_JSON or EGA_HOSTED_AUTHZ_FILE is required; hosted authorization must fail closed");
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** SAME shape validation that protects hosted startup. Never weakened. */
export function validateHostedAuthzPolicy(policy: unknown): asserts policy is HostedAuthzPolicy {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("hosted authorization policy has invalid shape");
  }
  const record = policy as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.some((key) => !ALLOWED_POLICY_KEYS.includes(key))) {
    throw new Error("hosted authorization policy has invalid shape");
  }
  if (
    typeof record["workspace_id"] !== "string" ||
    typeof record["visibility"] !== "string" ||
    !["private", "workspace", "public"].includes(record["visibility"] as string) ||
    typeof record["owner_subject"] !== "string" ||
    !Array.isArray(record["memberships"]) ||
    !Array.isArray(record["denies"])
  ) {
    throw new Error("hosted authorization policy has invalid shape");
  }
  for (const key of ["authorized_subjects", "denied_releases", "denied_skills", "denied_sources"] as const) {
    const value = record[key];
    if (value !== undefined && !isStringArray(value)) {
      throw new Error("hosted authorization policy has invalid shape");
    }
  }
  for (const membership of record["memberships"] as unknown[]) {
    if (
      membership === null ||
      typeof membership !== "object" ||
      typeof (membership as { subject?: unknown }).subject !== "string" ||
      !WORKSPACE_ROLE_SET.has((membership as { role?: unknown }).role as string) ||
      typeof (membership as { active?: unknown }).active !== "boolean"
    ) {
      throw new Error("hosted authorization membership has invalid shape");
    }
  }
  for (const denied of record["denies"] as unknown[]) {
    if (typeof denied !== "string") throw new Error("hosted authorization deny has invalid shape");
  }
}

export function parseHostedAuthzPolicy(raw: string): HostedAuthzPolicy {
  let policy: unknown;
  try {
    policy = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("hosted authorization policy is invalid JSON");
  }
  validateHostedAuthzPolicy(policy);
  return policy;
}

/** Build the exact hardened runtime from env. Throws sanitized errors only. */
export function createHostedRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<Record<string, string | undefined>>,
): HostedRuntimeHandle {
  const artifactDir = requiredEnv(env["EGA_HOSTED_ARTIFACT_DIR"]);
  const retainedManifestPath = requiredEnv(env["EGA_HOSTED_RETAINED_MANIFEST"]);
  const expectedToken = requiredEnv(env["EGA_HOSTED_BEARER_TOKEN"]);
  const allowStaticToken = env["EGA_HOSTED_ALLOW_STATIC_TOKEN"] === "true";
  const issuer = requiredEnv(env["EGA_HOSTED_ISSUER"]);
  const audience = requiredEnv(env["EGA_HOSTED_AUDIENCE"]);
  const jwksUrl = requiredEnv(env["EGA_HOSTED_JWKS_URL"]);
  const supabaseUrl = requiredEnv(env["EGA_HOSTED_SUPABASE_URL"]);
  const supabaseSecretKey = requiredEnv(env["EGA_HOSTED_SUPABASE_SECRET_KEY"]);
  const allowedOrigins = parseAllowedOrigins(env["EGA_HOSTED_ALLOWED_ORIGINS"]);

  if (!artifactDir && !retainedManifestPath) {
    throw new Error("EGA_HOSTED_ARTIFACT_DIR or EGA_HOSTED_RETAINED_MANIFEST is required");
  }
  // Production authentication is JWKS/JWT only. Partial JWT configuration
  // always fails closed; a shared literal token is allowed ONLY when the
  // deployment explicitly opts in for local development, deterministic
  // tests, or smoke fixtures.
  const jwtParts = [issuer, audience, jwksUrl].filter((value) => value !== undefined);
  if (jwtParts.length !== 0 && jwtParts.length !== 3) {
    throw new Error("EGA_HOSTED_ISSUER, EGA_HOSTED_AUDIENCE, and EGA_HOSTED_JWKS_URL must be configured together");
  }
  const useJwt = jwtParts.length === 3;
  if (!useJwt) {
    if (!expectedToken) {
      throw new Error("hosted JWT configuration (issuer/audience/JWKS) is required");
    }
    if (!allowStaticToken) {
      throw new Error("EGA_HOSTED_BEARER_TOKEN requires EGA_HOSTED_ALLOW_STATIC_TOKEN=true; static tokens are not a production authentication mode");
    }
  }
  if ((supabaseUrl && !supabaseSecretKey) || (!supabaseUrl && supabaseSecretKey)) {
    throw new Error("EGA_HOSTED_SUPABASE_URL and EGA_HOSTED_SUPABASE_SECRET_KEY must be configured together");
  }

  // OAuth discovery is part of production authentication: it is validated
  // once here, never derived from request headers. Local smoke mode may skip
  // discovery entirely, or configure it explicitly for interop fixtures.
  const resourceUrl = requiredEnv(env["EGA_HOSTED_RESOURCE_URL"]);
  const oauth: HostedOAuthConfig | undefined =
    useJwt || resourceUrl !== undefined
      ? parseHostedOAuthConfig({
          resourceUrl,
          authorizationServers: env["EGA_HOSTED_AUTHORIZATION_SERVERS"],
          scopesSupported: env["EGA_HOSTED_OAUTH_SCOPES_SUPPORTED"],
          defaultAuthorizationServer: issuer,
        })
      : undefined;
  if (useJwt && oauth && audience !== oauth.resource) {
    throw new Error("EGA_HOSTED_AUDIENCE must equal EGA_HOSTED_RESOURCE_URL for dedicated-resource JWT validation");
  }

  const maxBodyBytes = positiveInt(env["EGA_HOSTED_MAX_BODY_BYTES"], DEFAULT_HOSTED_MAX_BODY_BYTES, "EGA_HOSTED_MAX_BODY_BYTES");
  const maxResponseBytes = positiveInt(
    env["EGA_HOSTED_MAX_RESPONSE_BYTES"],
    DEFAULT_HOSTED_MAX_RESPONSE_BYTES,
    "EGA_HOSTED_MAX_RESPONSE_BYTES",
  );
  const requestTimeoutMs = positiveInt(
    env["EGA_HOSTED_REQUEST_TIMEOUT_MS"],
    DEFAULT_HOSTED_REQUEST_TIMEOUT_MS,
    "EGA_HOSTED_REQUEST_TIMEOUT_MS",
  );
  const maxConcurrentRequests = positiveInt(
    env["EGA_HOSTED_MAX_CONCURRENT_REQUESTS"],
    DEFAULT_HOSTED_MAX_CONCURRENT_REQUESTS,
    "EGA_HOSTED_MAX_CONCURRENT_REQUESTS",
  );

  // Immutable verified release first: a failed check never publishes a
  // partially verified snapshot. A retained manifest is the source of truth
  // when configured; the legacy single-artifact path remains supported.
  const retained: RetainedReleaseSet | undefined = retainedManifestPath
    ? loadRetainedReleaseSet(retainedManifestPath)
    : undefined;
  const snapshot = retained?.defaultSnapshot ?? loadHostedReleaseSnapshot(resolveArtifactDir(artifactDir as string));
  const policy = parseHostedAuthzPolicy(readHostedAuthzSource(env).raw);

  const controlPlane = new InMemoryControlPlane();
  const hubId = snapshot.release.payload.hub_id;
  controlPlane.setResource(hubId, {
    workspaceId: policy.workspace_id,
    visibility: policy.visibility,
    ownerSubject: policy.owner_subject,
    ...(policy.authorized_subjects ? { authorizedSubjects: [...policy.authorized_subjects] } : {}),
  });
  for (const membership of policy.memberships) {
    controlPlane.addMembership(policy.workspace_id, {
      subject: membership.subject,
      role: membership.role as WorkspaceRole,
      active: membership.active,
    });
  }
  for (const denied of policy.denies) {
    controlPlane.deny(denied);
  }
  const deniedSkills = new Set(policy.denied_skills ?? []);
  const deniedSources = new Set(policy.denied_sources ?? []);
  const deniedReleases = new Set(policy.denied_releases ?? []);

  const resolveRetained = retained
    ? async (releaseDigest: string): Promise<HostedReleaseSnapshot> => resolveRetainedRelease(loadRetainedReleaseSet(retained.manifestPath), releaseDigest)
    : undefined;
  let resolveContext: ((contextId: string, principal: HostedPrincipal, signal: AbortSignal) => Promise<HostedReleaseSnapshot>) | undefined;
  if (supabaseUrl && supabaseSecretKey) {
    resolveContext = createSupabaseContextResolver({
      supabaseUrl,
      secretKey: supabaseSecretKey,
      resolveRelease: async (releaseDigest) => {
        if (resolveRetained) return resolveRetained(releaseDigest);
        if (releaseDigest !== snapshot.releaseDigest) throw new Error("release unavailable");
        return snapshot;
      },
    });
  }

  const requiredScope = requiredEnv(env["EGA_HOSTED_REQUIRED_SCOPE"]);
  const jwksMaxAgeRaw = requiredEnv(env["EGA_HOSTED_JWKS_MAX_AGE_MS"]);
  const jwksRefreshCooldownRaw = requiredEnv(env["EGA_HOSTED_JWKS_REFRESH_COOLDOWN_MS"]);
  const handler = createHostedMcpHandler(snapshot, {
    allowedOrigins,
    ...(oauth ? { oauth } : {}),
    verifyBearer: useJwt
      ? createJwksBearerVerifier({
          issuer: issuer as string,
          audience: audience as string,
          jwksUrl: jwksUrl as string,
          // Supabase user/OAuth access tokens may not contain an
          // application-specific scope. Authorization is still enforced by
          // the authenticated subject plus the control-plane/RLS graph.
          // A whitespace-only scope is treated as unset (never a valid
          // scope); deployments needing a scope set it explicitly.
          ...(requiredScope ? { requiredScope } : {}),
          ...(jwksMaxAgeRaw !== undefined
            ? { jwksMaxAgeMs: positiveInt(jwksMaxAgeRaw, DEFAULT_HOSTED_REQUEST_TIMEOUT_MS, "EGA_HOSTED_JWKS_MAX_AGE_MS") }
            : {}),
          ...(jwksRefreshCooldownRaw !== undefined
            ? {
                jwksRefreshCooldownMs: positiveInt(
                  jwksRefreshCooldownRaw,
                  DEFAULT_HOSTED_REQUEST_TIMEOUT_MS,
                  "EGA_HOSTED_JWKS_REFRESH_COOLDOWN_MS",
                ),
              }
            : {}),
        })
      : async (token) => {
          if (token !== expectedToken) throw new Error("invalid token");
          return { subject: "local-smoke", scopes: ["ega:read"] };
        },
    authorize: async (principal) => controlPlane.authorize(hubId, principal.subject, "read_hub"),
    ...(resolveContext ? { resolveContext } : {}),
    ...(retained
      ? {
          resolveStableRelease: async () => loadRetainedReleaseSet(retained.manifestPath).defaultSnapshot,
          resolveRelease: async (releaseDigest: string) => resolveRetainedRelease(loadRetainedReleaseSet(retained.manifestPath), releaseDigest),
        }
      : {}),
    deniedSkills,
    deniedSources,
    deniedReleases,
    maxBodyBytes,
    maxResponseBytes,
    requestTimeoutMs,
    maxConcurrentRequests,
  });

  return {
    snapshot,
    handler,
    maxBodyBytes,
    maxResponseBytes,
    protectedResourceMetadata: oauth ? buildProtectedResourceMetadata(oauth) : undefined,
  };
}
