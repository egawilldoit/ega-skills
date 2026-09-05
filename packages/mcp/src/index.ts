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
