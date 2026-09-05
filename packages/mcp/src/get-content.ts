/**
 * EGA MCP runtime — `get_content` tool body (SPEC-006 §5.1.8, EGA-593).
 *
 * Exact selected L1/L2 content, versioned and never silently truncated:
 * - All input fields except `project_path` are REQUIRED; `level` accepts
 *   ONLY `L1` or `L2` (rule 0). Malformed input fails with
 *   `E_MCP_INPUT_INVALID`.
 * - The effective project policy/lock is enforced BEFORE cache access: a
 *   denied/not-visible skill surfaces as `E_SKILL_NOT_FOUND` (no existence
 *   oracle for denied skills); a project-visible skill requested at a
 *   version outside the active lock returns `E_VERSION_NOT_LOCKED`; a
 *   missing exact local version returns `E_VERSION_NOT_FOUND` (never falls
 *   forward to current); a missing requested level returns
 *   `E_CONTENT_LEVEL_MISSING`; content over the per-call budget returns
 *   `E_CONTENT_TOKEN_BUDGET` (rule 1).
 * - `max_tokens` is an integer 1–1,000,000 with its OWN per-call budget; no
 *   aggregate or session quota exists (rule 2).
 * - Content is the EXACT canonical text frozen by AMEND-02 (L1 = full
 *   canonical `SKILL.core.md`; L2 = full canonical `SKILL.md` including
 *   frontmatter), counted with `ega-o200k-v1`. Cache bytes are hash-verified
 *   before return; a corrupt blob fails with `E_CACHE_HASH_MISMATCH` before
 *   any content is exposed (rule 3). The cached token count is used
 *   (implementation note); content integrity is verified first.
 * - NEVER truncates: over-budget or missing-level conditions are errors, not
 *   partial content (rule 4). Output is exactly `{skill_id, version_hash,
 *   level, token_count, content}` (rule 5).
 *
 * Layering (frozen logic is reused, never reimplemented): the shared
 * project/runtime boundary (project-context.ts, EGA-589), the frozen
 * canonical-ID validator (`parseCanonicalSkillId`, @ega-skills/schema), the
 * frozen lock lookup (`lockedVersionFor`, @ega-skills/project), and the
 * immutable version/cache reads (`getSkillVersion`, `getTokenCount`,
 * `getCacheBlob`, @ega-skills/registry). Read-only and offline; no writes,
 * no shell, no network, no session state.
 */

import { join } from "node:path";
import { TextDecoder } from "node:util";

