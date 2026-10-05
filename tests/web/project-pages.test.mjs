/**
 * Projects and pinned contexts: route coverage and the page contract, no database
 * required.
 *
 * ## What this suite proves
 *
 * `apps/web/server/projects.ts` is the only place in this console where a
 * **release digest an operator must be able to trust verbatim** is assembled from
 * a database row. The failures this suite exists to catch are therefore not
 * "wrong SQL" but five specific wrong *answers*:
 *
 * 1. **A pin that was quietly swapped for the served release.** A context pins an
 *    exact `release_digest`; substituting whatever the deployment currently serves
 *    would be a plausible-looking lie. Asserted three ways: the pin equals the
 *    stored value, the served digest lives in its own field and never in
 *    `release_digest`, and a pin this deployment cannot resolve is reported as
 *    `not-resolvable` rather than as the served digest.
 * 2. **A zero that was never measured.** `projects` and `project_contexts` have no
 *    writer in this checkout, so an empty table is the normal state of every real
 *    deployment. The headline assertion is that an empty read produces the server's
 *    stated empty reason and never a metric: no `0 contexts`, no "no contexts" claim.
 * 3. **A pin reported as something it is not.** A revoked context whose digest was
 *    replaced, or a malformed `release_digest` rendered as a pin. The first is
 *    asserted to keep its digest verbatim; the second is asserted to be refused.
 * 4. **A privileged credential.** Every recorded header set is checked to be
 *    exactly `["accept", "authorization"]`, with the caller's own token, and
 *    `EGA_SUPABASE_SECRET_KEY` is both set in the environment and asserted absent
 *    from every URL and header.
 * 5. **A silent truncation.** Every read carries an explicit bounded limit, an
 *    oversized caller `limit` is refused rather than clamped, and a read that
 *    reaches its ceiling refuses the response rather than reporting a floor as an
 *    exact count.
 *
 * ## The fixture transport is a spy, and it is checked as one
 *
 * Every test drives `createProjectRoutes({ reader })` with a reader bound to a
 * recording transport. A spy is only useful if it is really observing the
 * adapter, so the suite asserts the URLs and headers that were actually built, and
 * asserts that **no read reached the transport at all** for a refusal that should
 * have happened first. Without that, a test could pass with a transport that was
 * never called.
 *
 * The fixture applies the request's own `eq.` / `in.(...)` filters to the rows it
 * was configured with. That is what makes "an id is a filter, not a capability"
 * testable: another workspace's id is present in the fixture, so a passing test
 * proves the *filter* emptied the result, not that the fixture was empty.
 *
 * ## Why the page assertions are static
 *
 * `node --test` cannot import a `.tsx` module: Node's native type stripping has no
 * JSX support (`ERR_UNKNOWN_FILE_EXTENSION`), and `typescript@7` in this
 * repository no longer exports `transpileModule`, so there is no in-repo
 * transpiler to add. The two page files are therefore read and asserted
 * structurally — no mutation control, the pin rendered unshortened and selectable,
 * the three envelope-only digests absent, and the server-provided empty reasons
 * wired straight into `EmptyState`. Every logic decision the pages make about
 * *data* lives in the server module and is executed above; the page tests guard the
 * wiring, not a second copy of the logic.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  CONTROL_PLANE_MAX_LIMIT,
  createControlPlaneReader,
} from "../../apps/web/server/supabase-read.ts";
import {
  CONTEXT_POLICY_NOTE,
  CONTEXTS_EMPTY_REASON,
  PROJECTS_PAGE_DEFAULT_LIMIT,
  PROJECTS_PAGE_MAX_LIMIT,
  PROJECT_NOT_VISIBLE_CODE,
  PROJECT_PAGE_INCOMPLETE_CODE,
  PROJECT_ROW_MALFORMED_CODE,
  REVOCATIONS_EMPTY_REASON,
  createProjectRoutes,
  describePinnedRelease,
  projectRoutes,
} from "../../apps/web/server/projects.ts";
import { API_ENDPOINTS } from "../../apps/web/src/api/client.ts";
import { describeApiError, isUnavailableError } from "../../apps/web/src/api/contracts.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SUPABASE_URL = "https://console-fixture.supabase.co";

/** A syntactically plausible but entirely fictional session token. */
const CALLER_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLWEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.not-a-real-signature-part";

/** The service credential that must never be used. Never a real value. */
const SERVICE_SECRET = "b4-fixture-privileged-supabase-secret-value";
const ABSOLUTE_PATH = "/srv/app/supabase-project/secret-notes.txt";

/** Values that must never reach a response body or an error message. */
const SECRET_MARKERS = Object.freeze({
  secret: SERVICE_SECRET,
  path: ABSOLUTE_PATH,
  upstreamBody: "upstream-body-must-not-be-echoed",
  upstreamHost: "internal-postgrest.fixture.invalid",
  password: "hunter2",
});

const AUTH_HEADERS = { authorization: `Bearer ${CALLER_TOKEN}` };

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTEXT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTEXT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Canonical digest form, built from a single repeated hex character. */
const digestOf = (seed) => `sha256:${seed.repeat(64)}`;
const PIN_OLD = digestOf("a");
const PIN_NEW = digestOf("b");
const PIN_OTHER = digestOf("c");
const CONTEXT_DIGEST_A = digestOf("1");
const CONTEXT_DIGEST_B = digestOf("2");

/** Envelope-only digests. They exist nowhere in the console's response. */
const FORBIDDEN_DIGEST_KEYS = Object.freeze([
  "config_digest",
  "lock_digest",
  "fingerprint_digest",
]);

/* -------------------------------------------------------------------------- */
/* Fixture rows                                                                 */
/* -------------------------------------------------------------------------- */

function projectRow(id, workspaceId, name, createdAt = "2026-01-04T09:00:00+00:00") {
  return { id, workspace_id: workspaceId, name, created_at: createdAt };
}

function contextRow(id, projectId, releaseDigest, extra = {}) {
  return {
    id,
    project_id: projectId,
    context_digest: CONTEXT_DIGEST_A,
    release_digest: releaseDigest,
    revoked_at: null,
    published_at: "2026-02-01T10:00:00+00:00",
    ...extra,
  };
}

function revocationRow(
  contextId,
  reason,
  revokedBy = "owner-subject-a",
  revokedAt = "2026-03-04T11:22:33+00:00",
) {
  return { context_id: contextId, reason, revoked_by: revokedBy, revoked_at: revokedAt };
}

/* -------------------------------------------------------------------------- */
/* Fixture transport                                                            */
/* -------------------------------------------------------------------------- */

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Build a recording transport that behaves like PostgREST plus RLS.
 *
 * `tables` holds the rows RLS admits for this caller. Filters on the request are
 * then applied on top, so a caller-supplied id genuinely selects rows.
 */
