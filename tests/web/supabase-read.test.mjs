/**
 * Control-plane read adapter: unit and behaviour coverage, no database required.
 *
 * ## What this suite is for
 *
 * `tests/web/cross-workspace-isolation.rls.mjs` proves *who can see what* against
 * a real PostgreSQL. This suite proves the properties that do not need one: that
 * a request without a caller is refused, that the adapter refuses to build a
 * query it was not told it may build, and that no failure message carries a
 * secret. Those are the defects a real-database run cannot see, because the
 * database is the enforcement point and a malformed request never reaches it.
 *
 * ## The fixture transport is a spy, and it is checked as one
 *
 * Every test drives `createControlPlaneReader({ transport })` with a recording
 * transport. A spy is only useful if it is actually observing the adapter, so the
 * suite asserts the recorded request directly: which URL was built, which headers
 * were sent, and that **no request reached the transport at all** for a refusal
 * that should have happened before any network call. Without that last assertion a
 * test could pass with a transport that was never called.
 *
 * ## The two invariants asserted most often
 *
 * - **The caller's token is the only credential.** `SECRET_MARKERS` below holds
 *   values that must appear in no message, in no URL, and in no recorded header
 *   other than the forwarded caller token. A privileged credential is
 *   `EGA_SUPABASE_SECRET_KEY`; the adapter never reads it, and `NO_PRIVILEGED_
 *   CREDENTIAL_OPTIONS` asserts the *type* forbids one, so the rule is checked
 *   structurally rather than by reading the implementation.
 * - **Failures never degrade into empty results.** Every refusal is a typed error
 *   with a status, checked per test. An empty array would have passed a naive
 *   "no rows leaked" assertion, which is exactly the failure mode this suite
 *   exists to prevent.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  CONTROL_PLANE_DEFAULT_LIMIT,
  CONTROL_PLANE_MAX_LIMIT,
  CONTROL_PLANE_MAX_OFFSET,
  CONTROL_PLANE_TABLE_NAMES,
  CONTROL_PLANE_TABLES,
  ControlPlaneReadError,
  assertTableAllowed,
  buildControlPlaneUrl,
  createControlPlaneReader,
  extractBearerToken,
  planControlPlaneRead,
  sanitizeReadMessage,
} from "../../apps/web/server/supabase-read.ts";
import {
  CONTROL_PLANE_SECURITY_HEADERS,
  createControlPlaneHandler,
  toControlPlaneApiError,
} from "../../apps/web/server/api.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SUPABASE_URL = "https://console-fixture.supabase.co";

/** A syntactically plausible but entirely fictional session token. */
const CALLER_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLWEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.not-a-real-signature-part";

/** The service credential that must never be used. Never a real value. */
const SERVICE_SECRET = "b4-fixture-privileged-supabase-secret-value";
const ABSOLUTE_PATH = "/srv/app/supabase-project/secret-notes.txt";

/** Values that must never appear in a message, a URL, or a header value. */
const SECRET_MARKERS = Object.freeze({
  secret: SERVICE_SECRET,
  path: ABSOLUTE_PATH,
  upstreamBody: "upstream-body-must-not-be-echoed",
  upstreamHost: "internal-postgrest.fixture.invalid",
});

/* -------------------------------------------------------------------------- */
/* Fixture transport                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a recording transport.
 *
 * `respond` decides what the "upstream" says. Every call is recorded with the URL
 * and headers so a test can assert what the adapter actually put on the wire
 * rather than what it intended.
 */
