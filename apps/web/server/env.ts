/**
 * Console server environment: parse, validate, freeze, fail closed.
 *
 * Every value the BFF reads at startup passes through here exactly once. The
 * rules are deliberately unforgiving:
 *
 * 1. A **blank or whitespace-only** variable is *unset*, never a configured
 *    empty value. Builder 1 shipped the same rule in `server.mts:117-123`
 *    (`defaultReadinessProbe`) after the readiness probe read a declared-but-
 *    blank Vercel env var as a real path. A whitespace artifact directory here
 *    would resolve to nothing and produce a confusing downstream error instead
 *    of "not configured".
 * 2. Every digest-shaped value is checked against the canonical database
 *    constraint `^sha256:[0-9a-f]{64}$`. A malformed expectation fails startup;
 *    it never degrades to "no expectation configured", because that would turn
 *    a configuration defect into an honest-looking `unpinned` release.
 * 3. **No secret or raw env value ever appears in an error message.** Error
 *    text names the variable and the rule it broke, nothing else.
 *
 * The parse function takes an explicit record so tests can build isolated
 * scenarios without mutating `process.env`. `loadServerConfig()` is the
 * `process.env` convenience wrapper; production code should prefer passing a
 * config explicitly into `release-identity.ts` / `registry.ts`.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import { resolveArtifactDir } from "@ega-skills/mcp";

/**
 * Canonical digest form, identical to the `check` constraints in
 * `supabase/migrations/202609090003_*.sql` and to `DIGEST_RE` in
 * `packages/mcp/src/retained.ts`. Lowercase hex only: an uppercase digest is a
 * *different* byte string to `sha256Hex`, so accepting it would silently bind
 * identity to a digest nothing else in the system would ever compare equal.
 */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** True for a canonical `sha256:<64 lowercase hex>` string. */
export function isCanonicalDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

/** Env var names this module owns. `VITE_`-prefixed values are never read. */
export const SERVER_ENV_KEYS = [
  "EGA_WEB_ARTIFACT_DIR",
  "EGA_WEB_RETAINED_MANIFEST",
  "EGA_WEB_EXPECTED_RELEASE_DIGEST",
  "EGA_SUPABASE_URL",
  "EGA_SUPABASE_SECRET_KEY",
] as const;

export type ServerEnvKey = (typeof SERVER_ENV_KEYS)[number];

/**
 * Typed, sanitized startup failure.
 *
 * `code` is a stable machine identifier the BFF maps to an HTTP status;
 * `message` is written for an operator reading `/readyz` output and is
 * guaranteed free of env values, secrets, and paths beyond variable names.
 */
export class ServerConfigError extends Error {
  readonly code: string;
  /** The variable that failed, when the failure is attributable to one. */
  readonly variable: string | null;

  constructor(code: string, message: string, variable: string | null = null) {
    super(message);
    this.name = "ServerConfigError";
    this.code = code;
    this.variable = variable;
  }
}

/**
 * The one option `parseServerConfig` accepts.
 *
 * `requireArtifactDir: false` skips the on-disk existence check. Tests use it
 * when they are only exercising blank-normalization, so the existence rule
 * cannot mask the blank rule.
 */
export interface ParseServerConfigOptions {
  readonly requireArtifactDir?: boolean;
}

/** A validated, frozen server configuration. */
export interface ServerConfig {
  /**
   * Absolute resolved artifact directory, or `null` when unconfigured.
   *
   * Resolution reuses `resolveArtifactDir` from `@ega-skills/mcp` — the exact
   * function the hosted runtime uses — so the console and hosted MCP can never
   * disagree about which directory a configured value means. A relative value
   * resolves against the working directory first, then against the artifact
   * directory shipped beside the built output, exactly as SPEC-006 requires.
   */
  readonly artifactDir: string | null;
  /** Absolute retained-manifest path, or `null` when unconfigured. */
  readonly retainedManifestPath: string | null;
  /** Canonical expected release digest, or `null` when unconfigured. */
  readonly expectedReleaseDigest: string | null;
  readonly supabaseUrl: string | null;
  /** Present only as a value: never rendered, never logged, never compared. */
  readonly supabaseSecretKey: string | null;
  /** True when an authoritative expected digest is configured. */
  readonly hasExpectedReleaseDigest: boolean;
  /** True when at least one release source is configured at all. */
  readonly hasReleaseSource: boolean;
}

/**
 * Blank and whitespace-only means *unset*.
 *
 * This is the single normalization rule for every variable below. It is the
 * bug Builder 1 already fixed once in the readiness probe; putting it in one
 * place means it cannot be forgotten in a second place.
 */
