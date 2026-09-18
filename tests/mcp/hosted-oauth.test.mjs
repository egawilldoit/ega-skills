// OAuth 2.1 resource-server foundation tests (RFC 9728 discovery,
// WWW-Authenticate challenges, Origin policy, and MCP tool regression
// through the real Vercel adapter + hardened hosted runtime).
//
// The canonical resource URL and authorization server are explicit trusted
// configuration; this suite proves request headers can never influence them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHubRelease } from "../../packages/project/dist/index.js";
import {
  buildProtectedResourceMetadata,
  parseAllowedOrigins,
  buildWwwAuthenticate,
  createHostedMcpHandler,
  createHostedRuntimeFromEnv,
  createVercelRequestListener,
  loadHostedReleaseSnapshot,
  parseHostedOAuthConfig,
} from "../../packages/mcp/dist/index.js";

const SECRET_TOKEN = "oauth-test-token-should-never-leak-4c1d";
const RESOURCE = "https://mcp.example.test/mcp";
const AS = "https://project-ref.supabase.co/auth/v1";
const METADATA_URL = "https://mcp.example.test/.well-known/oauth-protected-resource";

function makeHub(suffix, { alias = false } = {}) {
  const hubDir = mkdtempSync(join(tmpdir(), `ega-oauth-${suffix}-`));
  for (const name of ["alpha", "beta"]) {
    const skillDir = join(hubDir, "owned", "ega", name);
    mkdirSync(skillDir, { recursive: true });
    const withAlias = alias && name === "alpha" ? "\naliases:\n  - alpha-alias\n" : "";
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} oauth skill.\n---\n\nUse ${name} oauth body.\n`);
    writeFileSync(join(skillDir, "ega.yaml"), `schema_version: 1\ndomains:\n  - engineering\ntriggers:\n  - ${name}\n${withAlias}`);
  }
  writeFileSync(join(hubDir, "hub.yaml"), `schema_version: 1\nhub:\n  id: oauth-${suffix}\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n`);
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  return hubDir;
}

const BUILD = await buildHubRelease(makeHub("main"));
const ALIAS_BUILD = await buildHubRelease(makeHub("alias", { alias: true }));
const ALPHA_HASH = BUILD.skills.find((skill) => skill.skillId === "ega/alpha").versionHash;

function policyJSON(overrides = {}) {
  return JSON.stringify({
    workspace_id: "oauth-workspace",
    visibility: "private",
    owner_subject: "local-smoke",
    memberships: [{ subject: "local-smoke", role: "owner", active: true }],
    denies: [],
    ...overrides,
  });
}

function staticEnv(artifactDir, overrides = {}) {
  return {
    EGA_HOSTED_ARTIFACT_DIR: artifactDir,
    EGA_HOSTED_BEARER_TOKEN: SECRET_TOKEN,
    EGA_HOSTED_ALLOW_STATIC_TOKEN: "true",
    EGA_HOSTED_AUTHZ_JSON: policyJSON(),
    EGA_HOSTED_ALLOWED_ORIGINS: "http://localhost",
    EGA_HOSTED_RESOURCE_URL: RESOURCE,
    EGA_HOSTED_AUTHORIZATION_SERVERS: AS,
    ...overrides,
  };
}

function jwtEnv(artifactDir, overrides = {}) {
  const { EGA_HOSTED_BEARER_TOKEN: _token, EGA_HOSTED_ALLOW_STATIC_TOKEN: _flag, ...base } = staticEnv(artifactDir);
  return {
    ...base,
    EGA_HOSTED_ISSUER: AS,
    EGA_HOSTED_AUDIENCE: "authenticated",
    EGA_HOSTED_JWKS_URL: `${AS}/.well-known/jwks.json`,
    ...overrides,
  };
}

async function startServer(t, env) {
  let handler;
  let maxBodyBytes = 1_048_576;
  let maxResponseBytes = 4 * 1_048_576;
  let protectedResourceMetadata;
  let startupError = null;
  try {
    const runtime = createHostedRuntimeFromEnv(env);
    handler = runtime.handler;
    maxBodyBytes = runtime.maxBodyBytes;
    maxResponseBytes = runtime.maxResponseBytes;
    protectedResourceMetadata = runtime.protectedResourceMetadata;
  } catch (error) {
    startupError = error;
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
      } catch {}
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  return { base: `http://127.0.0.1:${address.port}`, startupError, get metadata() { return protectedResourceMetadata; } };
}

