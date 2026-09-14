import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHubRelease } from "../../packages/project/dist/index.js";
import {
  createHostedRuntimeFromEnv,
  createVercelRequestListener,
  parseHostedAuthzPolicy,
} from "../../packages/mcp/dist/index.js";

const SECRET_TOKEN = "vercel-test-token-should-never-leak-9f8e";
const SECRET_SUPABASE = "vercel-supabase-secret-should-never-leak-1a2b";

function makeHub(suffix, { alias = false } = {}) {
  const hubDir = mkdtempSync(join(tmpdir(), `ega-vercel-${suffix}-`));
  for (const name of ["alpha", "beta"]) {
    const skillDir = join(hubDir, "owned", "ega", name);
    mkdirSync(skillDir, { recursive: true });
    const withAlias = alias && name === "alpha" ? "\naliases:\n  - alpha-alias\n" : "";
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} vercel skill.\n---\n\nUse ${name} vercel body.\n`);
    writeFileSync(join(skillDir, "ega.yaml"), `schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - ${name}\n${withAlias}`);
  }
  writeFileSync(join(hubDir, "hub.yaml"), `schema_version: 1\nhub:\n  id: vercel-${suffix}\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n`);
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

const BUILD = await buildHubRelease(makeHub("main"));
const ALIAS_BUILD = await buildHubRelease(makeHub("alias", { alias: true }));
const ALPHA_HASH = BUILD.skills.find((skill) => skill.skillId === "ega/alpha").versionHash;

function policyJSON(overrides = {}) {
  return JSON.stringify({
    workspace_id: "vercel-workspace",
    visibility: "private",
    owner_subject: "local-smoke",
    memberships: [{ subject: "local-smoke", role: "owner", active: true }],
    denies: [],
    ...overrides,
  });
}

function validEnv(artifactDir, overrides = {}) {
  return {
    EGA_HOSTED_ARTIFACT_DIR: artifactDir,
    EGA_HOSTED_BEARER_TOKEN: SECRET_TOKEN,
    EGA_HOSTED_AUTHZ_JSON: policyJSON(),
    EGA_HOSTED_ALLOWED_ORIGINS: "http://localhost",
    ...overrides,
  };
}

async function startServer(t, env) {
  let handler;
  let maxBodyBytes = 1_048_576;
  let maxResponseBytes = 4 * 1_048_576;
  let startupError = null;
  try {
    const runtime = createHostedRuntimeFromEnv(env);
    handler = runtime.handler;
    maxBodyBytes = runtime.maxBodyBytes;
    maxResponseBytes = runtime.maxResponseBytes;
  } catch (error) {
    startupError = error;
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
      } catch {}
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  return { base: `http://127.0.0.1:${port}`, handler, startupError };
}

function mcpHeaders(token = SECRET_TOKEN, origin = "http://localhost") {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (origin !== null) headers.origin = origin;
  return headers;
}

async function mcpCall(base, id, method, params = {}, { token = SECRET_TOKEN, origin = "http://localhost" } = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(token, origin),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return response;
}

function parseRpc(text) {
  const data = text.match(/data: (.+)/)?.[1];
  return JSON.parse(data ?? text);
}

// 1. startup with valid env
test("vercel startup with valid env publishes the hardened runtime", async () => {
  const runtime = createHostedRuntimeFromEnv(validEnv(BUILD.registryHome));
  assert.match(runtime.snapshot.releaseDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof runtime.handler.fetch, "function");
  assert.equal(runtime.maxBodyBytes, 1_048_576);
});

// 2. malformed auth JSON => unavailable
test("vercel startup with malformed auth JSON is unavailable without leaking contents", async (t) => {
  const raw = `{"workspace_id": "oops-${SECRET_TOKEN}",`;
  let message = "";
  try {
    createHostedRuntimeFromEnv(validEnv(BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: raw }));
    assert.fail("must throw");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /invalid JSON|invalid shape/i);
  assert.doesNotMatch(message, new RegExp(SECRET_TOKEN));
  const { base, startupError } = await startServer(t, validEnv(BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: raw }));
  assert.ok(startupError);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
});

// 3. invalid authorization policy => unavailable
test("vercel startup with an invalid authorization policy is unavailable", async (t) => {
  const bad = policyJSON({ visibility: "visible-to-nobody" });
  assert.throws(() => createHostedRuntimeFromEnv(validEnv(BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: bad })), /invalid shape/);
  assert.throws(() => parseHostedAuthzPolicy(bad), /invalid shape/);
  const { base } = await startServer(t, validEnv(BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: bad }));
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  const mcp = await mcpCall(base, 1, "tools/list");
  assert.equal(mcp.status, 503);
});