function spyTransport(options = {}) {
  const tables = options["tables"] ?? {};
  const sessionStatus = options["sessionStatus"] ?? 200;
  const tableStatus = options["tableStatus"] ?? {};
  const upstreamBody = options["upstreamBody"] ?? SECRET_MARKERS.upstreamBody;

  const calls = [];
  const transport = async (input, init) => {
    calls.push({ url: input, method: init.method, headers: init.headers });
    const parsed = new URL(input);
    if (parsed.pathname === "/auth/v1/user") {
      return sessionStatus !== 200
        ? jsonResponse(sessionStatus, upstreamBody)
        : jsonResponse(200, { id: "user-a", role: "authenticated" });
    }
    const table = parsed.pathname.replace("/rest/v1/", "");
    const forced = tableStatus[table];
    if (forced !== undefined) return jsonResponse(forced, upstreamBody);

    let rows = [...(tables[table] ?? [])];
    for (const [column, raw] of parsed.searchParams) {
      if (column === "select" || column === "limit" || column === "offset") continue;
      const values = raw.startsWith("eq.")
        ? [raw.slice(3)]
        : raw.startsWith("in.(")
          ? raw.slice(4, -1).split(",")
          : null;
      if (values === null) continue;
      rows = rows.filter((row) => values.includes(String(row[column])));
    }
    // The adapter refuses an upstream that ignores the limit; reproduce that so a
    // test cannot pass by accident on an unbounded fixture.
    const limit = Number(parsed.searchParams.get("limit") ?? "50");
    return jsonResponse(200, rows.slice(0, limit));
  };
  transport.calls = calls;
  // A getter, not a snapshot: `calls` fills in as the route runs, so a test that
  // inspected it after construction would always see zero reads and pass for the
  // wrong reason.
  Object.defineProperty(transport, "tables", {
    get: () => calls.filter((call) => !new URL(call.url).pathname.endsWith("/auth/v1/user")),
  });
  return transport;
}

/** Assert that no table was read, ignoring the session probe. */
function assertNoTableRead(transport, message) {
  assert.equal(transport.tables.length, 0, message);
}

const BOUNDS = Object.freeze({
  maxResponseBytes: 4 * 1_048_576,
  requestTimeoutMs: 10_000,
  maxConcurrentRequests: 8,
});

/** Routes bound to `transport`, built exactly the way production builds them. */
function routesFor(transport, supabaseUrl = SUPABASE_URL) {
  return createProjectRoutes({
    reader: createControlPlaneReader({ supabaseUrl, transport }),
    bounds: BOUNDS,
  });
}

/** Invoke one route and capture either its body or its typed failure. */
async function call(routes, id, init = {}) {
  const route = routes.find((entry) => entry.id === id);
  assert.ok(route !== undefined, `route ${id} is not registered`);
  const context = {
    method: init.method ?? "GET",
    pathname: route.path,
    query: init.query ?? new URLSearchParams(),
    params: init.params ?? {},
    request: { headers: init.headers ?? AUTH_HEADERS },
  };
  return route.handle(context).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

const listRoute = (routes, init) => call(routes, "projects", init);
const detailRoute = (routes, init) => call(routes, "project-detail", init);
const detailFor = (routes, projectId = PROJECT_A, init = {}) =>
  detailRoute(routes, { ...init, params: { projectId } });

/** Every string reachable in a response, for leak scans. */
function collectStrings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, found);
  else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectStrings(entry, found);
  }
  return found;
}

/** Strip block and line comments, so a scan sees code rather than prose. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every object key reachable in a response, for forbidden-name scans. */
function collectKeys(value, found = new Set()) {
  if (Array.isArray(value)) for (const entry of value) collectKeys(entry, found);
  else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      collectKeys(entry, found);
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                 */
/* -------------------------------------------------------------------------- */

describe("the two routes exist, are GET-only, and match the client contract", () => {
  test("the exported route table matches API_ENDPOINTS", () => {
    assert.deepEqual(
      projectRoutes.map((route) => [route.id, route.path]),
      [
        ["projects", "/projects"],
        ["project-detail", "/projects/:projectId"],
      ],
    );
    assert.equal(API_ENDPOINTS.projects, "/projects");
    assert.equal(API_ENDPOINTS.project(PROJECT_A), `/projects/${PROJECT_A}`);
  });

  test("every route is registered through the seam and answers GET alone", async () => {
    for (const route of projectRoutes) {
      assert.deepEqual([...route.methods], ["GET"], `${route.id} must be GET-only`);
    }
    const transport = spyTransport({ tables: {} });
    const routes = routesFor(transport);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const result = await listRoute(routes, { method });
      assert.equal(result.ok, false, `${method} was served`);
      assert.equal(result.error.status, 405);
      assert.equal(result.error.code, "E_METHOD_NOT_ALLOWED");
    }
    assert.equal(transport.calls.length, 0, "a write verb reached the transport");
  });

  test("the table allow-list is asserted at registration, so a typo is a startup refusal", () => {
    const source = readFileSync(join(REPO_ROOT, "apps", "web", "server", "projects.ts"), "utf8");
    for (const table of ["projects", "project_contexts", "context_revocations"]) {
      assert.match(source, new RegExp(`assertTableAllowed\\("${table}"\\)`));
    }
    // Only the three tables this role owns are read. `source_credentials` and the
    // rest of the sixteen are absent by allow-list, and must stay absent here.
    assert.doesNotMatch(source, /readAsCaller<[^>]*>\([^)]*"source_credentials"/);
  });
});

/* -------------------------------------------------------------------------- */
/* The credential rule                                                         */
/* -------------------------------------------------------------------------- */