function mcpHeaders(token = SECRET_TOKEN, origin = "http://localhost") {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (origin !== null) headers.origin = origin;
  return headers;
}

async function mcpCall(base, id, method, params = {}, { token = SECRET_TOKEN, origin = "http://localhost" } = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(token, origin),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

function parseRpc(text) {
  const data = text.match(/data: (.+)/)?.[1];
  return JSON.parse(data ?? text);
}

async function toolCall(base, id, name, args, options) {
  const response = await mcpCall(base, id, "tools/call", { name, arguments: args }, options);
  return parseRpc(await response.text());
}

// ---------------------------------------------------------------------------
// Configuration + metadata unit contract
// ---------------------------------------------------------------------------

test("resource config normalizes and validates explicit trusted configuration", () => {
  const config = parseHostedOAuthConfig({
    resourceUrl: "https://mcp.example.test/mcp",
    authorizationServers: ` ${AS} , ${AS} `,
    scopesSupported: "openid offline_access,openid",
    defaultAuthorizationServer: AS,
  });
  assert.equal(config.resource, RESOURCE);
  assert.equal(config.resourceMetadataUrl, METADATA_URL);
  assert.deepEqual([...config.authorizationServers], [AS]);
  assert.deepEqual([...config.scopesSupported], ["openid", "offline_access"]);
  const metadata = buildProtectedResourceMetadata(config);
  assert.deepEqual(metadata, {
    resource: RESOURCE,
    authorization_servers: [AS],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "offline_access"],
  });
  assert.equal(buildWwwAuthenticate(config), `Bearer resource_metadata="${METADATA_URL}"`);
  assert.equal(
    buildWwwAuthenticate(config, "invalid_token"),
    `Bearer error="invalid_token", resource_metadata="${METADATA_URL}"`,
  );
});

test("resource config defaults authorization servers to the trusted issuer and omits empty scopes", () => {
  const config = parseHostedOAuthConfig({
    resourceUrl: RESOURCE,
    authorizationServers: undefined,
    scopesSupported: undefined,
    defaultAuthorizationServer: AS,
  });
  assert.deepEqual([...config.authorizationServers], [AS]);
  const metadata = buildProtectedResourceMetadata(config);
  assert.equal("scopes_supported" in metadata, false);
});

test("resource config rejects unsafe values", () => {
  const base = { authorizationServers: AS, scopesSupported: undefined, defaultAuthorizationServer: AS };
  assert.throws(() => parseHostedOAuthConfig({ ...base, resourceUrl: undefined }), /EGA_HOSTED_RESOURCE_URL/);
  assert.throws(() => parseHostedOAuthConfig({ ...base, resourceUrl: "http://mcp.example.test/mcp" }), /HTTPS/);
  assert.throws(() => parseHostedOAuthConfig({ ...base, resourceUrl: "not-a-url" }), /absolute URL/);
  assert.throws(() => parseHostedOAuthConfig({ ...base, resourceUrl: "https://user:pass@mcp.example.test/mcp" }), /credentials/);
  assert.throws(() => parseHostedOAuthConfig({ ...base, resourceUrl: "https://mcp.example.test/mcp?x=1" }), /query/);
  assert.throws(() => parseHostedOAuthConfig({ ...base, resourceUrl: "https://mcp.example.test/mcp#f" }), /fragment/);
  assert.throws(() => parseHostedOAuthConfig({ ...base, resourceUrl: "https://mcp.example.test" }), /protected resource path/);
  assert.throws(
    () => parseHostedOAuthConfig({ ...base, resourceUrl: RESOURCE, authorizationServers: "https://user:pass@as.example/auth" }),
    /credentials/,
  );
  assert.throws(
    () => parseHostedOAuthConfig({ ...base, resourceUrl: RESOURCE, authorizationServers: "not-a-url" }),
    /absolute URL/,
  );
  assert.throws(
    () => parseHostedOAuthConfig({ ...base, resourceUrl: RESOURCE, authorizationServers: "http://as.example/auth" }),
    /HTTPS/,
  );
  assert.throws(
    () => parseHostedOAuthConfig({ ...base, resourceUrl: RESOURCE, authorizationServers: "https://as.example/auth?x=1" }),
    /query/,
  );
  const rooted = parseHostedOAuthConfig({
    resourceUrl: RESOURCE,
    authorizationServers: "https://as.example",
    scopesSupported: undefined,
    defaultAuthorizationServer: undefined,
  });
  assert.deepEqual([...rooted.authorizationServers], ["https://as.example/"]);
  assert.throws(
    () => parseHostedOAuthConfig({ ...base, resourceUrl: RESOURCE, scopesSupported: "bad/scope" }),
    /invalid scope/,
  );
  assert.throws(
    () => parseHostedOAuthConfig({ resourceUrl: RESOURCE, authorizationServers: undefined, scopesSupported: undefined, defaultAuthorizationServer: undefined }),
    /EGA_HOSTED_AUTHORIZATION_SERVERS/,
  );
});

