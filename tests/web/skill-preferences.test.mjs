import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSkillPreferenceRoutes } from "../../apps/web/server/skill-preferences.ts";
import { parseServerConfig, ServerConfigError, sanitizeVerifiedTlsConnectionString } from "../../apps/web/server/env.ts";

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

test("skill-preferences database URL rejects TLS-weakening overrides and sanitizes driver options", async () => {
  for (const variant of [
    "postgresql://u:s@db.example.invalid:5432/app?sslmode=disable",
    "postgresql://u:s@db.example.invalid:5432/app?sslmode=allow",
    "postgresql://u:s@db.example.invalid:5432/app?sslmode=prefer",
    "postgresql://u:s@db.example.invalid:5432/app?sslmode=require",
    "postgresql://u:s@db.example.invalid:5432/app?sslmode=no-verify",
    "postgresql://u:s@db.example.invalid:5432/app?ssl=false",
    "postgresql://u:s@db.example.invalid:5432/app?uselibpqcompat=true",
  ]) {
    assert.throws(
      () => parseServerConfig({ EGA_SKILL_PREFERENCES_DATABASE_URL: variant }),
      (error) => error instanceof ServerConfigError && /must not weaken TLS verification|must not use libpq compatibility/.test(error.message),
      variant,
    );
  }
  const sanitized = sanitizeVerifiedTlsConnectionString("postgresql://u:s@db.example.invalid:5432/app?sslmode=verify-full&application_name=ega&sslrootcert=/tmp/x");
  assert.equal(sanitized.includes("sslmode"), false);
  assert.equal(sanitized.includes("sslrootcert"), false);
  assert.equal(sanitized.includes("application_name=ega"), true);
  // Actual pg parsing behavior: sanitized URL has no TLS-weakening params and
  // enforced ssl config is applied.
  const { createRequire } = await import("node:module");
  const requireFromWeb = createRequire(new URL("../../apps/web/server/env.ts", import.meta.url));
  const pg = requireFromWeb("pg");
  const pool = new pg.Pool({ connectionString: sanitized, ssl: { rejectUnauthorized: true } });
  try {
    assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true });
    assert.equal(pool.options.connectionString?.includes("sslmode"), false);
  } finally {
    await pool.end();
  }
  // And with a weakening sslmode in the raw string, pg parsing would not enforce
  // verified TLS - which is why env rejects and the store sanitizes before passing to pg.
  const weakPool = new pg.Pool({ connectionString: "postgresql://u:s@db.example.invalid:5432/app?sslmode=disable" });
  try {
    const ssl = weakPool.options.ssl;
    assert.notEqual(ssl?.rejectUnauthorized, true, `sslmode=disable must not yield verified TLS (got ${JSON.stringify(ssl)})`);
    assert.equal(ssl === true || ssl?.rejectUnauthorized === true, false);
  } finally {
    await weakPool.end();
  }
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

test("adding defaults fails closed when Supabase-backed release authorization cannot be verified", async () => {
  const saved = { url: process.env.EGA_SUPABASE_URL, key: process.env.EGA_SUPABASE_PUBLISHABLE_KEY, anon: process.env.EGA_SUPABASE_ANON_KEY };
  process.env.EGA_SUPABASE_URL = "https://example.supabase.co";
  process.env.EGA_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  delete process.env.EGA_SUPABASE_ANON_KEY;
  try {
    const routes = buildSkillPreferenceRoutes({
      bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
      reader: {
        async resolveCaller() { return { subject: "user-a" }; },
        async readAsCaller(_caller, table) {
          if (table === "workspace_memberships") return [{ workspace_id: WS, subject: "user-a", role: "owner", active: true }];
          return [];
        },
      },
      store: { async update() { throw new Error("must not write when release authorization is unavailable"); } },
      catalogIds: () => new Set(["known/skill"]),
      isPublicPolicy: () => false,
      resolveAdditionReleaseDigest: () => { throw new Error("release identity unavailable"); },
      authorizeRelease: async () => { throw new Error("must not authorize without verified release digest"); },
    });
    await assert.rejects(
      routes[0].handle({
        method: "PUT", pathname: "/api/skill-preferences", query: new URLSearchParams(), params: {},
        request: request("PUT", { workspace_id: WS, expected_revision: 0, favorite_skill_ids: [], default_skill_ids: ["known/skill"] }),
      }),
      (error) => error.code === "E_WEB_PREFERENCES_RELEASE_UNAVAILABLE" && error.status === 503,
    );
  } finally {
    if (saved.url === undefined) delete process.env.EGA_SUPABASE_URL; else process.env.EGA_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.EGA_SUPABASE_PUBLISHABLE_KEY; else process.env.EGA_SUPABASE_PUBLISHABLE_KEY = saved.key;
    if (saved.anon === undefined) delete process.env.EGA_SUPABASE_ANON_KEY; else process.env.EGA_SUPABASE_ANON_KEY = saved.anon;
  }
});

