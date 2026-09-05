/**
 * EGA MCP runtime — `inspect` tool body (SPEC-006 §5.1.7, EGA-592).
 *
 * Frozen contract (SPEC-006 §5.1.7):
 * - `skill_id` MUST be a canonical `<namespace>/<portable-name>` ID; aliases
 *   and bare portable names are rejected with `E_MCP_INPUT_INVALID` — use
 *   `search` for discovery (§5.1.7.1, §5.1.7.6).
 * - Project policy is enforced even when the caller knows the ID/hash:
 *   denied or not-visible skills surface `E_SKILL_NOT_FOUND` with no
 *   existence oracle (§5.1.7.2, §5.1.4.4 — policy/lock applies BEFORE
 *   registry reads).
 * - Version selection (§5.1.7.3, AMEND-03): under an active lock ONLY the
 *   exact locked version is inspectable (`E_VERSION_NOT_LOCKED` outside the
 *   lock); unlocked with omitted version resolves ONLY to
 *   `current_version_hash`; an explicitly requested historical version is
 *   allowed ONLY for a project-policy-visible skill. NO version fallback or
 *   fall-forward ever occurs.
 * - Output carries exact identity, L0, the canonical snake_case manifest,
 *   token metadata, and source observations — and NEVER full L1/L2
 *   instruction bodies (§5.1.7.4).
 *
 * Error mapping (SPEC-006 §5.2, never invented codes):
 * - malformed canonical ID (schema-layer validity error) -> E_MCP_INPUT_INVALID
 * - effective-project/boundary failures -> their frozen SPEC-005/006 codes
 * - a skill absent from the active lock is not visible -> E_SKILL_NOT_FOUND
 *   (the lock module's E_LOCKED_VERSION_MISSING is internal; no oracle)
 * - a missing exact local version -> E_VERSION_NOT_FOUND (get_content
 *   §5.1.8.1 rule parity: never falls forward to current)
 * - unknown skill in current-only (omitted version) resolution ->
 *   E_SKILL_NOT_FOUND (indistinguishable from denied: no oracle)
 * - registry read failures -> E_REGISTRY_UNAVAILABLE (§5.1.4.6)
 *
 * Layering (frozen logic is reused, never reimplemented): the shared
 * project/runtime boundary (project-context.ts, EGA-589), the frozen lock
 * lookup `lockedVersionFor` (@ega-skills/project, EGA-584), the frozen
 * canonical-ID validator `parseCanonicalSkillId` (@ega-skills/schema,
 * EGA-553), and the immutable version/source/token registry reads
 * (@ega-skills/registry, EGA-565/566/568). This module is read-only and
 * offline; it never writes, never shells out, and never touches the
 * network.
 */

