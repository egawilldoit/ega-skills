#!/usr/bin/env node
// Minimal Node adapter for the read-only hosted MCP handler. Authentication is
// intentionally supplied by an external verifier in production; this entry
// point only provides a disposable local smoke adapter.
import { createServer } from "node:http";
import { loadHostedReleaseSnapshot, createHostedMcpHandler } from "../dist/index.js";

const artifactDir = process.env.EGA_HOSTED_ARTIFACT_DIR;
const expectedToken = process.env.EGA_HOSTED_BEARER_TOKEN;
if (!artifactDir || !expectedToken) throw new Error("EGA_HOSTED_ARTIFACT_DIR and EGA_HOSTED_BEARER_TOKEN are required");

let snapshot;
let startupError;
try {
  snapshot = loadHostedReleaseSnapshot(artifactDir);
} catch (error) {
  startupError = error;
}
const handler = snapshot && createHostedMcpHandler(snapshot, {
  verifyBearer: async (token) => {
    if (token !== expectedToken) throw new Error("invalid token");
    return { subject: "local-smoke", scopes: ["ega:read"] };
  },
  authorize: async () => true,
});

const server = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/healthz" || incoming.url === "/readyz") {
    const ready = !startupError && handler;
    const status = ready ? 200 : 503;
    outgoing.writeHead(status, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ status: ready ? "ready" : "unavailable" }));
    return;
  }
  if (!handler) {
    outgoing.writeHead(503, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: { code: "E_RUNTIME_UNAVAILABLE" } }));
    return;
  }
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }
  const request = new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
    method: incoming.method,
    headers,
    body: body.byteLength ? body : undefined,
    duplex: "half",
  });
  const response = await handler.fetch(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});

const port = Number(process.env.PORT ?? 8787);
server.maxConnections = Number(process.env.EGA_HOSTED_MAX_CONNECTIONS ?? 128);
server.listen(port, "127.0.0.1", () => process.stderr.write(`ega-mcp-hosted listening on ${port}\n`));
