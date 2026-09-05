/**
 * EGA MCP runtime — local stdio server skeleton (SPEC-006 §5.1.1–§5.1.2).
 *
 * V1 exposes EXACTLY four tools over stdio: `resolve`, `search`, `inspect`,
 * `get_content`. This skeleton registers all four with their frozen input
 * shapes, but every body is a placeholder: it returns the frozen structured
 * unimplemented error. Real tool bodies land in EGA-590..EGA-593.
 *
 * Protocol hygiene (SPEC-006 §5.1.2): stdout carries MCP protocol ONLY.
 * Nothing in this module ever writes to stdout; the single logging sink goes
 * to stderr.
 *
 * Offline + registry safety (SPEC-006 §5.1.4.5/.6): the skeleton performs no
 * network and no registry/cache I/O at startup or in any tool call. A missing
 * or unreadable registry therefore can never crash the server — every call
 * still completes with the frozen structured error. (Bodies in EGA-590..593
 * will surface `E_REGISTRY_UNAVAILABLE` through the same structured
 * `McpToolError` envelope.)
 */

import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import process from "node:process";

import {
  McpContextError,
  resolveMcpProjectContext,
  toMcpErrorResult,
  type McpProjectContext,
} from "./project-context.js";
import {
  inspectOutputSchema,
  runInspectTool,
  toInspectErrorResult,
  toInspectSuccessResult,
} from "./inspect.js";

/**
 * Frozen structured error carried by every tool error result (SPEC-006
 * §5.1.3.3): `isError` plus a structured `McpToolError` with the exact
 * `E_*` code and the tool name. Deep-frozen: one shared instance, identical
 * payload across every call.
 */
export interface McpToolError {
  readonly code: string;
  readonly message: string;
  readonly tool: string;
}

/** `structuredContent` container for tool error results. */
export interface McpToolErrorEnvelope {
  readonly error: McpToolError;
}

/**
 * Frozen skeleton placeholder error: code + message are shared verbatim by
 * all four tools (EGA-588). Not part of the SPEC-006 §5.2 implemented-behavior
 * inventory — tool bodies in EGA-590..593 replace it with the real codes.
 */
export const TOOL_NOT_IMPLEMENTED_ERROR: Readonly<{
  code: string;
  message: string;
}> = Object.freeze({
  code: "E_TOOL_NOT_IMPLEMENTED",
  message:
    "Tool body is not implemented in the MCP skeleton; lands in EGA-590..EGA-593.",
});

/** The four V1 tool names, in registry order (SPEC-006 §5.1.1.3). */
export const TOOL_NAMES = ["resolve", "search", "inspect", "get_content"] as const;

type ToolName = (typeof TOOL_NAMES)[number];

function deepFreezeResult(
  content: readonly [Readonly<{ type: "text"; text: string }>],
  structuredContent: Readonly<McpToolErrorEnvelope>,
): CallToolResult {
  // The runtime object is fully frozen; the cast only satisfies the SDK's
  // mutable-typed CallToolResult signature.
  return Object.freeze({
    content: Object.freeze([content[0]]),
    structuredContent: Object.freeze({ error: structuredContent.error }),
    isError: true,
  }) as CallToolResult;
}

/** One frozen per-tool result, constructed once at module load. */
const TOOL_NOT_IMPLEMENTED_RESULTS: Readonly<Record<ToolName, CallToolResult>> =
  Object.freeze(
    Object.fromEntries(
      TOOL_NAMES.map((tool) => {
        const error: McpToolError = Object.freeze({
          code: TOOL_NOT_IMPLEMENTED_ERROR.code,
          message: TOOL_NOT_IMPLEMENTED_ERROR.message,
          tool,
        });
        return [
          tool,
          deepFreezeResult(
            [{ type: "text", text: JSON.stringify({ error }) }],
            Object.freeze({ error }),
          ),
        ];
      }),
    ) as Record<ToolName, CallToolResult>,
  );

