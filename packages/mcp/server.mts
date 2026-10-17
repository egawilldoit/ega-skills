// Vercel Node server entrypoint for the private hosted MCP runtime.
//
// Vercel detects this `server.mts` at the Project Root Directory
// (`packages/mcp`) and routes HTTPS requests to it through an internal port.
// The `.mts` extension forces ES-module semantics no matter which module
// system the platform infers from the surrounding package.json files, so the
// `import` statements below cannot be miscompiled to `require`.
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
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { createHostedRuntimeFromEnv } from "./dist/hosted-runtime.js";
import { createVercelRequestListener } from "./dist/vercel-adapter.js";

// NOTE: do NOT statically require the better-sqlite3 prebuilt binary here.
// The binding resolves at runtime through the package's own relative path:
// when file tracers ship it, it loads; when they do not, the first Database
// construction fails inside the runtime's try/catch and the server keeps
// serving fail-closed JSON (503s) instead of crashing. A static require of a
// bundle-relative path cannot resolve reliably and would itself throw at
// boot, failing every route.

// Atomic startup: a failure leaves the serving state unavailable and logs
// one generic sanitized error (never policy contents, never secrets).
let handler: McpHttpHandler | undefined;
let maxBodyBytes = 1_048_576;
let maxResponseBytes = 4 * 1_048_576;
let protectedResourceMetadata: unknown;

function socketEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    // Platforms own the socket surface: warn loudly but stay alive serving
    // fail-closed JSON instead of exiting and failing every route.
    process.stderr.write(
      `ega-mcp-vercel startup warning: ${name} is not a positive safe integer; using ${fallback}\n`,
    );
    return fallback;
  }
  return value;
}

try {
  const runtime = createHostedRuntimeFromEnv(process.env);
  handler = runtime.handler;
  maxBodyBytes = runtime.maxBodyBytes;
  maxResponseBytes = runtime.maxResponseBytes;
  protectedResourceMetadata = runtime.protectedResourceMetadata;
} catch (error) {
  handler = undefined;
  process.stderr.write(`ega-mcp-vercel startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
}

const listener = createVercelRequestListener({
  getHandler: () => handler,
  maxBodyBytes,
  maxResponseBytes,
  getProtectedResourceMetadata: () => protectedResourceMetadata,
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

server.maxConnections = socketEnv(process.env.EGA_HOSTED_MAX_CONNECTIONS, 128, "EGA_HOSTED_MAX_CONNECTIONS");

const port = socketEnv(process.env.PORT, 3000, "PORT");
// No host pin: Vercel routes to the server through an internal port and the
// documented Node-server form is listen(port). (The local smoke adapter in
// bin/ keeps 127.0.0.1 deliberately.)
server.listen(port, () => {
  process.stderr.write(`ega-mcp-vercel listening on ${port}\n`);
});
