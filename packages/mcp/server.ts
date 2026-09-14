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
import { createHostedRuntimeFromEnv } from "./dist/hosted-runtime.js";
import { createVercelRequestListener } from "./dist/vercel-adapter.js";

// Atomic startup: a failure leaves the serving state unavailable and logs
// one generic sanitized error (never policy contents, never secrets).
let handler;
let maxBodyBytes = 1_048_576;
let maxResponseBytes = 4 * 1_048_576;

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

server.maxConnections = Number(process.env.EGA_HOSTED_MAX_CONNECTIONS ?? 128);

const port = Number(process.env.PORT ?? 3000);
server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`ega-mcp-vercel listening on ${port}\n`);
});