import type { CallToolResult, StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import {
  EGA_O200K_V1_ESTIMATOR_ID,
  parseCanonicalSkillId,
  SchemaValidationError,
} from "@ega-skills/schema";
import {
  lockedVersionFor,
  ProjectLockError,
  type ProjectConfigV1,
} from "@ega-skills/project";
import {
  getCacheBlob,
  getSkillVersion,
  getTokenCount,
  RegistryError,
} from "@ega-skills/registry";

import {
  McpContextError,
  openReadOnlyRegistry,
  type McpProjectContext,
} from "./project-context.js";

/** SPEC-006 §5.1.8 rule 2: per-call budget bounds (mirrored in the input schema). */
export const GET_CONTENT_MAX_TOKENS_MIN = 1;
export const GET_CONTENT_MAX_TOKENS_MAX = 1_000_000;

/** Content levels (SPEC-006 §5.1.8 rule 0): ONLY L1 or L2. */
export const GET_CONTENT_LEVELS = ["L1", "L2"] as const;
export type GetContentLevel = (typeof GET_CONTENT_LEVELS)[number];

/** Immutable version identity shape (SPEC-005 §5.1.9 rule 4). */
const VERSION_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** Manifest roles carrying the canonical instruction texts (AMEND-02). */
const L1_ROLE = "core";
const L2_ROLE = "skill-body";

/** Raw tool arguments; every field is validated inside runGetContentTool. */
export interface GetContentToolArgs {
  readonly skill_id?: unknown;
  readonly version_hash?: unknown;
  readonly level?: unknown;
  readonly max_tokens?: unknown;
  readonly project_path?: unknown;
}

export interface GetContentToolOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Exact V1 get_content output container (SPEC-006 §5.1.8 rule 5). */
export interface McpGetContentOutput {
  readonly skill_id: string;
  readonly version_hash: string;
  readonly level: GetContentLevel;
  readonly token_count: number;
  readonly content: string;
}

function inputInvalid(message: string): never {
  throw new McpContextError("E_MCP_INPUT_INVALID", message);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

interface ValidatedGetContentInput {
  readonly skillId: string;
  readonly namespace: string;
  readonly versionHash: string;
  readonly level: GetContentLevel;
  readonly maxTokens: number;
}

/** Validates the frozen input shape; all fields but `project_path` required. */
function validateInput(args: GetContentToolArgs): ValidatedGetContentInput {
  if (typeof args.skill_id !== "string" || args.skill_id.length === 0) {
    inputInvalid('Argument "skill_id" must be a non-empty canonical skill ID string.');
  }
  let namespace: string;
  try {
    ({ namespace } = parseCanonicalSkillId(args.skill_id));
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      inputInvalid(`Argument "skill_id" must be a canonical ID: ${error.message}`);
    }
    throw error;
  }
  if (typeof args.version_hash !== "string" || !VERSION_HASH_RE.test(args.version_hash)) {
    inputInvalid('Argument "version_hash" must be a sha256:<64 lowercase hex> version identity.');
  }
  if (args.level !== "L1" && args.level !== "L2") {
    inputInvalid('Argument "level" must be "L1" or "L2".');
  }
  if (
    typeof args.max_tokens !== "number" ||
    !Number.isInteger(args.max_tokens) ||
    args.max_tokens < GET_CONTENT_MAX_TOKENS_MIN ||
    args.max_tokens > GET_CONTENT_MAX_TOKENS_MAX
  ) {
    inputInvalid(
      `Argument "max_tokens" must be an integer ${GET_CONTENT_MAX_TOKENS_MIN}..${GET_CONTENT_MAX_TOKENS_MAX}.`,
    );
  }
  return {
    skillId: args.skill_id,
    namespace,
    versionHash: args.version_hash,
    level: args.level,
    maxTokens: args.max_tokens,
  };
}

/**
 * Project deny check (SPEC-005 §5.1.7 rules 1–3, same gate as search/inspect):
 * `namespaces.deny`, a non-empty `namespaces.allow` lacking the namespace, or
 * the exact canonical ID in `skills.deny`. `skills.prefer` never restricts.
 */
function isDeniedByPolicy(config: ProjectConfigV1, namespace: string, skillId: string): boolean {
  if (config.namespaces.deny.includes(namespace)) return true;
  if (config.namespaces.allow.length > 0 && !config.namespaces.allow.includes(namespace)) {
    return true;
  }
  return config.skills.deny.includes(skillId);
}

/**
 * Pure project gate (SPEC-006 §5.1.8.1, §5.1.4.4): policy/lock BEFORE any
 * cache read. Denied/not-visible skills (including skills absent from the
 * active lock) surface `E_SKILL_NOT_FOUND` with no existence oracle; a
 * project-visible skill requested outside the active lock surfaces
 * `E_VERSION_NOT_LOCKED`. No registry read happens here.
 */
function gateProjectAccess(
  ctx: McpProjectContext,
  skillId: string,
  namespace: string,
  versionHash: string,
): void {
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
        throw new McpContextError(
          "E_SKILL_NOT_FOUND",
          `Skill ${JSON.stringify(skillId)} is not visible to this project (not in the active lock)`,
        );
      }
      throw error;
    }
    if (versionHash !== lockedHash) {
      throw new McpContextError(
        "E_VERSION_NOT_LOCKED",
        `Version ${JSON.stringify(versionHash)} of skill ${JSON.stringify(skillId)} is outside the active lock (locked version is ${lockedHash})`,
      );
    }
    return;
  }
  if (isDeniedByPolicy(ctx.config, namespace, skillId)) {
    throw new McpContextError(
      "E_SKILL_NOT_FOUND",
      `Skill ${JSON.stringify(skillId)} is not visible to this project (denied by project policy)`,
    );
  }
}

interface ManifestFileEntry {
  readonly path: string;
  readonly role: string;
  readonly blob_hash: string;
}

/** Blob hash for the requested level from the canonical manifest, if authored. */
function levelBlobHash(manifestJson: string, skillId: string, level: GetContentLevel): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry stored an unreadable manifest for ${JSON.stringify(skillId)}.`,
    );
  }
  const files: unknown =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { files?: unknown }).files
      : undefined;
  if (!Array.isArray(files)) {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry stored a manifest without files for ${JSON.stringify(skillId)}.`,
    );
  }
  const want = level === "L1" ? L1_ROLE : L2_ROLE;
  for (const file of files) {
    const entry = file as Partial<ManifestFileEntry>;
    if (entry?.role === want && typeof entry.blob_hash === "string") {
      return entry.blob_hash;
    }
  }
  return null;
}

const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Runs one `get_content` tool call against the given effective project
 * context. Success returns the MCP result (one-line text summary — NEVER the
 * body — plus the exact output container, `isError: false`); failures throw
 * `McpContextError` with a frozen code. Each call carries its OWN budget.
 */
