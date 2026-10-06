import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import test from "node:test";
import { createJwksBearerVerifier } from "../../packages/mcp/dist/index.js";

function rsaToken(privateKey, kid, claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid, typ: "JWT" });
  const body = encode(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`); signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString("base64url")}`;
}

function es256Token(privateKey, kid, claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", kid, typ: "JWT" });
  const body = encode(claims);
  const signer = createSign("SHA256");
  signer.update(`${header}.${body}`); signer.end();
  const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${signature.toString("base64url")}`;
}

test("JWKS verifier validates issuer, audience, scope and signature with bounded cache", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", kty: "RSA" };
  let fetches = 0;
  const verify = createJwksBearerVerifier({
    issuer: "https://issuer.example",
    audience: "https://ega.example/mcp",
    jwksUrl: "https://issuer.example/.well-known/jwks.json",
    requiredScope: "ega:read",
    jwksMaxAgeMs: 10_000,
    fetchImpl: async (_url, { signal }) => {
      assert.equal(signal.aborted, false); fetches += 1;
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ keys: [jwk] })).buffer };
    },
  });
  const claims = { iss: "https://issuer.example", aud: ["https://ega.example/mcp"], sub: "user-1", scope: "ega:read", exp: Math.floor(Date.now() / 1000) + 60 };
  const principal = await verify(rsaToken(privateKey, "k1", claims), new AbortController().signal);
  assert.deepEqual(principal, { subject: "user-1", scopes: ["ega:read"] });
  await verify(rsaToken(privateKey, "k1", claims), new AbortController().signal);
  assert.equal(fetches, 1);
  await assert.rejects(() => verify(rsaToken(privateKey, "k1", { ...claims, aud: "wrong" }), new AbortController().signal));
});

test("JWKS verifier accepts Supabase-style ES256 access tokens without custom scopes", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "supabase-k1", kty: "EC", alg: "ES256", use: "sig", key_ops: ["verify"] };
  const issuer = "https://project-ref.supabase.co/auth/v1";
  const verify = createJwksBearerVerifier({
    issuer,
    audience: "authenticated",
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    fetchImpl: async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ keys: [jwk] })).buffer,
    }),
  });
  const claims = {
    iss: issuer,
    aud: "authenticated",
    sub: "0af68091-aee0-4a77-89ac-f0f03cd7e67c",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 60,
  };
  const token = es256Token(privateKey, "supabase-k1", claims);
  const principal = await verify(token, new AbortController().signal);
  assert.deepEqual(principal, { subject: claims.sub, scopes: [] });
  const parts = token.split(".");
  const forgedClaims = Buffer.from(JSON.stringify({ ...claims, sub: "attacker" })).toString("base64url");
  await assert.rejects(() => verify(`${parts[0]}.${forgedClaims}.${parts[2]}`, new AbortController().signal));
});

test("JWKS cache age configuration fails closed", () => {
  assert.throws(() => createJwksBearerVerifier({ issuer: "i", audience: "a", jwksUrl: "u", jwksMaxAgeMs: 0, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }) }), /jwksMaxAgeMs/);
  assert.throws(() => createJwksBearerVerifier({ issuer: "i", audience: "a", jwksUrl: "u", jwksMaxAgeMs: Number.MAX_SAFE_INTEGER + 1, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }) }), /jwksMaxAgeMs/);
});

test("JWKS verifier preserves optional client_id, rejects blank subjects, malformed client_id and non-finite nbf", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "claims-k1", kty: "EC", alg: "ES256" };
  const issuer = "https://project-ref.supabase.co/auth/v1";
  const verify = createJwksBearerVerifier({
    issuer,
    audience: "authenticated",
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    fetchImpl: async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ keys: [jwk] })).buffer,
    }),
  });
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: issuer, aud: "authenticated", sub: "user-1", exp: now + 60 };

  const delegated = await verify(
    es256Token(privateKey, "claims-k1", { ...base, client_id: "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d", scope: "openid offline_access" }),
    new AbortController().signal,
  );
  assert.deepEqual(delegated, {
    subject: "user-1",
    scopes: ["openid", "offline_access"],
    clientId: "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d",
  });

  const direct = await verify(es256Token(privateKey, "claims-k1", base), new AbortController().signal);
  assert.equal("clientId" in direct, false);

  const rejected = [
    { ...base, sub: "" },
    { ...base, sub: "   " },
    { ...base, client_id: "" },
    { ...base, client_id: "   " },
    { ...base, client_id: 1234 },
    { ...base, client_id: {} },
    { ...base, nbf: "soon" },
    { ...base, nbf: Number.NaN },
    { ...base, nbf: now + 3600 },
    { ...base, nbf: Number.POSITIVE_INFINITY },
  ];
  for (const claims of rejected) {
    await assert.rejects(
      () => verify(es256Token(privateKey, "claims-k1", claims), new AbortController().signal),
      undefined,
      JSON.stringify(claims),
    );
  }
});

test("JWKS verifier reads streaming responses with a bounded buffer", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "bounded-k1", kty: "EC", alg: "ES256" };
  const issuer = "https://project-ref.supabase.co/auth/v1";
  let pulls = 0;
  const body = {
    getReader() {
      return {
        async read() {
          pulls += 1;
          if (pulls > 64) return { done: true, value: undefined };
          return { done: false, value: new Uint8Array(512).fill(0x20) };
        },
        async cancel() {},
      };
    },
  };
  const verify = createJwksBearerVerifier({
    issuer,
    audience: "authenticated",
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    maxBodyBytes: 4096,
    fetchImpl: async () => ({
      ok: true,
      body,
      arrayBuffer: async () => {
        throw new Error("arrayBuffer must not be used when a stream is available");
      },
    }),
  });
  const claims = { iss: issuer, aud: "authenticated", sub: "user-1", exp: Math.floor(Date.now() / 1000) + 60 };
  await assert.rejects(
    () => verify(es256Token(privateKey, "bounded-k1", claims), new AbortController().signal),
    /too large/,
  );
  assert.ok(pulls < 10, `bounded reading must stop early (pulled ${pulls} times)`);
});

test("unknown kid refresh storms are coalesced and rate limited", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "known-k1", kty: "EC", alg: "ES256" };
  const issuer = "https://project-ref.supabase.co/auth/v1";
  let fetches = 0;
  const verify = createJwksBearerVerifier({
    issuer,
    audience: "authenticated",
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    jwksRefreshCooldownMs: 30_000,
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ keys: [jwk] })).buffer };
    },
  });
  const known = { iss: issuer, aud: "authenticated", sub: "user-1", exp: Math.floor(Date.now() / 1000) + 60 };
  await verify(es256Token(privateKey, "known-k1", known), new AbortController().signal);
  assert.equal(fetches, 1);

  const unknownToken = es256Token(privateKey, "rotated-kid", known);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => verify(unknownToken, new AbortController().signal)),
  );
  assert.ok(results.every((entry) => entry.status === "rejected"));
  assert.equal(fetches, 1, "unknown kid requests must not trigger a refresh storm");
});