// 4. missing artifact => unavailable
test("vercel startup with a missing artifact is unavailable", async (t) => {
  const emptyDir = mkdtempSync(join(tmpdir(), "ega-vercel-empty-"));
  assert.throws(() => createHostedRuntimeFromEnv(validEnv(emptyDir)), /./);
  const { base } = await startServer(t, validEnv(emptyDir));
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
});

// 5. corrupt artifact => unavailable
test("vercel startup with a corrupt artifact is unavailable", async (t) => {
  const corruptDir = mkdtempSync(join(tmpdir(), "ega-vercel-corrupt-"));
  cpSync(BUILD.registryHome, corruptDir, { recursive: true });
  writeFileSync(join(corruptDir, "registry.sqlite"), "corrupt-bytes");
  assert.throws(() => createHostedRuntimeFromEnv(validEnv(corruptDir)), /./);
  const { base } = await startServer(t, validEnv(corruptDir));
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  assert.ok(readFileSync(join(corruptDir, "hub-release.json"), "utf8").length > 0);
});

// 6. valid artifact => ready
test("vercel startup with a valid artifact is ready", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { status: "ready" });
});

// 7. /healthz (ready AND failed startup)
test("vercel /healthz is 200 minimal JSON whenever the process is alive", async (t) => {
  const ready = await startServer(t, validEnv(BUILD.registryHome));
  assert.equal((await fetch(`${ready.base}/healthz`)).status, 200);
  assert.deepEqual(await (await fetch(`${ready.base}/healthz`)).json(), { status: "ok" });
  const failed = await startServer(t, validEnv(mkdtempSync(join(tmpdir(), "ega-vercel-dead-"))));
  const health = await fetch(`${failed.base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
});

// 8. /readyz (covered in 6 + failed case here)
test("vercel /readyz is 503 after failed startup", async (t) => {
  const { base } = await startServer(t, validEnv(mkdtempSync(join(tmpdir(), "ega-vercel-dead2-"))));
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 503);
  const body = await ready.text();
  assert.doesNotMatch(body, new RegExp(SECRET_TOKEN));
});

// 9. unknown path => 404
test("vercel unknown paths return a controlled 404", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  for (const path of ["/nope", "/debug", "/config", "/mcp-extra"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.match(await response.text(), /E_NOT_FOUND/);
  }
  const wrongMethod = await fetch(`${base}/healthz`, { method: "POST" });
  assert.equal(wrongMethod.status, 404);
});

// 10. MCP request without bearer => rejected
test("vercel MCP without a bearer token is rejected", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  const response = await mcpCall(base, 1, "tools/list", {}, { token: null });
  assert.equal(response.status, 401);
  assert.match(await response.text(), /E_AUTH_REQUIRED/);
});

// 11. invalid bearer => rejected
test("vercel MCP with an invalid bearer token is rejected", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  const response = await mcpCall(base, 1, "tools/list", {}, { token: "wrong-token" });
  assert.equal(response.status, 401);
  assert.match(await response.text(), /E_TOKEN_INVALID/);
});

// 12. valid bearer => MCP initialization works
test("vercel MCP initialization works with a valid bearer", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  const response = await mcpCall(base, 1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vercel-test", version: "0.0.0" },
  });
  assert.equal(response.status, 200);
  const body = parseRpc(await response.text());
  assert.ok(body.result?.serverInfo ?? body.result?.protocolVersion, JSON.stringify(body));
});

// 13. tools/list exposes exactly four tools
test("vercel tools/list exposes exactly four tools", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  const response = await mcpCall(base, 1, "tools/list");
  assert.equal(response.status, 200);
  const body = parseRpc(await response.text());
  assert.deepEqual(body.result.tools.map((tool) => tool.name), ["search", "resolve", "inspect", "get_content"]);
});

// 14. real search call works
test("vercel real search call works over the HTTP boundary", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  const response = await mcpCall(base, 2, "tools/call", { name: "search", arguments: { query: "alpha", limit: 5 } });
  assert.equal(response.status, 200);
  const body = parseRpc(await response.text());
  assert.notEqual(body.result.isError, true, JSON.stringify(body));
  assert.match(JSON.stringify(body.result), /ega\/alpha/);
});

// 15. real resolve call works
test("vercel real resolve call works over the HTTP boundary", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  const response = await mcpCall(base, 2, "tools/call", { name: "resolve", arguments: { task: "alpha" } });
  assert.equal(response.status, 200);
  const body = parseRpc(await response.text());
  assert.notEqual(body.result.isError, true, JSON.stringify(body));
  assert.match(JSON.stringify(body.result), /ega\/alpha/);
});

// 16. inspect
test("vercel inspect works over the HTTP boundary", async (t) => {
  const { base, handler } = await startServer(t, validEnv(BUILD.registryHome));
  assert.ok(handler);
  const digest = createHostedRuntimeFromEnv(validEnv(BUILD.registryHome)).snapshot.releaseDigest;
  const response = await mcpCall(base, 3, "tools/call", {
    name: "inspect",
    arguments: { skill_id: "ega/alpha", release_digest: digest },
  });
  assert.equal(response.status, 200);
  const body = parseRpc(await response.text());
  assert.notEqual(body.result.isError, true, JSON.stringify(body));
  assert.match(JSON.stringify(body.result), /ega\/alpha/);
});

// 17. get_content
test("vercel get_content works over the HTTP boundary", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  const digest = createHostedRuntimeFromEnv(validEnv(BUILD.registryHome)).snapshot.releaseDigest;
  const response = await mcpCall(base, 4, "tools/call", {
    name: "get_content",
    arguments: { skill_id: "ega/alpha", version_hash: ALPHA_HASH, level: "L2", max_tokens: 1000, release_digest: digest },
  });
  assert.equal(response.status, 200);
  const body = parseRpc(await response.text());
  assert.notEqual(body.result.isError, true, JSON.stringify(body));
  assert.match(JSON.stringify(body.result), /Use alpha vercel body/);
});

// 18. denied skill cannot leak
test("vercel denied skills cannot leak through any tool", async (t) => {
  const env = validEnv(BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: policyJSON({ denied_skills: ["ega/alpha"] }) });
  const { base } = await startServer(t, env);
  const digest = createHostedRuntimeFromEnv(env).snapshot.releaseDigest;
  const searched = parseRpc(await (await mcpCall(base, 1, "tools/call", { name: "search", arguments: { query: "alpha", limit: 20 } })).text());
  assert.notEqual(searched.result.isError, true, JSON.stringify(searched));
  assert.doesNotMatch(JSON.stringify(searched.result), /ega\/alpha/);
  const content = parseRpc(
    await (
      await mcpCall(base, 2, "tools/call", {
        name: "get_content",
        arguments: { skill_id: "ega/alpha", version_hash: ALPHA_HASH, level: "L2", max_tokens: 1000, release_digest: digest },
      })
    ).text(),
  );
  assert.equal(content.result.isError, true);
  assert.doesNotMatch(JSON.stringify(content.result), /Use alpha vercel body/);
});

// 19. denied alias cannot bypass policy
test("vercel denied aliases cannot bypass policy", async (t) => {
  const env = validEnv(ALIAS_BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: policyJSON({ denied_skills: ["ega/alpha"] }) });
  const { base } = await startServer(t, env);
  const digest = createHostedRuntimeFromEnv(env).snapshot.releaseDigest;
  const searched = parseRpc(await (await mcpCall(base, 1, "tools/call", { name: "search", arguments: { query: "alpha-alias", limit: 20 } })).text());
  assert.doesNotMatch(JSON.stringify(searched.result), /ega\/alpha/);
  const inspected = parseRpc(
    await (await mcpCall(base, 2, "tools/call", { name: "inspect", arguments: { skill_id: "alpha-alias", release_digest: digest } })).text(),
  );
  assert.equal(inspected.result.isError, true, JSON.stringify(inspected));
  const resolved = parseRpc(
    await (await mcpCall(base, 3, "tools/call", { name: "resolve", arguments: { task: "alpha", explicit_skills: ["alpha-alias"] } })).text(),
  );
  assert.doesNotMatch(JSON.stringify(resolved.result?.structuredContent ?? resolved), /Use alpha vercel body/);
  void digest;
});

// 20. Origin policy remains fail-closed
test("vercel Origin policy remains fail-closed", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  for (const origin of [null, "https://evil.example"]) {
    const response = await mcpCall(base, 1, "tools/list", {}, { origin });
    assert.equal(response.status, 403, `origin ${origin} must be rejected`);
  }
  const allowed = await mcpCall(base, 1, "tools/list");
  assert.equal(allowed.status, 200);
});

// 21. context/release mismatch rejected
test("vercel context/release mismatches are rejected", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome));
  const badDigest = `sha256:${"0".repeat(64)}`;
  const inspected = parseRpc(
    await (await mcpCall(base, 1, "tools/call", { name: "inspect", arguments: { skill_id: "ega/alpha", release_digest: badDigest } })).text(),
  );
  assert.equal(inspected.result.isError, true, JSON.stringify(inspected));
  assert.match(JSON.stringify(inspected.result), /E_RELEASE_MISMATCH/);
  const contextual = parseRpc(
    await (await mcpCall(base, 2, "tools/call", { name: "search", arguments: { query: "alpha", context_id: "ctx-unknown" } })).text(),
  );
  assert.equal(contextual.result.isError, true, JSON.stringify(contextual));
  assert.match(JSON.stringify(contextual.result), /E_CONTEXT_UNAVAILABLE/);
});

// 22. oversized body rejected
test("vercel oversized bodies are rejected", async (t) => {
  const { base } = await startServer(t, validEnv(BUILD.registryHome, { EGA_HOSTED_MAX_BODY_BYTES: "64" }));
  const big = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {}, pad: "x".repeat(1024) }),
  });
  assert.equal(big.status, 413);
});

// 23. no secrets appear in error responses
test("vercel error responses never contain secrets", async (t) => {
  const env = validEnv(BUILD.registryHome, {
    EGA_HOSTED_SUPABASE_URL: "https://project.supabase.co",
    EGA_HOSTED_SUPABASE_SECRET_KEY: SECRET_SUPABASE,
  });
  const { base } = await startServer(t, env);
  const probes = [
    await (await mcpCall(base, 1, "tools/list", {}, { token: null })).text(),
    await (await mcpCall(base, 1, "tools/list", {}, { token: "wrong" })).text(),
    await (await mcpCall(base, 1, "tools/list", {}, { origin: "https://evil.example" })).text(),
    await (await fetch(`${base}/nope`)).text(),
    await (await fetch(`${base}/readyz`)).text(),
  ];
  for (const body of probes) {
    assert.doesNotMatch(body, new RegExp(SECRET_TOKEN), body.slice(0, 200));
    assert.doesNotMatch(body, new RegExp(SECRET_SUPABASE), body.slice(0, 200));
  }
});

// 24. no secrets appear in startup logs
test("vercel startup failures never log secrets or policy contents", async () => {
  const leakyPolicy = policyJSON({ denied_skills: [`leak-marker-${SECRET_TOKEN}`] });
  const cases = [
    validEnv(BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: `not-json ${SECRET_SUPABASE} {` }),
    validEnv(BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: leakyPolicy.slice(0, 20) }),
    validEnv(BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: policyJSON({ visibility: "everyone" }) }),
    validEnv(mkdtempSync(join(tmpdir(), "ega-vercel-dead3-"))),
  ];
  for (const env of cases) {
    let logged = "";
    try {
      createHostedRuntimeFromEnv(env);
      assert.fail("must throw");
    } catch (error) {
      logged = `ega-mcp-vercel startup failed: ${error instanceof Error ? error.message : String(error)}\n`;
    }
    assert.doesNotMatch(logged, new RegExp(SECRET_TOKEN));
    assert.doesNotMatch(logged, new RegExp(SECRET_SUPABASE));
    assert.doesNotMatch(logged, /leak-marker/);
  }
});

test("vercel file authorization still works for local usage", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "ega-vercel-fileauth-"));
  const authzPath = join(workDir, "authz.json");
  writeFileSync(authzPath, policyJSON());
  const { EGA_HOSTED_AUTHZ_JSON: _dropped, ...fileEnv } = validEnv(BUILD.registryHome);
  void _dropped;
  const { base } = await startServer(t, { ...fileEnv, EGA_HOSTED_AUTHZ_FILE: authzPath });
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const listed = await mcpCall(base, 1, "tools/list");
  assert.equal(listed.status, 200);
});

test("vercel JSON authorization wins deterministically when both sources are set", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "ega-vercel-bothauth-"));
  const authzPath = join(workDir, "authz.json");
  writeFileSync(authzPath, policyJSON({ visibility: "visible-to-nobody" }));
  const env = { ...validEnv(BUILD.registryHome), EGA_HOSTED_AUTHZ_FILE: authzPath };
  const { base } = await startServer(t, env);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const listed = await mcpCall(base, 1, "tools/list");
  assert.equal(listed.status, 200);
});