/**
 * Minimal Standard Schema v1 implementation (no runtime dependencies; the
 * pinned SDK accepts any `StandardSchemaWithJSON`). `validate` checks the
 * declared field types/requiredness; `jsonSchema` advertises the same shape
 * to clients via `tools/list`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function toolSchema(spec: {
  fields: Record<
    string,
    | { type: "string"; nonEmpty?: boolean }
    | { type: "integer"; min?: number; max?: number }
    | { type: "string-array" }
    | { type: "enum"; values: readonly string[] }
  >;
  required: readonly string[];
}): StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>> {
  const jsonProperties: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(spec.fields)) {
    switch (field.type) {
      case "string":
        jsonProperties[key] = { type: "string" };
        break;
      case "integer":
        jsonProperties[key] = {
          type: "integer",
          ...(field.min !== undefined ? { minimum: field.min } : {}),
          ...(field.max !== undefined ? { maximum: field.max } : {}),
        };
        break;
      case "string-array":
        jsonProperties[key] = { type: "array", items: { type: "string" } };
        break;
      case "enum":
        jsonProperties[key] = { type: "string", enum: [...field.values] };
        break;
    }
  }
  return {
    "~standard": {
      version: 1,
      vendor: "ega-skills",
      types: {
        input: {} as Record<string, unknown>,
        output: {} as Record<string, unknown>,
      },
      validate: (value) => {
        const issues: { message: string; path?: (string | number)[] }[] = [];
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "Expected an object of tool arguments" }] };
        }
        const args = value as Record<string, unknown>;
        for (const key of spec.required) {
          if (!(key in args)) {
            issues.push({ message: `Missing required argument: ${key}`, path: [key] });
          }
        }
        for (const [key, field] of Object.entries(spec.fields)) {
          const raw = args[key];
          if (raw === undefined) continue;
          switch (field.type) {
            case "string": {
              if (typeof raw !== "string") {
                issues.push({ message: `Argument ${key} must be a string`, path: [key] });
              } else if (field.nonEmpty && raw.trim() === "") {
                issues.push({ message: `Argument ${key} must not be empty`, path: [key] });
              }
              break;
            }
            case "integer": {
              if (typeof raw !== "number" || !Number.isInteger(raw)) {
                issues.push({ message: `Argument ${key} must be an integer`, path: [key] });
              } else if (
                (field.min !== undefined && raw < field.min) ||
                (field.max !== undefined && raw > field.max)
              ) {
                issues.push(
                  {
                    message: `Argument ${key} must be within ${field.min}..${field.max}`,
                    path: [key],
                  },
                );
              }
              break;
            }
            case "string-array": {
              if (
                !Array.isArray(raw) ||
                raw.some((item) => typeof item !== "string")
              ) {
                issues.push({
                  message: `Argument ${key} must be an array of strings`,
                  path: [key],
                });
              }
              break;
            }
            case "enum": {
              if (typeof raw !== "string" || !field.values.includes(raw)) {
                issues.push(
                  {
                    message: `Argument ${key} must be one of: ${field.values.join(", ")}`,
                    path: [key],
                  },
                );
              }
              break;
            }
          }
        }
        return issues.length > 0
          ? { issues }
          : { value: args as Record<string, unknown> };
      },
      jsonSchema: {
        input: () => ({
          type: "object",
          properties: jsonProperties,
          required: [...spec.required],
          additionalProperties: true,
        }),
        output: () => ({ $ref: "#/$defs/toolErrorEnvelope" }),
      },
    },
  };
}

/** Shared output schema: `structuredContent` is the frozen error envelope. */
const OUTPUT_SCHEMA: StandardSchemaWithJSON<McpToolErrorEnvelope, McpToolErrorEnvelope> = {
  "~standard": {
    version: 1,
    vendor: "ega-skills",
    types: {
      input: {} as McpToolErrorEnvelope,
      output: {} as McpToolErrorEnvelope,
    },
    validate: (value) => {
      if (value === null || typeof value !== "object") {
        return { issues: [{ message: "Expected an McpToolError envelope" }] };
      }
      const envelope = value as McpToolErrorEnvelope;
      const error = envelope.error;
      if (
        error === null ||
        typeof error !== "object" ||
        typeof error.code !== "string" ||
        typeof error.message !== "string" ||
        typeof error.tool !== "string"
      ) {
        return {
          issues: [
            { message: "Expected error: { code, message, tool }" },
          ],
        };
      }
      return { value: envelope };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              tool: { type: "string" },
            },
            required: ["code", "message", "tool"],
            additionalProperties: false,
          },
        },
        required: ["error"],
        additionalProperties: false,
      }),
      output: () => ({ $ref: "#/$defs/toolErrorEnvelope" }),
    },
  },
};

/**
 * Context-first handler shell (EGA-589, SPEC-006 §5.1.4): resolves the shared
 * project/runtime boundary before any tool logic. Boundary failures return
 * the frozen structured error for that tool; success falls through to the
 * tool body (the skeleton placeholder until EGA-590..EGA-593 land the real
 * bodies, which reuse this same shell).
 */
function withProjectBoundary(
  tool: ToolName,
  placeholder: CallToolResult,
): (args: Record<string, unknown>) => CallToolResult {
  return (args) => {
    const rawProjectPath: unknown = args["project_path"];
    try {
      resolveMcpProjectContext(
        typeof rawProjectPath === "string" ? rawProjectPath : undefined,
      );
    } catch (error) {
      const contextError =
        error instanceof McpContextError
          ? error
          : new McpContextError(
              "E_PROJECT_NOT_FOUND",
              error instanceof Error ? error.message : "Project path does not exist",
            );
      return toMcpErrorResult(tool, contextError);
    }
    return placeholder;
  };
}

/**
 * Context-first inspect handler (SPEC-006 §5.1.4, EGA-592): resolves the
 * shared project boundary exactly like the shell, then runs the real
 * `inspect` body. Boundary failures use the shared envelope; body failures
 * use the inspect error mapping (frozen codes only, never invented).
 */
