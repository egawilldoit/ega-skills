/**
 * EGA MCP runtime — `resolve` tool body (SPEC-006 §5.1.5, EGA-590).
 *
 * Thin adapter over the production SPEC-004 resolver (`resolveSkills`):
 * snake_case externals in, the frozen `ResolutionResult` mapped to
 * snake_case externals out — metadata/structured output ONLY, never L1/L2
 * instruction bodies. No independent router behavior, no session state, no
 * network.
 *
 * Read-only note: the production resolver opens the registry through its own
 * `openRegistry` path, so the adapter gates on the shared boundary FIRST —
 * a missing database fails with `E_REGISTRY_UNAVAILABLE` before the
 * resolver can ever create anything, and with an available database the
 * open/migration path is inert (existing dirs, current schema) while
 * resolution itself is SELECT-only. A database byte-identity test pins this.
 *
 * Error mapping: malformed external input (including the internal
 * `E_RESOLVE_REQUEST_INVALID`, never exposed raw) surfaces as
 * `E_MCP_INPUT_INVALID` through the frozen structured envelope.
 */

import process from "node:process";

import type { CallToolResult, StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import {
  resolveSkills,
  type ResolutionResult,
} from "@ega-skills/router";

import {
  McpContextError,
  type McpProjectContext,
} from "./project-context.js";

/** SPEC-006 §5.1.5 input bounds (mirrored in the registered input schema). */
export const RESOLVE_TASK_MAX_CODE_POINTS = 16_384;
export const RESOLVE_MAX_SKILLS_MIN = 1;
export const RESOLVE_MAX_SKILLS_MAX = 3;
export const RESOLVE_MAX_TOKENS_MIN = 1;
export const RESOLVE_MAX_TOKENS_MAX = 1_000_000;

/** Raw tool arguments; every field is validated inside runResolveTool. */
export interface ResolveToolArgs {
  readonly task?: unknown;
  readonly project_path?: unknown;
  readonly explicit_skills?: unknown;
  readonly max_skills?: unknown;
  readonly max_tokens?: unknown;
}

export interface ResolveToolOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function inputInvalid(message: string): never {
  throw new McpContextError("E_MCP_INPUT_INVALID", message);
}

function validateTask(raw: unknown): string {
  if (typeof raw !== "string") {
    inputInvalid(`Argument "task" must be a string (got ${typeof raw}).`);
  }
  if (raw.trim().length === 0) {
    inputInvalid('Argument "task" must be non-empty after trimming whitespace.');
  }
  if ([...raw].length > RESOLVE_TASK_MAX_CODE_POINTS) {
    inputInvalid(
      `Argument "task" exceeds the ${RESOLVE_TASK_MAX_CODE_POINTS} Unicode code-point maximum.`,
    );
  }
  return raw;
}

function validateExplicitSkills(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    inputInvalid('Argument "explicit_skills" must be an array of strings.');
  }
  return raw as readonly string[];
}

function validateIntInRange(
  raw: unknown,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    inputInvalid(`Argument "${name}" must be an integer ${min}..${max}.`);
  }
  return raw as number;
}

/** SPEC-004 validity codes that surface verbatim through the MCP envelope. */
const VERBATIM_RESOLVER_CODES = new Set([
  "E_SKILL_NOT_FOUND",
  "E_SKILL_REFERENCE_AMBIGUOUS",
]);

/** Maps resolver/internal failures to frozen MCP codes (never raw). */
function mapResolverError(error: unknown): McpContextError {
  if (error instanceof McpContextError) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = (error as { code: unknown }).code;
    // Internal request-validity failures are never exposed raw (SPEC-006 §5.1.5.4).
    if (code === "E_RESOLVE_REQUEST_INVALID") {
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Malformed resolve request.";
      return new McpContextError("E_MCP_INPUT_INVALID", message);
    }
    // SPEC-004 validity codes (explicit-reference outcomes) surface verbatim
    // through the same structured envelope (SPEC-006 §5.2 parenthetical).
    if (typeof code === "string" && VERBATIM_RESOLVER_CODES.has(code)) {
      const message =
        error instanceof Error && error.message.length > 0 ? error.message : code;
      return new McpContextError(code, message);
    }
  }
  if (error instanceof Error && error.message.length > 0) {
    // Production resolver failures (registry reads, fingerprinting) are
    // local-read failures in this offline tool: surface the message under the
    // registry-unavailable code rather than leaking internals.
    return new McpContextError("E_REGISTRY_UNAVAILABLE", `Resolve failed: ${error.message}`);
  }
  return new McpContextError("E_REGISTRY_UNAVAILABLE", "Resolve failed: unreadable local state.");
}