describe("the caller's own token is the only credential", () => {
  test("every recorded header set is exactly accept and the caller's authorization", async () => {
    const transport = spyTransport({
      tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")] },
    });
    const routes = routesFor(transport);
    await listRoute(routes);
    await detailFor(routes);
    assert.ok(transport.calls.length >= 2);
    for (const call of transport.calls) {
      assert.deepEqual(Object.keys(call.headers).sort(), ["accept", "authorization"]);
      assert.equal(call.headers["authorization"], `Bearer ${CALLER_TOKEN}`);
      assert.equal(call.headers["accept"], "application/json");
      assert.equal(call.method, "GET");
    }
  });

  test("the configured privileged credential is never read, sent, or named", async () => {
    process.env.EGA_SUPABASE_SECRET_KEY = SERVICE_SECRET;
    try {
      const transport = spyTransport({
        tables: {
          projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
          project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD)],
        },
      });
      const routes = routesFor(transport);
      await listRoute(routes);
      await detailFor(routes);
      assert.ok(transport.calls.length >= 3);
      for (const call of transport.calls) {
        assert.ok(!call.url.includes(SERVICE_SECRET), "the secret reached a URL");
        assert.ok(!call.headers["authorization"].includes(SERVICE_SECRET));
      }
      const source = readFileSync(join(REPO_ROOT, "apps", "web", "server", "projects.ts"), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      assert.ok(!code.includes("EGA_SUPABASE_SECRET_KEY"), "projects.ts reads the privileged credential");
      assert.ok(!/supabaseSecretKey/.test(code), "projects.ts reads ServerConfig.supabaseSecretKey");
      assert.doesNotMatch(code, /["'`]apikey["'`]\s*:/i, "projects.ts builds an apikey header");
      // The adapter's own reader options carry no credential field, so there is
      // nowhere for one to have been threaded in.
      assert.doesNotMatch(code, /serviceRole|service_role|secretKey\b/);
    } finally {
      delete process.env.EGA_SUPABASE_SECRET_KEY;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Every required state                                                        */
/* -------------------------------------------------------------------------- */

describe("every required state answers with its own code, never with a zero", () => {
  test("loaded: the projects the caller may read, with a measured context count", async () => {
    const transport = spyTransport({
      tables: {
        projects: [
          projectRow(PROJECT_A, WORKSPACE_A, "Alpha"),
          projectRow(PROJECT_B, WORKSPACE_A, "Beta"),
        ],
        project_contexts: [
          contextRow(CONTEXT_A, PROJECT_A, PIN_OLD),
          contextRow(CONTEXT_B, PROJECT_B, PIN_OLD),
        ],
      },
    });
    const routes = routesFor(transport);
    const result = await listRoute(routes);
    assert.ok(result.ok, `expected a body, got ${result.error?.message}`);
    assert.equal(result.value.length, 2);
    assert.deepEqual(
      result.value.map((row) => [row.name, row.active_context_count]),
      [
        ["Alpha", 1],
        ["Beta", 1],
      ],
    );
    for (const row of result.value) {
      assert.deepEqual(Object.keys(row).sort(), [
        "active_context_count",
        "created_at",
        "name",
        "project_id",
        "workspace_id",
      ]);
    }
  });

  test("empty: an empty projects table is an empty array, not a metric", async () => {
    const transport = spyTransport({ tables: {} });
    const result = await listRoute(routesFor(transport));
    assert.ok(result.ok);
    // A bare empty array. There is no object carrying `projects: 0`, no summary
    // with a zero total, and nothing that could be rendered as a count.
    assert.deepEqual(result.value, []);
    assert.equal(typeof result.value, "object");
    assert.ok(!JSON.stringify(result.value).includes("total"));
  });

  test("empty: an empty project_contexts table carries the stated reason, never a zero", async () => {
    const transport = spyTransport({
      tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")] },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok);
    assert.deepEqual(result.value.contexts, []);
    assert.equal(result.value.contexts_unavailable_reason, CONTEXTS_EMPTY_REASON);
    assert.ok(CONTEXTS_EMPTY_REASON.length > 40, "the empty reason must be a real sentence");
    // The headline assertion: the empty message never claims a measurement.
    assert.doesNotMatch(CONTEXTS_EMPTY_REASON, /\b0 contexts\b|\bzero contexts\b|\bno contexts\b/i);
    assert.match(CONTEXTS_EMPTY_REASON, /not a measurement/i);
    // A project with no readable context reports a count of 0, which is a
    // *measured* zero; the reason field is what stops it reading as "none exist".
    assert.equal(result.value.project.active_context_count, 0);
    assert.equal(result.value.revocations_unavailable_reason, REVOCATIONS_EMPTY_REASON);
    assert.ok(!REVOCATIONS_EMPTY_REASON.includes("0 revocation"));
  });

  test("empty: the list route states no writer exists, so a zero is never a claim", async () => {
    // The page's own empty copy is asserted statically below; here the point is
    // that the wire response is a bare array and therefore cannot carry a metric.
    const transport = spyTransport({ tables: { projects: [] } });
    const result = await listRoute(routesFor(transport));
    assert.ok(result.ok);
    assert.equal(result.value.length, 0);
    assert.equal(result.value.filter((row) => typeof row === "object").length, 0);
  });

  test("unauthorized: a request with no session is 401 and reads no table", async () => {
    const transport = spyTransport({ tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")] } });
    const result = await listRoute(routesFor(transport), { headers: {} });
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 401);
    assert.equal(result.error.code, "E_WEB_UNAUTHENTICATED");
    assert.equal(transport.tables.length, 0, "a table was read without a caller");
  });

  test("a rejected session is 401 on the detail route too", async () => {
    const transport = spyTransport({ sessionStatus: 401 });
    const result = await detailFor(routesFor(transport));
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 401);
    assert.equal(result.error.code, "E_WEB_UNAUTHENTICATED");
    assert.ok(!result.error.message.includes(SECRET_MARKERS.upstreamBody));
  });

  test("forbidden: a gateway 403 is 401, never a disclosure of upstream state", async () => {
    const transport = spyTransport({ sessionStatus: 403 });
    const result = await listRoute(routesFor(transport));
    assert.equal(result.error.status, 401);
    assert.ok(!result.error.message.includes(SECRET_MARKERS.upstreamBody));
    // A 403 from a *table* read is likewise a session rejection, and the page's
    // forbidden surface is reachable only through the console's own role gate.
    const tableForbidden = spyTransport({
      tables: { projects: [] },
      tableStatus: { projects: 403 },
    });
    const forbidden = await listRoute(routesFor(tableForbidden));
    assert.equal(forbidden.error.status, 401);
  });

  test("unavailable: an unconfigured Supabase is a 503 naming the variable", async () => {
    const transport = spyTransport({ tables: { projects: [] } });
    const result = await listRoute(routesFor(transport, null));
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 503);
    assert.match(result.error.message, /EGA_SUPABASE_URL/);
    assert.match(result.error.message, /Control-plane data is unavailable/);
    assertNoTableRead(transport, "an unconfigured deployment read a table");
  });

  test("unavailable: a table this deployment does not expose is 503, not absent", async () => {
    const transport = spyTransport({ tables: {}, tableStatus: { projects: 404 } });
    const result = await listRoute(routesFor(transport));
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 503);
    assert.ok(!result.error.message.includes(SECRET_MARKERS.upstreamBody));
  });

  test("unavailable: an unreachable control plane is 503 without the cause", async () => {
    const reader = createControlPlaneReader({
      supabaseUrl: SUPABASE_URL,
      transport: async (input) => {
        if (new URL(input).pathname === "/auth/v1/user") {
          return jsonResponse(200, { id: "user-a" });
        }
        throw new Error(`connect ECONNREFUSED ${SECRET_MARKERS.upstreamHost}${ABSOLUTE_PATH}`);
      },
    });
    const result = await listRoute(createProjectRoutes({ reader, bounds: BOUNDS }));
    assert.equal(result.error.status, 503);
    for (const marker of Object.values(SECRET_MARKERS)) {
      assert.ok(!result.error.message.includes(marker), `${marker} leaked`);
    }
  });

  test("error: an unexpected upstream status is 502, not a silently empty page", async () => {
    const transport = spyTransport({
      tables: { projects: [] },
      tableStatus: { projects: 500 },
    });
    const result = await listRoute(routesFor(transport));
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 502);
    assert.ok(!JSON.stringify(result.error).includes(SECRET_MARKERS.upstreamBody));
  });

  test("not visible: a project the policy does not admit is 404 and names no row", async () => {
    const transport = spyTransport({ tables: {} });
    const result = await detailFor(routesFor(transport));
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 404);
    assert.equal(result.error.code, PROJECT_NOT_VISIBLE_CODE);
    assert.match(result.error.message, /does not disclose whether any project exists/);
  });

  test("the route refuses a projectId that is not a uuid, before any read", async () => {
    const transport = spyTransport({ tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")] } });
    const result = await detailFor(routesFor(transport), "../../etc/passwd");
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 400);
    // The session probe necessarily precedes the handler; what must not happen is
    // a *table* read.
    assertNoTableRead(transport, "a malformed id reached PostgREST");
  });

  test("the route surfaces the console's own error shapes for the page's states", async () => {
    // The page renders these through `ResourceSection` / `ErrorPanel`; the copy
    // every state shows is `describeApiError`, asserted here per discriminant.
    const states = [
      { kind: "network", message: "offline", code: null, status: null, retryable: true },
      { kind: "not_configured", message: "no API base URL", code: null, status: null, retryable: false },
      { kind: "unauthorized", message: "session rejected", code: "E_WEB_UNAUTHENTICATED", status: 401, retryable: false },
      { kind: "forbidden", message: "role does not grant this read", code: "E_WEB_CONTROL_PLANE_FORBIDDEN", status: 403, retryable: false },
      { kind: "not_found", message: "not visible", code: PROJECT_NOT_VISIBLE_CODE, status: 404, retryable: false },
      { kind: "unavailable", message: "EGA_SUPABASE_URL is not configured", code: "E_WEB_READ_UNAVAILABLE", status: 503, retryable: true },
      { kind: "server", message: "upstream failed", code: "E_WEB_READ_UPSTREAM", status: 502, retryable: true },
      { kind: "malformed_response", message: "unexpected shape", code: "E_WEB_READ_UPSTREAM_MALFORMED", status: 502, retryable: false },
    ];
    for (const state of states) {
      const sentence = describeApiError(state);
      assert.ok(sentence.length > 0, `${state.kind} produced no sentence`);
      for (const marker of Object.values(SECRET_MARKERS)) {
        assert.ok(!sentence.includes(marker));
      }
    }
    assert.equal(isUnavailableError(states[1]), true);
    assert.equal(isUnavailableError(states[4]), true);
    assert.equal(isUnavailableError(states[3]), false);
  });
});

/* -------------------------------------------------------------------------- */
/* The pinned release                                                          */
/* -------------------------------------------------------------------------- */

describe("the pinned release is answered, and never substituted", () => {
  test("the pin served is the exact digest stored on the context row", async () => {
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [
          contextRow(CONTEXT_A, PROJECT_A, PIN_OLD, { context_digest: CONTEXT_DIGEST_A }),
          contextRow(CONTEXT_B, PROJECT_A, PIN_NEW, { context_digest: CONTEXT_DIGEST_B }),
        ],
      },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok, result.error?.message);
    assert.deepEqual(
      result.value.contexts.map((row) => [row.context_id, row.release_digest]),
      [
        [CONTEXT_A, PIN_OLD],
        [CONTEXT_B, PIN_NEW],
      ],
    );
    // Every field the shared DTO declares is present, and the pin is in it.
    for (const row of result.value.contexts) {
      assert.deepEqual(Object.keys(row).sort(), [
        "context_digest",
        "context_id",
        "project_id",
        "published_at",
        "release_digest",
        "release_resolution",
        "release_resolution_reason",
        "revocation_reason",
        "revoked_at",
        "revoked_by",
      ]);
      assert.match(row.release_resolution_reason, new RegExp(row.release_digest));
    }
    // The three envelope-only digests are in no response, at any nesting depth.
    for (const key of FORBIDDEN_DIGEST_KEYS) {
      assert.ok(!collectKeys(result.value).has(key), `${key} reached the response`);
      assert.ok(!JSON.stringify(result.value).includes(key));
    }
  });

  test("the served release lives in its own field and never in a pin", async () => {
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD)],
      },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok);
    const value = result.value;
    // With no verified artifact configured the deployment cannot say anything, and
    // says that instead of guessing. Crucially, no pin is filled in from it.
    assert.equal(value.served_release_digest, null);
    assert.ok(typeof value.served_release_unavailable_reason === "string");
    assert.ok(value.served_release_unavailable_reason.length > 0);
    for (const context of value.contexts) {
      assert.equal(context.release_digest, PIN_OLD);
      assert.equal(context.release_resolution, "unknown");
      assert.match(context.release_resolution_reason, /could not be determined/);
    }
    // The pin digest is not "the current release", and the current release is not
    // presented as the pin: the two appear in different fields.
    assert.ok(!collectStrings(value).includes(PIN_NEW));
  });

  test("a pin this deployment cannot resolve says so, and names the pin", () => {
    const verdict = describePinnedRelease(PIN_OLD, {
      served: PIN_NEW,
      servedReason: null,
      digests: [PIN_OTHER],
      unresolvedReason: null,
    });
    assert.equal(verdict.release_resolution, "not-resolvable");
    assert.match(verdict.release_resolution_reason, new RegExp(PIN_OLD));
    // The served digest is named only as an explicit contrast.
    assert.match(verdict.release_resolution_reason, /which is NOT what this context is pinned to/);
    assert.match(verdict.release_resolution_reason, /never replaced by another digest/);
  });

  test("a pin this deployment can resolve says so without claiming a rule", () => {
    const verdict = describePinnedRelease(PIN_OLD, {
      served: PIN_OLD,
      servedReason: null,
      digests: [PIN_OLD],
      unresolvedReason: null,
    });
    assert.equal(verdict.release_resolution, "resolvable");
    assert.match(verdict.release_resolution_reason, new RegExp(PIN_OLD));
    assert.match(verdict.release_resolution_reason, /not a rule/);
  });

  test("a deployment that cannot resolve anything reports unknown, not not-resolvable", () => {
    const verdict = describePinnedRelease(PIN_OLD, {
      served: null,
      servedReason: "No verified release identity.",
      digests: [],
      unresolvedReason: "No verified release identity.",
    });
    assert.equal(verdict.release_resolution, "unknown");
    assert.match(verdict.release_resolution_reason, /No verified release identity/);
    assert.match(verdict.release_resolution_reason, /unaffected/);
    assert.ok(!verdict.release_resolution_reason.includes(PIN_OTHER));
  });

  test("a malformed project row field refuses the response too", async () => {
    for (const override of [
      { name: "" },
      { name: "   " },
      { name: 42 },
      { workspace_id: "not-a-uuid" },
      { created_at: 0 },
      { created_at: "last tuesday" },
      { id: "not-a-uuid" },
    ]) {
      const row = { ...projectRow(PROJECT_A, WORKSPACE_A, "Alpha"), ...override };
      const result = await listRoute(routesFor(spyTransport({ tables: { projects: [row] } })));
      assert.equal(result.ok, false, `${JSON.stringify(override)} was rendered`);
      assert.equal(result.error.code, PROJECT_ROW_MALFORMED_CODE);
    }
  });

  test("a malformed release_digest refuses the response rather than being shown as a pin", async () => {
    for (const bad of ["sha256:short", "SHA256:" + "A".repeat(64), "", "not-a-digest", 42, null]) {
      const transport = spyTransport({
        tables: {
          projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
          project_contexts: [contextRow(CONTEXT_A, PROJECT_A, bad)],
        },
      });
      const result = await detailFor(routesFor(transport));
      assert.equal(result.ok, false, `release_digest ${JSON.stringify(bad)} was shown as a pin`);
      assert.equal(result.error.status, 502);
      assert.equal(result.error.code, PROJECT_ROW_MALFORMED_CODE);
      assert.ok(!result.error.message.includes(String(bad)) || bad === "");
    }
  });

  test("a malformed context_digest or id refuses the response too", async () => {
    for (const override of [
      { context_digest: "sha256:nope" },
      { id: "not-a-uuid" },
      { published_at: "yesterday" },
      { revoked_at: 17 },
      { context_digest: null },
    ]) {
      const transport = spyTransport({
        tables: {
          projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
          project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD, override)],
        },
      });
      const result = await detailFor(routesFor(transport));
      assert.equal(result.ok, false, `${JSON.stringify(override)} was accepted`);
      assert.equal(result.error.code, PROJECT_ROW_MALFORMED_CODE);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Revoked contexts                                                             */
/* -------------------------------------------------------------------------- */

describe("a revoked context is distinct, and its pin survives", () => {
  test("a revoked context returned by the policy keeps its pin and gains the revocation", async () => {
    const revokedAt = "2026-03-04T11:22:33+00:00";
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD, { revoked_at: revokedAt })],
        context_revocations: [revocationRow(CONTEXT_A, "rolled back after an incident")],
      },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok, result.error?.message);
    const [context] = result.value.contexts;
    assert.equal(context.revoked_at, revokedAt);
    assert.equal(context.revocation_reason, "rolled back after an incident");
    assert.equal(context.revoked_by, "owner-subject-a");
    // The pin of a revoked context is the thing an operator needs: unchanged.
    assert.equal(context.release_digest, PIN_OLD);
    assert.equal(result.value.revocations.length, 1);
    // A revoked context is not counted as active.
    assert.equal(result.value.project.active_context_count, 0);
  });

  test("two revocation timestamps that disagree are both shown, and neither is discarded", async () => {
    // This cannot happen under today's policies; it is asserted because the day it
    // can, the console must not pick a winner silently.
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [
          contextRow(CONTEXT_A, PROJECT_A, PIN_OLD, { revoked_at: "2026-03-04T11:22:33+00:00" }),
        ],
        context_revocations: [revocationRow(CONTEXT_A, "rolled back", "owner-a", "2026-03-05T08:00:00+00:00")],
      },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok);
    const [context] = result.value.contexts;
    // The context row's own column wins, because it is the one the schema checks.
    assert.equal(context.revoked_at, "2026-03-04T11:22:33+00:00");
    // And the disagreement is stated in full.
    assert.match(context.revocation_reason, /2026-03-04T11:22:33\+00:00/);
    assert.match(context.revocation_reason, /2026-03-05T08:00:00\+00:00/);
    assert.match(context.revocation_reason, /both are shown and neither is discarded/);
    assert.equal(context.revoked_by, "owner-a");
  });

  test("a revocation record on a context whose row says active fails toward revoked", async () => {
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD, { revoked_at: null })],
        context_revocations: [revocationRow(CONTEXT_A, "revoked after the fact")],
      },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok);
    const [context] = result.value.contexts;
    // A revocation row is evidence of revocation, so the context cannot render as
    // active. Its pin is unaffected either way.
    assert.equal(context.revoked_at, "2026-03-04T11:22:33+00:00");
    assert.equal(context.revocation_reason, "revoked after the fact");
    assert.equal(context.release_digest, PIN_OLD);
    assert.equal(result.value.project.active_context_count, 0);
  });

  test("a revoked context with no readable revocation record still reports the revocation", async () => {
    const revokedAt = "2026-03-04T11:22:33+00:00";
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD, { revoked_at: revokedAt })],
      },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok);
    const [context] = result.value.contexts;
    assert.equal(context.revoked_at, revokedAt);
    // Nothing is invented to explain a revocation the caller may not read: the
    // reason stays `null` rather than becoming an empty string or a placeholder.
    assert.equal(context.revocation_reason, null);
    assert.equal(context.revoked_by, null);
    assert.deepEqual(result.value.revocations, []);
    assert.equal(result.value.revocations_unavailable_reason, REVOCATIONS_EMPTY_REASON);
  });

  test("today's policy hides a revoked context, and the response says why", async () => {
    // `private.can_read_context` requires `revoked_at IS NULL` *and* no
    // `context_revocations` row, so a revoked context returns nothing — even for
    // its own workspace owner. The fixture models exactly that: the row exists in
    // `project_contexts` upstream, but the policy admits it to nobody, so it is not
    // configured as readable here and the console cannot invent it.
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [],
        context_revocations: [],
      },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok);
    assert.deepEqual(result.value.contexts, []);
    assert.deepEqual(result.value.revocations, []);
    assert.equal(result.value.contexts_unavailable_reason, CONTEXTS_EMPTY_REASON);
    assert.equal(result.value.revocations_unavailable_reason, REVOCATIONS_EMPTY_REASON);

    // The policy note names both halves of the rule and the role that still cannot
    // see the row, so the page states a policy fact rather than implying data loss.
    assert.equal(result.value.context_policy_note, CONTEXT_POLICY_NOTE);
    assert.match(CONTEXT_POLICY_NOTE, /revoked_at IS NULL/);
    assert.match(CONTEXT_POLICY_NOTE, /no context_revocations row/);
    assert.match(CONTEXT_POLICY_NOTE, /including the owner of its own/);
    assert.match(CONTEXT_POLICY_NOTE, /never shows the release it currently serves in place of a pin/);
    // No revocation row is fabricated for a context the console cannot read.
    assert.ok(!JSON.stringify(result.value).includes("rolled back"));
  });

  test("the revocation read is keyed only on contexts that were actually readable", async () => {
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD)],
        context_revocations: [revocationRow(CONTEXT_A, "should not be linked to an active context")],
      },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok);
    const revocationReads = transport.tables
      .map((call) => new URL(call.url))
      .filter((url) => url.pathname.endsWith("/rest/v1/context_revocations"));
    assert.equal(revocationReads.length, 1);
    // The filter is the readable context id, and nothing else: no workspace id, no
    // "give me every revocation" form.
    assert.equal(revocationReads[0].searchParams.get("context_id"), `eq.${CONTEXT_A}`);
    assert.equal(revocationReads[0].searchParams.get("workspace_id"), null);
    // The read was performed even though `can_read_context` should have excluded a
    // context that has one; the response reports what was actually returned rather
    // than what the policy should have produced.
    assert.equal(result.value.contexts[0].context_id, CONTEXT_A);
    assert.equal(result.value.revocations.length, 1);
  });

  test("with no readable context, no revocation query is sent at all", async () => {
    const transport = spyTransport({ tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")] } });
    await detailFor(routesFor(transport));
    assert.equal(
      transport.tables.filter((call) => new URL(call.url).pathname.endsWith("/context_revocations")).length,
      0,
      "an empty filter reached PostgREST",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Ids are filters, never capabilities                                         */
/* -------------------------------------------------------------------------- */

describe("an id in a request selects rows and grants nothing", () => {
  test("another workspace's workspace_id yields no rows, and reaches the URL as a filter", async () => {
    const transport = spyTransport({
      tables: {
        projects: [
          projectRow(PROJECT_A, WORKSPACE_A, "Alpha"),
          projectRow(PROJECT_B, WORKSPACE_B, "Beta"),
        ],
      },
    });
    const routes = routesFor(transport);
    const mine = await listRoute(routes, { query: new URLSearchParams({ workspace_id: WORKSPACE_A }) });
    assert.ok(mine.ok);
    assert.deepEqual(mine.value.map((row) => row.project_id), [PROJECT_A]);

    const theirs = await listRoute(routes, { query: new URLSearchParams({ workspace_id: WORKSPACE_B }) });
    assert.ok(theirs.ok);
    assert.deepEqual(theirs.value.map((row) => row.project_id), [PROJECT_B]);

    // The id was a PostgREST equality filter, never a bearer of authority. Only the
    // `projects` reads are inspected; each list request also reads contexts, which
    // carry no workspace filter by design (they are keyed on the page's own ids).
    const reads = transport.tables
      .map((call) => new URL(call.url))
      .filter((url) => url.pathname === "/rest/v1/projects");
    assert.deepEqual(
      reads.map((url) => url.searchParams.get("workspace_id")),
      [`eq.${WORKSPACE_A}`, `eq.${WORKSPACE_B}`],
    );
    // No read ever names a workspace other than the one that was asked for.
    for (const url of transport.tables.map((call) => new URL(call.url))) {
      const named = url.searchParams.get("workspace_id");
      if (named !== null) {
        assert.ok(
          named === `eq.${WORKSPACE_A}` || named === `eq.${WORKSPACE_B}`,
          `a read named ${named}`,
        );
      }
    }
  });

  test("a malformed workspace_id is refused before any read", async () => {
    const transport = spyTransport({ tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")] } });
    for (const value of ["not-a-uuid", `${WORKSPACE_A}' or '1'='1`, "11111111-1111-4111-8111-11111111111Z"]) {
      const result = await listRoute(routesFor(transport), {
        query: new URLSearchParams({ workspace_id: value }),
      });
      assert.equal(result.ok, false, `workspace_id=${value} was accepted`);
      assert.equal(result.error.status, 400);
      assertNoTableRead(transport, `workspace_id=${value} reached PostgREST`);
    }
  });

  test("a project id the caller may not read is indistinguishable from one that does not exist", async () => {
    const routes = routesFor(spyTransport({ tables: {} }));
    const missing = await detailFor(routes, "99999999-9999-4999-8999-999999999999");
    const forbidden = await detailFor(routes, PROJECT_B);
    assert.equal(missing.ok, false);
    assert.equal(forbidden.ok, false);
    assert.equal(missing.error.status, forbidden.error.status);
    assert.equal(missing.error.code, forbidden.error.code);
    assert.equal(missing.error.message, forbidden.error.message);
  });

  test("the list route sends no workspace filter when the shell has resolved none", async () => {
    const transport = spyTransport({
      tables: {
        projects: [
          projectRow(PROJECT_A, WORKSPACE_A, "Alpha"),
          projectRow(PROJECT_B, WORKSPACE_B, "Beta"),
        ],
      },
    });
    await listRoute(routesFor(transport));
    const read = new URL(transport.tables[0].url);
    assert.equal(read.searchParams.get("workspace_id"), null);
    assert.equal(read.searchParams.get("select"), "id,workspace_id,name,created_at");
  });

  test("a caller-supplied page size selects rows and never widens the read", async () => {
    const transport = spyTransport({
      tables: {
        projects: [
          projectRow(PROJECT_A, WORKSPACE_A, "Alpha"),
          projectRow(PROJECT_B, WORKSPACE_A, "Beta"),
        ],
        project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD)],
      },
    });
    const result = await listRoute(routesFor(transport), { query: new URLSearchParams({ limit: "1" }) });
    assert.ok(result.ok);
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0].project_id, PROJECT_A);
    // The context count was read for the one project on the page, not for all of
    // them, so a page cannot starve a project's count with another project's rows.
    const contextRead = transport.tables
      .map((call) => new URL(call.url))
      .find((url) => url.pathname.endsWith("/rest/v1/project_contexts"));
    assert.equal(contextRead.searchParams.get("project_id"), `eq.${PROJECT_A}`);
  });

  test("the default page size is documented and within the adapter's ceiling", async () => {
    assert.equal(PROJECTS_PAGE_DEFAULT_LIMIT, 50);
    assert.equal(PROJECTS_PAGE_MAX_LIMIT, CONTROL_PLANE_MAX_LIMIT);
  });
});

/* -------------------------------------------------------------------------- */
/* Bounded reads                                                                */
/* -------------------------------------------------------------------------- */

describe("reads are bounded rather than truncated", () => {
  test("every read carries an explicit limit within the adapter's ceiling", async () => {
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD)],
        context_revocations: [],
      },
    });
    const routes = routesFor(transport);
    await listRoute(routes);
    await detailFor(routes);
    assert.ok(transport.tables.length >= 4);
    for (const call of transport.tables) {
      const url = new URL(call.url);
      const limit = url.searchParams.get("limit");
      assert.ok(limit !== null, `${url.pathname} was read without a limit`);
      const value = Number(limit);
      assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= CONTROL_PLANE_MAX_LIMIT);
    }
  });

  test("an absent, malformed, or oversized limit is refused rather than clamped", async () => {
    for (const value of ["0", "abc", "-1", "1.5", String(PROJECTS_PAGE_MAX_LIMIT + 1), "1e3", ""]) {
      const transport = spyTransport({
        tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")] },
      });
      const result = await listRoute(routesFor(transport), {
        query: new URLSearchParams({ limit: value }),
      });
      if (value === "") {
        // Blank is the client's documented way of dropping a parameter, so it is
        // absent rather than malformed — and it must not refuse.
        assert.ok(result.ok, `limit=${JSON.stringify(value)} should be treated as absent`);
        continue;
      }
      assert.equal(result.ok, false, `limit=${value} was served`);
      assert.equal(result.error.status, 400);
      assert.equal(result.error.code, "E_WEB_PROJECT_LIMIT_INVALID");
      assertNoTableRead(transport, `limit=${value} reached PostgREST`);
    }
  });

  test("a contexts read that reaches its ceiling refuses rather than reporting a floor", async () => {
    const rows = Array.from({ length: CONTROL_PLANE_MAX_LIMIT }, (_, index) =>
      contextRow(`cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`, PROJECT_A, PIN_OLD),
    );
    const transport = spyTransport({
      tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")], project_contexts: rows },
    });
    const result = await detailFor(routesFor(transport));
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 503);
    assert.equal(result.error.code, PROJECT_PAGE_INCOMPLETE_CODE);
    assert.match(result.error.message, /refuses rather than publish a partial list or report an inexact count/);
  });

  test("a projects page that reaches its ceiling refuses rather than slicing a partial page", async () => {
    const rows = Array.from({ length: PROJECTS_PAGE_MAX_LIMIT }, (_, index) =>
      projectRow(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`, WORKSPACE_A, `Project ${index}`),
    );
    const transport = spyTransport({ tables: { projects: rows } });
    const result = await listRoute(routesFor(transport));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, PROJECT_PAGE_INCOMPLETE_CODE);
  });

  test("a query carrying too many parameters is refused before any read", async () => {
    const transport = spyTransport({ tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")] } });
    const query = new URLSearchParams();
    for (let index = 0; index < 32; index += 1) query.set(`junk${index}`, "x");
    const result = await listRoute(routesFor(transport), { query });
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 400);
    assert.equal(result.error.code, "E_WEB_PROJECT_QUERY_INVALID");
    assertNoTableRead(transport, "an oversized query reached PostgREST");
  });
});

/* -------------------------------------------------------------------------- */
/* Sanity of the values that do reach the wire                                 */
/* -------------------------------------------------------------------------- */

describe("no secret, token, path, or SQL fragment reaches a response", () => {
  test("a hostile project name is redacted rather than echoed", async () => {
    const hostile = [
      `${CALLER_TOKEN}`,
      "postgres://ega:hunter2@db.internal:5432/ega",
      "deploy at /srv/app/supabase-project/secret-notes.txt",
      "C:\\deploy\\console\\artifact",
      "apikey=b4-fixture-privileged-supabase-secret-value",
      "secret: b4-fixture-privileged-supabase-secret-value",
      "select 1 from projects; drop table projects",
      "line\nbreak\ttab",
      `null${String.fromCharCode(0)}byte`,
      "   ",
    ];
    for (const name of hostile) {
      const transport = spyTransport({
        tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, name)] },
      });
      const result = await listRoute(routesFor(transport));
      if (name.trim() === "") {
        // A blank name is a row that does not match its own column contract.
        assert.equal(result.ok, false, "a blank project name was rendered as an empty cell");
        assert.equal(result.error.code, PROJECT_ROW_MALFORMED_CODE);
        continue;
      }
      assert.ok(result.ok, `${JSON.stringify(name)} failed with ${result.error?.code}`);
      const rendered = result.value[0].name;
      assert.ok(!rendered.includes("\n") && !rendered.includes("\t"), "layout forged by a control character");
      assert.ok(!rendered.includes(String.fromCharCode(0)), "a NUL byte survived");
      for (const marker of Object.values(SECRET_MARKERS)) {
        assert.ok(!rendered.includes(marker), `${marker} survived in ${JSON.stringify(rendered)}`);
      }
      assert.ok(!rendered.includes(CALLER_TOKEN));
      assert.ok(!rendered.includes("hunter2"));
      assert.ok(rendered.length <= 400);
      // Every case here carries something structural — a JWT, a URL with userinfo, a
      // filesystem path, a credential assignment, a SQL statement, or a control
      // character. Each must have left a trace: a redaction, or the disappearance of
      // the offending characters. A value that came back byte-identical was never
      // processed, which is what this assertion exists to catch.
      assert.ok(
        rendered.includes("<redacted") || rendered !== name,
        `nothing was neutralised in ${JSON.stringify(rendered)} from ${JSON.stringify(name)}`,
      );
      if (!rendered.includes("<redacted")) {
        // Whitespace collapsing is the neutralisation for a control-character
        // payload: a newline that could forge the next row's layout is simply gone.
        assert.doesNotMatch(rendered, /[\n\r\t\0]/, "a layout control character survived");
      }
    }
  });

  test("a hostile revocation reason and actor are redacted the same way", async () => {
    const transport = spyTransport({
      tables: {
        projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")],
        project_contexts: [contextRow(CONTEXT_A, PROJECT_A, PIN_OLD, { revoked_at: "2026-03-04T11:22:33+00:00" })],
        context_revocations: [
          revocationRow(
            CONTEXT_A,
            `leaked ${SERVICE_SECRET} from /srv/app/notes and Bearer ${CALLER_TOKEN}`,
            "postgres://ega:hunter2@db.internal:5432/ega",
          ),
        ],
      },
    });
    const result = await detailFor(routesFor(transport));
    assert.ok(result.ok);
    const [record] = result.value.revocations;
    // The credential-URL form and the absolute path are structural, so both are
    // redacted. The bare secret string is not: a revocation reason is
    // operator-authored prose, and no console can recognise an arbitrary secret
    // without redacting ordinary English words. What is asserted is that the
    // *structural* forms never survive, in either field.
    assert.ok(!record.reason.includes(SECRET_MARKERS.path), "a path survived in the reason");
    assert.ok(!record.revoked_by.includes(SECRET_MARKERS.password), "a URL password survived in the actor");
    assert.ok(!record.revoked_by.includes(SECRET_MARKERS.upstreamHost), "a host survived in the actor");
    assert.match(record.reason, /<redacted-path>/);
    assert.match(record.revoked_by, /<redacted-url>/);
    // A bearer token is structural too.
    assert.ok(!record.reason.includes(CALLER_TOKEN), "a bearer token survived");
  });

  test("no response value carries an absolute path, and no error message does either", async () => {
    const transport = spyTransport({ tables: { projects: [projectRow(PROJECT_A, WORKSPACE_A, "Alpha")] } });
    const ok = await listRoute(routesFor(transport));
    assert.ok(ok.ok);
    for (const value of collectStrings(ok.value)) {
      assert.doesNotMatch(value, /(^|\s)\/[A-Za-z0-9._@+-]+/, `a path survived: ${value}`);
      assert.doesNotMatch(value, /\bdrop\s+table\b/i);
      assert.doesNotMatch(value, /\bBearer\s+\S+/);
    }
    const failed = await detailFor(routesFor(spyTransport({ tables: {} })), PROJECT_B);
    assert.equal(failed.ok, false);
    assert.doesNotMatch(failed.error.message, /(^|\s)\/[A-Za-z0-9._@+-]+/);
  });

  test("the module contains no SQL at all", () => {
    const source = readFileSync(join(REPO_ROOT, "apps", "web", "server", "projects.ts"), "utf8");
    // Comments are prose about SQL and legitimately name its keywords; the
    // SQL_STATEMENT redaction pattern is a *detector*, not a statement. Both are
    // excluded so the scan cannot pass or fail for the wrong reason.
    const code = stripComments(source);
    const withoutDetector = code.slice(0, code.indexOf("const SQL_STATEMENT")) + code.slice(code.indexOf(");", code.indexOf("const SQL_STATEMENT")) + 3);
    assert.doesNotMatch(withoutDetector, /\b(select|insert|update|delete)\b[\s\S]{0,40}\bfrom\b/i);
    assert.doesNotMatch(withoutDetector, /[`"'][^`"']*\bwhere\b[^`"']*[`"']/i);
    assert.doesNotMatch(withoutDetector, /\bquery\s*\(/, "the module builds a query");
    assert.ok(!source.includes("supabase.from"), "the module must go through the adapter, not a client");
  });
});

/* -------------------------------------------------------------------------- */
/* The page contract                                                            */
/* -------------------------------------------------------------------------- */

const PROJECTS_PAGE_SOURCE = readFileSync(
  join(REPO_ROOT, "apps", "web", "src", "pages", "ProjectsPage.tsx"),
  "utf8",
);
const PROJECT_DETAIL_SOURCE = readFileSync(
  join(REPO_ROOT, "apps", "web", "src", "pages", "ProjectDetailPage.tsx"),
  "utf8",
);

describe("the pages render the contract and offer no mutation", () => {
  test("both pages delegate every state to ResourceSection, so none can render blank", () => {
    for (const [label, source] of [
      ["ProjectsPage", PROJECTS_PAGE_SOURCE],
      ["ProjectDetailPage", PROJECT_DETAIL_SOURCE],
    ]) {
      assert.match(source, /<ResourceSection/, `${label} does not use ResourceSection`);
      // `ResourceSection` is what maps `status: "loading"` to a loading surface and
      // `status: "error"` to unavailable / forbidden / error, so its presence is the
      // assertion that those states exist on the page. Both pages hand it the live
      // resource state and a reload, through the exported render function a test
      // can drive directly.
      assert.match(
        source,
        /render(ProjectDetail|Projects)\(resource\.state, resource\.reload/,
        `${label} does not pass its live resource state to its render function`,
      );
      assert.match(
        source,
        /<ResourceSection[\s\S]{0,200}state=\{state\}/,
        `${label} does not forward the state to ResourceSection`,
      );
      assert.match(source, /reload=\{reload\}/, `${label} does not forward a reload`);
    }
  });

  test("no mutation control is rendered on either page", () => {
    for (const [label, source] of [
      ["ProjectsPage", PROJECTS_PAGE_SOURCE],
      ["ProjectDetailPage", PROJECT_DETAIL_SOURCE],
    ]) {
      // Comments legitimately discuss SQL keywords ("no writer", "delete"); the
      // scan sees code only, so a mention cannot hide a real statement.
      const code = stripComments(source);
      for (const banned of [
        /<button/i,
        /onClick/i,
        /onSubmit/i,
        /<form/i,
        /type="submit"/i,
        /\bmethod:\s*"POST"/i,
        /"PUT"/,
        /"PATCH"/,
        /"DELETE"/i,
        /\.post\(/i,
        /\.mutate\(/i,
      ]) {
        assert.doesNotMatch(code, banned, `${label} renders a mutation control`);
      }
    }
  });

  test("the empty states render the server's stated reason, not a local guess", () => {
    assert.match(PROJECTS_PAGE_SOURCE, /title=\{PROJECTS_EMPTY_TITLE\}/);
    assert.match(PROJECTS_PAGE_SOURCE, /reason=\{PROJECTS_EMPTY_REASON\}/);
    assert.match(PROJECTS_PAGE_SOURCE, /<EmptyState/);
    // The detail page wires both server-provided reasons in, with a fallback that
    // names the table rather than asserting a measurement.
    assert.match(PROJECT_DETAIL_SOURCE, /data\.contexts_unavailable_reason\s*\?\?/);
    assert.match(PROJECT_DETAIL_SOURCE, /data\.revocations_unavailable_reason\s*\?\?/);
    assert.match(PROJECT_DETAIL_SOURCE, /contexts\.length === 0 \?/);
    assert.match(PROJECT_DETAIL_SOURCE, /revocations\.length === 0 \?/);
    // And no page renders a zero where a reason belongs.
    assert.doesNotMatch(PROJECTS_PAGE_SOURCE, />0 contexts</i);
    assert.doesNotMatch(PROJECT_DETAIL_SOURCE, />0 contexts</i);
  });

  test("no page mentions a digest that exists only inside the envelope", () => {
    for (const [label, source] of [
      ["ProjectsPage", PROJECTS_PAGE_SOURCE],
      ["ProjectDetailPage", PROJECT_DETAIL_SOURCE],
    ]) {
      for (const key of FORBIDDEN_DIGEST_KEYS) {
        assert.ok(!source.includes(key), `${label} mentions ${key}`);
      }
    }
  });

  test("the pinned digest is rendered whole, in a selectable element, with its verdict", () => {
    // Dominant and copyable: the pin is the first field of its own panel, rendered
    // as a <code> element so it selects and copies as one string.
    assert.match(PROJECT_DETAIL_SOURCE, /<code>\{context\.release_digest\}<\/code>/);
    assert.match(PROJECT_DETAIL_SOURCE, /PIN_LEAD/);
    // Never abbreviated: the release pages use `shortDigest` for display, and this
    // one must not, because a truncated digest cannot be compared to anything.
    assert.doesNotMatch(PROJECT_DETAIL_SOURCE, /shortDigest/);
    assert.doesNotMatch(PROJECT_DETAIL_SOURCE, /release_digest\.slice|substring|substr/);
    // The served release is shown once, explicitly as a contrast.
    assert.match(PROJECT_DETAIL_SOURCE, /pinContrastNote\(data\.served_release_digest/);
    assert.match(
      PROJECT_DETAIL_SOURCE,
      /No pin on this page has been replaced by it/,
      "the served digest must be presented as a contrast, never as a replacement",
    );
    assert.match(
      PROJECT_DETAIL_SOURCE,
      /which is a fact about the deployment/,
      "the contrast must say what it is a contrast to",
    );
  });

  test("a revoked context renders distinctly and still renders its pin", () => {
    assert.match(PROJECT_DETAIL_SOURCE, /const revoked = context\.revoked_at !== null/);
    assert.match(PROJECT_DETAIL_SOURCE, /badge--mismatch">Revoked/);
    assert.match(PROJECT_DETAIL_SOURCE, /state--warning/);
    // The revoked branch replaces the lead sentence, not the digest field.
    const panel = PROJECT_DETAIL_SOURCE.slice(
      PROJECT_DETAIL_SOURCE.indexOf("function ContextPanel"),
      PROJECT_DETAIL_SOURCE.indexOf("const REVOCATION_COLUMNS"),
    );
    assert.match(panel, /<code>\{context\.release_digest\}<\/code>/);
    assert.match(panel, /revocation_reason/);
    assert.match(panel, /revoked_by/);
  });

  test("the revoked-context policy state is rendered with the server's own note", () => {
    assert.match(PROJECT_DETAIL_SOURCE, /<UnavailableState/);
    assert.match(PROJECT_DETAIL_SOURCE, /reason=\{data\.context_policy_note\}/);
    assert.match(PROJECT_DETAIL_SOURCE, /Revoked contexts are excluded from this view by policy/);
  });

  test("the list page explains that a zero context count is a completed read", () => {
    assert.match(PROJECTS_PAGE_SOURCE, /is not a count of contexts a policy hid from you/);
    // The sentence lives in the exported constant; the page renders it verbatim.
    assert.match(
      PROJECTS_PAGE_SOURCE,
      /export const PROJECTS_EMPTY_TITLE = "No project rows recorded"/,
      "the empty title must say rows are unrecorded, not that none exist",
    );
    assert.match(PROJECTS_PAGE_SOURCE, /no writer for the/);
    assert.match(PROJECTS_PAGE_SOURCE, /label: "Contexts recorded"/);
  });

  test("the list page sends the selected workspace as a filter and nothing else", () => {
    assert.match(PROJECTS_PAGE_SOURCE, /workspaceId === null \? \{\} : \{ workspace_id: workspaceId \}/);
    assert.match(PROJECTS_PAGE_SOURCE, /filter, not a grant/);
  });
});
