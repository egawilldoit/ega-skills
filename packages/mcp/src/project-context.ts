/**
 * EGA MCP runtime — shared project/runtime boundary (SPEC-006 §5.1.4, §5.3;
 * EGA-589).
 *
 * ONE effective-project normalization helper serves all four V1 tools
 * (`resolve`, `search`, `inspect`, `get_content`). Every call executes inside
 * one effective project config/lock/policy context; there is no
 * unscoped/global MCP mode. The boundary is read-only and offline: it reads
 * project config/lock discovery inputs and the local registry home path, and
 * performs no writes, no shell use, no skill-script invocation, and no
 * network access. It keeps no activation or session state — every call is
 * evaluated from its explicit `project_path` input plus local
 * project/registry state.
 *
 * Layering (frozen logic is reused, never reimplemented):
 * - effective path + nearest-config walk: `@ega-skills/project` EGA-582
 *   (`resolveEffectiveProjectPath`, `discoverConfig`);
 * - control-file gate: `@ega-skills/project` EGA-584 (`readConfigAndLock`);
 * - lock-mode decision: `@ega-skills/project` EGA-586 (`resolveLockMode`);
 * - registry home: `@ega-skills/registry` (`resolveRegistryHome`, pure — the
 *   mkdir variant `ensureRegistryHome` is NEVER used here).
 *
 * Failure mapping (SPEC-006 §5.2): a missing project path surfaces
 * `E_PROJECT_NOT_FOUND`; config/lock gate failures propagate their frozen
 * SPEC-005 codes verbatim (`E_PROJECT_CONFIG_INVALID`,
 * `E_PROJECT_LOCK_INVALID`, plus the owning-layer validity codes such as
 * `E_LOCK_CONFIG_MISMATCH` / `E_LOCK_REQUIRED`, which surface through the
 * same structured envelope per §5.2); an unusable registry surfaces
 * `E_REGISTRY_UNAVAILABLE`. The function is total: it returns a context or
 * throws `McpContextError`, never a raw internal error.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type { CallToolResult } from "@modelcontextprotocol/server";
import Database, { type DatabaseConnection } from "better-sqlite3";

import {
  PROJECT_CONFIG_V1_DEFAULTS,
  discoverConfig,
  readConfigAndLock,
  resolveEffectiveProjectPath,
  resolveLockMode,
  type ProjectConfigV1,
  type ProjectLockMode,
  type ProjectLockV1,
} from "@ega-skills/project";
import { CURRENT_SCHEMA_VERSION, resolveRegistryHome } from "@ega-skills/registry";

/** Primary frozen codes produced by this boundary module. */
export const MCP_BOUNDARY_ERROR_CODES = [
  "E_PROJECT_NOT_FOUND",
  "E_PROJECT_CONFIG_INVALID",
  "E_PROJECT_LOCK_INVALID",
  "E_REGISTRY_UNAVAILABLE",
] as const;

export type McpBoundaryErrorCode = (typeof MCP_BOUNDARY_ERROR_CODES)[number];

/**
 * Structured boundary failure. `code` is always a frozen `E_*` code: the
 * primary boundary codes above, or a verbatim owning-layer SPEC-005 validity
 * code (e.g. `E_LOCK_CONFIG_MISMATCH`, `E_LOCK_REQUIRED`) surfaced through
 * the same envelope per SPEC-006 §5.2.
 */
export class McpContextError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpContextError";
    this.code = code;
  }
}

/** Extracts a frozen string `code` from an owning-layer error, if present. */
function owningCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = (error as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * ONE effective MCP project context shared by all four tools (SPEC-006
 * §5.1.4 rules 1–4).
 */
export interface McpProjectContext {
  /** Real (symlink-resolved) effective project directory. */
  readonly projectPath: string;
  /** Nearest `.egaskills.yaml`, or null when no config is selected. */
  readonly configPath: string | null;
  /** `.egaskills.lock` adjacent to the selected config, or null. */
  readonly lockPath: string | null;
  /** Effective normalized config (frozen defaults when none selected). */
  readonly config: ProjectConfigV1;
  /** False when no config is selected (defaults apply, unlocked unless a lock exists — locks without a config are ignored). */
  readonly hasSelectedConfig: boolean;
  /** Validated active lock, or null when none is in force. */
  readonly lock: ProjectLockV1 | null;
  /** LOCKED when a valid active lock governs, else UNLOCKED. */
  readonly lockMode: ProjectLockMode;
  /** Pure registry home path (never created by this module). */
  readonly registryHome: string;
  /** Expected `registry.sqlite` path inside the registry home. */
  readonly registryDatabase: string;
  /** False when the database file is absent — tools then fail with `E_REGISTRY_UNAVAILABLE` instead of creating anything. */
  readonly registryAvailable: boolean;
}

export interface McpProjectContextOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam for the omitted-`project_path` fallback (defaults to `process.cwd()`). */
  readonly cwd?: string;
}

/**
 * Resolves the shared MCP project context for one tool call.
 *
 * @param projectPathInput the tool's optional `project_path` (absent means
 *   realpath(cwd); a file input resolves to its parent directory).
 */