test("default digest resolution path is used for Supabase-backed additions (fail-closed without verified snapshot)", async () => {
  const saved = { url: process.env.EGA_SUPABASE_URL, key: process.env.EGA_SUPABASE_PUBLISHABLE_KEY, anon: process.env.EGA_SUPABASE_ANON_KEY, art: process.env.EGA_WEB_ARTIFACT_DIR };
  process.env.EGA_SUPABASE_URL = "https://example.supabase.co";
  process.env.EGA_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  delete process.env.EGA_SUPABASE_ANON_KEY;
  delete process.env.EGA_WEB_ARTIFACT_DIR;
  try {
    const routes = buildSkillPreferenceRoutes({
      bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
      reader: {
        async resolveCaller() { return { subject: "user-a" }; },
        async readAsCaller(_caller, table) {
          if (table === "workspace_memberships") return [{ workspace_id: WS, subject: "user-a", role: "owner", active: true }];
          return [];
        },
      },
      store: { async update() { throw new Error("must not write when default digest resolution fails"); } },
      catalogIds: () => new Set(["known/skill"]),
      isPublicPolicy: () => false,
      // resolveAdditionReleaseDigest and authorizeRelease intentionally NOT injected:
      // exercises actual default getRegistry(config).snapshot.release.digest path.
    });
    await assert.rejects(
      routes[0].handle({
        method: "PUT", pathname: "/api/skill-preferences", query: new URLSearchParams(), params: {},
        request: request("PUT", { workspace_id: WS, expected_revision: 0, favorite_skill_ids: [], default_skill_ids: ["known/skill"] }),
      }),
      (error) => error.code === "E_WEB_PREFERENCES_RELEASE_UNAVAILABLE" && error.status === 503,
    );
  } finally {
    for (const [k, v] of [["EGA_SUPABASE_URL", saved.url], ["EGA_SUPABASE_PUBLISHABLE_KEY", saved.key], ["EGA_SUPABASE_ANON_KEY", saved.anon], ["EGA_WEB_ARTIFACT_DIR", saved.art]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("additions use reusable release registry once per request (bounded handle path)", async () => {
  let registryReads = 0;
  const routes = buildSkillPreferenceRoutes({
    bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
    reader: {
      async resolveCaller() { return { subject: "user-a" }; },
      async readAsCaller(_c, t) { return t === "workspace_memberships" ? [{ workspace_id: WS, subject: "user-a", role: "owner", active: true }] : []; },
    },
    store: { async update(input) { return { revision: 1, favorite_skill_ids: [], default_skill_ids: [...input.defaults], updated_at: null }; } },
    isPublicPolicy: () => true,
    getReleaseRegistry: () => { registryReads += 1; return { snapshot: { release: { digest: "sha256:" + "b".repeat(64) } }, listReleasedSkillIds: () => ["known/skill"] }; },
  });
  await routes[0].handle({ method: "PUT", pathname: "/skill-preferences", query: new URLSearchParams(), params: {},
    request: request("PUT", { workspace_id: WS, expected_revision: 0, favorite_skill_ids: [], default_skill_ids: ["known/skill"] }) });
  assert.equal(registryReads, 1, "one reusable registry read per request; no per-request handle opening");
});

test("stale expected revision fails before addition/catalog classification (prevents retired-ID re-add race)", async () => {
  // Race model: rev=1 has [retired] (no longer in catalog). T2 removed it -> rev=2.
  // T1 read rev=1, submits expected_revision=2 keeping [retired]; classifying additions
  // against stale rev=1 would see no addition and bypass catalog. Must reject as conflict.
  const routes = buildSkillPreferenceRoutes({
    bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
    reader: {
      async resolveCaller() { return { subject: "user-a" }; },
      async readAsCaller(_c, t, o) {
        if (t === "workspace_memberships") return [{ workspace_id: WS, subject: "user-a", role: "owner", active: true }];
        if (t === "skill_preferences") return [{ revision: 1, favorite_skill_ids: [], default_skill_ids: ["retired/skill"], updated_at: null }];
        return [];
      },
    },
    store: { async update() { throw new Error("must not write when expected revision is stale"); } },
    isPublicPolicy: () => true,
    getReleaseRegistry: () => { throw new Error("must not resolve catalog for stale revision"); },
  });
  await assert.rejects(
    routes[0].handle({ method: "PUT", pathname: "/skill-preferences", query: new URLSearchParams(), params: {},
      request: request("PUT", { workspace_id: WS, expected_revision: 2, favorite_skill_ids: [], default_skill_ids: ["retired/skill"] }) }),
    (e) => e.code === "E_WEB_PREFERENCES_CONFLICT" && e.status === 409,
  );
});

test("additions bind one release snapshot for digest authorization and catalog validation", async () => {
  const saved = { url: process.env.EGA_SUPABASE_URL, key: process.env.EGA_SUPABASE_PUBLISHABLE_KEY, anon: process.env.EGA_SUPABASE_ANON_KEY };
  process.env.EGA_SUPABASE_URL = "https://example.supabase.co";
  process.env.EGA_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  delete process.env.EGA_SUPABASE_ANON_KEY;
  try {
    let authDigest;
    let ctxReads = 0;
    const routes = buildSkillPreferenceRoutes({
      bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
      reader: {
        async resolveCaller() { return { subject: "user-a" }; },
        async readAsCaller(_c, t) { return t === "workspace_memberships" ? [{ workspace_id: WS, subject: "user-a", role: "owner", active: true }] : []; },
      },
      store: { async update(input) { return { revision: 1, favorite_skill_ids: [], default_skill_ids: [...input.defaults], updated_at: null }; } },
      isPublicPolicy: () => false,
      authorizeRelease: async (_ctx, _r, o) => { authDigest = o?.requestedDigests?.[0]; },
      resolveReleaseContext: () => { ctxReads += 1; return { digest: "sha256:" + "a".repeat(64), catalogIds: new Set(["skill/from-a"]) }; },
    });
    await routes[0].handle({ method: "PUT", pathname: "/api/skill-preferences", query: new URLSearchParams(), params: {},
      request: request("PUT", { workspace_id: WS, expected_revision: 0, favorite_skill_ids: [], default_skill_ids: ["skill/from-a"] }) });
    assert.equal(ctxReads, 1, "digest+catalog must come from one bound snapshot read");
    assert.equal(authDigest, "sha256:" + "a".repeat(64));
    await assert.rejects(routes[0].handle({ method: "PUT", pathname: "/api/skill-preferences", query: new URLSearchParams(), params: {},
      request: request("PUT", { workspace_id: WS, expected_revision: 0, favorite_skill_ids: [], default_skill_ids: ["skill/from-b"] }) }),
      (e) => e.code === "E_WEB_PREFERENCES_DEFAULT_UNAVAILABLE");
  } finally {
    if (saved.url === undefined) delete process.env.EGA_SUPABASE_URL; else process.env.EGA_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.EGA_SUPABASE_PUBLISHABLE_KEY; else process.env.EGA_SUPABASE_PUBLISHABLE_KEY = saved.key;
    if (saved.anon === undefined) delete process.env.EGA_SUPABASE_ANON_KEY; else process.env.EGA_SUPABASE_ANON_KEY = saved.anon;
  }
});

test("adding defaults on Supabase-backed deployments requires explicit release digest authorization", async () => {
  const saved = { url: process.env.EGA_SUPABASE_URL, key: process.env.EGA_SUPABASE_PUBLISHABLE_KEY, anon: process.env.EGA_SUPABASE_ANON_KEY };
  process.env.EGA_SUPABASE_URL = "https://example.supabase.co";
  process.env.EGA_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  delete process.env.EGA_SUPABASE_ANON_KEY;
  try {
    let seen;
    const routes = buildSkillPreferenceRoutes({
      bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
      reader: {
        async resolveCaller() { return { subject: "user-a" }; },
        async readAsCaller(_caller, table) {
          if (table === "workspace_memberships") return [{ workspace_id: WS, subject: "user-a", role: "owner", active: true }];
          return [];
        },
      },
      store: { async update(input) { return { revision: 1, favorite_skill_ids: [], default_skill_ids: [...input.defaults], updated_at: null }; } },
      catalogIds: () => new Set(["known/skill"]),
      isPublicPolicy: () => false,
      resolveAdditionReleaseDigest: () => "sha256:abc123",
      authorizeRelease: async (_ctx, _reader, options) => { seen = options; },
    });
    await routes[0].handle({
      method: "PUT", pathname: "/api/skill-preferences", query: new URLSearchParams(), params: {},
      request: request("PUT", { workspace_id: WS, expected_revision: 0, favorite_skill_ids: [], default_skill_ids: ["known/skill"] }),
    });
    assert.deepEqual(seen?.requestedDigests, ["sha256:abc123"]);
  } finally {
    if (saved.url === undefined) delete process.env.EGA_SUPABASE_URL; else process.env.EGA_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.EGA_SUPABASE_PUBLISHABLE_KEY; else process.env.EGA_SUPABASE_PUBLISHABLE_KEY = saved.key;
    if (saved.anon === undefined) delete process.env.EGA_SUPABASE_ANON_KEY; else process.env.EGA_SUPABASE_ANON_KEY = saved.anon;
  }
});
