#!/usr/bin/env node
// Minimal Node adapter for the read-only hosted MCP handler. Authentication is
// intentionally supplied by an external verifier in production; this entry
// point only provides a disposable local smoke adapter.
//
// Runtime construction (env validation, immutable release verification,
// authorization policy, control plane) is shared with the Vercel server
// entrypoint via `../dist/hosted-runtime.js`; only the HTTP plumbing below
// is local to this adapter.
import { createServer } from "node:http";
import { createHostedRuntimeFromEnv } from "../dist/hosted-runtime.js";

// Startup is atomic: env validation, artifact verification, policy validation,
// and control-plane construction all complete before `handler` is published.
// A failure leaves the serving state unavailable and logs one generic error.
let maxBodyBytes = 0;
let handler;
let protectedResourceMetadata;
try {
  const runtime = createHostedRuntimeFromEnv(process.env);
  handler = runtime.handler;
  maxBodyBytes = runtime.maxBodyBytes;
  protectedResourceMetadata = runtime.protectedResourceMetadata;
} catch (error) {
  handler = undefined;
  process.stderr.write(`ega-mcp-hosted startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
}

const server = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/healthz" || incoming.url === "/readyz") {
    const ready = handler !== undefined;
    const status = ready ? 200 : 503;
    outgoing.writeHead(status, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ status: ready ? "ready" : "unavailable" }));
    return;
  }
  if (
    (incoming.url === "/.well-known/oauth-protected-resource" ||
      incoming.url === "/.well-known/oauth-protected-resource/mcp") &&
    protectedResourceMetadata !== undefined
  ) {
    if (incoming.method !== "GET") {
      outgoing.writeHead(405, { "content-type": "application/json", allow: "GET" });
      outgoing.end(JSON.stringify({ error: { code: "E_METHOD_NOT_ALLOWED" } }));
      return;
    }
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(protectedResourceMetadata));
    return;
  }
  if (!handler) {
    outgoing.writeHead(503, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: { code: "E_RUNTIME_UNAVAILABLE" } }));
    return;
  }
  const declaredLength = Number(incoming.headers["content-length"] ?? 0);
  if (declaredLength > maxBodyBytes) {
    incoming.resume();
    outgoing.writeHead(413);
    outgoing.end("Request too large");
    return;
  }
  const chunks = [];
  let bodyLength = 0;
  for await (const chunk of incoming) {
    bodyLength += chunk.byteLength;
    if (bodyLength > maxBodyBytes) {
      incoming.destroy();
      outgoing.writeHead(413);
      outgoing.end("Request too large");
      return;
    }
    chunks.push(chunk);
  }
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

const port = positiveSocketEnv(process.env.PORT, 8787, "PORT");
server.maxConnections = positiveSocketEnv(process.env.EGA_HOSTED_MAX_CONNECTIONS, 128, "EGA_HOSTED_MAX_CONNECTIONS");
server.listen(port, "127.0.0.1", () => process.stderr.write(`ega-mcp-hosted listening on ${server.address().port}\n`));

function positiveSocketEnv(raw, fallback, name) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    process.stderr.write(`ega-mcp-hosted startup failed: ${name} must be a positive safe integer\n`);
    process.exit(1);
  }
  return value;
}
