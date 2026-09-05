/**
 * EGA MCP runtime — `search` tool body (SPEC-006 §5.1.6, EGA-591).
 *
 * Project-scoped L0-only search over the local registry:
 * - Input rules (SPEC-006 §5.1.6 rules 1–2): `query` non-empty after trim and
 *   at most 16,384 Unicode code points; `limit` an integer 1–20, default 10.
 *   Malformed input fails with `E_MCP_INPUT_INVALID`.
 * - Output contains ONLY project-visible L0 current/locked versions (rule 3):
 *   denied, not-in-lock, and historical/non-visible versions NEVER appear; no
 *   instruction body, no reference content, and no BM25 score is ever
 *   returned. The wire payload is EXACTLY the frozen `McpSearchOutput`
 *   container (rule 4), and rows preserve the deterministic registry/search
 *   order — relative BM25, then `skill_id`, then `version_hash` (SPEC-003
 *   §5.1.5) — with FTS escaping preserved end-to-end (rule 5).
 * - The effective project policy/lock comes from the shared context BEFORE
 *   any read: deny/lock/can-be-never-visible decisions (SPEC-004 §5.1.15
 *   rules 1–3, SPEC-005 §5.1.12) are applied to the candidate set before any
 *   per-hit metadata is loaded, and under `LOCKED` the deny filter is applied
 *   to the lock catalog BEFORE the FTS query runs so denied pairs never even
 *   enter a query.
 * - The registry handle is the shared read-only boundary handle
 *   (`openReadOnlyRegistry`): never opened for writes, never created, never
 *   migrated. A missing/unusable registry fails with `E_REGISTRY_UNAVAILABLE`.
 *
 * Policy-filter reuse note: `@ega-skills/router` exports `applyAutomaticFilters`
 * (SPEC-004 §5.1.15), but its filter primitive is router-shaped — it requires
 * `EligibleSkill` candidates carrying platforms/anti-triggers/l2 size-class and
 * always emits `RejectedSkill` diagnostics, and the MCP package does not depend
 * on the router. The deny/lock conditions (rules 1–3 only) are therefore
 * implemented here directly from the frozen SPEC-004 §5.1.15 table + SPEC-005
 * §5.1.12; platform/anti-trigger conditions do not exist in search and are
 * intentionally absent.
 */

import type { CallToolResult, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { DatabaseConnection } from "better-sqlite3";

import {
  TOKEN_ESTIMATOR_EGA_O200K_V1,
  type ProjectConfigV1,
} from "@ega-skills/project";
import { getTokenCount, searchSkills, type SearchHit } from "@ega-skills/registry";

import {
  McpContextError,
  openReadOnlyRegistry,
  type McpProjectContext,
  type ReadOnlyRegistryHandle,
} from "./project-context.js";

/** SPEC-006 §5.1.6 rule 1: maximum `query` length in Unicode code points. */
export const SEARCH_QUERY_MAX_CODE_POINTS = 16_384;
/** SPEC-006 §5.1.6 rule 2: default `limit`. */
export const SEARCH_LIMIT_DEFAULT = 10;
/** SPEC-006 §5.1.6 rule 2: hard maximum `limit`. */
export const SEARCH_LIMIT_MAX = 20;

/** Raw tool arguments; every field is validated inside runSearchTool. */
export interface SearchToolArgs {
  readonly query?: unknown;
  readonly project_path?: unknown;
  readonly limit?: unknown;
}

/** One search result row — EXACTLY the frozen SPEC-006 §5.1.6 rule 4 shape. */
export interface McpSearchResultRow {
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
  readonly l1_status: "AUTHORED" | "MISSING";
  readonly l1_tokens: number | null;
  readonly l2_tokens: number;
}

/** Frozen `search` success output container (SPEC-006 §5.1.6 rule 4). */
export interface McpSearchOutput {
  readonly results: readonly McpSearchResultRow[];
}

export interface SearchToolOptions {
  /** Accepted for parity with the shared boundary options; registry paths come from the context. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function inputInvalid(message: string): never {
  throw new McpContextError("E_MCP_INPUT_INVALID", message);
}

/** SPEC-006 §5.1.6 rule 1: non-empty after trim, at most 16,384 code points. */
function validateQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    inputInvalid(`Argument "query" must be a string (got ${typeof raw}).`);
  }
  if (raw.trim().length === 0) {
    inputInvalid('Argument "query" must be non-empty after trimming whitespace.');
  }
  if ([...raw].length > SEARCH_QUERY_MAX_CODE_POINTS) {
    inputInvalid(
      `Argument "query" exceeds the ${SEARCH_QUERY_MAX_CODE_POINTS} Unicode code-point maximum.`,
    );
  }
  return raw;
}