// ---------------------------------------------------------------------------
// HTTP discovery
// ---------------------------------------------------------------------------

test("protected resource metadata is served at both discovery paths and cannot be moved by Host headers", async (t) => {
  const { base } = await startServer(t, staticEnv(BUILD.registryHome));
  const expected = {
    resource: RESOURCE,
    authorization_servers: [AS],
    bearer_methods_supported: ["header"],
  };
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await fetch(`${base}${path}`, {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), expected, path);
  }
  const notModified = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.deepEqual(await notModified.json(), expected);
});

test("protected resource metadata fails safely for unsupported methods and absent config", async (t) => {
  const configured = await startServer(t, staticEnv(BUILD.registryHome));
  const post = await fetch(`${configured.base}/.well-known/oauth-protected-resource`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");

  const { EGA_HOSTED_RESOURCE_URL: _r, EGA_HOSTED_AUTHORIZATION_SERVERS: _a, ...noOauth } = staticEnv(BUILD.registryHome);
  const unconfigured = await startServer(t, noOauth);
  const response = await fetch(`${unconfigured.base}/.well-known/oauth-protected-resource`);
  assert.equal(response.status, 404);
});

test("metadata responses never contain secrets or policy contents", async (t) => {
  const { base } = await startServer(t, staticEnv(BUILD.registryHome));
  const text = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).text();
  assert.doesNotMatch(text, new RegExp(SECRET_TOKEN));
  assert.doesNotMatch(text, /oauth-workspace|local-smoke|memberships/);
});

test("Origin allow-list configuration validates at startup", () => {
  assert.deepEqual(parseAllowedOrigins("https://app.example, http://localhost:3000"), [
    "https://app.example",
    "http://localhost:3000",
  ]);
  assert.deepEqual(parseAllowedOrigins(" https://app.example , https://app.example "), ["https://app.example"]);
  for (const raw of [
    undefined,
    "",
    "*",
    "https://*.example",
    "https://app.example/path",
    "https://app.example/?x=1",
    "https://app.example/#f",
    "https://user:pass@app.example",
    "http://app.example",
    "not-a-url",
  ]) {
    assert.throws(() => parseAllowedOrigins(raw), undefined, String(raw));
  }
});

// ---------------------------------------------------------------------------
// WWW-Authenticate challenge
// ---------------------------------------------------------------------------

test("anonymous MCP requests are 401 with a resource_metadata challenge", async (t) => {
  const { base } = await startServer(t, staticEnv(BUILD.registryHome));
  const response = await mcpCall(base, 1, "tools/list", {}, { token: null });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), `Bearer resource_metadata="${METADATA_URL}"`);
  assert.match(await response.text(), /E_AUTH_REQUIRED/);
});

test("invalid bearer tokens are 401 with an invalid_token challenge", async (t) => {
  const { base } = await startServer(t, staticEnv(BUILD.registryHome));
  const response = await mcpCall(base, 1, "tools/list", {}, { token: "not-the-token" });
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    `Bearer error="invalid_token", resource_metadata="${METADATA_URL}"`,
  );
  assert.match(await response.text(), /E_TOKEN_INVALID/);
});

// ---------------------------------------------------------------------------
// Origin policy
// ---------------------------------------------------------------------------

