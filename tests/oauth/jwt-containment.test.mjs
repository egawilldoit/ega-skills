// Offline JWT audience-containment matrix for the hosted MCP runtime.
//
// The live interop harnesses prove real Supabase tokens; this suite proves the
// same runtime fails closed on every structurally reachable bad credential
// without touching the network: a local JWKS endpoint serves a freshly
// generated P-256 key, and every negative case is signed (or deliberately
// malformed) by the same code path a hostile client would use.
//
// The protected resource here is `http://127.0.0.1/mcp` (loopback HTTP is the
// only non-HTTPS form the runtime accepts) and the audience must equal it.

import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHostedRuntimeFromEnv } from "../../packages/mcp/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(HERE, "..", "..", "packages", "mcp", "artifact");
const RESOURCE = "http://127.0.0.1/mcp";
const ISSUER = "https://issuer.containment.test/auth/v1";
const SUBJECT = "0af68091-aee0-4a77-89ac-f0f03cd7e67c";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "containment-k1", kty: "EC", alg: "ES256", use: "sig" };

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(header, claims) {
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return { token: `${signingInput}.${signature.toString("base64url")}`, parts: [encode(header), encode(claims), signature.toString("base64url")] };
}

function es256(claims, header = { alg: "ES256", kid: "containment-k1", typ: "JWT" }) {
  return sign(header, claims).token;
}

async function startJwks() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [JWK] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/jwks.json` };
}

async function rpc(handler, id, method, params = {}, token) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    origin: "https://client.example",
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await handler.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }));
  const text = await response.text();
  const data = text.match(/data: (.+)/)?.[1];
  return { status: response.status, wwwAuthenticate: response.headers.get("www-authenticate"), body: data ?? text };
}

test("hosted runtime rejects every bad JWT shape and accepts one valid delegated token", async (t) => {
  const jwks = await startJwks();
  t.after(() => jwks.server.close());
  const runtime = createHostedRuntimeFromEnv({
    EGA_HOSTED_ARTIFACT_DIR: ARTIFACT,
    EGA_HOSTED_AUTHZ_JSON: JSON.stringify({
      workspace_id: "ega-skills-staging",
      visibility: "private",
      owner_subject: SUBJECT,
      memberships: [{ subject: SUBJECT, role: "owner", active: true }],
      denies: [],
    }),
    EGA_HOSTED_ALLOWED_ORIGINS: "https://client.example",
    EGA_HOSTED_RESOURCE_URL: RESOURCE,
    EGA_HOSTED_AUDIENCE: RESOURCE,
    EGA_HOSTED_ISSUER: ISSUER,
    EGA_HOSTED_JWKS_URL: jwks.url,
    EGA_HOSTED_OAUTH_SCOPES_SUPPORTED: "openid offline_access",
  });

  const now = Math.floor(Date.now() / 1000);
  const validClaims = {
    iss: ISSUER,
    aud: RESOURCE,
    sub: SUBJECT,
    client_id: "delegated-client-1",
    scope: "openid offline_access",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
  };

  // Positive: one real delegated-shaped token validates fully and reaches
  // the four-tool catalog plus a search on the verified release.
  const positive = await rpc(runtime.handler, 1, "tools/list", {}, es256(validClaims));
  assert.equal(positive.status, 200);
  const listed = JSON.parse(positive.body);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ["get_content", "inspect", "resolve", "search"]);
  const searched = await rpc(runtime.handler, 2, "tools/call", { name: "search", arguments: { query: "architect" } }, es256(validClaims));
  assert.equal(searched.status, 200);
  assert.match(searched.body, /cursor\/architect/);

  const { parts } = sign({ alg: "ES256", kid: "containment-k1", typ: "JWT" }, validClaims);
  const tamper = (value, index) => value.slice(0, index) + (value[index] === "A" ? "B" : "A") + value.slice(index + 1);
  const unknownKid = es256(validClaims, { alg: "ES256", kid: "rotated-but-unknown", typ: "JWT" });
  const firstParty = es256({ iss: ISSUER, aud: "authenticated", sub: SUBJECT, role: "authenticated", exp: now + 300 });

  const negatives = [
    ["missing token", undefined],
    ["first-party aud=authenticated", firstParty],
    ["wrong audience", es256({ ...validClaims, aud: "https://elsewhere.example/mcp" })],
    ["wrong issuer", es256({ ...validClaims, iss: "https://attacker.example/auth/v1" })],
    ["expired", es256({ ...validClaims, exp: now - 3600 })],
    ["not-yet-valid nbf", es256({ ...validClaims, nbf: now + 3600 })],
    ["missing subject", es256({ ...validClaims, sub: "" })],
    ["blank client_id", es256({ ...validClaims, client_id: "   " })],
    ["malformed", "not-a-jwt"],
    ["tampered signature", `${parts[0]}.${parts[1]}.${tamper(parts[2], parts[2].length - 1)}`],
    ["tampered claims", `${parts[0]}.${encode({ ...validClaims, sub: "attacker" })}.${parts[2]}`],
    ["unknown kid", unknownKid],
    ["alg none", sign({ alg: "none", kid: "containment-k1", typ: "JWT" }, validClaims).token.replace(/\.[^.]+$/, ".")],
    ["alg HS256 confusion", sign({ alg: "HS256", kid: "containment-k1", typ: "JWT" }, validClaims).token],
  ];

  let id = 10;
  for (const [name, token] of negatives) {
    id += 1;
    const result = await rpc(runtime.handler, id, "tools/list", {}, token);
    assert.equal(result.status, 401, `${name} must be rejected with 401`);
    assert.match(result.wwwAuthenticate ?? "", /^Bearer /, `${name} must carry a Bearer challenge`);
    assert.match(result.wwwAuthenticate ?? "", /resource_metadata="http:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource"/, `${name} challenge resource metadata is canonical`);
    assert.ok(!result.body.includes('"tools"'), `${name} must not expose the tool catalog`);
    assert.ok(!result.body.includes("cursor/architect"), `${name} must not expose release content`);
  }
});

test("containment matrix fails closed on partial JWT configuration", () => {
  const base = {
    EGA_HOSTED_ARTIFACT_DIR: ARTIFACT,
    EGA_HOSTED_AUTHZ_JSON: JSON.stringify({ workspace_id: "w", visibility: "private", owner_subject: "s", memberships: [], denies: [] }),
    EGA_HOSTED_ALLOWED_ORIGINS: "https://client.example",
  };
  assert.throws(() => createHostedRuntimeFromEnv({ ...base, EGA_HOSTED_ISSUER: ISSUER }), /must be configured together/);
  assert.throws(() => createHostedRuntimeFromEnv({ ...base, EGA_HOSTED_AUDIENCE: RESOURCE }), /must be configured together/);
  assert.throws(() => createHostedRuntimeFromEnv({ ...base, EGA_HOSTED_JWKS_URL: "http://127.0.0.1/jwks.json" }), /must be configured together/);
  assert.throws(
    () => createHostedRuntimeFromEnv({ ...base, EGA_HOSTED_BEARER_TOKEN: "static" }),
    /static tokens are not a production authentication mode/,
  );
  assert.throws(
    () => createHostedRuntimeFromEnv({ ...base, EGA_HOSTED_ISSUER: ISSUER, EGA_HOSTED_AUDIENCE: "https://elsewhere.example/mcp", EGA_HOSTED_JWKS_URL: "http://127.0.0.1/jwks.json" }),
    /EGA_HOSTED_AUDIENCE must equal EGA_HOSTED_RESOURCE_URL|EGA_HOSTED_RESOURCE_URL is required/,
  );
});