export function resolveMcpProjectContext(
  projectPathInput?: string,
  options: McpProjectContextOptions = {},
): McpProjectContext {
  const env = options.env ?? process.env;
  const supplied = projectPathInput ?? options.cwd ?? process.cwd();

  // Stage 1 — effective real project path (SPEC-005 §5.1.1). A symlinked cwd
  // and its real path resolve identically; a missing path fails closed.
  let projectPath: string;
  try {
    projectPath = resolveEffectiveProjectPath(supplied);
  } catch (error) {
    throw new McpContextError(
      "E_PROJECT_NOT_FOUND",
      `Project path does not exist: ${messageOf(error, supplied)}`,
    );
  }

  // Stage 2 — nearest-config discovery + control-file gate (SPEC-005
  // §5.1.2/§5.1.14). Stray locks without a selected config are ignored;
  // linked/non-text/stale control files fail with their frozen codes.
  const discovery = discoverConfig(projectPath);
  let config: ProjectConfigV1 | null;
  let lock: ProjectLockV1 | null;
  try {
    const gated = readConfigAndLock(discovery);
    config = gated.config;
    lock = gated.lock;
  } catch (error) {
    throw new McpContextError(
      owningCode(error) ?? "E_PROJECT_CONFIG_INVALID",
      messageOf(error, "Invalid project config or lock"),
    );
  }

  // Stage 3 — lock-mode decision (SPEC-005 §5.1.12). A valid present lock is
  // authoritative; `locking.required` without a lock throws E_LOCK_REQUIRED.
  const effectiveConfig: ProjectConfigV1 = config ?? PROJECT_CONFIG_V1_DEFAULTS;
  let lockMode: ProjectLockMode;
  let activeLock: ProjectLockV1 | null;
  try {
    const modeData = resolveLockMode({ config: effectiveConfig, lock });
    lockMode = modeData.mode;
    activeLock = modeData.lock;
  } catch (error) {
    throw new McpContextError(
      owningCode(error) ?? "E_PROJECT_LOCK_INVALID",
      messageOf(error, "Invalid project lock state"),
    );
  }

  // Stage 4 — registry home (pure resolution only: never created, never
  // migrated, never written by this module).
  let registryHome: string;
  try {
    registryHome = resolveRegistryHome(env);
  } catch (error) {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry is unavailable: ${messageOf(error, "registry home is unusable")}`,
    );
  }
  const registryDatabase = join(registryHome, "registry.sqlite");
  let registryAvailable = false;
  try {
    registryAvailable = existsSync(registryDatabase);
  } catch {
    registryAvailable = false;
  }

  return Object.freeze({
    projectPath,
    configPath: discovery.configPath,
    lockPath: discovery.lockPath,
    config: effectiveConfig,
    hasSelectedConfig: config !== null,
    lock: activeLock,
    lockMode,
    registryHome,
    registryDatabase,
    registryAvailable,
  });
}

/** Read-only registry handle: the database plus its close function. */
export interface ReadOnlyRegistryHandle {
  readonly db: DatabaseConnection;
  readonly registryDatabase: string;
  close(): void;
}

const FTS5_PROBE_TABLE = "temp.__ega_mcp_fts5_probe";

/**
 * Opens the context's registry database WITHOUT creating, migrating, or
 * writing it (SPEC-006 §5.1.4 rules 5–6, §5.3). Missing/unreadable/newer
 * databases fail with `E_REGISTRY_UNAVAILABLE`; the network is never
 * consulted and no fallback registry is used. Reads run under SQLite
 * `query_only` so even the owning handle cannot mutate the file.
 */
export function openReadOnlyRegistry(context: McpProjectContext): ReadOnlyRegistryHandle {
  if (!context.registryAvailable) {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry database is not present: ${context.registryDatabase}`,
    );
  }
  let db: DatabaseConnection;
  try {
    // The database file was verified present above: better-sqlite3 must never
    // implicitly create it here.
    db = new Database(context.registryDatabase);
  } catch (error) {
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry cannot be opened: ${messageOf(error, context.registryDatabase)}`,
    );
  }
  try {
    const schemaVersion = db.pragma<number>("user_version", { simple: true });
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new McpContextError(
        "E_REGISTRY_UNAVAILABLE",
        `Local registry schema is unusable (user_version ${String(schemaVersion)})`,
      );
    }
    // FTS5 must exist for project-scoped search. The probe touches the temp
    // schema only and is dropped before the read-only lockdown, so the
    // database file is never modified.
    db.exec(`CREATE VIRTUAL TABLE ${FTS5_PROBE_TABLE} USING fts5(x)`);
    db.exec(`DROP TABLE ${FTS5_PROBE_TABLE}`);
    db.pragma("query_only = ON");
    const enforced = db.pragma<number>("query_only", { simple: true });
    if (enforced !== 1) {
      throw new McpContextError(
        "E_REGISTRY_UNAVAILABLE",
        "Local registry could not be locked to read-only mode",
      );
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // Ignore close failures while propagating the opening failure.
    }
    if (error instanceof McpContextError) throw error;
    throw new McpContextError(
      "E_REGISTRY_UNAVAILABLE",
      `Local registry cannot be read: ${messageOf(error, context.registryDatabase)}`,
    );
  }
  const registryDatabase = context.registryDatabase;
  return Object.freeze({
    db,
    registryDatabase,
    close: (): void => {
      db.close();
    },
  });
}

/**
 * Maps a boundary failure to the frozen structured MCP error result
 * (SPEC-006 §5.1.3.3): `isError` plus a structured `McpToolError` carrying
 * the exact `E_*` code and the tool name.
 */
export function toMcpErrorResult(tool: string, error: McpContextError): CallToolResult {
  const payload = Object.freeze({ code: error.code, message: error.message, tool });
  const text = JSON.stringify({ error: payload });
  return Object.freeze({
    content: Object.freeze([{ type: "text", text }]),
    structuredContent: Object.freeze({ error: payload }),
    isError: true,
  }) as CallToolResult;
}
