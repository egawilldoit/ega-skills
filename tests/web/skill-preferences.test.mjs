import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSkillPreferenceRoutes } from "../../apps/web/server/skill-preferences.ts";
import { parseServerConfig, ServerConfigError } from "../../apps/web/server/env.ts";

const WS = "00000000-0000-4000-8000-0000000000a1";

test("the dedicated PostgreSQL URL is server-only configuration and fails closed", () => {
  const url = "postgresql://preferences_user:secret-value@db.example.invalid:5432/app";
  assert.equal(parseServerConfig({ EGA_SKILL_PREFERENCES_DATABASE_URL: url }).skillPreferencesDatabaseUrl, url);
  assert.equal(parseServerConfig({ EGA_SKILL_PREFERENCES_DATABASE_URL: "   " }).skillPreferencesDatabaseUrl, null);
  assert.throws(
    () => parseServerConfig({ EGA_SKILL_PREFERENCES_DATABASE_URL: "https://user:secret-value@example.invalid/db" }),
    (error) => error instanceof ServerConfigError && !error.message.includes("secret-value"),
  );
});

function request(method, body = undefined) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return {
    headers: {
      authorization: "Bearer caller-session",
      ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(bytes.length) }),
    },
    async *[Symbol.asyncIterator]() {
      if (bytes.length > 0) yield bytes;
    },
  };
}

function fixture(callerSubject = "user-a") {
  let record = {
    revision: 1,
    favorite_skill_ids: [],
    default_skill_ids: ["retired/skill"],
    updated_at: "2026-11-03T00:00:00.000Z",
  };
  const writes = [];
  const reader = {
    async resolveCaller(input) {
      assert.equal(input.method, "GET", "identity resolution uses the reader's read-only contract");
      return { subject: callerSubject };
    },
    async readAsCaller(caller, table) {
      if (table === "workspace_memberships" && caller.subject === "user-a") {
        return [{ workspace_id: WS, subject: "user-a", role: "owner", active: true }];
      }
      if (table === "skill_preferences" && caller.subject === "user-a" && record.revision > 0) return [record];
      return [];
    },
  };
  const store = {
    async update(input) {
      writes.push(input);
      if (input.expectedRevision !== record.revision) return null;
      record = {
        revision: record.revision + 1,
        favorite_skill_ids: [...input.favorites],
        default_skill_ids: [...input.defaults],
        updated_at: "2026-11-04T00:00:00.000Z",
      };
      return record;
    },
  };
  const routes = buildSkillPreferenceRoutes({
    bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
    reader,
    store,
    catalogIds: () => new Set(["known/skill"]),
    isPublicPolicy: () => true,
  });
  const route = routes[0];
  const invoke = (method, body, query = new URLSearchParams()) => route.handle({
    method,
    pathname: "/api/skill-preferences",
    query,
    request: request(method, body),
    params: {},
  });
  return { invoke, writes };
}

test("preferences require the caller's active Owner membership and validate only new defaults", async () => {
  const owner = fixture();
  const read = await owner.invoke("GET", undefined, new URLSearchParams({ workspace_id: WS }));
  assert.deepEqual(read.default_skill_ids, ["retired/skill"]);

  const removedRetired = await owner.invoke("PUT", {
    workspace_id: WS,
    expected_revision: 1,
    favorite_skill_ids: [],
    default_skill_ids: [],
  });
  assert.equal(removedRetired.revision, 2);
  assert.equal(owner.writes[0].subject, "user-a");

  await assert.rejects(
    owner.invoke("PUT", {
      workspace_id: WS,
      expected_revision: 2,
      favorite_skill_ids: [],
      default_skill_ids: ["unknown/skill"],
    }),
    (error) => error.code === "E_WEB_PREFERENCES_DEFAULT_UNAVAILABLE" && error.status === 400,
  );
  assert.equal(owner.writes.length, 1, "unknown catalog additions never reach the database writer");

  const otherSubject = fixture("admin-a");
  await assert.rejects(
    otherSubject.invoke("GET", undefined, new URLSearchParams({ workspace_id: WS })),
    (error) => error.code === "E_WEB_PREFERENCES_FORBIDDEN" && error.status === 403,
  );
});