interface SnakeSkill {
  readonly id: string;
  readonly name: string;
  readonly version_hash: string;
  readonly tier: string;
  readonly recommended_content_level: string;
  readonly recommended_content_tokens: number;
  readonly evidence: readonly { readonly category: string; readonly value: string }[];
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
}

function toSnakeSkill(skill: {
  readonly id: string;
  readonly name: string;
  readonly versionHash: string;
  readonly tier: string;
  readonly recommendedContentLevel: string;
  readonly recommendedContentTokens: number;
  readonly evidence: readonly { readonly category: string; readonly value: string }[];
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
}): SnakeSkill {
  return Object.freeze({
    id: skill.id,
    name: skill.name,
    version_hash: skill.versionHash,
    tier: skill.tier,
    recommended_content_level: skill.recommendedContentLevel,
    recommended_content_tokens: skill.recommendedContentTokens,
    evidence: Object.freeze(skill.evidence.map((item) => Object.freeze({ ...item }))),
    reasons: Object.freeze([...skill.reasons]),
    warnings: Object.freeze([...skill.warnings]),
  });
}

/**
 * The SPEC-004 `ResolutionResult` mapped to snake_case externals (SPEC-006
 * §5.1.5.2, AMEND-04): every frozen child type is preserved; L1/L2 bodies
 * never enter the payload (the resolver never produces them).
 */
export function toSnakeResolution(result: ResolutionResult): Record<string, unknown> {
  return Object.freeze({
    resolution_id: result.resolutionId,
    router_contract_version: result.routerContractVersion,
    router_implementation_version: result.routerImplementationVersion,
    mode: result.mode,
    confidence: result.confidence,
    project_fingerprint: Object.freeze({
      project_path: result.projectFingerprint.projectPath,
      package_root: result.projectFingerprint.packageRoot,
      workspace_root: result.projectFingerprint.workspaceRoot,
      workspace_ambiguous: result.projectFingerprint.workspaceAmbiguous,
      languages: Object.freeze([...result.projectFingerprint.languages]),
      platforms: Object.freeze([...result.projectFingerprint.platforms]),
      frameworks: Object.freeze([...result.projectFingerprint.frameworks]),
      evidence: Object.freeze(
        result.projectFingerprint.evidence.map((item) => Object.freeze({ ...item })),
      ),
    }),
    explicit: Object.freeze(result.explicit.map(toSnakeSkill)),
    selected: Object.freeze(result.selected.map(toSnakeSkill)),
    candidates: Object.freeze(result.candidates.map(toSnakeSkill)),
    rejected: Object.freeze(
      result.rejected.map((skill) =>
        Object.freeze({
          id: skill.id,
          name: skill.name,
          ...(skill.versionHash !== undefined ? { version_hash: skill.versionHash } : {}),
          ...(skill.tier !== undefined ? { tier: skill.tier } : {}),
          evidence: Object.freeze(skill.evidence.map((item) => Object.freeze({ ...item }))),
          reasons: Object.freeze([...skill.reasons]),
        }),
      ),
    ),
    automatic_selected_tokens: result.automaticSelectedTokens,
    explicit_selected_tokens: result.explicitSelectedTokens,
    max_tokens: result.maxTokens,
    max_skills: result.maxSkills,
    lock_status: result.lockStatus,
    budget_status: result.budgetStatus,
  });
}

/**
 * Runs one `resolve` tool call against the given effective project context.
 * Async: the production resolver is async. Success returns the MCP result
 * (compact text summary + snake_case structured payload, `isError: false`);
 * failures throw `McpContextError` with a frozen code.
 */