function spyTransport(respond = defaultRespond) {
  const calls = [];
  const transport = async (input, init) => {
    calls.push({ url: input, method: init.method, headers: init.headers });
    return respond(input, init, calls.length - 1);
  };
  transport.calls = calls;
  return transport;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Accepts any session and answers a table read with one row. */
function defaultRespond(input) {
  const parsed = new URL(input);
  if (parsed.pathname === "/auth/v1/user") {
    return jsonResponse(200, { id: "user-a", role: "authenticated" });
  }
  return jsonResponse(200, [{ id: "00000000-0000-4000-8000-0000000000a1" }]);
}

const FIXTURE_PUBLISHABLE_KEY = "sb_publishable_fixture-key";

/** A reader wired to `transport`, plus the transport for assertions. */
function readerWith(transport, supabaseUrl = SUPABASE_URL, publishableKey = FIXTURE_PUBLISHABLE_KEY) {
  return { reader: createControlPlaneReader({ supabaseUrl, publishableKey, transport }), transport };
}

const AUTH_HEADERS = { authorization: `Bearer ${CALLER_TOKEN}` };

/** Resolve a caller against the fixture session endpoint. */
async function resolvedCaller(reader) {
  return reader.resolveCaller({ method: "GET", headers: AUTH_HEADERS });
}

/* -------------------------------------------------------------------------- */
/* Unauthenticated callers                                                     */
/* -------------------------------------------------------------------------- */

describe("a caller must be present and verified", () => {
  test("a missing Authorization header is 401 and never an anonymous read", async () => {
    const { reader, transport } = readerWith(spyTransport());
    await assert.rejects(
      reader.resolveCaller({ method: "GET", headers: {} }),
      (error) => {
        assert.ok(error instanceof ControlPlaneReadError);
        assert.equal(error.code, "E_WEB_UNAUTHENTICATED");
        assert.equal(error.status, 401);
        return true;
      },
    );
    // A refusal must happen before any network call: an anonymous probe would
    // have asked the database something on the caller's behalf.
    assert.equal(transport.calls.length, 0);
  });

  test("non-Bearer schemes are 401: Basic, the apikey form, and a bare token", async () => {
    const refused = [
      "Basic dXNlcjpwYXNzd29yZA==",
      CALLER_TOKEN,
      `bearer ${CALLER_TOKEN}`,
      `BEARER ${CALLER_TOKEN}`,
      `Bearer${CALLER_TOKEN}`,
      `Bearer:${CALLER_TOKEN}`,
      `Basic ${CALLER_TOKEN}`,
      "Bearer",
      "Bearer ",
      "Token " + CALLER_TOKEN,
      `Apikey ${CALLER_TOKEN}`,
      "",
    ];
    for (const header of refused) {
      const { reader, transport } = readerWith(spyTransport());
      await assert.rejects(
        reader.resolveCaller({ method: "GET", headers: { authorization: header } }),
        (error) => {
          assert.equal(error.code, "E_WEB_UNAUTHENTICATED", `header ${JSON.stringify(header)}`);
          assert.equal(error.status, 401);
          return true;
        },
      );
      assert.equal(transport.calls.length, 0, `header ${JSON.stringify(header)} reached the network`);
    }
  });

  test("two Authorization credentials arriving at once are refused, not resolved to the first", async () => {
    // Node joins duplicate `authorization` headers with ", ". Picking one would
    // silently decide a client bug on the caller's behalf.
    const { reader } = readerWith(spyTransport());
    await assert.rejects(
      reader.resolveCaller({
        method: "GET",
        headers: { authorization: [`Bearer ${CALLER_TOKEN}`, "Bearer other-token-value"] },
      }),
      (error) => {
        assert.equal(error.code, "E_WEB_UNAUTHENTICATED");
        return true;
      },
    );
  });

  test("an array of one credential is accepted, since Node hands it over verbatim", () => {
    assert.equal(extractBearerToken({ headers: { authorization: [`Bearer ${CALLER_TOKEN}`] } }), CALLER_TOKEN);
  });

  test("an over-long credential is refused before it is parsed", () => {
    assert.throws(
      () => extractBearerToken({ headers: { authorization: `Bearer ${"a".repeat(9000)}` } }),
      (error) => error.code === "E_WEB_UNAUTHENTICATED",
    );
  });

  test("a credential containing whitespace is not split into a shorter token", () => {
    assert.throws(
      () => extractBearerToken({ headers: { authorization: `Bearer ${CALLER_TOKEN} extra` } }),
      (error) => error.code === "E_WEB_UNAUTHENTICATED",
    );
  });

  test("a rejected token is 401 and the upstream body is never echoed", async () => {
    const upstream = {
      message: "invalid JWT: signature verification failed for " + SECRET_MARKERS.upstreamBody,
      hint: `token rejected at ${SECRET_MARKERS.upstreamHost}`,
      absolute: ABSOLUTE_PATH,
    };
    const { reader, transport } = readerWith(
      spyTransport((input) =>
        new URL(input).pathname === "/auth/v1/user"
          ? jsonResponse(401, upstream)
          : jsonResponse(200, []),
      ),
    );
    await assert.rejects(
      reader.resolveCaller({ method: "GET", headers: AUTH_HEADERS }),
      (error) => {
        assert.ok(error instanceof ControlPlaneReadError);
        assert.equal(error.status, 401);
        assert.equal(error.code, "E_WEB_UNAUTHENTICATED");
        for (const [name, marker] of Object.entries(SECRET_MARKERS)) {
          assert.ok(!error.message.includes(marker), `${name} leaked in: ${error.message}`);
        }
        assert.ok(!error.message.includes(CALLER_TOKEN));
        return true;
      },
    );
    // The body was received and dropped: one call, no table read attempted.
    assert.equal(transport.calls.length, 1);
    assert.ok(transport.calls[0].url.endsWith("/auth/v1/user"));
  });

  test("a 403 from the session endpoint is also 401, not a leak of upstream state", async () => {
    const { reader } = readerWith(
      spyTransport((input) =>
        new URL(input).pathname === "/auth/v1/user"
          ? jsonResponse(403, { message: "no such user " + SECRET_MARKERS.upstreamBody })
          : jsonResponse(200, []),
      ),
    );
    await assert.rejects(
      reader.resolveCaller({ method: "GET", headers: AUTH_HEADERS }),
      (error) => error.status === 401 && error.code === "E_WEB_UNAUTHENTICATED",
    );
  });

  test("a session endpoint that does not report a subject is a malformed upstream", async () => {
    for (const body of [{}, { id: "" }, { id: 42 }, { id: null }, { id: "u".repeat(400) }, []]) {
      const { reader } = readerWith(
        spyTransport((input) =>
          new URL(input).pathname === "/auth/v1/user" ? jsonResponse(200, body) : jsonResponse(200, []),
        ),
      );
      await assert.rejects(
        reader.resolveCaller({ method: "GET", headers: AUTH_HEADERS }),
        (error) => {
          assert.equal(error.status, 502);
          assert.equal(error.code, "E_WEB_READ_UPSTREAM_MALFORMED");
          return true;
        },
        `body ${JSON.stringify(body)} was accepted as a session`,
      );
    }
  });

  test("no resolved caller is cached across requests", async () => {
    // Two different tokens, two different subjects, resolved from the same reader.
    const transport = spyTransport((input) => {
      if (new URL(input).pathname !== "/auth/v1/user") return jsonResponse(200, []);
      const token = input && transport;
      void token;
      return jsonResponse(200, { id: transport.calls.length === 1 ? "user-a" : "user-b" });
    });
    const { reader } = readerWith(transport);
    const first = await reader.resolveCaller({ method: "GET", headers: AUTH_HEADERS });
    const second = await reader.resolveCaller({
      method: "GET",
      headers: { authorization: "Bearer second-session-token-value" },
    });
    assert.equal(first.subject, "user-a");
    assert.equal(second.subject, "user-b");
    assert.equal(first.token, CALLER_TOKEN);
    assert.equal(second.token, "second-session-token-value");
  });
});

/* -------------------------------------------------------------------------- */
/* The credential rule                                                         */
/* -------------------------------------------------------------------------- */

describe("the caller's own token is the only credential", () => {
  test("the reader options type has no field a privileged credential could occupy", () => {
    // Read the declared option names out of the source. If a future edit adds
    // `secretKey`, `serviceRole`, `token`, or `apikey`, this fails here rather
    // than passing unnoticed because a runtime object ignores unknown keys.
    const source = readFileSync(join(REPO_ROOT, "apps", "web", "server", "supabase-read.ts"), "utf8");
    const start = source.indexOf("export interface ControlPlaneReaderOptions {");
    assert.ok(start > 0, "ControlPlaneReaderOptions must be declared");
    // Slice to the closing brace of THIS interface, so the scan cannot pick up a
    // later interface's fields and fail for the wrong reason.
    const declared = source.slice(start, source.indexOf("\n}", start));
    assert.ok(declared.includes("transport"), "the slice must have reached the interface body");
    const fields = [...declared.matchAll(/readonly (\w+)\??:/g)].map((match) => match[1]);
    assert.deepEqual(fields.sort(), ["publishableKey", "supabaseUrl", "transport"]);
    for (const field of fields) {
      assert.doesNotMatch(
        field,
        /secret|service|role/i,
        `ControlPlaneReaderOptions.${field} could carry a privileged credential`,
      );
    }
  });

  test("the source names no privileged credential variable and sends only publishable key as apikey", () => {
    const source = readFileSync(join(REPO_ROOT, "apps", "web", "server", "supabase-read.ts"), "utf8");
    // `EGA_SUPABASE_SECRET_KEY` may appear in prose explaining why it is NOT used,
    // but never as a read. Strip comments before the assertion.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert.ok(
      !code.includes("EGA_SUPABASE_SECRET_KEY"),
      "supabase-read.ts must not reference the privileged credential outside a comment",
    );
    assert.ok(
      !/supabaseSecretKey/.test(code),
      "supabase-read.ts must not read ServerConfig.supabaseSecretKey",
    );
    assert.match(code, /apikey\s*:\s*key/, "supabase-read.ts must forward publishable key as apikey");
  });

  test("every recorded header carries accept, apikey, and the caller's own credential", async () => {
    const transport = spyTransport();
    const { reader } = readerWith(transport);
    const caller = await resolvedCaller(reader);
    await reader.readAsCaller(caller, "projects");
    assert.equal(transport.calls.length, 2);
    for (const call of transport.calls) {
      const names = Object.keys(call.headers).sort();
      assert.deepEqual(names, ["accept", "apikey", "authorization"]);
      assert.equal(call.headers["apikey"], FIXTURE_PUBLISHABLE_KEY);
      assert.equal(call.headers["authorization"], `Bearer ${CALLER_TOKEN}`);
      assert.equal(call.headers["accept"], "application/json");
    }
  });

  test("no configured secret appears in the URL the adapter builds", async () => {
    process.env.EGA_SUPABASE_SECRET_KEY = SERVICE_SECRET;
    try {
      const { createControlPlaneReader: create } = await import(
        "../../apps/web/server/supabase-read.ts"
      );
      const transport = spyTransport();
      const reader = create({ supabaseUrl: SUPABASE_URL, publishableKey: FIXTURE_PUBLISHABLE_KEY, transport });
      const caller = await resolvedCaller(reader);
      await reader.readAsCaller(caller, "workspace_memberships");
      for (const call of transport.calls) {
        assert.ok(!call.url.includes(SERVICE_SECRET), "a configured secret reached the URL");
        assert.ok(!call.headers["authorization"].includes(SERVICE_SECRET));
        assert.ok(!call.headers["apikey"].includes(SERVICE_SECRET));
      }
    } finally {
      delete process.env.EGA_SUPABASE_SECRET_KEY;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* GET only                                                                    */
/* -------------------------------------------------------------------------- */

describe("the surface is GET only", () => {
  test("every write verb is refused with 405 before the credential is read", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "get "]) {
      const { reader, transport } = readerWith(spyTransport());
      await assert.rejects(
        reader.resolveCaller({ method, headers: AUTH_HEADERS }),
        (error) => {
          assert.ok(error instanceof ControlPlaneReadError, `${method} was not refused`);
          assert.equal(error.status, 405);
          assert.equal(error.code, "E_WEB_READ_METHOD_NOT_ALLOWED");
          return true;
        },
        `${method} was accepted`,
      );
      // Refused before the network: a write verb must not probe the session.
      assert.equal(transport.calls.length, 0, `${method} reached the network`);
    }
  });

  test("an omitted method is accepted, because the router already rejected non-GET", async () => {
    // `server.mts` refuses a non-GET before it builds an `ApiRouteContext`, so the
    // adapter does not duplicate the check for the case where a caller omits it.
    const { reader } = readerWith(spyTransport());
    const caller = await reader.resolveCaller({ headers: AUTH_HEADERS });
    assert.equal(caller.subject, "user-a");
  });

  test("no route built on the seam can answer a write verb", async () => {
    const transport = spyTransport();
    const { reader } = readerWith(transport);
    const handler = createControlPlaneHandler(
      { maxResponseBytes: 4096, requestTimeoutMs: 1000, maxConcurrentRequests: 4 },
      () => ({ ok: true }),
      reader,
    );
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await assert.rejects(
        handler({
          method,
          pathname: "/workspace",
          query: new URLSearchParams(),
          params: {},
          request: { headers: AUTH_HEADERS },
        }),
        (error) => {
          assert.equal(error.status, 405);
          assert.equal(error.code, "E_METHOD_NOT_ALLOWED");
          return true;
        },
      );
    }
    assert.equal(transport.calls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The allow-list                                                              */
/* -------------------------------------------------------------------------- */

describe("only allow-listed tables and columns are readable", () => {
  test("the allow-list is exactly the eleven documented surfaces", () => {
    assert.deepEqual(CONTROL_PLANE_TABLE_NAMES, [
      "audit_events",
      "context_revocations",
      "hub_releases",
      "hub_stable_pointers",
      "hubs",
      "personal_workspaces",
      "project_contexts",
      "projects",
      "quota_policies",
      "quota_usage",
      "security_denies",
      "workspace_memberships",
    ]);
  });

  test("the four deliberately absent tables are refused", () => {
    // These exist, have RLS, and are readable by an admin. They are absent from
    // the console's allow-list on purpose, and the refusal must be the adapter's
    // rather than RLS's.
    for (const table of [
      "immutable_objects",
      "hub_release_artifacts",
      "source_credentials",
      "public_hub_publications",
    ]) {
      assert.throws(
        () => assertTableAllowed(table),
        (error) => {
          assert.equal(error.code, "E_WEB_READ_TABLE_NOT_ALLOWED");
          assert.equal(error.status, 400);
          return true;
        },
        `${table} must not be allow-listed`,
      );
    }
  });

  test("an inherited Object property is not mistaken for a table", () => {
    for (const table of ["constructor", "toString", "__proto__", "hasOwnProperty", "toJSON"]) {
      assert.throws(
        () => assertTableAllowed(table),
        (error) => error.code === "E_WEB_READ_TABLE_NOT_ALLOWED",
        `${table} resolved to a spec`,
      );
    }
  });

  test("a refused table never reaches the network", async () => {
    const transport = spyTransport();
    const { reader } = readerWith(transport);
    const caller = await resolvedCaller(reader);
    await assert.rejects(reader.readAsCaller(caller, "source_credentials"), (error) => {
      assert.equal(error.code, "E_WEB_READ_TABLE_NOT_ALLOWED");
      return true;
    });
    assert.equal(transport.calls.length, 1, "only the session probe should have happened");
  });

  test("a column outside the allow-list is refused even on an allow-listed table", () => {
    // `workspace_memberships` projects exactly five columns; each of these is
    // either a column of a *different* table or a name no table has.
    for (const column of [
      "secret_reference",
      "workspace_id_x",
      "owner_subject",
      "visibility",
      "context_digest",
      "*",
      "workspace_id,secret",
    ]) {
      assert.throws(
        () => planControlPlaneRead("workspace_memberships", { columns: ["workspace_id", column] }),
        (error) => {
          assert.equal(error.code, "E_WEB_READ_COLUMN_NOT_ALLOWED");
          return true;
        },
        `${column} was projected`,
      );
    }
  });

  test("a filter column that is not filterable is refused", () => {
    // `security_denies.identity` is projectable but deliberately not filterable:
    // it is free text, so filtering on it would need PostgREST syntax the adapter
    // does not implement.
    assert.throws(
      () =>
        planControlPlaneRead("security_denies", {
          filters: [{ column: "identity", values: ["anything"] }],
        }),
      (error) => error.code === "E_WEB_READ_FILTER_NOT_ALLOWED",
    );
    // `created_at` is not filterable on any table: an ordering/range filter would
    // need `gte`/`lt` operators, which this adapter does not build.
    assert.throws(
      () =>
        planControlPlaneRead("projects", { filters: [{ column: "created_at", values: ["2026-01-01"] }] }),
      (error) => error.code === "E_WEB_READ_FILTER_NOT_ALLOWED",
    );
  });

  test("a filter value is pattern-checked against its declared kind", () => {
    const refused = [
      ["projects", "workspace_id", "not-a-uuid"],
      ["projects", "workspace_id", "00000000-0000-4000-8000-0000000000a1' or '1'='1"],
      ["hub_releases", "release_digest", "sha256:short"],
      ["hub_releases", "release_digest", "SHA256:" + "A".repeat(64)],
      ["workspace_memberships", "role", "superuser"],
      ["security_denies", "kind", "everything"],
      ["hubs", "visibility", "public,private"],
      ["workspace_memberships", "active", "1"],
      ["workspace_memberships", "subject", "user-a,user-b"],
      ["workspace_memberships", "subject", "user a"],
      ["workspace_memberships", "subject", "in.(user-a,user-b)"],
      ["audit_events", "operation", "publish_context; drop table audit_events"],
    ];
    for (const [table, column, value] of refused) {
      assert.throws(
        () => planControlPlaneRead(table, { filters: [{ column, values: [value] }] }),
        (error) => {
          assert.equal(
            error.code,
            "E_WEB_READ_FILTER_INVALID",
            `${table}.${column} accepted ${JSON.stringify(value)}`,
          );
          return true;
        },
        `${table}.${column}=${JSON.stringify(value)} was accepted`,
      );
    }
  });

  test("a well-formed value of each kind is accepted", () => {
    const accepted = [
      ["projects", "workspace_id", "00000000-0000-4000-8000-0000000000a1"],
      ["hub_releases", "release_digest", `sha256:${"1".repeat(64)}`],
      ["workspace_memberships", "role", "viewer"],
      ["security_denies", "kind", "blob"],
      ["hubs", "visibility", "workspace"],
      ["workspace_memberships", "active", "false"],
      ["workspace_memberships", "subject", "user-a"],
      ["audit_events", "result", "allowed"],
    ];
    for (const [table, column, value] of accepted) {
      const plan = planControlPlaneRead(table, { filters: [{ column, values: [value] }] });
      assert.deepEqual(plan.filters, [{ column, values: [value] }]);
    }
  });

  test("too many filters, an empty value list, and a repeated column are refused", () => {
    assert.throws(
      () =>
        planControlPlaneRead("workspace_memberships", {
          filters: [
            { column: "workspace_id", values: ["00000000-0000-4000-8000-0000000000a1"] },
            { column: "subject", values: ["user-a"] },
            { column: "role", values: ["owner"] },
            { column: "active", values: ["true"] },
            { column: "workspace_id", values: ["00000000-0000-4000-8000-0000000000b1"] },
          ],
        }),
      (error) => error.code === "E_WEB_READ_FILTER_NOT_ALLOWED",
    );
    assert.throws(
      () => planControlPlaneRead("projects", { filters: [{ column: "workspace_id", values: [] }] }),
      (error) => error.code === "E_WEB_READ_FILTER_INVALID",
    );
    assert.throws(
      () =>
        planControlPlaneRead("workspace_memberships", {
          filters: [
            { column: "subject", values: ["user-a"] },
            { column: "subject", values: ["user-b"] },
          ],
        }),
      (error) => error.code === "E_WEB_READ_FILTER_NOT_ALLOWED",
    );
  });

  test("too many values for one filter is refused rather than truncated", () => {
    const values = Array.from({ length: 21 }, (_, index) => `user-${index}`);
    assert.throws(
      () => planControlPlaneRead("workspace_memberships", { filters: [{ column: "subject", values }] }),
      (error) => {
        assert.equal(error.code, "E_WEB_READ_FILTER_INVALID");
        return true;
      },
    );
  });

  test("the allow-list is deep-frozen, so a runtime mutation cannot widen it", () => {
    assert.throws(() => {
      CONTROL_PLANE_TABLES["projects"].columns.push("secret");
    });
    assert.throws(() => {
      CONTROL_PLANE_TABLES["projects"].filterable["secret_reference"] = { kind: "uuid" };
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

describe("reads are bounded rather than truncated", () => {
  test("an absent, zero, negative, fractional, or oversized limit is refused", () => {
    for (const limit of [0, -1, 1.5, CONTROL_PLANE_MAX_LIMIT + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => planControlPlaneRead("projects", { limit }),
        (error) => {
          assert.equal(error.code, "E_WEB_READ_LIMIT_INVALID", `limit ${limit} was accepted`);
          assert.equal(error.status, 400);
          return true;
        },
        `limit ${limit} was accepted`,
      );
    }
    assert.equal(planControlPlaneRead("projects", {}).limit, CONTROL_PLANE_DEFAULT_LIMIT);
    assert.equal(planControlPlaneRead("projects", { limit: 1 }).limit, 1);
    assert.equal(planControlPlaneRead("projects", { limit: CONTROL_PLANE_MAX_LIMIT }).limit, CONTROL_PLANE_MAX_LIMIT);
  });

  test("an out-of-range offset is refused", () => {
    for (const offset of [-1, 1.5, CONTROL_PLANE_MAX_OFFSET + 1, Number.NaN]) {
      assert.throws(
        () => planControlPlaneRead("projects", { offset }),
        (error) => error.code === "E_WEB_READ_OFFSET_INVALID",
        `offset ${offset} was accepted`,
      );
    }
  });

  test("the URL always carries an explicit limit", () => {
    const base = new URL(SUPABASE_URL);
    const url = new URL(buildControlPlaneUrl(base, planControlPlaneRead("projects", {})));
    assert.equal(url.searchParams.get("limit"), String(CONTROL_PLANE_DEFAULT_LIMIT));
    assert.equal(url.searchParams.get("offset"), null, "a zero offset is not sent at all");
    const offset = new URL(
      buildControlPlaneUrl(base, planControlPlaneRead("projects", { offset: 200 })),
    );
    assert.equal(offset.searchParams.get("offset"), "200");
  });

  test("an upstream that returns more rows than the limit is refused, not trimmed", async () => {
    const transport = spyTransport((input) =>
      new URL(input).pathname === "/auth/v1/user"
        ? jsonResponse(200, { id: "user-a" })
        : jsonResponse(200, [{ id: "a" }, { id: "b" }, { id: "c" }]),
    );
    const { reader } = readerWith(transport);
    const caller = await resolvedCaller(reader);
    await assert.rejects(reader.readAsCaller(caller, "projects", { limit: 2 }), (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.code, "E_WEB_READ_UPSTREAM_MALFORMED");
      return true;
    });
  });

  test("a projection that is empty or wider than the allow-list is refused", () => {
    assert.throws(
      () => planControlPlaneRead("projects", { columns: [] }),
      (error) => error.code === "E_WEB_READ_PROJECTION_INVALID",
    );
    // `projects` allows four columns; five entries is refused before any of them
    // is checked, so a caller cannot use an oversized projection to probe which
    // names are valid.
    assert.throws(
      () => planControlPlaneRead("projects", { columns: ["id", "name", "workspace_id", "created_at", "extra"] }),
      (error) => error.code === "E_WEB_READ_PROJECTION_INVALID",
    );
  });

  test("a repeated projection column is de-duplicated rather than sent twice", () => {
    assert.deepEqual(
      planControlPlaneRead("projects", { columns: ["id", "name", "id"] }).columns,
      ["id", "name"],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* URL assembly                                                                */
/* -------------------------------------------------------------------------- */

describe("the assembled query is parameterized, not interpolated", () => {
  test("filters render as eq/in and a caller value cannot escape the query", () => {
    const base = new URL(SUPABASE_URL);
    const single = new URL(
      buildControlPlaneUrl(
        base,
        planControlPlaneRead("projects", {
          filters: [{ column: "workspace_id", values: ["00000000-0000-4000-8000-0000000000a1"] }],
        }),
      ),
    );
    assert.equal(single.pathname, "/rest/v1/projects");
    assert.equal(single.searchParams.get("workspace_id"), "eq.00000000-0000-4000-8000-0000000000a1");
    assert.equal(single.searchParams.get("select"), "id,workspace_id,name,created_at");

    const many = new URL(
      buildControlPlaneUrl(
        base,
        planControlPlaneRead("workspace_memberships", {
          filters: [{ column: "subject", values: ["user-a", "user-b"] }],
        }),
      ),
    );
    assert.equal(many.searchParams.get("subject"), "in.(user-a,user-b)");
  });

  test("the only un-validated inputs that reach a URL are allow-listed names", () => {
    // Every caller-supplied string in this adapter passes a validator. This test
    // proves the validator is not decorative by feeding it something that would
    // be catastrophic as raw PostgREST syntax and showing it never reaches a URL.
    const { reader, transport } = readerWith(spyTransport());
    const caller = { subject: "user-a", token: CALLER_TOKEN };
    return (async () => {
      for (const value of ["or.(workspace_id.eq.x)", "not.is.null", "*", "1", "true) or (1=1"]) {
        await assert.rejects(
          reader.readAsCaller(caller, "projects", {
            filters: [{ column: "workspace_id", values: [value] }],
          }),
          (error) => error.code === "E_WEB_READ_FILTER_INVALID",
        );
      }
      assert.equal(transport.calls.length, 0, "a refused value produced a request");
    })();
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-closed configuration                                                   */
/* -------------------------------------------------------------------------- */

describe("an unconfigured or unreachable control plane is unavailable with a reason", () => {
  test("an unconfigured Supabase publishable key is a 503 naming the variable", async () => {
    const transport = spyTransport();
    const reader = createControlPlaneReader({ supabaseUrl: SUPABASE_URL, publishableKey: null, transport });
    assert.match(reader.describeAvailability(), /EGA_SUPABASE_PUBLISHABLE_KEY/);
    const caller = Object.freeze({ subject: "user-a", token: CALLER_TOKEN });
    const error = await reader.readAsCaller(caller, "projects").then(() => null, (c) => c);
    assert.ok(error instanceof ControlPlaneReadError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "E_WEB_READ_UNAVAILABLE");
    assert.match(error.message, /EGA_SUPABASE_PUBLISHABLE_KEY/);
    assert.equal(transport.calls.length, 0);
  });

  test("a privileged secret key is rejected as publishableKey", async () => {
    const transport = spyTransport();
    const reader = createControlPlaneReader({
      supabaseUrl: SUPABASE_URL,
      publishableKey: "sb_secret_never-forward-this",
      transport,
    });
    const caller = Object.freeze({ subject: "user-a", token: CALLER_TOKEN });
    const error = await reader.readAsCaller(caller, "projects").then(() => null, (c) => c);
    assert.ok(error instanceof ControlPlaneReadError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "E_WEB_READ_UNAVAILABLE");
    assert.match(error.message, /privileged (?:secret|<redacted>)/);
    assert.equal(transport.calls.length, 0);
  });

  test("an unconfigured Supabase is a 503 naming the variable, never an empty list", async () => {
    const transport = spyTransport();
    const reader = createControlPlaneReader({ supabaseUrl: null, transport });
    assert.match(reader.describeAvailability(), /EGA_SUPABASE_URL/);
    for (const attempt of [
      () => reader.resolveCaller({ method: "GET", headers: AUTH_HEADERS }),
      async () => {
        const caller = Object.freeze({ subject: "user-a", token: CALLER_TOKEN });
        return reader.readAsCaller(caller, "projects");
      },
    ]) {
      const error = await attempt().then(
        () => null,
        (cause) => cause,
      );
      assert.ok(error instanceof ControlPlaneReadError, "an unconfigured read resolved");
      assert.equal(error.status, 503);
      assert.equal(error.code, "E_WEB_READ_UNAVAILABLE");
      assert.match(error.message, /EGA_SUPABASE_URL/);
      assert.ok(Array.isArray(error.message) === false);
    }
    assert.equal(transport.calls.length, 0);
  });

  test("a non-HTTPS, malformed, or credential-bearing Supabase URL is refused", () => {
    for (const url of [
      "http://insecure.supabase.co",
      "ftp://x.supabase.co",
      "file:///etc/passwd",
      "not a url",
      "://missing-scheme.supabase.co",
      "https://user:pw@x.supabase.co",
      "https://pw@x.supabase.co",
    ]) {
      assert.throws(
        () => createControlPlaneReader({ supabaseUrl: url, transport: spyTransport() }),
        (error) => {
          assert.ok(error instanceof ControlPlaneReadError, `${url} was accepted`);
          assert.equal(error.status, 503);
          assert.equal(error.code, "E_WEB_READ_UNAVAILABLE");
          assert.ok(!error.message.includes("pw"), "userinfo from the URL was echoed");
          assert.ok(!error.message.includes("insecure"), "the rejected URL was echoed");
          return true;
        },
        `${url} was accepted`,
      );
    }
  });

  test("a transport failure is a 503 that does not carry the cause's message", async () => {
    const { reader } = readerWith(async () => {
      throw new Error(`connect ECONNREFUSED ${SECRET_MARKERS.upstreamHost}${ABSOLUTE_PATH}`);
    });
    await assert.rejects(
      reader.readAsCaller(Object.freeze({ subject: "user-a", token: CALLER_TOKEN }), "projects"),
      (error) => {
        assert.equal(error.status, 503);
        for (const marker of Object.values(SECRET_MARKERS)) {
          assert.ok(!error.message.includes(marker), `leaked ${marker}`);
        }
        return true;
      },
    );
  });

  test("a table that this deployment does not expose is unavailable, not absent", async () => {
    const { reader } = readerWith(
      spyTransport((input) =>
        new URL(input).pathname === "/auth/v1/user"
          ? jsonResponse(200, { id: "user-a" })
          : jsonResponse(404, { message: SECRET_MARKERS.upstreamBody, hint: ABSOLUTE_PATH }),
      ),
    );
    const caller = await resolvedCaller(reader);
    await assert.rejects(reader.readAsCaller(caller, "projects"), (error) => {
      assert.equal(error.status, 503);
      assert.ok(!error.message.includes(SECRET_MARKERS.upstreamBody));
      return true;
    });
  });

  test("an upstream error body is never surfaced", async () => {
    const body = { message: "db error at " + ABSOLUTE_PATH, detail: SECRET_MARKERS.upstreamBody, code: "42P01" };
    for (const status of [400, 409, 500, 502, 503]) {
      const { reader } = readerWith(
        spyTransport((input) =>
          new URL(input).pathname === "/auth/v1/user"
            ? jsonResponse(200, { id: "user-a" })
            : jsonResponse(status, body),
        ),
      );
      const caller = await resolvedCaller(reader);
      await assert.rejects(reader.readAsCaller(caller, "projects"), (error) => {
        assert.ok(error.status === 502 || error.status === 503, `status ${status} mapped oddly`);
        for (const marker of Object.values(SECRET_MARKERS)) {
          assert.ok(!error.message.includes(marker), `status ${status} leaked ${marker}`);
        }
        return true;
      });
    }
  });

  test("a non-array or non-object-row upstream body is refused rather than coerced", async () => {
    for (const body of [null, {}, "[]", 42, [null], [["a"]], [42]]) {
      const { reader } = readerWith(
        spyTransport((input) =>
          new URL(input).pathname === "/auth/v1/user"
            ? jsonResponse(200, { id: "user-a" })
            : jsonResponse(200, body),
        ),
      );
      const caller = await resolvedCaller(reader);
      await assert.rejects(
        reader.readAsCaller(caller, "projects"),
        (error) => error.code === "E_WEB_READ_UPSTREAM_MALFORMED",
        `body ${JSON.stringify(body)} was accepted as rows`,
      );
    }
  });

  test("an unreadable body is refused, not treated as no rows", async () => {
    const { reader } = readerWith((input) => {
      if (new URL(input).pathname === "/auth/v1/user") return jsonResponse(200, { id: "user-a" });
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`unexpected token in ${ABSOLUTE_PATH}`);
        },
      };
    });
    const caller = await resolvedCaller(reader);
    await assert.rejects(reader.readAsCaller(caller, "projects"), (error) => {
      assert.equal(error.code, "E_WEB_READ_UPSTREAM_MALFORMED");
      assert.ok(!error.message.includes(ABSOLUTE_PATH));
      return true;
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Message hygiene                                                             */
/* -------------------------------------------------------------------------- */

describe("no message carries a secret, a token, a credential, or a path", () => {
  test("sanitizeReadMessage strips each structural form", () => {
    const cases = [
      `token is ${CALLER_TOKEN}`,
      `Authorization: Bearer ${CALLER_TOKEN}`,
      `apikey=${SERVICE_SECRET}`,
      `secret: ${SERVICE_SECRET}`,
      `postgres://ega:hunter2@db.internal:5432/ega`,
      `failed reading ${ABSOLUTE_PATH}`,
      `failed reading C:\\deploy\\console\\artifact`,
    ];
    for (const message of cases) {
      const sanitized = sanitizeReadMessage(message);
      for (const marker of Object.values(SECRET_MARKERS)) {
        assert.ok(!sanitized.includes(marker), `${marker} survived: ${sanitized}`);
      }
      assert.ok(!sanitized.includes(CALLER_TOKEN), "a token survived");
      assert.ok(!sanitized.includes("hunter2"), "a URL password survived");
    }
  });

  test("sanitizeReadMessage is idempotent and length-capped", () => {
    const once = sanitizeReadMessage(`token ${CALLER_TOKEN}`);
    assert.equal(sanitizeReadMessage(once), once);
    assert.ok(sanitizeReadMessage("x".repeat(2000)).length <= 512);
  });

  test("every refusal the adapter raises is sanitized at the throw site", async () => {
    // Drive a range of refusals and check the message, not just the code.
    const attempts = [
      createControlPlaneReader({ supabaseUrl: null, transport: spyTransport() }).resolveCaller({
        method: "GET",
        headers: AUTH_HEADERS,
      }),
      createControlPlaneReader({ supabaseUrl: SUPABASE_URL, publishableKey: FIXTURE_PUBLISHABLE_KEY, transport: spyTransport() }).resolveCaller({
        method: "GET",
        headers: { authorization: "Basic " + SECRET_MARKERS.secret },
      }),
      createControlPlaneReader({
        supabaseUrl: SUPABASE_URL,
        publishableKey: FIXTURE_PUBLISHABLE_KEY,
        transport: spyTransport((input) =>
          new URL(input).pathname === "/auth/v1/user"
            ? jsonResponse(401, { message: SECRET_MARKERS.upstreamBody })
            : jsonResponse(200, []),
        ),
      }).resolveCaller({ method: "GET", headers: AUTH_HEADERS }),
    ];
    for (const attempt of attempts) {
      const error = await attempt.then(() => null, (cause) => cause);
      assert.ok(error instanceof ControlPlaneReadError);
      for (const marker of Object.values(SECRET_MARKERS)) {
        assert.ok(!error.message.includes(marker), `${marker} leaked in ${error.message}`);
      }
    }
  });

  test("a refused table name cannot smuggle a path or a query into the message", () => {
    assert.throws(
      () => assertTableAllowed(`${ABSOLUTE_PATH}?select=*`),
      (error) => {
        assert.ok(!error.message.includes(ABSOLUTE_PATH));
        assert.match(error.message, /<redacted-path>/);
        return true;
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The route seam                                                              */
/* -------------------------------------------------------------------------- */

describe("the control-plane route seam", () => {
  const bounds = { maxResponseBytes: 4096, requestTimeoutMs: 1000, maxConcurrentRequests: 4 };

  test("a route refuses an unauthenticated request before its handler runs", async () => {
    let ran = false;
    const transport = spyTransport();
    const { reader } = readerWith(transport);
    const handler = createControlPlaneHandler(
      bounds,
      () => {
        ran = true;
        return {};
      },
      reader,
    );
    const error = await handler({
      method: "GET",
      pathname: "/workspace/members",
      query: new URLSearchParams(),
      params: {},
      request: { headers: {} },
    }).then(() => null, (cause) => cause);
    assert.ok(error instanceof Error);
    assert.equal(error.status, 401);
    assert.equal(error.code, "E_WEB_UNAUTHENTICATED");
    assert.equal(ran, false, "the handler ran without a caller");
    assert.equal(transport.calls.length, 0);
  });

  test("a route hands its handler the verified caller and the reader", async () => {
    const transport = spyTransport((input) =>
      new URL(input).pathname === "/auth/v1/user"
        ? jsonResponse(200, { id: "user-b" })
        : jsonResponse(200, [{ id: "00000000-0000-4000-8000-0000000000b1" }]),
    );
    const { reader } = readerWith(transport);
    let seen = null;
    const handler = createControlPlaneHandler(
      bounds,
      async (context, caller, handed) => {
        seen = { caller, handed, path: context.pathname };
        return await handed.readAsCaller(caller, "projects");
      },
      reader,
    );
    const body = await handler({
      method: "GET",
      pathname: "/projects",
      query: new URLSearchParams(),
      params: {},
      request: { headers: AUTH_HEADERS },
    });
    assert.equal(seen.caller.subject, "user-b");
    assert.equal(seen.caller.token, CALLER_TOKEN);
    assert.equal(seen.handed, reader);
    assert.equal(seen.path, "/projects");
    assert.equal(body.length, 1);
  });

  test("an adapter error is translated to its own status and code, not a generic 503", async () => {
    const transport = spyTransport();
    const { reader } = readerWith(transport);
    const handler = createControlPlaneHandler(
      bounds,
      async (context, caller, handed) => handed.readAsCaller(caller, "source_credentials"),
      reader,
    );
    const error = await handler({
      method: "GET",
      pathname: "/workspace/security",
      query: new URLSearchParams(),
      params: {},
      request: { headers: AUTH_HEADERS },
    }).then(() => null, (cause) => cause);
    assert.equal(error.status, 400);
    assert.equal(error.code, "E_WEB_READ_TABLE_NOT_ALLOWED");
  });

  test("toControlPlaneApiError preserves 401 and marks 503 as a control-plane fact", () => {
    const unauthorized = toControlPlaneApiError(
      new ControlPlaneReadError(401, "E_WEB_UNAUTHENTICATED", "no session"),
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.code, "E_WEB_UNAUTHENTICATED");

    const unavailable = toControlPlaneApiError(
      new ControlPlaneReadError(503, "E_WEB_READ_UNAVAILABLE", "EGA_SUPABASE_URL is not configured"),
    );
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.message, /Control-plane data is unavailable/);
    assert.match(unavailable.message, /EGA_SUPABASE_URL/);
  });

  test("the security headers a control-plane response must carry are exported", () => {
    // Same values `server.mts` sends on every API response, so a control-plane
    // route cannot answer without them by accident.
    assert.equal(CONTROL_PLANE_SECURITY_HEADERS["x-content-type-options"], "nosniff");
    assert.equal(CONTROL_PLANE_SECURITY_HEADERS["x-frame-options"], "DENY");
    assert.equal(CONTROL_PLANE_SECURITY_HEADERS["referrer-policy"], "no-referrer");
    // Control-plane rows are per-caller; a cache that keyed on URL alone would
    // serve one member another's workspace.
    assert.equal(CONTROL_PLANE_SECURITY_HEADERS["cache-control"], "no-store");
  });
});