test("native clients without Origin authenticate; hostile browser Origins are rejected", async (t) => {
  const { base } = await startServer(t, staticEnv(BUILD.registryHome));
  const noOrigin = await mcpCall(base, 1, "tools/list", {}, { origin: null });
  assert.equal(noOrigin.status, 200);
  const trusted = await mcpCall(base, 1, "tools/list", {}, { origin: "http://localhost" });
  assert.equal(trusted.status, 200);
  for (const origin of [
    "https://evil.example",
    "null",
    "http://localhost, https://evil.example",
    "http://localhost/",
    "http://localhost/path",
    "https://LOCALHOST",
  ]) {
    const response = await mcpCall(base, 1, "tools/list", {}, { origin });
    assert.equal(response.status, 403, `origin ${origin} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// JWT-authenticated resource server (no Origin required)
// ---------------------------------------------------------------------------

function es256Mint(privateKey, kid, claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", kid, typ: "JWT" });
  const body = encode(claims);
  const signer = createSign("SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

test("JWT mode: missing Origin and delegated client_id work; invalid tokens fail closed", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "oauth-k1", kty: "EC", alg: "ES256", use: "sig", key_ops: ["verify"] };
  const env = jwtEnv(BUILD.registryHome, {
    EGA_HOSTED_AUTHZ_JSON: policyJSON({ memberships: [{ subject: "user-1", role: "owner", active: true }] }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(`${AS}/`)) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { base } = await startServer(t, env);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: AS,
    aud: "authenticated",
    sub: "user-1",
    client_id: "delegated-client-abc",
    scope: "openid offline_access",
    exp: now + 60,
    nbf: now - 5,
  };
  const token = es256Mint(privateKey, "oauth-k1", claims);
  const noOrigin = await mcpCall(base, 1, "tools/list", {}, { token, origin: null });
  assert.equal(noOrigin.status, 200);
  const list = parseRpc(await noOrigin.text());
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name).sort(),
    ["get_content", "inspect", "resolve", "search"],
  );

  for (const [name, broken] of [
    ["wrong issuer", { ...claims, iss: "https://other.example/auth/v1" }],
    ["wrong audience", { ...claims, aud: "other" }],
    ["expired", { ...claims, exp: now - 3600 }],
    ["future nbf", { ...claims, nbf: now + 3600 }],
    ["empty subject", { ...claims, sub: "   " }],
    ["malformed client_id", { ...claims, client_id: 42 }],
    ["empty client_id", { ...claims, client_id: "" }],
  ]) {
    const response = await mcpCall(base, 1, "tools/list", {}, { token: es256Mint(privateKey, "oauth-k1", broken), origin: null });
    assert.equal(response.status, 401, name);
    assert.equal(
      response.headers.get("www-authenticate"),
      `Bearer error="invalid_token", resource_metadata="${METADATA_URL}"`,
      name,
    );
  }
  const forged = token.split(".");
  const forgedClaims = Buffer.from(JSON.stringify({ ...claims, sub: "attacker" })).toString("base64url");
  const badSignature = await mcpCall(base, 1, "tools/list", {}, { token: `${forged[0]}.${forgedClaims}.${forged[2]}`, origin: null });
  assert.equal(badSignature.status, 401);
});

// ---------------------------------------------------------------------------
// MCP tool regression through the OAuth-configured resource server
// ---------------------------------------------------------------------------

test("exactly four MCP tools remain reachable and behave", async (t) => {
  const { base } = await startServer(t, staticEnv(BUILD.registryHome));
  const digest = createHostedRuntimeFromEnv(staticEnv(BUILD.registryHome)).snapshot.releaseDigest;

  const list = parseRpc(await (await mcpCall(base, 1, "tools/list")).text());
  assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), ["get_content", "inspect", "resolve", "search"]);

  const searched = await toolCall(base, 2, "search", { query: "alpha", limit: 20 });
  assert.doesNotMatch(JSON.stringify(searched.result), /"isError":true/);
  assert.match(JSON.stringify(searched.result), /ega\/alpha/);
  assert.match(JSON.stringify(searched.result), new RegExp(digest.slice(0, 20)));

  const resolved = await toolCall(base, 3, "resolve", { task: "alpha oauth skill" });
  assert.doesNotMatch(JSON.stringify(resolved.result), /"isError":true/);

  const inspected = await toolCall(base, 4, "inspect", { skill_id: "ega/alpha", release_digest: digest });
  assert.doesNotMatch(JSON.stringify(inspected.result), /"isError":true/);

  const content = await toolCall(base, 5, "get_content", {
    skill_id: "ega/alpha",
    version_hash: ALPHA_HASH,
    level: "L2",
    max_tokens: 1000,
    release_digest: digest,
  });
  assert.doesNotMatch(JSON.stringify(content.result), /"isError":true/);
  assert.match(JSON.stringify(content.result), /Use alpha oauth body/);
});

test("release, context, deny, and limit regressions still fail closed", async (t) => {
  const denied = await startServer(
    t,
    staticEnv(BUILD.registryHome, {
      EGA_HOSTED_AUTHZ_JSON: policyJSON({
        denied_skills: ["ega/alpha"],
        denied_sources: ["src-denied"],
        denied_releases: [],
      }),
    }),
  );
  const digest = createHostedRuntimeFromEnv(staticEnv(BUILD.registryHome)).snapshot.releaseDigest;

  const mismatch = await toolCall(denied.base, 1, "inspect", { skill_id: "ega/alpha", release_digest: `sha256:${"0".repeat(64)}` });
  assert.match(JSON.stringify(mismatch.result), /E_RELEASE_MISMATCH/);

  const context = await toolCall(denied.base, 2, "search", { query: "alpha", context_id: "ctx-unknown" });
  assert.match(JSON.stringify(context.result), /E_CONTEXT_UNAVAILABLE/);

  const deniedContent = await toolCall(denied.base, 3, "get_content", {
    skill_id: "ega/alpha",
    version_hash: ALPHA_HASH,
    level: "L2",
    max_tokens: 1000,
    release_digest: digest,
  });
  assert.match(JSON.stringify(deniedContent.result), /E_CONTENT_REVOKED/);

  const searched = await toolCall(denied.base, 4, "search", { query: "alpha", limit: 20 });
  assert.doesNotMatch(JSON.stringify(searched.result), /ega\/alpha/);

  const oversized = await fetch(`${denied.base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(),
    body: new Uint8Array(2 * 1_048_576),
  });
  assert.equal(oversized.status, 413);

  const alias = await startServer(t, staticEnv(ALIAS_BUILD.registryHome, { EGA_HOSTED_AUTHZ_JSON: policyJSON({ denied_skills: ["ega/alpha"] }) }));
  const aliasInspect = await toolCall(alias.base, 1, "inspect", { skill_id: "alpha-alias", release_digest: digest });
  assert.equal(aliasInspect.result.isError, true);
});

test("denied releases and denied sources fail closed with revoked content", async () => {
  const snapshot = loadHostedReleaseSnapshot(BUILD.registryHome);
  const base = {
    allowedOrigins: ["http://localhost"],
    verifyBearer: async () => ({ subject: "local-smoke", scopes: [] }),
    authorize: async () => true,
  };
  const handlerFetch = async (handler, name, args) => {
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }));
    const text = await response.text();
    return parseRpc(text);
  };

  const deniedRelease = createHostedMcpHandler(snapshot, {
    ...base,
    deniedReleases: new Set([snapshot.releaseDigest]),
  });
  const releaseResult = await handlerFetch(deniedRelease, "search", { query: "alpha" });
  assert.match(JSON.stringify(releaseResult.result), /E_UNAUTHORIZED/);

  const sourceSnapshot = {
    ...snapshot,
    release: {
      ...snapshot.release,
      payload: { ...snapshot.release.payload, adopted_sources: [{ source_id: "src-denied" }] },
    },
  };
  const deniedSource = createHostedMcpHandler(sourceSnapshot, {
    ...base,
    deniedSources: new Set(["src-denied"]),
  });
  const sourceResult = await handlerFetch(deniedSource, "search", { query: "alpha" });
  assert.match(JSON.stringify(sourceResult.result), /E_CONTENT_REVOKED/);
});

test("no secret or policy leakage across challenge, metadata, and tool errors", async (t) => {
  const { base } = await startServer(t, staticEnv(BUILD.registryHome));
  const responses = await Promise.all([
    mcpCall(base, 1, "tools/list", {}, { token: null }),
    mcpCall(base, 2, "tools/list", {}, { token: "wrong" }),
    mcpCall(base, 3, "tools/call", { name: "inspect", arguments: { skill_id: "ega/alpha" } }),
    fetch(`${base}/.well-known/oauth-protected-resource`),
  ]);
  for (const response of responses) {
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(SECRET_TOKEN));
    assert.doesNotMatch(text, /local-smoke|oauth-workspace|memberships/);
  }
});
