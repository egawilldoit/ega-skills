import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHubRelease } from "../../packages/project/dist/index.js";

function makeHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-vercel-server-"));
  const skillDir = join(hubDir, "owned", "ega", "alpha");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha server skill.\n---\n\nUse alpha over the server.\n");
  writeFileSync(join(skillDir, "ega.yaml"), "schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - alpha\n");
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: vercel-server\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

async function waitForReady(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("vercel server did not become ready");
}

test("vercel server.mts serves the verified release over real HTTP", async (t) => {
  const build = await buildHubRelease(makeHub());
  const policy = {
    workspace_id: "vercel-server-workspace",
    visibility: "private",
    owner_subject: "local-smoke",
    memberships: [{ subject: "local-smoke", role: "owner", active: true }],
    denies: [],
  };
  const port = 18900 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ["packages/mcp/server.mts"], {
    cwd: join(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      PORT: String(port),
      EGA_HOSTED_ARTIFACT_DIR: build.registryHome,
      EGA_HOSTED_BEARER_TOKEN: "server-smoke-token",
      EGA_HOSTED_AUTHZ_JSON: JSON.stringify(policy),
      EGA_HOSTED_ALLOWED_ORIGINS: "http://localhost",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => child.kill());

  await waitForReady(port);

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const unknown = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(unknown.status, 404);

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer server-smoke-token", "content-type": "application/json", accept: "application/json, text/event-stream", origin: "http://localhost" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "alpha" } } }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ega\/alpha/);
  assert.doesNotMatch(stderr, /server-smoke-token/);
});

test("vercel server.mts warns and falls back on invalid socket configuration", async (t) => {
  const build = await buildHubRelease(makeHub());
  const policy = {
    workspace_id: "vercel-server-workspace",
    visibility: "private",
    owner_subject: "local-smoke",
    memberships: [{ subject: "local-smoke", role: "owner", active: true }],
    denies: [],
  };
  const baseEnv = {
    ...process.env,
    EGA_HOSTED_ARTIFACT_DIR: build.registryHome,
    EGA_HOSTED_BEARER_TOKEN: "server-smoke-token",
    EGA_HOSTED_AUTHZ_JSON: JSON.stringify(policy),
    EGA_HOSTED_ALLOWED_ORIGINS: "http://localhost",
  };
  // Platforms own the socket surface: an invalid PORT/MAX_CONNECTIONS warns
  // loudly and falls back instead of exiting and failing every route.
  const child = spawn(process.execPath, ["packages/mcp/server.mts"], {
    cwd: join(import.meta.dirname, "../.."),
    env: { ...baseEnv, PORT: "abc", EGA_HOSTED_MAX_CONNECTIONS: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (stderr.includes("listening on 3000")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(stderr, /PORT is not a positive safe integer; using 3000/);
  assert.match(stderr, /EGA_HOSTED_MAX_CONNECTIONS is not a positive safe integer; using 128/);
  assert.match(stderr, /listening on 3000/);
  assert.doesNotMatch(stderr, /server-smoke-token/);
  const health = await fetch("http://127.0.0.1:3000/healthz").catch(() => null);
  if (health) {
    assert.equal(health.status, 200);
  }
});