function withInspectBoundary(): (args: Record<string, unknown>) => CallToolResult {
  return (args) => {
    const rawProjectPath: unknown = args["project_path"];
    let context: McpProjectContext;
    try {
      context = resolveMcpProjectContext(
        typeof rawProjectPath === "string" ? rawProjectPath : undefined,
      );
    } catch (error) {
      const contextError =
        error instanceof McpContextError
          ? error
          : new McpContextError(
              "E_PROJECT_NOT_FOUND",
              error instanceof Error ? error.message : "Project path does not exist",
            );
      return toMcpErrorResult("inspect", contextError);
    }
    try {
      const rawSkillId: unknown = args["skill_id"];
      const rawVersionHash: unknown = args["version_hash"];
      return toInspectSuccessResult(
        runInspectTool(
          {
            skill_id: typeof rawSkillId === "string" ? rawSkillId : "",
            ...(typeof rawProjectPath === "string" ? { project_path: rawProjectPath } : {}),
            ...(typeof rawVersionHash === "string" ? { version_hash: rawVersionHash } : {}),
          },
          context,
        ),
      );
    } catch (error) {
      return toInspectErrorResult(error);
    }
  };
}

/** Module-load-bound context-first handlers (one shared closure per tool). */
const BOUND_HANDLERS: Readonly<
  Record<ToolName, (args: Record<string, unknown>) => CallToolResult>
> = Object.freeze({
  resolve: withProjectBoundary("resolve", TOOL_NOT_IMPLEMENTED_RESULTS.resolve),
  search: withProjectBoundary("search", TOOL_NOT_IMPLEMENTED_RESULTS.search),
  inspect: withInspectBoundary(),
  get_content: withProjectBoundary("get_content", TOOL_NOT_IMPLEMENTED_RESULTS.get_content),
});

/**
 * Constructs the MCP server with the four frozen V1 tool registrations.
 * Stateless: a fresh instance per connection (SPEC-006 §5.1.9).
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "ega-skills", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  const resolveInput = toolSchema({
    fields: {
      task: { type: "string", nonEmpty: true },
      project_path: { type: "string" },
      explicit_skills: { type: "string-array" },
      max_skills: { type: "integer", min: 1, max: 3 },
      max_tokens: { type: "integer", min: 1, max: 1_000_000 },
    },
    required: ["task"],
  });

  const searchInput = toolSchema({
    fields: {
      query: { type: "string", nonEmpty: true },
      project_path: { type: "string" },
      limit: { type: "integer", min: 1, max: 20 },
    },
    required: ["query"],
  });

  const inspectInput = toolSchema({
    fields: {
      skill_id: { type: "string", nonEmpty: true },
      project_path: { type: "string" },
      version_hash: { type: "string" },
    },
    required: ["skill_id"],
  });

  const getContentInput = toolSchema({
    fields: {
      skill_id: { type: "string", nonEmpty: true },
      version_hash: { type: "string", nonEmpty: true },
      level: { type: "enum", values: ["L1", "L2"] },
      max_tokens: { type: "integer", min: 1, max: 1_000_000 },
      project_path: { type: "string" },
    },
    required: ["skill_id", "version_hash", "level", "max_tokens"],
  });

  server.registerTool(
    "resolve",
    {
      title: "Resolve a task to the best local skill set",
      description: "Resolve a task to the best local skill set (SPEC-006 §5.1.5)",
      inputSchema: resolveInput,
      outputSchema: OUTPUT_SCHEMA,
    },
    (args: Record<string, unknown>) => BOUND_HANDLERS.resolve(args),
  );
  server.registerTool(
    "search",
    {
      description: "Search project-visible skill L0 metadata by query",
      inputSchema: searchInput,
      outputSchema: OUTPUT_SCHEMA,
    },
    (args: Record<string, unknown>) => BOUND_HANDLERS.search(args),
  );
  server.registerTool(
    "inspect",
    {
      description: "Inspect one canonical skill version's L0 metadata",
      inputSchema: inspectInput,
      outputSchema: inspectOutputSchema,
    },
    (args: Record<string, unknown>) => BOUND_HANDLERS.inspect(args),
  );
  server.registerTool(
    "get_content",
    {
      description: "Return exact canonical L1/L2 content for a version",
      inputSchema: getContentInput,
      outputSchema: OUTPUT_SCHEMA,
    },
    (args: Record<string, unknown>) => BOUND_HANDLERS.get_content(args),
  );

  return server;
}

/**
 * Serves the EGA MCP runtime over stdio (SPEC-006 §5.1.1): protocol on
 * stdout only, diagnostics on stderr, clean process exit on disconnect.
 * The process terminates once stdin is exhausted (client disconnect).
 */
export function startStdioServer(): StdioServerHandle {
  const handle = serveStdio(() => createMcpServer(), {
    onerror: (error) => {
      // Logging sink: stderr ONLY (SPEC-006 §5.1.2.2). Never stdout.
      process.stderr.write(
        `ega-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  });

  // Clean disconnect (SPEC-006 §5.1.2.3): stdin EOF ends the connection and
  // terminates the process with exit code 0.
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    void handle
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  return handle;
}