function configured(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse a digest-shaped variable.
 *
 * A blank value is unset (not an error). A *present but malformed* value is a
 * hard failure: silently dropping `sha256:not-a-digest` would report the
 * deployment as `unpinned` when the operator believes it is pinned.
 */
function digestVariable(
  raw: string | undefined | null,
  name: string,
): string | undefined {
  const value = configured(raw);
  if (value === undefined) return undefined;
  if (!isCanonicalDigest(value)) {
    throw new ServerConfigError(
      "E_WEB_ENV_INVALID",
      `${name} must match sha256:<64 lowercase hex characters>; the configured value is malformed and is not reported`,
      name,
    );
  }
  return value;
}

/**
 * Parse a filesystem-path variable.
 *
 * An absolute value is used verbatim. A relative value is resolved against the
 * working directory, then through `resolveArtifactDir`, which also considers
 * the artifact directory shipped beside the built output. Existence is
 * checked so a typo becomes "does not exist" at startup instead of an opaque
 * snapshot-verification failure on the first request.
 */
function pathVariable(
  raw: string | undefined | null,
  name: string,
  options: { readonly requireExists: boolean; readonly requireDirectory: boolean },
): string | null {
  const value = configured(raw);
  if (value === undefined) return null;
  const absolute = isAbsolute(value) ? resolve(value) : resolve(resolveArtifactDir(value));
  if (options.requireExists && !existsSync(absolute)) {
    throw new ServerConfigError(
      "E_WEB_ENV_MISSING_PATH",
      `${name} does not resolve to an existing ${options.requireDirectory ? "directory" : "file"}`,
      name,
    );
  }
  if (options.requireExists && options.requireDirectory && !statSync(absolute).isDirectory()) {
    throw new ServerConfigError(
      "E_WEB_ENV_MISSING_PATH",
      `${name} exists but is not a directory`,
      name,
    );
  }
  return absolute;
}

/**
 * Validate a whole environment record into a frozen {@link ServerConfig}.
 *
 * Throws {@link ServerConfigError} on any malformed configured value. Never
 * returns a partially-valid config, and never echoes an env value.
 */
export function parseServerConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: ParseServerConfigOptions = {},
): Readonly<ServerConfig> {
  const requireArtifactDir = options.requireArtifactDir ?? true;

  const artifactDir = pathVariable(env["EGA_WEB_ARTIFACT_DIR"], "EGA_WEB_ARTIFACT_DIR", {
    requireExists: requireArtifactDir,
    requireDirectory: true,
  });
  const retainedManifestPath = pathVariable(
    env["EGA_WEB_RETAINED_MANIFEST"],
    "EGA_WEB_RETAINED_MANIFEST",
    { requireExists: requireArtifactDir, requireDirectory: false },
  );
  const expectedReleaseDigest = digestVariable(
    env["EGA_WEB_EXPECTED_RELEASE_DIGEST"],
    "EGA_WEB_EXPECTED_RELEASE_DIGEST",
  ) ?? null;

  // A blank secret key is unset, not an empty credential. The value is carried
  // so later builders can authenticate without re-reading the environment, and
  // it is deliberately absent from every error path and every log line.
  const supabaseUrl = configured(env["EGA_SUPABASE_URL"]) ?? null;
  const supabaseSecretKey = configured(env["EGA_SUPABASE_SECRET_KEY"]) ?? null;

  return Object.freeze({
    artifactDir,
    retainedManifestPath,
    expectedReleaseDigest,
    supabaseUrl,
    supabaseSecretKey,
    hasExpectedReleaseDigest: expectedReleaseDigest !== null,
    hasReleaseSource: artifactDir !== null || retainedManifestPath !== null,
  });
}

/** {@link parseServerConfig} over the real process environment. */
export function loadServerConfig(): Readonly<ServerConfig> {
  return parseServerConfig(process.env);
}

/**
 * Operator-safe description of what is configured, for `/readyz` and the
 * settings page. Reports presence only: no path, no digest, no secret.
 */
export function describeServerConfig(config: Readonly<ServerConfig>): string {
  const parts = [
    config.artifactDir !== null ? "artifact directory configured" : "artifact directory NOT configured",
    config.retainedManifestPath !== null ? "retained manifest configured" : "retained manifest NOT configured",
    config.hasExpectedReleaseDigest ? "expected release digest configured" : "expected release digest NOT configured",
  ];
  return parts.join("; ");
}