/** SPEC-006 §5.1.6 rule 2: integer 1–20, default 10 when omitted. */
function validateLimit(raw: unknown): number {
  if (raw === undefined) return SEARCH_LIMIT_DEFAULT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > SEARCH_LIMIT_MAX) {
    inputInvalid(
      `Argument "limit" must be an integer 1..${SEARCH_LIMIT_MAX} (got ${JSON.stringify(raw)}).`,
    );
  }
  return raw;
}

/**
 * Deny filter derived from the effective normalized config (SPEC-004 §5.1.15
 * rules 1–2: `namespaces.deny`, a non-empty `namespaces.allow` lacking the
 * namespace, `skills.deny`). `skills.prefer` never restricts visibility.
 */
function isDeniedByPolicy(config: ProjectConfigV1, skillId: string): boolean {
  const slash = skillId.indexOf("/");
  const namespace = slash > 0 ? skillId.slice(0, slash) : skillId;
  const deniedNamespaces = config.namespaces.deny;
  const allowedNamespaces = config.namespaces.allow;
  if (
    deniedNamespaces.includes(namespace) ||
    (allowedNamespaces.length > 0 && !allowedNamespaces.includes(namespace))
  ) {
    return true;
  }
  return config.skills.deny.includes(skillId);
}

/**
 * Visible (skill_id, version_hash) pairs in deterministic registry/search
 * order (SPEC-003 §5.1.5: relative BM25, then skill_id, then version_hash).
 * Policy/lock is applied BEFORE any per-hit metadata read:
 * - LOCKED: the deny filter removes pairs from the lock catalog, then the FTS
 *   query is constrained to the remaining EXACT locked pairs — not-in-lock,
 *   denied, and historical versions never appear (SPEC-005 §5.1.12).
 * - UNLOCKED: the FTS query returns only current-version rows (historical
 *   rows never compete), and the deny filter drops rejected hits before any
 *   metadata read.
 */
function searchVisibleHits(
  db: DatabaseConnection,
  ctx: McpProjectContext,
  query: string,
): SearchHit[] {
  const config: ProjectConfigV1 = ctx.config;
  if (ctx.lockMode === "LOCKED" && ctx.lock !== null) {
    const lockedPairs = new Map<string, string>();
    for (const [skillId, entry] of Object.entries(ctx.lock.skills)) {
      if (!isDeniedByPolicy(config, skillId)) {
        lockedPairs.set(skillId, entry.version_hash);
      }
    }
    return searchSkills(db, query, { locked: lockedPairs });
  }
  return searchSkills(db, query).filter((hit) => !isDeniedByPolicy(config, hit.skillId));
}

/**
 * Canonical manifest stored as `skill_versions.manifest_json` (SPEC-002
 * §5.1.15). Only the L0 metadata fields search is allowed to surface are
 * read; instruction bodies, references, assets, and scripts never are.
 */
