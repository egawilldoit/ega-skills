/**
 * EGA MCP runtime package entry — re-exports the stdio server skeleton
 * (SPEC-006 §5.1.1) and its frozen structured error contract.
 */

export {
  createMcpServer,
  startStdioServer,
  TOOL_NAMES,
  TOOL_NOT_IMPLEMENTED_ERROR,
} from "./server.js";
export type { McpToolError, McpToolErrorEnvelope } from "./server.js";
export {
  RESOLVE_MAX_SKILLS_MAX,
  RESOLVE_MAX_SKILLS_MIN,
  RESOLVE_MAX_TOKENS_MAX,
  RESOLVE_MAX_TOKENS_MIN,
  RESOLVE_OUTPUT_SCHEMA,
  RESOLVE_TASK_MAX_CODE_POINTS,
  runResolveTool,
  toSnakeResolution,
} from "./resolve.js";
export type { ResolveToolArgs, ResolveToolOptions } from "./resolve.js";
export {
  McpContextError,
  MCP_BOUNDARY_ERROR_CODES,
  openReadOnlyRegistry,
  resolveMcpProjectContext,
  toMcpErrorResult,
} from "./project-context.js";
export type {
  McpBoundaryErrorCode,
  McpProjectContext,
  McpProjectContextOptions,
  ReadOnlyRegistryHandle,
} from "./project-context.js";
