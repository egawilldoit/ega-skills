/**
 * Test suite for Mandate 4: Artifact Access Policy (R8).
 *
 * Verifies that:
 * 1. Default policy is authenticated: unauthenticated requests to artifact endpoints return 401 E_WEB_UNAUTHENTICATED.
 * 2. Public policy (EGA_WEB_PUBLIC_POLICY="public") explicitly permits anonymous access.
 * 3. Authenticated requests verify Hub/Release visibility under RLS:
 *    - Inaccessible or denied releases produce 403 E_WEB_CONTROL_PLANE_FORBIDDEN.
 *    - Release comparisons verify both base and head digests are authorized.
 * 4. Authorized authenticated requests succeed.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { authorizeArtifactRequest } from "../../apps/web/server/api.ts";
import { parseServerConfig } from "../../apps/web/server/env.ts";

function createMockReader(options = {}) {
  const { callerSubject = "user-123", authorizedDigests = [] } = options;

  return {
    async resolveCaller(request) {
      const auth = request.headers?.["authorization"] ?? request.headers?.["Authorization"];
      if (!auth || !auth.startsWith("Bearer ")) {
        const error = new Error("Authentication is required");
        error.status = 401;
        error.code = "E_WEB_UNAUTHENTICATED";
        throw error;
      }
      const token = auth.slice("Bearer ".length).trim();
      if (token === "invalid-token") {
        const error = new Error("Session rejected");
        error.status = 401;
        error.code = "E_WEB_UNAUTHENTICATED";
        throw error;
      }
      return { subject: callerSubject, token };
    },

    async readAsCaller(caller, table, readOptions) {
      if (table === "hub_releases") {
        const filter = readOptions?.filters?.find((f) => f.column === "release_digest");
        const digest = filter?.values?.[0];
        if (digest && authorizedDigests.includes(digest)) {
          return [{ hub_id: "hub-1", release_digest: digest }];
        }
        return [];
      }
      return [];
    },

    describeAvailability() {
      return "mock reader active";
    },
  };
}

describe("Mandate 4 (R8): Artifact Access Policy", () => {
  const testDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const otherDigest = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

  test("default configuration enforces authenticated policy (anonymous requests fail 401)", async () => {
    const origEnv = { ...process.env };
    delete process.env.EGA_WEB_PUBLIC_POLICY;
    delete process.env.EGA_WEB_ALLOW_ANONYMOUS;
    process.env.EGA_SUPABASE_URL = "https://example.supabase.co";

    const reader = createMockReader();
    const context = {
      method: "GET",
      request: { headers: {} },
    };

    try {
      await assert.rejects(
        async () => {
          await authorizeArtifactRequest(context, reader);
        },
        (err) => {
          assert.equal(err.status, 401);
          assert.equal(err.code, "E_WEB_UNAUTHENTICATED");
          return true;
        },
      );
    } finally {
      process.env = origEnv;
    }
  });

  test("rejected token results in 401 E_WEB_UNAUTHENTICATED", async () => {
    const origEnv = { ...process.env };
    delete process.env.EGA_WEB_PUBLIC_POLICY;
    process.env.EGA_SUPABASE_URL = "https://example.supabase.co";

    const reader = createMockReader();
    const context = {
      method: "GET",
      request: { headers: { authorization: "Bearer invalid-token" } },
    };

    try {
      await assert.rejects(
        async () => {
          await authorizeArtifactRequest(context, reader);
        },
        (err) => {
          assert.equal(err.status, 401);
          assert.equal(err.code, "E_WEB_UNAUTHENTICATED");
          return true;
        },
      );
    } finally {
      process.env = origEnv;
    }
  });

  test("explicit EGA_WEB_PUBLIC_POLICY=public permits anonymous requests", async () => {
    const origEnv = { ...process.env };
    process.env.EGA_WEB_PUBLIC_POLICY = "public";

    const reader = createMockReader();
    const context = {
      method: "GET",
      request: { headers: {} },
    };

    try {
      const caller = await authorizeArtifactRequest(context, reader);
      assert.equal(caller, null, "public policy returns null caller and does not reject");
    } finally {
      process.env = origEnv;
    }
  });

  test("authenticated request to unauthorized release digest returns 403 E_WEB_CONTROL_PLANE_FORBIDDEN", async () => {
    const origEnv = { ...process.env };
    delete process.env.EGA_WEB_PUBLIC_POLICY;
    process.env.EGA_SUPABASE_URL = "https://example.supabase.co";

    // Reader has no authorized digests
    const reader = createMockReader({ authorizedDigests: [] });
    const context = {
      method: "GET",
      request: { headers: { authorization: "Bearer valid-token" } },
    };

    try {
      await assert.rejects(
        async () => {
          await authorizeArtifactRequest(context, reader, { requestedDigests: [testDigest] });
        },
        (err) => {
          assert.equal(err.status, 403);
          assert.equal(err.code, "E_WEB_CONTROL_PLANE_FORBIDDEN");
          return true;
        },
      );
    } finally {
      process.env = origEnv;
    }
  });

  test("authenticated release comparison requires BOTH base and head to be authorized", async () => {
    const origEnv = { ...process.env };
    delete process.env.EGA_WEB_PUBLIC_POLICY;
    process.env.EGA_SUPABASE_URL = "https://example.supabase.co";

    // Reader only authorizes testDigest, NOT otherDigest
    const reader = createMockReader({ authorizedDigests: [testDigest] });
    const context = {
      method: "GET",
      request: { headers: { authorization: "Bearer valid-token" } },
    };

    try {
      // Comparison with one authorized and one unauthorized digest
      await assert.rejects(
        async () => {
          await authorizeArtifactRequest(context, reader, {
            requestedDigests: [testDigest, otherDigest],
          });
        },
        (err) => {
          assert.equal(err.status, 403);
          assert.equal(err.code, "E_WEB_CONTROL_PLANE_FORBIDDEN");
          return true;
        },
      );

      // Comparison when both are authorized succeeds
      const readerBoth = createMockReader({ authorizedDigests: [testDigest, otherDigest] });
      const caller = await authorizeArtifactRequest(context, readerBoth, {
        requestedDigests: [testDigest, otherDigest],
      });
      assert.equal(caller.subject, "user-123");
    } finally {
      process.env = origEnv;
    }
  });
});
