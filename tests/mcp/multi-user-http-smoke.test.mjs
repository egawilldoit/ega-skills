import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHubRelease } from "../../packages/project/dist/index.js";
import { createHostedMcpHandler, loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";
import { InMemoryControlPlane } from "../../packages/control-plane/dist/index.js";

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-multi-user-http-"));
  const skillDir = join(hubDir, "owned", "ega", "alpha");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha private skill.\n---\n\nUse alpha.\n");
  writeFileSync(join(skillDir, "ega.yaml"), "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - alpha\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: private-a\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

async function rpc(url, token, name, args) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: response.status, body: await response.text() };
}

test("real HTTP hosted runtime isolates private Hub access by principal and deny state", async (t) => {
  const build = await buildHubRelease(makeHub());
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);
  const controlPlane = new InMemoryControlPlane();
  controlPlane.setResource("hub-a", { workspaceId: "workspace-a", visibility: "private", ownerSubject: "user-a" });
  controlPlane.addMembership("workspace-a", { subject: "user-a", role: "owner", active: true });
  const principals = new Map([["token-a", { subject: "user-a", scopes: ["mcp:read"] }], ["token-b", { subject: "user-b", scopes: ["mcp:read"] }]]);
  const handler = createHostedMcpHandler(snapshot, {
    verifyBearer: async (token) => principals.get(token) ?? (() => { throw new Error("invalid token"); })(),
    authorize: async (principal) => controlPlane.authorize("hub-a", principal.subject, "read_hub"),
  });
  const server = createServer(async (request, response) => {
    const body = request.method === "POST" ? await new Promise((resolve, reject) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    }) : undefined;
    const webResponse = await handler.fetch(new Request(`http://127.0.0.1${request.url}`, {
      method: request.method,
      headers: request.headers,
      body,
    }));
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/mcp`;

  const allowed = await rpc(url, "token-a", "search", { query: "alpha" });
  assert.equal(allowed.status, 200);
  assert.match(allowed.body, /ega\/alpha/);

  const denied = await rpc(url, "token-b", "search", { query: "alpha" });
  assert.equal(denied.status, 200);
  assert.match(denied.body, /not authorized/i);
  assert.doesNotMatch(denied.body, /ega\/alpha/);

  controlPlane.deny("hub-a");
  const revoked = await rpc(url, "token-a", "search", { query: "alpha", release_digest: snapshot.releaseDigest });
  assert.equal(revoked.status, 200);
  assert.match(revoked.body, /not authorized|unavailable/i);
});