export function runGetContentTool(
  args: GetContentToolArgs,
  ctx: McpProjectContext,
  opts: GetContentToolOptions = {},
): CallToolResult {
  void opts;
  const input = validateInput(args);

  // Policy/lock BEFORE any cache read (SPEC-006 §5.1.8.1): knowing an exact
  // ID/hash can never bypass project visibility.
  gateProjectAccess(ctx, input.skillId, input.namespace, input.versionHash);

  // The read-only boundary handle is the ONLY registry surface used here.
  const handle = openReadOnlyRegistry(ctx);
  try {
    // Exact local version only — never fall forward to current (rule 1).
    let manifestJson: string;
    try {
      manifestJson = getSkillVersion(handle.db, input.skillId, input.versionHash).manifestJson;
    } catch (error) {
      if (error instanceof RegistryError && error.code === "E_VERSION_NOT_FOUND") {
        throw new McpContextError(
          "E_VERSION_NOT_FOUND",
          `No local version ${JSON.stringify(input.versionHash)} for skill ${JSON.stringify(input.skillId)}.`,
        );
      }
      throw error;
    }

    // Requested level must exist — missing levels are errors, not partials.
    const blobHash = levelBlobHash(manifestJson, input.skillId, input.level);
    if (blobHash === null) {
      throw new McpContextError(
        "E_CONTENT_LEVEL_MISSING",
        `Skill ${JSON.stringify(input.skillId)} version ${input.versionHash} has no ${input.level} content.`,
      );
    }

    // Exact canonical bytes, hash-verified BEFORE exposure (rule 3). Missing
    // or corrupt blobs fail with E_CACHE_HASH_MISMATCH from the cache layer.
    let bytes: Uint8Array;
    try {
      bytes = getCacheBlob(cacheDirOf(ctx), blobHash);
    } catch (error) {
      if (error instanceof RegistryError && error.code === "E_CACHE_HASH_MISMATCH") {
        throw new McpContextError("E_CACHE_HASH_MISMATCH", error.message);
      }
      throw error;
    }
    let content: string;
    try {
      content = utf8StrictDecoder.decode(bytes);
    } catch {
      throw new McpContextError(
        "E_CACHE_HASH_MISMATCH",
        `Cached ${input.level} blob for ${JSON.stringify(input.skillId)} is not valid UTF-8 text.`,
      );
    }

    // Cached ega-o200k-v1 count (implementation note); integrity already
    // verified above. A missing count row is an incoherent local version.
    const tokenCount = getTokenCount(handle.db, blobHash, EGA_O200K_V1_ESTIMATOR_ID);
    if (tokenCount === null) {
      throw new McpContextError(
        "E_REGISTRY_UNAVAILABLE",
        `Local version ${input.versionHash} of skill ${JSON.stringify(input.skillId)} has no ega-o200k-v1 token metadata.`,
      );
    }

    // Per-call budget (rule 2/4): over-budget is an error, never truncation.
    if (tokenCount > input.maxTokens) {
      throw new McpContextError(
        "E_CONTENT_TOKEN_BUDGET",
        `Content has ${tokenCount} ega-o200k-v1 tokens, exceeding this call's max_tokens of ${input.maxTokens}.`,
      );
    }

    const output: McpGetContentOutput = Object.freeze({
      skill_id: input.skillId,
      version_hash: input.versionHash,
      level: input.level,
      token_count: tokenCount,
      content,
    });
    const text =
      `get_content ${input.skillId} ${input.versionHash} ${input.level} ` +
      `tokens=${tokenCount}/${input.maxTokens}.`;
    return Object.freeze({
      content: Object.freeze([Object.freeze({ type: "text", text })]),
      structuredContent: output,
      isError: false,
    }) as CallToolResult;
  } finally {
    handle.close();
  }
}

/** Frozen cache-sha256 directory inside the gated registry home. */
function cacheDirOf(ctx: McpProjectContext): string {
  return join(ctx.registryHome, "cache", "sha256");
}

/**
 * Success `outputSchema` for the `get_content` tool: validates that
 * `structuredContent` is EXACTLY the frozen output container and advertises
 * the same shape over `tools/list`.
 */
export const GET_CONTENT_OUTPUT_SCHEMA: StandardSchemaWithJSON<
  McpGetContentOutput,
  McpGetContentOutput
> = {
  "~standard": {
    version: 1,
    vendor: "ega-skills",
    types: {
      input: {} as McpGetContentOutput,
      output: {} as McpGetContentOutput,
    },
    validate: (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "Expected a get_content output object" }] };
      }
      const output = value as Record<string, unknown>;
      for (const key of ["skill_id", "version_hash", "content"]) {
        if (typeof output[key] !== "string") {
          return { issues: [{ message: `Expected ${key} to be a string`, path: [key] }] };
        }
      }
      if (output["level"] !== "L1" && output["level"] !== "L2") {
        return { issues: [{ message: 'Expected level to be "L1" or "L2"', path: ["level"] }] };
      }
      if (typeof output["token_count"] !== "number" || !Number.isInteger(output["token_count"])) {
        return { issues: [{ message: "Expected token_count to be an integer", path: ["token_count"] }] };
      }
      return { value: value as McpGetContentOutput };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: {
          skill_id: { type: "string" },
          version_hash: { type: "string" },
          level: { type: "string", enum: ["L1", "L2"] },
          token_count: { type: "integer" },
          content: { type: "string" },
        },
        required: ["skill_id", "version_hash", "level", "token_count", "content"],
        additionalProperties: false,
      }),
      output: () => ({ $ref: "#/$defs/getContentOutput" }),
    },
  },
};
