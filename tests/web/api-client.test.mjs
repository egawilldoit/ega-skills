/**
 * Tests for the BFF API client's pure helpers and error normalization.
 *
 * The transport wrapper is exercised with a stub `fetch`, so these tests cover
 * real request shaping and real status-to-error mapping without a server.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  API_ENDPOINTS,
  apiErrorFromResponse,
  apiUrl,
  buildQueryString,
  createApiClient,
  encodePathSegment,
  errorKindForStatus,
  isReleaseDigest,
  isRetryableStatus,
  isUuid,
  normalizeThrownError,
  readErrorEnvelope,
} from "../../apps/web/src/api/client.ts";

/** Minimal Response stand-in: the client only reads `ok`, `status`, `json`, `text`. */
function stubResponse({ status = 200, body = "" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return JSON.parse(typeof body === "string" ? body : JSON.stringify(body));
    },
  };
}

test("a release digest must be canonical sha256 with 64 lowercase hex chars", () => {
  const valid = `sha256:${"a".repeat(64)}`;
  assert.equal(isReleaseDigest(valid), true);
  assert.equal(isReleaseDigest(`sha256:${"A".repeat(64)}`), false, "uppercase is rejected");
  assert.equal(isReleaseDigest(`sha256:${"a".repeat(63)}`), false, "short digest is rejected");
  assert.equal(isReleaseDigest("sha256:", false), false);
  assert.equal(isReleaseDigest("deadbeef"), false);
});

test("UUID validation matches the control-plane identifier form", () => {
  assert.equal(isUuid("018f0c2a-1b2c-7d3e-8f40-1234567890ab"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(""), false);
});

test("path segments that could escape the route shape are refused", () => {
  assert.throws(() => encodePathSegment("", "skillId"), TypeError);
  assert.throws(() => encodePathSegment("..", "skillId"), TypeError);
  assert.throws(() => encodePathSegment(".", "skillId"), TypeError);
  assert.throws(() => encodePathSegment("a/b", "skillId"), TypeError);
  assert.equal(encodePathSegment("alpha", "skillId"), "alpha");
});

test("a digest colon is percent-encoded so it stays inside one segment", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  const url = API_ENDPOINTS.release(digest);
  assert.ok(url.startsWith("/releases/sha256%3A"), url);
  // Exactly two separators: the leading one and the one after "releases".
  assert.equal(url.split("/").length - 1, 2, `expected one path segment, got ${url}`);
});

test("query strings are deterministic and drop undefined and empty values", () => {
  assert.equal(buildQueryString({}), "");
  assert.equal(buildQueryString({ a: undefined, b: "" }), "");
  assert.equal(buildQueryString({ b: "2", a: "1" }), "?a=1&b=2", "keys are sorted");
  assert.equal(buildQueryString({ q: "a b&c" }), "?q=a%20b%26c", "values are encoded");
});

test("apiUrl builds a same-origin path under /api", () => {
  assert.equal(apiUrl("/skills"), "/api/skills");
  assert.equal(apiUrl("/releases/compare", { base: "x" }), "/api/releases/compare?base=x");
  assert.throws(() => apiUrl("skills"), TypeError);
});

test("HTTP statuses map onto the documented error kinds", () => {
  assert.equal(errorKindForStatus(401), "unauthorized");
  assert.equal(errorKindForStatus(403), "forbidden");
  assert.equal(errorKindForStatus(404), "not_found");
  assert.equal(errorKindForStatus(409), "conflict");
  assert.equal(errorKindForStatus(503), "unavailable");
  assert.equal(errorKindForStatus(500), "server");
  assert.equal(errorKindForStatus(418), "server", "an unmapped status fails as a server error");
});

test("only transport-recoverable statuses are retryable", () => {
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(404), false);
});

test("a well-formed error envelope is read and its status mapped", () => {
  const error = apiErrorFromResponse(403, {
    error: { code: "E_FORBIDDEN", message: "role may not read audit" },
  });
  assert.equal(error.kind, "forbidden");
  assert.equal(error.status, 403);
  assert.equal(error.code, "E_FORBIDDEN");
  assert.equal(error.retryable, false);
});