import type { CallToolResult, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { DatabaseConnection } from "better-sqlite3";

import {
  EGA_O200K_V1_ESTIMATOR_ID,
  parseCanonicalSkillId,
  SchemaValidationError,
  type L1Status,
  type L2SizeClass,
} from "@ega-skills/schema";
import type { CanonicalSkillVersionManifest } from "@ega-skills/hashing";
import {
  lockedVersionFor,
  ProjectLockError,
  type ProjectConfigV1,
} from "@ega-skills/project";
import {
  getCurrentVersionHash,
  getSkillVersion,
  getTokenCount,
  listVersionSources,
  RegistryError,
  type VersionRecord,
} from "@ega-skills/registry";

import {
  McpContextError,
  openReadOnlyRegistry,
  resolveMcpProjectContext,
  toMcpErrorResult,
  type McpProjectContext,
} from "./project-context.js";

/**
 * The canonical manifest wire object (SPEC-002 §5.1.15, AMEND-02): the exact
 * snake_case object used for version identity, as stored in
 * `skill_versions.manifest_json`.
 */
export type CanonicalVersionManifestSnakeCase = CanonicalSkillVersionManifest;

export type McpInspectTrustLevel = "OWNED" | "EXTERNAL" | "UNKNOWN";

/** One L0 row, identical in shape to a `search` result (SPEC-006 §5.1.6). */
export interface McpInspectL0 {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly namespace: string;
  readonly name: string;
  readonly description: string;
  readonly domains: readonly string[];
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly triggers: readonly string[];
  readonly anti_triggers: readonly string[];
  readonly aliases: readonly string[];
  readonly l1_status: L1Status;
  readonly l1_tokens: number | null;
  readonly l2_tokens: number;
}

export interface McpInspectTokenMetadata {
  readonly estimator_id: typeof EGA_O200K_V1_ESTIMATOR_ID;
  readonly l1_tokens: number | null;
  readonly l2_tokens: number;
  readonly l2_size_class: L2SizeClass;
}

/** One source observation on the wire (SPEC-006 §5.1.7 output). */
export interface McpInspectSource {
  readonly source_type: "local" | "git";
  readonly local_path: string | null;
  readonly repository: string | null;
  readonly commit_sha: string | null;
  readonly repository_path: string | null;
  readonly observed_at: string;
}

/** Exact V1 inspect output container (SPEC-006 §5.1.7.5). */
export interface McpInspectOutput {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly trust_level: McpInspectTrustLevel;
  readonly l0: McpInspectL0;
  readonly token_metadata: McpInspectTokenMetadata;
  readonly manifest: CanonicalVersionManifestSnakeCase;
  readonly sources: readonly McpInspectSource[];
}

export interface McpInspectArgs {
  readonly skill_id: string;
  readonly project_path?: string;
  readonly version_hash?: string;
}

export interface McpInspectOptions {
  /** Env override for context resolution when no `ctx` is supplied (defaults to `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam for the omitted-`project_path` fallback (defaults to `process.cwd()`). */
  readonly cwd?: string;
}

/**
 * Derives the wire `observed_at` for a source observation. The frozen v1
 * registry schema (SPEC-003) persists no observation timestamp; `source_id`
 * is the monotonic observation ordinal (INTEGER PRIMARY KEY). The wire field
 * is therefore derived from the ordinal as an ISO-8601 UTC instant: stable,
 * deterministic, offline-friendly, and it orders observations by insertion
 * sequence whenever the other sort keys tie (SPEC-006 §5.1.7.5).
 */
function observedAtOf(sourceId: number): string {
  return new Date(sourceId * 1000).toISOString();
}

/** SPEC-006 §5.1.7.5 source ordering: null-before-non-null, UTF-16 strings. */
function compareNullableString(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareSources(
  left: McpInspectSource,
  right: McpInspectSource,
): number {
  return (
    compareNullableString(left.source_type, right.source_type) ||
    compareNullableString(left.local_path, right.local_path) ||
    compareNullableString(left.repository, right.repository) ||
    compareNullableString(left.commit_sha, right.commit_sha) ||
    compareNullableString(left.repository_path, right.repository_path) ||
    compareNullableString(left.observed_at, right.observed_at)
  );
}

/**
 * Effective project policy deny check (SPEC-005 §5.1.7 rules 1–3): a
 * namespace in `namespaces.deny`, a namespace absent from a non-empty
 * `namespaces.allow`, or the exact canonical ID in `skills.deny` denies the
 * skill. Deny always wins; `skills.prefer` never bypasses it.
 */
function isDeniedByProjectPolicy(
  config: ProjectConfigV1,
  namespace: string,
  skillId: string,
): boolean {
  if (config.namespaces.deny.includes(namespace)) return true;
  if (
    config.namespaces.allow.length > 0 &&
    !config.namespaces.allow.includes(namespace)
  ) {
    return true;
  }
  if (config.skills.deny.includes(skillId)) return true;
  return false;
}

/** L1 blob hash (role `core`) from the manifest, or null when unauthored. */
function l1BlobHash(manifest: CanonicalVersionManifestSnakeCase): string | null {
  for (const file of manifest.files) {
    if (file.role === "core") return file.blob_hash;
  }
  return null;
}

/** L2 blob hash (role `skill-body`, canonical SKILL.md) from the manifest. */
function l2BlobHash(manifest: CanonicalVersionManifestSnakeCase): string | null {
  for (const file of manifest.files) {
    if (file.role === "skill-body") return file.blob_hash;
  }
  return null;
}

/**
 * Pure project gate (SPEC-006 §5.1.7.2/.3, §5.1.4.4): chooses the exact
 * inspectable version hash from the active lock or the caller, WITHOUT any
 * registry read. Returns `null` when the target must be resolved to the
 * registry's `current_version_hash` (unlocked + omitted version).
 *
 * - LOCKED: ONLY the exact locked version is inspectable; a requested
 *   version outside the active lock fails with E_VERSION_NOT_LOCKED; a
 *   skill absent from the lock is not visible — E_SKILL_NOT_FOUND, no
 *   existence oracle (the lock module's E_LOCKED_VERSION_MISSING is
 *   internal and never exposed raw).
 * - UNLOCKED: project policy first — denied skills never become
 *   inspectable even with an exact hash in hand (no oracle); an explicit
 *   historical version is permitted for a policy-visible skill (looked up
 *   exactly, NEVER forwarded).
 */
function resolveTargetHash(
  ctx: McpProjectContext,
  skillId: string,
  requestedHash: string | undefined,
): string | null {
  if (ctx.lockMode === "LOCKED") {
    if (ctx.lock === null) {
      throw new McpContextError(
        "E_PROJECT_LOCK_INVALID",
        "Active lock mode without a validated lock object",
      );
    }
    let lockedHash: string;
    try {
      lockedHash = lockedVersionFor(ctx.lock, skillId);
    } catch (error) {
      if (error instanceof ProjectLockError && error.code === "E_LOCKED_VERSION_MISSING") {
        // A skill absent from the active lock is not visible to this project:
        // E_SKILL_NOT_FOUND with no existence oracle (never raw internal code).
        throw new McpContextError(
          "E_SKILL_NOT_FOUND",
          `Skill ${JSON.stringify(skillId)} is not visible to this project (not in the active lock; never fall forward to current/latest)`,
        );
      }
      throw error;
    }
    if (requestedHash !== undefined && requestedHash !== lockedHash) {
      throw new McpContextError(
        "E_VERSION_NOT_LOCKED",
        `Version ${JSON.stringify(requestedHash)} of skill ${JSON.stringify(skillId)} is outside the active lock (locked version is ${lockedHash}); ONLY the exact locked version is inspectable`,
      );
    }
    return lockedHash;
  }

  const { namespace } = parseCanonicalSkillId(skillId);
  if (isDeniedByProjectPolicy(ctx.config, namespace, skillId)) {
    throw new McpContextError(
      "E_SKILL_NOT_FOUND",
      `Skill ${JSON.stringify(skillId)} is not visible to this project (denied by project policy)`,
    );
  }
  return requestedHash ?? null;
}

/**
 * Exact immutable-row lookup. `hash` is always the gate's chosen hash
 * (locked, explicit-exact, or the current pointer). A missing exact local
 * version surfaces the frozen `E_VERSION_NOT_FOUND` verbatim — NEVER a
 * fallback or fall-forward (SPEC-006 §5.1.7.3, §5.1.8.1 parity).
 */
function lookupVersionRecord(
  db: DatabaseConnection,
  skillId: string,
  hash: string,
): VersionRecord {
  try {
    return getSkillVersion(db, skillId, hash);
  } catch (error) {
    if (error instanceof RegistryError && error.code === "E_VERSION_NOT_FOUND") {
      // Same frozen code, typed for MCP consumers (never a raw internal error).
      throw new McpContextError(
        "E_VERSION_NOT_FOUND",
        `No local version ${JSON.stringify(hash)} for skill ${JSON.stringify(skillId)}.`,
      );
    }
    throw error;
  }
}

/**
 * Runs the `inspect` tool (SPEC-006 §5.1.7). Returns the frozen
 * `McpInspectOutput`; throws typed errors (`McpContextError`, frozen-code
 * `RegistryError`) that the server maps to the structured error envelope.
 * When no shared `ctx` is supplied the tool resolves the effective project
 * boundary itself (context-first, exactly like the server shell), using
 * `opts.env`/`opts.cwd` as test seams.
 */
export function runInspectTool(
  args: McpInspectArgs,
  ctx?: McpProjectContext,
  opts: McpInspectOptions = {},
): McpInspectOutput {
  if (typeof args.skill_id !== "string" || args.skill_id.length === 0) {
    throw new McpContextError(
      "E_MCP_INPUT_INVALID",
      "Malformed inspect input: skill_id must be a non-empty canonical <namespace>/<portable-name> string",
    );
  }
  if (
    args.project_path !== undefined &&
    typeof args.project_path !== "string"
  ) {
    throw new McpContextError(
      "E_MCP_INPUT_INVALID",
      "Malformed inspect input: project_path must be a string",
    );
  }
  if (
    args.version_hash !== undefined &&
    typeof args.version_hash !== "string"
  ) {
    throw new McpContextError(
      "E_MCP_INPUT_INVALID",
      "Malformed inspect input: version_hash must be a string",
    );
  }

  // 1. ONE effective project context (SPEC-006 §5.1.4): all four tools run
  //    inside one effective project config/lock/policy context.
  const effective = ctx ?? resolveMcpProjectContext(args.project_path, opts);

  // 2. Canonical ID gate (SPEC-006 §5.1.7.1): namespace-plus-portable-name
  //    only; aliases and bare names are malformed input, never resolved.
  let namespace: string;
  try {
    ({ namespace } = parseCanonicalSkillId(args.skill_id));
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new McpContextError("E_MCP_INPUT_INVALID", error.message);
    }
    throw error;
  }

  // 3. Project policy + lock gate (SPEC-006 §5.1.7.2/.3, §5.1.4.4): deny and
  //    lock apply BEFORE any registry/cache read — a caller who knows the
  //    exact ID and hash can never bypass policy (no existence oracle).
  const targetHash = resolveTargetHash(effective, args.skill_id, args.version_hash);

  // 4. Read-only registry handle (§5.1.4.5: never writes, never migrates,
  //    never creates; closed before returning). Denied/not-visible skills
  //    never reach this point, so no oracle leaks through I/O side effects.
  const handle = openReadOnlyRegistry(effective);
  try {
    // 5. Exact immutable-row lookup, never fallback or fall-forward.
    const version =
      targetHash === null
        ? (() => {
            // Current-only resolution (AMEND-03): an unknown skill is
            // indistinguishable from a denied one — E_SKILL_NOT_FOUND, no
            // existence oracle.
            let currentHash: string;
            try {
              currentHash = getCurrentVersionHash(handle.db, args.skill_id);
            } catch (error) {
              if (
                error instanceof RegistryError &&
                error.code === "E_VERSION_NOT_FOUND"
              ) {
                throw new McpContextError(
                  "E_SKILL_NOT_FOUND",
                  `Skill ${JSON.stringify(args.skill_id)} is not visible to this project`,
                );
              }
              throw error;
            }
            return lookupVersionRecord(handle.db, args.skill_id, currentHash);
          })()
        : lookupVersionRecord(handle.db, args.skill_id, targetHash);
    if (version.skillId !== args.skill_id) {
      // Immutable rows are keyed by identity; a mismatch here is a corrupt
      // registry, and V1 never guesses identity (SPEC-006 §5.1.4.6).
      throw new McpContextError(
        "E_REGISTRY_UNAVAILABLE",
        `Local registry returned incoherent identity for skill ${JSON.stringify(args.skill_id)}`,
      );
    }

    // 4. Canonical manifest (SPEC-002 §5.1.15): the stored manifest_json IS
    //    the exact snake_case wire object; parsing it back out is identity-
    //    preserving (registry-written canonical JSON).
    let manifest: CanonicalVersionManifestSnakeCase;
    try {
      manifest = JSON.parse(version.manifestJson) as CanonicalVersionManifestSnakeCase;
    } catch (error) {
      throw new McpContextError(
        "E_REGISTRY_UNAVAILABLE",
        `Local registry stored an unreadable manifest for ${JSON.stringify(args.skill_id)} ${version.versionHash}`,
      );
    }

    // 5. Token metadata (SPEC-002 §5.1.16, SPEC-003 §5.1.16): L1 = canonical
    //    SKILL.core.md (role `core`), L2 = canonical SKILL.md (role
    //    `skill-body`), both counted with ega-o200k-v1. Binary blobs and
    //    unauthored L1 project as null — never a fake zero.
    const l1Status = version.l1Status as L1Status;
    const l2SizeClass = version.l2SizeClass as L2SizeClass;
    const coreBlob = l1BlobHash(manifest);
    const l1Tokens =
      l1Status === "AUTHORED" && coreBlob !== null
        ? getTokenCount(handle.db, coreBlob, EGA_O200K_V1_ESTIMATOR_ID)
        : null;
    const skillBodyBlob = l2BlobHash(manifest);
    const l2Tokens =
      skillBodyBlob !== null
        ? getTokenCount(handle.db, skillBodyBlob, EGA_O200K_V1_ESTIMATOR_ID)
        : null;
    if (l2Tokens === null) {
      // SKILL.md is required TEXT and its ega-o200k-v1 count is always
      // persisted at import; a missing row is an incoherent local version —
      // never a guess (E_VERSION_NOT_FOUND: the exact local version is not
      // fully available).
      throw new McpContextError(
        "E_VERSION_NOT_FOUND",
        `Local version ${version.versionHash} of skill ${JSON.stringify(args.skill_id)} has no ega-o200k-v1 L2 token metadata`,
      );
    }

    // 6. Source observations, deterministically ordered (SPEC-006 §5.1.7.5):
    //    source_type, local_path, repository, commit_sha, repository_path,
    //    observed_at — null-before-non-null, UTF-16 string order.
    const sources: McpInspectSource[] = listVersionSources(
      handle.db,
      args.skill_id,
      version.versionHash,
    )
      .map((source) => ({
        source_type: source.sourceType as "local" | "git",
        local_path: source.localPath ?? null,
        repository: source.repository ?? null,
        commit_sha: source.commitSha ?? null,
        repository_path: source.repositoryPath ?? null,
        observed_at: observedAtOf(source.sourceId),
      }))
      .sort(compareSources);

    // 7. L0 row (§5.1.7.5): identical in shape to a search result, with
    //    skill_id/version_hash equal to the top-level values.
    const l0: McpInspectL0 = Object.freeze({
      skill_id: args.skill_id,
      version_hash: version.versionHash,
      namespace,
      name: manifest.portable.name,
      description: manifest.portable.description,
      domains: Object.freeze([...manifest.routing.domains]),
      platforms: Object.freeze([...manifest.routing.platforms]),
      frameworks: Object.freeze([...manifest.routing.frameworks]),
      triggers: Object.freeze([...manifest.routing.triggers]),
      anti_triggers: Object.freeze([...manifest.routing.anti_triggers]),
      aliases: Object.freeze([...manifest.routing.aliases]),
      l1_status: l1Status,
      l1_tokens: l1Tokens,
      l2_tokens: l2Tokens,
    });

    return Object.freeze({
      skill_id: args.skill_id,
      version_hash: version.versionHash,
      trust_level: version.trustLevel as McpInspectTrustLevel,
      l0,
      token_metadata: Object.freeze({
        estimator_id: EGA_O200K_V1_ESTIMATOR_ID,
        l1_tokens: l1Tokens,
        l2_tokens: l2Tokens,
        l2_size_class: l2SizeClass,
      }),
      manifest,
      sources: Object.freeze(sources),
    });
  } finally {
    handle.close();
  }
}

/**
 * Maps a body failure to the frozen structured error result (SPEC-006
 * §5.1.3.3, §5.2). Codes are never invented: boundary failures keep their
 * frozen SPEC-005/006 codes, malformed canonical IDs map to
 * `E_MCP_INPUT_INVALID`, an unobservable skill maps to `E_SKILL_NOT_FOUND`,
 * registry version/source errors keep their frozen codes, and any other
 * registry read failure surfaces `E_REGISTRY_UNAVAILABLE` (§5.1.4.6).
 */
export function toInspectErrorResult(error: unknown): CallToolResult {
  const tool = "inspect";
  if (error instanceof McpContextError) {
    return toMcpErrorResult(tool, error);
  }
  if (error instanceof SchemaValidationError) {
    return toMcpErrorResult(
      tool,
      new McpContextError("E_MCP_INPUT_INVALID", error.message),
    );
  }
  if (error instanceof ProjectLockError && error.code === "E_LOCKED_VERSION_MISSING") {
    // The lock module's internal "not locked" failure means the skill is
    // not visible to this project (§5.1.7.2): E_SKILL_NOT_FOUND, no oracle.
    return toMcpErrorResult(
      tool,
      new McpContextError(
        "E_SKILL_NOT_FOUND",
        `Skill is not visible to this project (not in the active lock; never fall forward to current/latest)`,
      ),
    );
  }
  if (error instanceof RegistryError) {
    // Frozen registry codes (E_VERSION_NOT_FOUND, …) surface verbatim.
    return toMcpErrorResult(tool, new McpContextError(error.code, error.message));
  }
  // Any other failure is a registry read failure in this read-only tool
  // (SPEC-006 §5.1.4.6: an unreadable local registry surfaces
  // E_REGISTRY_UNAVAILABLE; never a fallback or raw internal error).
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : String(error);
  return toMcpErrorResult(
    tool,
    new McpContextError("E_REGISTRY_UNAVAILABLE", `Local registry cannot be read: ${message}`),
  );
}

/**
 * Successful inspect call result: exact `McpInspectOutput` as
 * structuredContent plus a COMPACT text fallback that never duplicates the
 * structured payload (SPEC-006 §5.1.3.2).
 */
export function toInspectSuccessResult(
  output: McpInspectOutput,
): CallToolResult {
  const text =
    `inspect ${output.skill_id} ${output.version_hash} ` +
    `trust=${output.trust_level} l1=${String(output.token_metadata.l1_tokens)} ` +
    `l2=${String(output.token_metadata.l2_tokens)} l2_size_class=${output.token_metadata.l2_size_class} ` +
    `files=${output.manifest.files.length} sources=${output.sources.length}`;
  return Object.freeze({
    content: Object.freeze([{ type: "text", text }]),
    structuredContent: output,
    isError: false,
  }) as CallToolResult;
}

/**
 * Success output schema (SPEC-006 §5.1.3.2): a Standard Schema v1 whose
 * JSON Schema projection describes the exact `McpInspectOutput` container.
 */
export const inspectOutputSchema: StandardSchemaWithJSON<
  McpInspectOutput,
  McpInspectOutput
> = {
  "~standard": {
    version: 1,
    vendor: "ega-skills",
    types: {
      input: {} as McpInspectOutput,
      output: {} as McpInspectOutput,
    },
    validate: (value) => {
      const issues: { message: string; path?: (string | number)[] }[] = [];
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "Expected an McpInspectOutput object" }] };
      }
      const output = value as McpInspectOutput;
      const requireString = (key: keyof McpInspectOutput): void => {
        if (typeof output[key] !== "string") {
          issues.push({ message: `Expected ${key} to be a string`, path: [key] });
        }
      };
      requireString("skill_id");
      requireString("version_hash");
      if (
        output.trust_level !== "OWNED" &&
        output.trust_level !== "EXTERNAL" &&
        output.trust_level !== "UNKNOWN"
      ) {
        issues.push({
          message: 'Expected trust_level to be "OWNED" | "EXTERNAL" | "UNKNOWN"',
          path: ["trust_level"],
        });
      }
      if (output.l0 === null || typeof output.l0 !== "object") {
        issues.push({ message: "Expected l0 to be an object", path: ["l0"] });
      }
      const tokenMetadata = output.token_metadata;
      if (tokenMetadata === null || typeof tokenMetadata !== "object") {
        issues.push({
          message: "Expected token_metadata to be an object",
          path: ["token_metadata"],
        });
      } else if (tokenMetadata.estimator_id !== EGA_O200K_V1_ESTIMATOR_ID) {
        issues.push({
          message: `Expected token_metadata.estimator_id to be ${EGA_O200K_V1_ESTIMATOR_ID}`,
          path: ["token_metadata", "estimator_id"],
        });
      }
      if (output.manifest === null || typeof output.manifest !== "object") {
        issues.push({ message: "Expected manifest to be an object", path: ["manifest"] });
      }
      if (!Array.isArray(output.sources)) {
        issues.push({ message: "Expected sources to be an array", path: ["sources"] });
      }
      return issues.length > 0
        ? { issues }
        : { value: output as McpInspectOutput };
    },
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({
        type: "object",
        properties: {
          skill_id: { type: "string" },
          version_hash: { type: "string" },
          trust_level: { type: "string", enum: ["OWNED", "EXTERNAL", "UNKNOWN"] },
          l0: {
            type: "object",
            properties: {
              skill_id: { type: "string" },
              version_hash: { type: "string" },
              namespace: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              domains: { type: "array", items: { type: "string" } },
              platforms: { type: "array", items: { type: "string" } },
              frameworks: { type: "array", items: { type: "string" } },
              triggers: { type: "array", items: { type: "string" } },
              anti_triggers: { type: "array", items: { type: "string" } },
              aliases: { type: "array", items: { type: "string" } },
              l1_status: { type: "string", enum: ["AUTHORED", "MISSING"] },
              l1_tokens: { type: ["integer", "null"] },
              l2_tokens: { type: "integer" },
            },
            required: ["skill_id", "version_hash"],
            additionalProperties: true,
          },
          token_metadata: {
            type: "object",
            properties: {
              estimator_id: { type: "string", const: EGA_O200K_V1_ESTIMATOR_ID },
              l1_tokens: { type: ["integer", "null"] },
              l2_tokens: { type: "integer" },
              l2_size_class: {
                type: "string",
                enum: ["NORMAL", "LARGE", "OVERSIZED"],
              },
            },
            required: ["estimator_id", "l1_tokens", "l2_tokens", "l2_size_class"],
            additionalProperties: false,
          },
          manifest: {
            type: "object",
            properties: {
              schema_version: { type: "integer" },
              skill_id: { type: "string" },
              portable: { type: "object" },
              routing: { type: "object" },
              files: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    role: { type: "string" },
                    blob_hash: { type: "string" },
                    byte_size: { type: "integer" },
                    content_kind: { type: "string", enum: ["TEXT", "BINARY"] },
                  },
                  required: ["path", "role", "blob_hash", "byte_size", "content_kind"],
                  additionalProperties: false,
                },
              },
            },
            required: ["schema_version", "skill_id", "portable", "routing", "files"],
            additionalProperties: false,
          },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source_type: { type: "string", enum: ["local", "git"] },
                local_path: { type: ["string", "null"] },
                repository: { type: ["string", "null"] },
                commit_sha: { type: ["string", "null"] },
                repository_path: { type: ["string", "null"] },
                observed_at: { type: "string" },
              },
              required: [
                "source_type",
                "local_path",
                "repository",
                "commit_sha",
                "repository_path",
                "observed_at",
              ],
              additionalProperties: false,
            },
          },
        },
        required: [
          "skill_id",
          "version_hash",
          "trust_level",
          "l0",
          "token_metadata",
          "manifest",
          "sources",
        ],
        additionalProperties: false,
      }),
    },
  },
};