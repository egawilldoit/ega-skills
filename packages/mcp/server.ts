// Vercel Node server entrypoint for the private hosted MCP runtime.
//
// Vercel detects this `server.ts` at the Project Root Directory
// (`packages/mcp`) and routes HTTPS requests to it through an internal port.
// The `server.listen()` call below is required for detection; the PORT value
// is only used for local runs.
//
// The hardened runtime (env validation, immutable HubRelease verification,
// authorization policy, Supabase context) is shared with the local smoke
// adapter via `./dist/hosted-runtime.js`. This file only wires HTTP routing
// (`./dist/vercel-adapter.js`) and startup. It performs no local mutation,
// no git, no package installation, and no release generation.
//
// Routes:
// - GET /healthz → 200 minimal JSON whenever the process is alive
// - GET /readyz → 200 only after verified initialization, else 503
// - /mcp → authenticated Streamable HTTP MCP (exactly four tools)
// - anything else → controlled 404
//
// Build: the Vercel Build Command must compile the workspace first
// (`tsc -b` via the root build) so `./dist/*` exists before this file is
// bundled. See `VERCEL.md`.

import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { createHostedRuntimeFromEnv } from "./dist/hosted-runtime.js";
import { createVercelRequestListener } from "./dist/vercel-adapter.js";

// Pin the native SQLite binding into the function bundle. better-sqlite3
// resolves its prebuilt binary through a runtime-computed path that file
// tracers cannot follow, so reference it statically here. Without this, the
// import inside ./dist/*.js throws at boot and every route fails with
// FUNCTION_INVOCATION_FAILED. The require is Linux/x64-only (the deployment
// target); other platforms skip it because the module is never executed
// there. Version-pinned: tests/mcp/vercel-bundle.test.mjs fails loudly when
// the better-sqlite3 version changes.
const requireFromMcp = createRequire(import.meta.url);
let sqliteNativeBinding: unknown;
if (process.platform === "linux" && process.arch === "x64") {
  sqliteNativeBinding = requireFromMcp(
    "../../node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/prebuilds/linux-x64.node",
  );
}
void sqliteNativeBinding;

// Atomic startup: a failure leaves the serving state unavailable and logs
// one generic sanitized error (never policy contents, never secrets).
let handler: McpHttpHandler | undefined;
let maxBodyBytes = 1_048_576;
let maxResponseBytes = 4 * 1_048_576;

function positiveSocketEnv(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    process.stderr.write(`ega-mcp-vercel startup failed: ${name} must be a positive safe integer\n`);
    process.exit(1);
  }
  return value;
}

try {
  const runtime = createHostedRuntimeFromEnv(process.env);
  handler = runtime.handler;
  maxBodyBytes = runtime.maxBodyBytes;
  maxResponseBytes = runtime.maxResponseBytes;
} catch (error) {
  handler = undefined;
  process.stderr.write(`ega-mcp-vercel startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
}

const listener = createVercelRequestListener({
  getHandler: () => handler,
  maxBodyBytes,
  maxResponseBytes,
});

const server = createServer((incoming, outgoing) => {
  void listener(incoming, outgoing).catch(() => {
    try {
      if (!outgoing.writableEnded) {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { code: "E_RUNTIME_UNAVAILABLE" } }));
      }
    } catch {
      try {
        outgoing.destroy();
      } catch {
        // Never let an error-response failure crash the process.
      }
    }
  });
});

server.maxConnections = positiveSocketEnv(process.env.EGA_HOSTED_MAX_CONNECTIONS, 128, "EGA_HOSTED_MAX_CONNECTIONS");

const port = positiveSocketEnv(process.env.PORT, 3000, "PORT");
// No host pin: Vercel routes to the server through an internal port and the
// documented Node-server form is listen(port). (The local smoke adapter in
// bin/ keeps 127.0.0.1 deliberately.)
server.listen(port, () => {
  process.stderr.write(`ega-mcp-vercel listening on ${port}\n`);
});