test("a missing envelope still yields a typed error rather than a throw", () => {
  const error = apiErrorFromResponse(404, null);
  assert.equal(error.kind, "not_found");
  assert.equal(error.message, "HTTP 404");
  assert.equal(error.code, null);
});

test("an unreadable error body degrades to null instead of throwing", async () => {
  assert.equal(await readErrorEnvelope(stubResponse({ status: 500, body: "<html>oops</html>" })), null);
  assert.equal(await readErrorEnvelope(stubResponse({ status: 500, body: "" })), null);
  assert.equal(await readErrorEnvelope(stubResponse({ status: 500, body: '{"nope":1}' })), null);
  assert.deepEqual(
    await readErrorEnvelope(stubResponse({ status: 400, body: { error: { code: "E_X", message: "m" } } })),
    { error: { code: "E_X", message: "m" } },
  );
});

test("an abort becomes an aborted error, which is not retryable", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const error = normalizeThrownError(abort);
  assert.equal(error.kind, "aborted");
  assert.equal(error.retryable, false);
});

test("a transport throw becomes a retryable network error carrying no URL", () => {
  const error = normalizeThrownError(new TypeError("fetch failed"));
  assert.equal(error.kind, "network");
  assert.equal(error.retryable, true);
  assert.equal(error.status, null);
  assert.ok(!error.message.includes("/api"), "the request path must not leak into the message");
});

test("the client attaches the first-party access token and nothing else", async () => {
  let seen;
  const client = createApiClient({
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return stubResponse({ status: 200, body: { ok: true } });
    },
    getAccessToken: async () => "user-jwt",
  });

  await client.get("/skills");
  assert.equal(seen.url, "/api/skills", "requests are same-origin relative paths");
  assert.equal(seen.init.credentials, "same-origin");
  assert.equal(seen.init.headers.authorization, "Bearer user-jwt");
  assert.equal(seen.init.redirect, "error", "no silent redirect to another origin");
  assert.equal(seen.init.method, "GET");
});

test("a signed-out session sends no authorization header at all", async () => {
  let seen;
  const client = createApiClient({
    fetchImpl: async (url, init) => {
      seen = init;
      return stubResponse({ status: 200, body: {} });
    },
    getAccessToken: async () => null,
  });

  await client.get("/catalog");
  assert.equal("authorization" in seen.headers, false);
});

test("a non-2xx response rejects with a typed ApiError carrying the envelope", async () => {
  const client = createApiClient({
    fetchImpl: async () =>
      stubResponse({
        status: 503,
        body: { error: { code: "E_RUNTIME_UNAVAILABLE", message: "no release" } },
      }),
  });

  await assert.rejects(client.get("/catalog"), (error) => {
    assert.equal(error.kind, "unavailable");
    assert.equal(error.status, 503);
    assert.equal(error.code, "E_RUNTIME_UNAVAILABLE");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("a 2xx body that is not JSON rejects as malformed_response", async () => {
  const client = createApiClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return "not json";
      },
      async json() {
        throw new SyntaxError("unexpected token");
      },
    }),
  });

  await assert.rejects(client.get("/skills"), (error) => {
    assert.equal(error.kind, "malformed_response");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("a supplied decoder replaces the trusted cast", async () => {
  const client = createApiClient({
    fetchImpl: async () => stubResponse({ status: 200, body: { skill_total: 3 } }),
  });

  // Plain JS in this file: `node --test` runs it untransformed, so no TS cast.
  const decoded = await client.get("/catalog", {
    decode: (value) => {
      const total = value && typeof value === "object" ? value.skill_total : undefined;
      if (typeof total !== "number") throw new TypeError("skill_total must be a number");
      return { skill_total: total };
    },
  });
  assert.deepEqual(decoded, { skill_total: 3 });
});

test("a decoder rejection propagates so a malformed payload cannot be trusted", async () => {
  const client = createApiClient({
    fetchImpl: async () => stubResponse({ status: 200, body: { skill_total: "three" } }),
  });

  await assert.rejects(
    client.get("/catalog", {
      decode: (value) => {
        const total = value && typeof value === "object" ? value.skill_total : undefined;
        if (typeof total !== "number") throw new TypeError("skill_total must be a number");
        return { skill_total: total };
      },
    }),
    TypeError,
  );
});