interface StoredManifest {
  readonly skill_id: string;
  readonly portable: {
    readonly name: string;
    readonly description: string;
  };
  readonly routing: {
    readonly domains: readonly string[];
    readonly platforms: readonly string[];
    readonly frameworks: readonly string[];
    readonly triggers: readonly string[];
    readonly anti_triggers: readonly string[];
    readonly aliases: readonly string[];
  };
  readonly files: readonly {
    readonly path: string;
    readonly role: string;
    readonly blob_hash: string;
  }[];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Parses the stored canonical manifest; corruption fails closed as unreadable. */
function parseStoredManifest(manifestJson: string, skillId: string, versionHash: string): StoredManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry manifest for ${skillId}@${versionHash} is not valid JSON.`,
    );
  }
  const manifest = parsed as StoredManifest;
  const routing = manifest?.routing;
  const portable = manifest?.portable;
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    typeof manifest.skill_id !== "string" ||
    portable === null ||
    typeof portable !== "object" ||
    typeof portable.name !== "string" ||
    typeof portable.description !== "string" ||
    routing === null ||
    typeof routing !== "object" ||
    !isStringArray(routing.domains) ||
    !isStringArray(routing.platforms) ||
    !isStringArray(routing.frameworks) ||
    !isStringArray(routing.triggers) ||
    !isStringArray(routing.anti_triggers) ||
    !isStringArray(routing.aliases) ||
    !Array.isArray(manifest.files)
  ) {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry manifest for ${skillId}@${versionHash} is missing required L0 metadata.`,
    );
  }
  return manifest as StoredManifest;
}

/**
 * Token counts are keyed by blob hash (SPEC-003 §5.1.13). L1 counts exist
 * only for AUTHORED L1s; the L2 (SKILL.md) count is always recorded for
 * imported versions. A missing count stays null (never a fake zero, AMEND-02).
 */
function blobTokenCount(
  db: DatabaseConnection,
  manifest: StoredManifest,
  role: string,
): number | null {
  for (const file of manifest.files) {
    if (file.role !== role) continue;
    return getTokenCount(db, file.blob_hash, TOKEN_ESTIMATOR_EGA_O200K_V1);
  }
  return null;
}

/** Loads one hit's frozen L0 output row from the version manifest. */
function toResultRow(
  db: DatabaseConnection,
  hit: SearchHit,
): McpSearchResultRow {
  const row = db
    .prepare(
      "SELECT manifest_json AS manifestJson, l1_status AS l1Status FROM skill_versions WHERE skill_id = ? AND version_hash = ?",
    )
    .get<{ manifestJson: string; l1Status: "AUTHORED" | "MISSING" }>(
      hit.skillId,
      hit.versionHash,
    ) as { manifestJson: string; l1Status: "AUTHORED" | "MISSING" } | undefined;
  // A hit without its version row cannot be produced by the supported import
  // pipeline; skip it deterministically rather than surfacing partial data.
  if (row === undefined) {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry is inconsistent: FTS hit ${hit.skillId}@${hit.versionHash} has no version row.`,
    );
  }
  const manifest = parseStoredManifest(row.manifestJson, hit.skillId, hit.versionHash);
  const slash = manifest.skill_id.indexOf("/");
  const namespace = slash > 0 ? manifest.skill_id.slice(0, slash) : manifest.skill_id;
  const l1Status: "AUTHORED" | "MISSING" = row.l1Status;
  const l1Tokens =
    l1Status === "AUTHORED" ? blobTokenCount(db, manifest, "core") : null;
  // The frozen container types l2_tokens as a plain number: imported versions
  // always carry the SKILL.md count, so a missing row is an incoherent local
  // version — fail closed rather than emit a shape-violating null.
  const l2Tokens = blobTokenCount(db, manifest, "skill-body");
  if (l2Tokens === null) {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry is inconsistent: version ${hit.skillId}@${hit.versionHash} has no ega-o200k-v1 L2 token count.`,
    );
  }
  return Object.freeze({
    skill_id: hit.skillId,
    version_hash: hit.versionHash,
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
  }) as McpSearchResultRow;
}

/**
 * Runs one `search` tool call against the given effective project context.
 * Throws `McpContextError` (frozen `E_*` code) on any failure — malformed
 * input (`E_MCP_INPUT_INVALID`), an unusable registry
 * (`E_REGISTRY_UNAVAILABLE`), or any boundary failure produced upstream.
 * Success returns the full MCP result: a compact one-line text summary,
 * `structuredContent` carrying EXACTLY the frozen `McpSearchOutput` container,
 * and `isError: false`.
 */
