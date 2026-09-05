/**
 * EGA MCP runtime package entry — re-exports the stdio server skeleton
 * (SPEC-006 §5.1.1), its frozen structured error contract, and the
 * implemented `search` tool body (SPEC-006 §5.1.6, EGA-591).
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
export {
  inspectOutputSchema,
  runInspectTool,
  toInspectErrorResult,
  toInspectSuccessResult,
} from "./inspect.js";
export type {
  CanonicalVersionManifestSnakeCase,
  McpInspectArgs,
  McpInspectL0,
  McpInspectOptions,
  McpInspectOutput,
  McpInspectSource,
  McpInspectTokenMetadata,
  McpInspectTrustLevel,
} from "./inspect.js";
export {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_OUTPUT_SCHEMA,
  SEARCH_QUERY_MAX_CODE_POINTS,
  runSearchTool,
} from "./search.js";
export type {
  McpSearchOutput,
  McpSearchResultRow,
  SearchToolArgs,
  SearchToolOptions,
} from "./search.js";
