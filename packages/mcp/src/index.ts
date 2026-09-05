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
  GET_CONTENT_LEVELS,
  GET_CONTENT_MAX_TOKENS_MAX,
  GET_CONTENT_MAX_TOKENS_MIN,
  GET_CONTENT_OUTPUT_SCHEMA,
  runGetContentTool,
} from "./get-content.js";
export type {
  GetContentLevel,
  GetContentToolArgs,
  GetContentToolOptions,
  McpGetContentOutput,
} from "./get-content.js";
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