export async function runResolveTool(
  args: ResolveToolArgs,
  ctx: McpProjectContext,
  opts: ResolveToolOptions = {},
): Promise<CallToolResult> {
  const task = validateTask(args.task);
  const explicitSkills = validateExplicitSkills(args.explicit_skills);
  const maxSkills = validateIntInRange(
    args.max_skills,
    "max_skills",
    RESOLVE_MAX_SKILLS_MIN,
    RESOLVE_MAX_SKILLS_MAX,
  );
  const maxTokens = validateIntInRange(
    args.max_tokens,
    "max_tokens",
    RESOLVE_MAX_TOKENS_MIN,
    RESOLVE_MAX_TOKENS_MAX,
  );
  if (!ctx.registryAvailable) {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry database is not present: ${ctx.registryDatabase}`,
    );
  }
  // The resolver reads the SAME registry the boundary already gated: pin
  // EGA_SKILLS_HOME to the context's resolved home so direct calls (no ambient
  // env) and served calls behave identically. No network is ever consulted.
  const env: Record<string, string | undefined> = {
    ...(opts.env ?? process.env),
    EGA_SKILLS_HOME: ctx.registryHome,
  };
  let result: ResolutionResult;
  try {
    result = await resolveSkills({
      task,
      projectPath: ctx.projectPath,
      ...(explicitSkills !== undefined ? { explicitSkills } : {}),
      ...(maxSkills !== undefined || maxTokens !== undefined
        ? {
            budget: {
              ...(maxSkills !== undefined ? { maxSkills } : {}),
              ...(maxTokens !== undefined ? { maxTokens } : {}),
            },
          }
        : {}),
      env,
    });
  } catch (error) {
    throw mapResolverError(error);
  }
  const structuredContent = toSnakeResolution(result);
  const selected = result.selected.map((skill) => skill.id).join(", ") || "(none)";
  const text =
    `Resolve selected ${result.selected.length} skill(s) ` +
    `[${selected}] at ${result.confidence} confidence (${result.lockStatus}, ${result.budgetStatus}).`;
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: "text", text })]),
    structuredContent,
    isError: false,
  }) as CallToolResult;
}

/**
 * Success `outputSchema` for the `resolve` tool: validates that
 * `structuredContent` is the snake_case resolution container and advertises
 * the same shape over `tools/list`.
 */
export const RESOLVE_OUTPUT_SCHEMA: StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "ega-skills",
    types: {
      input: {} as Record<string, unknown>,
      output: {} as Record<string, unknown>,
    },
    validate: (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "Expected a snake_case resolution object" }] };
      }
      const output = value as Record<string, unknown>;
      for (const key of [
        "resolution_id",
        "router_contract_version",
        "router_implementation_version",
        "mode",
        "confidence",
        "project_fingerprint",
        "explicit",
        "selected",
        "candidates",
        "rejected",
        "automatic_selected_tokens",
        "explicit_selected_tokens",
        "max_tokens",
        "max_skills",
        "lock_status",
        "budget_status",
      ]) {
        if (!(key in output)) {
          return { issues: [{ message: `Missing resolution field: ${key}`, path: [key] }] };
        }
      }
      for (const key of ["explicit", "selected", "candidates", "rejected"]) {
        if (!Array.isArray(output[key])) {
          return { issues: [{ message: `Resolution field ${key} must be an array`, path: [key] }] };
        }
      }
      if (output["confidence"] !== "HIGH" && output["confidence"] !== "MEDIUM" && output["confidence"] !== "LOW") {
        return { issues: [{ message: "Resolution confidence must be HIGH, MEDIUM, or LOW" }] };
      }
      return { value: output };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: {
          resolution_id: { type: "string" },
          router_contract_version: { type: "integer" },
          router_implementation_version: { type: "string" },
          mode: { type: "string", enum: ["suggest"] },
          confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
          project_fingerprint: { type: "object" },
          explicit: { type: "array" },
          selected: { type: "array" },
          candidates: { type: "array" },
          rejected: { type: "array" },
          automatic_selected_tokens: { type: "integer" },
          explicit_selected_tokens: { type: "integer" },
          max_tokens: { type: "integer" },
          max_skills: { type: "integer" },
          lock_status: { type: "string", enum: ["LOCKED", "UNLOCKED"] },
          budget_status: { type: "string" },
        },
        required: [
          "resolution_id",
          "confidence",
          "selected",
          "lock_status",
          "budget_status",
        ],
        additionalProperties: true,
      }),
      output: () => ({ $ref: "#/$defs/resolveOutput" }),
    },
  },
};
