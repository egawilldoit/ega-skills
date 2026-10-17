// Hosted-runtime HTTP harness shared by the protocol-era suites (Agent B).
//
// Starts the EXISTING hosted handler (createHostedMcpHandler) over a real
// loopback HTTP server and connects SDK Protocol clients to it.

import { createServer } from "node:http";
import { rmSync } from "node:fs";

import {
  createHostedMcpHandler,
  loadHostedReleaseSnapshot,
} from "../../../packages/mcp/dist/index.js";
import { buildEraArtifact } from "./era-fixture.mjs";
import { createHttpTransport, EraClient } from "./sdk-era-client.mjs";

export const AUTH_TOKEN = "era-http-token";
export const EXPECTED_TOOLS = ["get_content", "inspect", "resolve", "search"];

/** Starts the hosted runtime for the deterministic fixture. */
export async function startHosted(t) {
  const fixture = await buildEraArtifact();
  const snapshot = loadHostedReleaseSnapshot(fixture.artifactDir);
  const handler = createHostedMcpHandler(snapshot, {
    verifyBearer: async (token) => {
      if (token !== AUTH_TOKEN) throw new Error("invalid token");
      return { subject: "era-http-principal", scopes: ["mcp:read"] };
    },
    authorize: async () => true,
  });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const webResponse = await handler.fetch(
      new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      }),
    );
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    rmSync(fixture.hubDir, { recursive: true, force: true });
    rmSync(fixture.artifactDir, { recursive: true, force: true });
  });
  return {
    fixture,
    snapshot,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  };
}

/** Connects a real SDK client over the hosted handler's HTTP endpoint. */
export function connectHttp(t, url, { supportedProtocolVersions }) {
  const client = new EraClient({ supportedProtocolVersions });
  const transport = createHttpTransport({
    url,
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    getProtocolVersion: () => client.protocolVersion,
  });
  t.after(() => client.close().catch(() => {}));
  return { client, transport };
}
