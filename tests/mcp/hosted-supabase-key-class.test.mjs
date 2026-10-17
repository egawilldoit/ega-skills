import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseContextResolver } from "../../packages/mcp/dist/index.js";

const principal = { subject: "user-a", scopes: ["ega:read"] };
const signal = new AbortController().signal;
const releaseDigest = `sha256:${"1".repeat(64)}`;
const snapshot = { releaseDigest };

// A real-shaped legacy service_role JWT (HS256, iss=supabase, no kid).
// Structure only; this is a test fixture and is not a credential.
const legacyJwt = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ role: "service_role", iss: "supabase", sub: "fixture" })).toString("base64url"),
  "c2lnbmF0dXJlLWZpeHR1cmU",
].join(".");

// A modern Supabase secret key is an opaque, non-JWT string.
const modernSecret = "sb_secret_fixture_opaque_value_not_a_jwt";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordingFetch() {
  const seen = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init.headers);
    seen.push({ url, apikey: headers.get("apikey"), authorization: headers.get("authorization") });
    if (url.pathname.endsWith("/project_contexts")) return json([{
      id: "ctx-a",
      project_id: "project-a",
      release_digest: releaseDigest,
      revoked_at: null,
    }]);
    if (url.pathname.endsWith("/context_revocations")) return json([]);
    if (url.pathname.endsWith("/projects")) return json([{ id: "project-a", workspace_id: "workspace-a" }]);
    if (url.pathname.endsWith("/workspace_memberships")) return json([{
      workspace_id: "workspace-a",
      subject: "user-a",
      role: "viewer",
      active: true,
    }]);
    return json([], 404);
  };
  return { fetchImpl, seen };
}

function resolverFor(secretKey, fetchImpl) {
  return createSupabaseContextResolver({
    supabaseUrl: "https://project.supabase.co",
    secretKey,
    fetch: fetchImpl,
    resolveRelease: async () => snapshot,
  });
}

async function run(secretKey) {
  const { fetchImpl, seen } = recordingFetch();
  const resolved = await resolverFor(secretKey, fetchImpl)("ctx-a", principal, signal);
  assert.equal(resolved.releaseDigest, releaseDigest);
  assert.ok(seen.length > 0);
  return seen;
}

test("a modern non-JWT secret key is authenticated on the apikey header only", async () => {
  const seen = await run(modernSecret);
  for (const call of seen) {
    assert.equal(call.apikey, modernSecret);
    // A non-JWT key placed on `Authorization: Bearer` is parsed as a JWT by the
    // Supabase gateway and rejected. API keys belong on `apikey` alone.
    assert.equal(call.authorization, null);
  }
});

test("a modern secret key is passed through unchanged and never parsed as a JWT", async () => {
  const seen = await run(modernSecret);
  for (const call of seen) {
    // Byte-for-byte passthrough: no re-encoding, trimming, or claim extraction.
    assert.equal(call.apikey, modernSecret);
    // The key is structurally incapable of being inspected as a JWT, and the
    // resolver must not attempt to derive a role from it.
    assert.equal(modernSecret.split(".").length, 1);
  }
});

test("a legacy JWT secret key keeps sending apikey and Authorization Bearer", async () => {
  const seen = await run(legacyJwt);
  for (const call of seen) {
    assert.equal(call.apikey, legacyJwt);
    assert.equal(call.authorization, `Bearer ${legacyJwt}`);
  }
});

test("the secret key is never placed in the request URL for either key class", async () => {
  for (const key of [modernSecret, legacyJwt]) {
    const seen = await run(key);
    for (const call of seen) {
      assert.doesNotMatch(call.url.toString(), new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(call.url.search, /apikey|token|key=/i);
    }
  }
});

test("an opaque non-JWT key is accepted by the resolver constructor without a JWT requirement", () => {
  assert.doesNotThrow(() => resolverFor(modernSecret, async () => json([])));
});

test("the resolver sends only header credentials, never a query or body credential", async () => {
  const seen = await run(modernSecret);
  for (const call of seen) {
    assert.ok(call.apikey !== null);
    assert.equal(new URL(call.url).searchParams.get("apikey"), null);
  }
});
