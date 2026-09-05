#!/usr/bin/env node
// EGA MCP stdio server entry (SPEC-006 §5.1.1). stdout carries MCP protocol
// ONLY — the server writes all diagnostics to stderr and exits cleanly when
// the client disconnects (stdin EOF).
import { startStdioServer } from "../dist/index.js";

startStdioServer();