export function runSearchTool(
  args: SearchToolArgs,
  ctx: McpProjectContext,
  opts: SearchToolOptions = {},
): CallToolResult {
  void opts;
  const query = validateQuery(args.query);
  const limit = validateLimit(args.limit);

  // The read-only boundary handle is the ONLY registry surface used here: it
  // never creates, migrates, or writes the database (SPEC-006 §5.3).
  const handle: ReadOnlyRegistryHandle = openReadOnlyRegistry(ctx);
  try {
    const hits = searchVisibleHits(handle.db, ctx, query);
    const visible = hits.slice(0, limit);
    const results = visible.map((hit) => toResultRow(handle.db, hit));
    const output: McpSearchOutput = Object.freeze({
      results: Object.freeze(results),
    });
    const text = `Search matched ${results.length} project-visible skill version(s).`;
    return Object.freeze({
      content: Object.freeze([Object.freeze({ type: "text", text })]),
      structuredContent: output,
      isError: false,
    }) as CallToolResult;
  } finally {
    handle.close();
  }
}

/**
 * Success `outputSchema` for the `search` tool: validates that
 * `structuredContent` is EXACTLY the frozen `McpSearchOutput` container
 * (SPEC-006 §5.1.6 rule 4) and advertises the same shape over `tools/list`.
 */
export const SEARCH_OUTPUT_SCHEMA: StandardSchemaWithJSON<
  McpSearchOutput,
  McpSearchOutput
> = {
  "~standard": {
    version: 1,
    vendor: "ega-skills",
    types: {
      input: {} as McpSearchOutput,
      output: {} as McpSearchOutput,
    },
    validate: (value) => {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Array.isArray((value as McpSearchOutput).results)
      ) {
        return {
          issues: [{ message: "Expected a { results: [...] } McpSearchOutput container" }],
        };
      }
      const results = (value as McpSearchOutput).results as readonly unknown[];
      for (const [index, row] of results.entries()) {
        if (row === null || typeof row !== "object" || Array.isArray(row)) {
          return { issues: [{ message: `results[${index}] must be an object` }] };
        }
        const r = row as Record<string, unknown>;
        const strings: [string, string][] = [
          ["skill_id", "string"],
          ["version_hash", "string"],
          ["namespace", "string"],
          ["name", "string"],
          ["description", "string"],
        ];
        for (const [key, kind] of strings) {
          if (typeof r[key] !== kind) {
            return {
              issues: [{ message: `results[${index}].${key} must be a ${kind}` }],
            };
          }
        }
        for (const key of [
          "domains",
          "platforms",
          "frameworks",
          "triggers",
          "anti_triggers",
          "aliases",
        ]) {
          const value = r[key];
          if (
            !Array.isArray(value) ||
            value.some((item) => typeof item !== "string")
          ) {
            return {
              issues: [{ message: `results[${index}].${key} must be an array of strings` }],
            };
          }
        }
        if (r.l1_status !== "AUTHORED" && r.l1_status !== "MISSING") {
          return {
            issues: [
              { message: `results[${index}].l1_status must be "AUTHORED" or "MISSING"` },
            ],
          };
        }
        const l1 = r.l1_tokens;
        if (l1 !== null && (typeof l1 !== "number" || !Number.isInteger(l1))) {
          return {
            issues: [
              { message: `results[${index}].l1_tokens must be an integer or null` },
            ],
          };
        }
        const l2 = r.l2_tokens;
        if (typeof l2 !== "number" || !Number.isInteger(l2)) {
          return {
            issues: [{ message: `results[${index}].l2_tokens must be an integer` }],
          };
        }
      }
      return { value: value as McpSearchOutput };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
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
              required: [
                "skill_id",
                "version_hash",
                "namespace",
                "name",
                "description",
                "domains",
                "platforms",
                "frameworks",
                "triggers",
                "anti_triggers",
                "aliases",
                "l1_status",
                "l1_tokens",
                "l2_tokens",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["results"],
        additionalProperties: false,
      }),
      output: () => ({ $ref: "#/$defs/searchOutput" }),
    },
  },
};