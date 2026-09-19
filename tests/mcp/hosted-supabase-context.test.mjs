import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseContextResolver, HostedRuntimeError } from "../../packages/mcp/dist/index.js";

const principal = { subject: "user-a", scopes: ["ega:read"] };
const signal = new AbortController().signal;
const releaseDigest = `sha256:${"1".repeat(64)}`;
const snapshot = { releaseDigest };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url);
    assert.equal(init.method, "GET");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("apikey"), "server-secret");
    assert.equal(headers.get("authorization"), "Bearer server-secret");
    assert.doesNotMatch(url.toString(), /server-secret/);
    if (overrides[url.pathname]) return overrides[url.pathname](url);
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
  return { fetchImpl, calls };
}

function resolverWith(fetchImpl, onRelease = async () => snapshot) {
  return createSupabaseContextResolver({
    supabaseUrl: "https://project.supabase.co",
    secretKey: "server-secret",
    fetch: fetchImpl,
    resolveRelease: onRelease,
  });
}

test("Supabase context resolver authorizes an active workspace member and pins the exact release", async () => {
  const { fetchImpl, calls } = apiFetch();
  let requestedRelease;
  const resolver = resolverWith(fetchImpl, async (digest) => {
    requestedRelease = digest;
    return snapshot;
  });

  const result = await resolver("ctx-a", principal, signal);
  assert.equal(result, snapshot);
  assert.equal(requestedRelease, releaseDigest);
  assert.deepEqual(calls.map((url) => url.pathname), [
    "/rest/v1/project_contexts",
    "/rest/v1/context_revocations",
    "/rest/v1/projects",
    "/rest/v1/workspace_memberships",
  ]);
});

test("Supabase context resolver fails closed when a context_revocations row exists", async () => {
  const { fetchImpl } = apiFetch({
    "/rest/v1/context_revocations": () => json([{ context_id: "ctx-a" }]),
  });
  let releaseLookups = 0;
  const resolver = resolverWith(fetchImpl, async () => {
    releaseLookups += 1;
    return snapshot;
  });

  await assert.rejects(() => resolver("ctx-a", principal, signal), (error) => {
    assert.ok(error instanceof HostedRuntimeError);
    assert.equal(error.code, "E_CONTEXT_UNAVAILABLE");
    assert.equal(error.message, "Context is unavailable");
    return true;
  });
  assert.equal(releaseLookups, 0);
});

test("Supabase context resolver fails closed when project_contexts.revoked_at is set", async () => {
  const { fetchImpl } = apiFetch({
    "/rest/v1/project_contexts": () => json([{
      id: "ctx-a",
      project_id: "project-a",
      release_digest: releaseDigest,
      revoked_at: "2026-09-09T21:52:29.374335+00:00",
    }]),
  });
  const resolver = resolverWith(fetchImpl);
  await assert.rejects(() => resolver("ctx-a", principal, signal), (error) => error?.code === "E_CONTEXT_UNAVAILABLE");
});

test("Supabase context resolver fails closed for a missing or inactive membership", async () => {
  for (const rows of [[], [{ workspace_id: "workspace-a", subject: "user-a", role: "viewer", active: false }]]) {
    const { fetchImpl } = apiFetch({
      "/rest/v1/workspace_memberships": () => json(rows),
    });
    const resolver = resolverWith(fetchImpl);
    await assert.rejects(() => resolver("ctx-a", principal, signal), (error) => error?.code === "E_CONTEXT_UNAVAILABLE");
  }
});

test("Supabase context resolver maps backend failures to the same non-enumerating error", async () => {
  const { fetchImpl } = apiFetch({
    "/rest/v1/project_contexts": () => json({ message: "backend detail" }, 500),
  });
  const resolver = resolverWith(fetchImpl);
  await assert.rejects(() => resolver("ctx-a", principal, signal), (error) => {
    assert.equal(error?.code, "E_CONTEXT_UNAVAILABLE");
    assert.equal(error?.message, "Context is unavailable");
    return true;
  });
});