test("preference request body cannot spoof subject and requires exact fields", async () => {
  const { invoke, writes } = fixture();
  await assert.rejects(invoke("PUT", {
    workspace_id: WS,
    subject: "admin-a",
    expected_revision: 1,
    favorite_skill_ids: [],
    default_skill_ids: [],
  }), (error) => error.code === "E_WEB_PREFERENCES_BODY_INVALID");
  await assert.rejects(invoke("PUT", {
    workspace_id: WS,
    expected_revision: 1,
    favorite_skill_ids: [],
  }), (error) => error.code === "E_WEB_PREFERENCES_BODY_INVALID");
  assert.equal(writes.length, 0, "spoofed/malformed bodies must not reach the writer");
});

test("preference updates reject duplicate/excess defaults and stale revisions", async () => {
  const { invoke, writes } = fixture();
  const put = (revision, defaults) => invoke("PUT", {
    workspace_id: WS,
    expected_revision: revision,
    favorite_skill_ids: [],
    default_skill_ids: defaults,
  });
  await assert.rejects(put(1, ["known/skill", "known/skill"]), (error) => error.code === "E_WEB_PREFERENCES_IDS_INVALID");
  await assert.rejects(put(1, ["known/skill", "b/two", "c/three", "d/four"]), (error) => error.code === "E_WEB_PREFERENCES_IDS_INVALID");
  assert.equal(writes.length, 0);
  await put(1, ["known/skill"]);
  await assert.rejects(put(1, ["known/skill"]), (error) => error.code === "E_WEB_PREFERENCES_CONFLICT" && error.status === 409);
});

test("removing defaults/favorites does not require current-release authorization", async () => {
  let releaseChecks = 0;
  let record = {
    revision: 1,
    favorite_skill_ids: ["known/skill"],
    default_skill_ids: ["retired/skill"],
    updated_at: "2026-11-03T00:00:00.000Z",
  };
  const routes = buildSkillPreferenceRoutes({
    bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
    reader: {
      async resolveCaller() { return { subject: "user-a" }; },
      async readAsCaller(_caller, table) {
        if (table === "workspace_memberships") return [{ workspace_id: WS, subject: "user-a", role: "owner", active: true }];
        if (table === "skill_preferences") return [record];
        return [];
      },
    },
    store: {
      async update(input) {
        record = { revision: input.expectedRevision + 1, favorite_skill_ids: [...input.favorites], default_skill_ids: [...input.defaults], updated_at: "2026-11-04T00:00:00.000Z" };
        return record;
      },
    },
    catalogIds: () => { throw new Error("catalog must not be consulted for removal-only updates"); },
    isPublicPolicy: () => false,
    authorizeRelease: async () => {
      releaseChecks += 1;
      throw { status: 403, code: "E_WEB_RELEASE_FORBIDDEN", message: "release inaccessible" };
    },
  });
  const route = routes[0];
  const result = await route.handle({
    method: "PUT",
    pathname: "/api/skill-preferences",
    query: new URLSearchParams(),
    request: request("PUT", { workspace_id: WS, expected_revision: 1, favorite_skill_ids: [], default_skill_ids: [] }),
    params: {},
  });
  assert.deepEqual(result.default_skill_ids, []);
  assert.deepEqual(result.favorite_skill_ids, []);
  assert.equal(releaseChecks, 0, "inaccessible release must not block removal-only updates");
});

test("anonymous sessions are rejected before workspace or preference reads", async () => {
  let reads = 0;
  const routes = buildSkillPreferenceRoutes({
    bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
    reader: {
      async resolveCaller() {
        throw { status: 401, code: "E_WEB_UNAUTHENTICATED", message: "session required" };
      },
      async readAsCaller() {
        reads += 1;
        return [];
      },
    },
    store: { async update() { throw new Error("unauthenticated writes must not reach the store"); } },
    catalogIds: () => new Set(),
    isPublicPolicy: () => true,
  });
  const route = routes[0];
  const context = {
    method: "GET",
    pathname: "/api/skill-preferences",
    query: new URLSearchParams({ workspace_id: WS }),
    request: request("GET"),
    params: {},
  };
  await assert.rejects(
    route.handle(context),
    (error) => error.status === 401 && error.code === "E_WEB_UNAUTHENTICATED",
  );
  assert.equal(reads, 0);
});
