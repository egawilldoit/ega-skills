/**
 * Builder A's control-plane pages: `/workspace` and `/workspace/members`.
 *
 * ## What this suite is for
 *
 * `tests/web/cross-workspace-isolation.test.mjs` proves *who can see what*
 * against a real PostgreSQL, and `tests/web/supabase-read.test.mjs` proves the
 * adapter's own refusals. Neither can see the thing most likely to go wrong in
 * these two pages: that the route sends a filter it should not, or that it fills
 * a field it cannot actually read. Both are invisible to a green database run
 * and obvious to a code reader.
 *
 * So every test here drives the real route through the real adapter with a
 * recording `transport`, and asserts the **recorded request** — not the intent.
 * A spy that is never checked is not a spy.
 *
 * ## The invariants asserted most often
 *
 * - **The caller's token is the only credential.** Every recorded header map must
 *   be exactly `["accept", "authorization"]`. A service-role read would pass
 *   every "who can see what" assertion and make the permission-aware navigation a
 *   lie, so the header list is asserted rather than inferred.
 * - **Ids are filters, never capabilities.** Another workspace's id is sent as a
 *   filter and the fixture returns nothing for it, exactly as RLS would.
 * - **A refusal happens before the network.** Every pre-read refusal asserts the
 *   transport was called only for the session probe, never for a table read.
 * - **An unreadable column is never filled in.** The headline test: a non-owner
 *   gets a 403 naming `personal_workspace_owner_read`, and no response anywhere
 *   in this suite carries an owner subject or a created_at the fixture did not
 *   serve for that caller.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import { createControlPlaneReader } from "../../apps/web/server/supabase-read.ts";
import { CONTROL_PLANE_SECURITY_HEADERS } from "../../apps/web/server/api.ts";
import {
  MEMBERS_PAGE_LIMIT,
  WORKSPACE_AMBIGUOUS_CODE,
  WORKSPACE_NOT_VISIBLE_CODE,
  WORKSPACE_QUERY_INVALID_CODE,
  WORKSPACE_RECORD_NOT_READABLE_CODE,
  WORKSPACE_MEMBERSHIP_NOT_READABLE_CODE,
  WORKSPACE_ROW_INVALID_CODE,
  WORKSPACE_ROUTE_PATHS,
  buildWorkspaceRoutes,
} from "../../apps/web/server/workspace.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUPABASE_URL = "https://console-fixture.supabase.co";

/** A syntactically plausible but entirely fictional session token. */
const CALLER_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLWEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.not-a-real-signature-part";

/** The service credential that must never be used. Never a real value. */
const SERVICE_SECRET = "b4-fixture-privileged-supabase-secret-value";
const ABSOLUTE_PATH = "/srv/app/supabase-project/secret-notes.txt";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_SUBJECT = "user-owner";
const MEMBER_SUBJECT = "user-member";
const NOW = "2026-09-09T00:00:00Z";

/** Values that must never appear in a response, a URL, or a header value. */
const SECRET_MARKERS = Object.freeze({
  secret: SERVICE_SECRET,
  path: ABSOLUTE_PATH,
  upstreamBody: "upstream-body-must-not-be-echoed",
});

const AUTH_HEADERS = { authorization: `Bearer ${CALLER_TOKEN}` };
const BOUNDS = { maxResponseBytes: 65_536, requestTimeoutMs: 5_000, maxConcurrentRequests: 8 };

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function membership(overrides) {
  return {
    workspace_id: WORKSPACE_ID,
    subject: MEMBER_SUBJECT,
    role: "member",
    active: true,
    created_at: NOW,
    ...overrides,
  };
}

/**
 * A recording transport over a caller-shaped fixture.
 *
 * `subject` is who the session endpoint claims to be. `memberships` is what RLS
 * *would* return for that subject — the fixture never filters on the console's
 * behalf, so a test that expects a refusal has to omit the row.
 */
function fixture(options = {}) {
  const {
    subject = MEMBER_SUBJECT,
    memberships,
    workspaces,
    roster,
    ignoreLimit = false,
  } = options;
  const calls = [];
  const rows = memberships ?? [membership({ subject })];
  const owned = workspaces ?? [];
  // The roster read is a *separate* query and RLS admits a different row set for
  // it than for the identity read: the identity read is filtered to the caller's
  // own subject, the roster read is filtered to the workspace. `roster` models a
  // case where the first yields a row and the second yields none — which is real:
  // a workspace owner with no membership row of their own can read the workspace
  // (via personal_workspaces) and yet the workspace has no membership rows.
  const rosterRows = roster ?? rows;
  const transport = async (input, init) => {
    const url = new URL(input);
    calls.push({
      url: input,
      pathname: url.pathname,
      method: init.method,
      headers: init.headers,
      headerNames: Object.keys(init.headers).sort(),
    });
    if (url.pathname === "/auth/v1/user") return jsonResponse(200, { id: subject });
    if (url.pathname === "/rest/v1/personal_workspaces") return jsonResponse(200, owned);
    if (url.pathname === "/rest/v1/workspace_memberships") {
      // Model the one filter the route is *allowed* to send on the members read:
      // a workspace selector. RLS, not the transport, decides visibility, so the
      // fixture returns rows for the selected workspace and nothing otherwise.
      // `URLSearchParams.get` answers `null` for an absent key, not `undefined`.
      const workspaceFilter = url.searchParams.get("workspace_id");
      const selected =
        workspaceFilter === null
          ? rows
          : rosterRows.filter((row) => row.workspace_id === workspaceFilter.replace(/^eq\./, ""));
      // PostgREST honours `limit`, so the fixture does too — with one exception:
      // `ignoreLimit` models a gateway that dropped the parameter, which the
      // adapter must refuse rather than silently truncate.
      if (ignoreLimit === true) return jsonResponse(200, selected);
      const limit = url.searchParams.get("limit");
      if (limit === null) return jsonResponse(200, selected);
      return jsonResponse(200, selected.slice(0, Number(limit)));
    }
    return jsonResponse(404, {});
  };
  return { transport, calls };
}

/** Build the routes against a fixture transport, plus that transport. */
function routesFor(options = {}) {
  const { transport, calls } = fixture(options);
  // `supabaseUrl: null` is the *unconfigured* case and must be passed through as
  // null. `options.supabaseUrl ?? SUPABASE_URL` would silently substitute the
  // fixture URL for it and the 503 assertion would never be exercised.
  const supabaseUrl = "supabaseUrl" in options ? options.supabaseUrl : SUPABASE_URL;
  const reader = createControlPlaneReader({ supabaseUrl, transport });
  const routes = buildWorkspaceRoutes(BOUNDS, reader);
  return { routes, calls };
}

function routeByPath(routes, path) {
  const route = routes.find((candidate) => candidate.path === path);
  assert.ok(route !== undefined, `no route registered for ${path}`);
  return route;
}

async function call(routes, path, { query = {}, headers = AUTH_HEADERS, method = "GET" } = {}) {
  const route = routeByPath(routes, path);
  return route.handle({
    method,
    pathname: path,
    query: new URLSearchParams(query),
    params: {},
    request: { headers },
  });
}

/** Call and capture either a body or the thrown `ConsoleApiError`. */
async function settle(routes, path, options) {
  return call(routes, path, options).then(
    (body) => ({ body }),
    (error) => ({ error }),
  );
}

/** URLs of recorded table reads, with the deployment host stripped. */
function tableUrls(calls) {
  return calls
    .filter((entry) => entry.pathname.startsWith("/rest/v1/"))
    .map((entry) => entry.url.replace(SUPABASE_URL, ""));
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

describe("route registration", () => {
  test("both Builder A routes are exported and GET-only", () => {
    const paths = buildWorkspaceRoutes().map((route) => route.path);
    assert.deepEqual(paths, ["/workspace", "/workspace/members"]);
    for (const route of buildWorkspaceRoutes()) {
      assert.deepEqual([...route.methods], ["GET"], `${route.id} must be GET-only`);
      assert.equal(typeof route.handle, "function");
    }
  });

  test("the exported paths match the client contract exactly", () => {
    // `API_ENDPOINTS` in apps/web/src/api/client.ts is the client contract. A
    // server path that drifts from it is a 404 a user finds, not a build error.
    assert.deepEqual([...WORKSPACE_ROUTE_PATHS], ["/workspace", "/workspace/members"]);
    assert.equal(WORKSPACE_ROUTE_PATHS[0], "/workspace");
    assert.equal(WORKSPACE_ROUTE_PATHS[1], "/workspace/members");
  });

  test("no route mutates: there is no write verb and no write handler shape", () => {
    for (const route of buildWorkspaceRoutes()) {
      const verbs = route.methods.map((method) => method.toUpperCase());
      for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
        assert.ok(!verbs.includes(verb), `${route.id} exposes ${verb}`);
      }
    }
  });

  test("the seam's security headers are the shared control-plane set", () => {
    assert.deepEqual(Object.keys(CONTROL_PLANE_SECURITY_HEADERS).sort(), [
      "cache-control",
      "referrer-policy",
      "x-content-type-options",
      "x-frame-options",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

describe("a caller must be present and verified", () => {
  test("both routes refuse an unauthenticated request with 401", async () => {
    for (const path of ["/workspace", "/workspace/members"]) {
      const { routes, calls } = routesFor();
      const { error } = await settle(routes, path, { headers: {} });
      assert.equal(error.status, 401, path);
      assert.equal(error.code, "E_WEB_UNAUTHENTICATED", path);
      // No anonymous probe: the refusal must precede every network call.
      assert.equal(calls.length, 0, `${path} reached the transport without a credential`);
    }
  });

  test("a non-GET request is refused with 405 before the credential is read", async () => {
    const { routes, calls } = routesFor();
    const { error } = await settle(routes, "/workspace", { method: "POST" });
    assert.equal(error.status, 405);
    assert.equal(error.code, "E_METHOD_NOT_ALLOWED");
    assert.equal(calls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The credential invariant                                                    */
/* -------------------------------------------------------------------------- */

describe("the caller's own token is the only credential", () => {
  test("every recorded header map is exactly accept and authorization", async () => {
    const { routes, calls } = routesFor({
      workspaces: [{ id: WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: NOW }],
    });
    await settle(routes, "/workspace");
    await settle(routes, "/workspace/members");
    assert.ok(calls.length > 0);
    for (const entry of calls) {
      assert.deepEqual(entry.headerNames, ["accept", "authorization"]);
      // No apikey header at all: the publishable key is a browser-side value and
      // the secret key is not in this process by construction.
      assert.equal(entry.headers["accept"], "application/json");
      assert.equal(entry.headers["authorization"], `Bearer ${CALLER_TOKEN}`);
      assert.ok(!("apikey" in entry.headers));
    }
  });

  test("the forwarded credential is the session token, never a privileged one", async () => {
    const { routes, calls } = routesFor();
    await settle(routes, "/workspace/members");
    const serialized = JSON.stringify(calls);
    assert.ok(!serialized.includes(SERVICE_SECRET));
    assert.ok(!serialized.includes("apikey"));
  });

  test("the module never references the server secret key or a service role", () => {
    const source = readFileSync(join(REPO_ROOT, "apps/web/server/workspace.ts"), "utf8");
    for (const banned of ["EGA_SUPABASE_SECRET_KEY", "supabaseSecretKey", "serviceRole", "service_role"]) {
      assert.ok(!source.includes(banned), `workspace.ts must not reference ${banned}`);
    }
    // The reader is constructed from the URL alone; no credential parameter.
    assert.ok(source.includes("defaultControlPlaneReader()"));
  });
});

/* -------------------------------------------------------------------------- */
/* /workspace — the owner path                                                 */
/* -------------------------------------------------------------------------- */

describe("/workspace for the workspace owner", () => {
  test("serves the summary from the rows RLS admitted, with no substitution", async () => {
    const { routes } = routesFor({
      subject: OWNER_SUBJECT,
      memberships: [
        membership({ subject: OWNER_SUBJECT, role: "owner", created_at: "2026-01-01T00:00:00Z" }),
      ],
      workspaces: [{ id: WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: "2026-02-02T00:00:00Z" }],
    });
    const { body, error } = await settle(routes, "/workspace");
    assert.equal(error, undefined);
    assert.deepEqual(body, {
      workspace_id: WORKSPACE_ID,
      owner_subject: OWNER_SUBJECT,
      created_at: "2026-02-02T00:00:00Z",
      viewer_role: "owner",
    });
    // The workspace created_at must be the personal_workspaces value, never the
    // membership created_at. Substituting one column for another is the exact
    // dishonesty this suite exists to catch.
    assert.notEqual(body.created_at, "2026-01-01T00:00:00Z");
  });

  test("carries no hub-visibility field, because the DTO declares none", async () => {
    const { routes } = routesFor({
      subject: OWNER_SUBJECT,
      memberships: [membership({ subject: OWNER_SUBJECT, role: "owner" })],
      workspaces: [{ id: WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: NOW }],
    });
    const { body } = await settle(routes, "/workspace");
    // `WorkspaceSummary` has no hub field and `hubs` is not read. Asserting the
    // absence keeps a later edit from quietly adding a value nothing validates.
    assert.ok(!("hubs" in body));
    assert.ok(!("hub_visibility" in body));
  });
});

/* -------------------------------------------------------------------------- */
/* /workspace — the non-owner refusals                                        */
/* -------------------------------------------------------------------------- */

describe("/workspace refuses rather than substituting an unreadable column", () => {
  test("a non-owner gets 403 naming personal_workspace_owner_read", async () => {
    // The fixture serves the caller's own membership row but NO personal_workspaces
    // row — precisely what RLS does for a maintainer/member/viewer.
    const { routes } = routesFor({ memberships: [membership({ subject: MEMBER_SUBJECT })] });
    const { body, error } = await settle(routes, "/workspace");
    assert.equal(body, undefined);
    assert.equal(error.status, 403);
    assert.equal(error.code, WORKSPACE_RECORD_NOT_READABLE_CODE);
    assert.match(error.message, /personal_workspace_owner_read/);
    // No owner subject and no created_at anywhere in the refusal.
    assert.ok(!error.message.includes(OWNER_SUBJECT));
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(error.message));
  });

  test("an owner of another workspace still cannot read this one's record", async () => {
    // Owning workspace A grants nothing about workspace B. A read that ignored
    // that would be a cross-workspace leak dressed as a convenience.
    const { routes } = routesFor({
      subject: OWNER_SUBJECT,
      memberships: [membership({ subject: OWNER_SUBJECT, role: "owner" })],
      workspaces: [{ id: OTHER_WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: NOW }],
    });
    const { error } = await settle(routes, "/workspace", {
      query: { workspace: WORKSPACE_ID },
    });
    assert.equal(error.status, 403);
    assert.equal(error.code, WORKSPACE_RECORD_NOT_READABLE_CODE);
  });

  test("an owner with no membership row is refused, never assigned a role", async () => {
    // personal_workspaces.owner_subject is the owner; workspace_memberships is a
    // separate table. Owning a workspace grants no membership row, and a role is
    // only ever read from the caller's own row.
    const { routes } = routesFor({
      subject: OWNER_SUBJECT,
      memberships: [],
      workspaces: [{ id: WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: NOW }],
    });
    const { body, error } = await settle(routes, "/workspace");
    assert.equal(body, undefined);
    assert.equal(error.status, 403);
    assert.equal(error.code, WORKSPACE_MEMBERSHIP_NOT_READABLE_CODE);
  });

  test("a caller with no workspace at all is 404, not an empty workspace", async () => {
    const { routes } = routesFor({ subject: MEMBER_SUBJECT, memberships: [] });
    const { body, error } = await settle(routes, "/workspace");
    assert.equal(body, undefined, "an empty object would read as a workspace with no owner");
    assert.equal(error.status, 404);
    assert.equal(error.code, WORKSPACE_NOT_VISIBLE_CODE);
    assert.match(error.message, /not an empty workspace/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Workspace selection                                                         */
/* -------------------------------------------------------------------------- */

describe("a workspace id is a filter, never a capability", () => {
  test("another workspace's id yields no rows rather than another workspace's data", async () => {
    const { routes, calls } = routesFor({
      subject: MEMBER_SUBJECT,
      memberships: [membership({ subject: MEMBER_SUBJECT })],
    });
    const { body, error } = await settle(routes, "/workspace/members", {
      query: { workspace: OTHER_WORKSPACE_ID },
    });
    // The selector is not in the caller's visible set, so it is refused with the
    // same 404 as no selector: the status never confirms the workspace exists.
    assert.equal(error.status, 404);
    assert.equal(error.code, WORKSPACE_NOT_VISIBLE_CODE);
    assert.equal(body, undefined);

    // And it never reached the database as a filter for another workspace.
    const memberReads = tableUrls(calls).filter((url) => url.includes("workspace_id="));
    assert.equal(memberReads.length, 0);
  });

  test("a selector inside the caller's own set is sent as a filter", async () => {
    const { routes, calls } = routesFor({
      subject: MEMBER_SUBJECT,
      memberships: [
        membership({ subject: MEMBER_SUBJECT, workspace_id: WORKSPACE_ID }),
        membership({ subject: MEMBER_SUBJECT, workspace_id: OTHER_WORKSPACE_ID }),
      ],
    });
    const { body, error } = await settle(routes, "/workspace/members", {
      query: { workspace: WORKSPACE_ID },
    });
    assert.equal(error, undefined);
    // `MemberRow` declares subject/role/active/created_at and no workspace_id, so
    // the response cannot and does not carry one. The row is attributable by the
    // filter the route sent, which is asserted below.
    assert.equal(body.length, 1);
    assert.deepEqual(Object.keys(body[0]).sort(), ["active", "created_at", "role", "subject"]);
    const filter = tableUrls(calls).find((url) => url.includes("workspace_id="));
    assert.match(filter, /workspace_id=eq\.11111111-1111-4111-8111-111111111111/);
  });

  test("two visible workspaces and no selector is a 400 that asks for one", async () => {
    const { routes } = routesFor({
      subject: MEMBER_SUBJECT,
      memberships: [
        membership({ subject: MEMBER_SUBJECT, workspace_id: WORKSPACE_ID }),
        membership({ subject: MEMBER_SUBJECT, workspace_id: OTHER_WORKSPACE_ID }),
      ],
    });
    const { body, error } = await settle(routes, "/workspace/members");
    assert.equal(body, undefined, "the route must not silently pick a workspace");
    assert.equal(error.status, 400);
    assert.equal(error.code, WORKSPACE_AMBIGUOUS_CODE);
    assert.match(error.message, /workspace=<uuid>/);
  });

  test("a malformed selector is refused before any read happens", async () => {
    const { routes, calls } = routesFor();
    const { error } = await settle(routes, "/workspace/members", {
      query: { workspace: "not-a-uuid" },
    });
    assert.equal(error.status, 400);
    assert.equal(error.code, WORKSPACE_QUERY_INVALID_CODE);
    // Only the session probe. A refused request must not ask the database anything.
    const tableReads = calls.filter((entry) => entry.pathname.startsWith("/rest/v1/"));
    assert.equal(tableReads.length, 0);
  });

  test("an unrecognised parameter is refused rather than ignored", () => {
    // `?lmit=1000` or `?owner=true` silently dropped would tell the operator a
    // bound or a filter was applied when it was not.
    const source = readFileSync(join(REPO_ROOT, "apps/web/server/workspace.ts"), "utf8");
    assert.match(source, /assertKnownParams/);
    assert.match(source, /is not a parameter of this read/);
  });

  test("an unknown parameter is refused at runtime with a 400", async () => {
    const { routes } = routesFor({ memberships: [membership({ subject: MEMBER_SUBJECT })] });
    const { error } = await settle(routes, "/workspace/members", { query: { owner: "true" } });
    assert.equal(error.status, 400);
    assert.equal(error.code, WORKSPACE_QUERY_INVALID_CODE);
    assert.match(error.message, /owner is not a parameter/);
  });
});

/* -------------------------------------------------------------------------- */
/* The members read — the policy itself                                       */
/* -------------------------------------------------------------------------- */

describe("membership_self_or_admin_read decides visibility, not the console", () => {
  test("the members read sends no subject filter at all", async () => {
    const { routes, calls } = routesFor({
      subject: OWNER_SUBJECT,
      memberships: [
        membership({ subject: OWNER_SUBJECT, role: "owner" }),
        membership({ subject: MEMBER_SUBJECT, role: "member" }),
      ],
      workspaces: [{ id: WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: NOW }],
    });
    const { body } = await settle(routes, "/workspace/members");
    assert.equal(body.length, 2, "an owner sees the whole roster");

    // The identity read filters by subject; the roster read must not. If it did,
    // an owner would see one row — the defect this assertion exists to catch.
    const urls = tableUrls(calls);
    const rosterRead = urls.filter((url) => url.includes("workspace_id=eq."));
    assert.equal(rosterRead.length, 1);
    for (const url of rosterRead) {
      assert.ok(!url.includes("subject="), `the roster read must not filter by subject: ${url}`);
    }
    // The self-identity read does filter, and by the caller's own subject only.
    const identityReads = urls.filter((url) => url.includes("subject=eq."));
    assert.ok(identityReads.length >= 1);
    for (const url of identityReads) {
      assert.match(url, /subject=eq\.user-owner/);
    }
  });

  test("an ordinary member's single row is returned, not dropped", async () => {
    // The headline behaviour: RLS admits exactly one row for a non-admin, and the
    // API must return it. Returning [] would make the console's scoped view a lie
    // about its own authority.
    const { routes } = routesFor({ subject: MEMBER_SUBJECT });
    const { body, error } = await settle(routes, "/workspace/members");
    assert.equal(error, undefined);
    assert.equal(body.length, 1);
    assert.deepEqual(body[0], {
      subject: MEMBER_SUBJECT,
      role: "member",
      active: true,
      created_at: NOW,
    });
  });

  test("an inactive admin also sees exactly one row, because self has no active test", async () => {
    // private.has_workspace_role requires active, so an inactive admin fails the
    // admin branch and falls back to the subject branch. The policy, not a guess.
    const { routes } = routesFor({
      subject: MEMBER_SUBJECT,
      memberships: [membership({ subject: MEMBER_SUBJECT, role: "admin", active: false })],
    });
    const { body } = await settle(routes, "/workspace/members");
    assert.equal(body.length, 1);
    assert.equal(body[0].role, "admin");
    assert.equal(body[0].active, false);
  });

  test("rows are ordered strongest role first, which is presentation only", async () => {
    const { routes } = routesFor({
      subject: OWNER_SUBJECT,
      memberships: [
        membership({ subject: OWNER_SUBJECT, role: "owner" }),
        membership({ subject: "user-viewer", role: "viewer" }),
        membership({ subject: "user-admin", role: "admin" }),
        membership({ subject: "user-maintainer", role: "maintainer" }),
      ],
      workspaces: [{ id: WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: NOW }],
    });
    const { body } = await settle(routes, "/workspace/members");
    assert.deepEqual(
      body.map((row) => row.role),
      ["owner", "admin", "maintainer", "viewer"],
    );
  });

  test("no field on a member row is invented: only the declared columns are projected", async () => {
    const { routes, calls } = routesFor({ subject: OWNER_SUBJECT });
    await settle(routes, "/workspace/members");
    const url = tableUrls(calls).find((candidate) => candidate.includes("workspace_id=eq."));
    // A column that is not requested cannot be rendered, and every column the
    // DTO declares must be requested or the row would carry an invented value.
    assert.match(url, /select=workspace_id%2Csubject%2Crole%2Cactive%2Ccreated_at/);
  });
});

/* -------------------------------------------------------------------------- */
/* Empty results                                                               */
/* -------------------------------------------------------------------------- */

describe("an empty table is reported as policy, never as a zero", () => {
  test("an empty roster is an empty array plus a stated reason, not a count of 0", async () => {
    // The caller has a membership row (so a workspace is selected) but RLS admits
    // no rows for the roster read. This is the state a page must render as an
    // explained empty view rather than as "0 members".
    const { routes } = routesFor({ subject: OWNER_SUBJECT, roster: [] });
    const { body, error } = await settle(routes, "/workspace/members");
    assert.equal(error, undefined);
    // The array is empty — but the response carries no count field, so no client
    // can render "0 members" as if it were a measurement.
    assert.deepEqual(body, []);
    for (const key of Object.keys(body)) {
      assert.notEqual(key, "count");
      assert.notEqual(key, "member_count");
      assert.notEqual(key, "total");
    }
  });

  test("the members page states the policy reason for an empty roster", () => {
    // The page is the only place the reason can live: the API returns a bare
    // array by contract. Assert the copy exists so it cannot be dropped in a
    // later edit and leave an unlabelled empty table.
    const source = readFileSync(join(REPO_ROOT, "apps/web/src/pages/MembersPage.tsx"), "utf8");
    assert.match(source, /No membership rows are readable for this workspace/);
    assert.match(source, /Row-level security returned no rows/);
    assert.match(source, /membership_self_or_admin_read/);
  });

  test("the members page renders no zero metric and no count-as-measurement copy", () => {
    const source = readFileSync(join(REPO_ROOT, "apps/web/src/pages/MembersPage.tsx"), "utf8");
    // A count of visible rows is fine; the *word* "0" as a metric is not.
    for (const banned of ["0 members", "zero members", "no members exist", "Member count"]) {
      assert.ok(!source.includes(banned), `MembersPage must not render "${banned}"`);
    }
  });

  test("the single-row scope is stated as a scoped view, not a truncation", () => {
    const source = readFileSync(join(REPO_ROOT, "apps/web/src/pages/MembersPage.tsx"), "utf8");
    assert.match(source, /scoped view, not a truncated roster/);
    assert.match(source, /the single row above is your own membership row/);
  });
});

/* -------------------------------------------------------------------------- */
/* Availability and error states                                               */
/* -------------------------------------------------------------------------- */

describe("unavailable is never an empty result", () => {
  test("an unconfigured Supabase is 503 with a reason, not an empty array", async () => {
    const { routes } = routesFor({ supabaseUrl: null });
    for (const path of ["/workspace", "/workspace/members"]) {
      const { body, error } = await settle(routes, path);
      assert.equal(body, undefined, `${path} degraded to an empty result`);
      assert.equal(error.status, 503, path);
      assert.match(error.message, /Control-plane data is unavailable/);
      assert.match(error.message, /EGA_SUPABASE_URL/);
    }
  });

  test("an unreachable database is 503, never a zero-row answer", async () => {
    const calls = [];
    const transport = async (input, init) => {
      calls.push({ pathname: new URL(input).pathname, headerNames: Object.keys(init.headers).sort() });
      if (new URL(input).pathname === "/auth/v1/user") {
        return jsonResponse(200, { id: MEMBER_SUBJECT });
      }
      throw new TypeError("fetch failed");
    };
    const reader = createControlPlaneReader({ supabaseUrl: SUPABASE_URL, transport });
    const routes = buildWorkspaceRoutes(BOUNDS, reader);
    const { body, error } = await settle(routes, "/workspace/members");
    assert.equal(body, undefined);
    assert.equal(error.status, 503);
    assert.match(error.message, /could not be reached/);
    // Even on failure the credential set is unchanged.
    for (const entry of calls) assert.deepEqual(entry.headerNames, ["accept", "authorization"]);
  });

  test("a rejected session is 401 and the upstream body is dropped", async () => {
    const transport = async (input) => {
      const url = new URL(input);
      if (url.pathname === "/auth/v1/user") {
        return jsonResponse(401, { msg: SECRET_MARKERS.upstreamBody, hint: SECRET_MARKERS.path });
      }
      return jsonResponse(200, []);
    };
    const reader = createControlPlaneReader({ supabaseUrl: SUPABASE_URL, transport });
    const routes = buildWorkspaceRoutes(BOUNDS, reader);
    const { error } = await settle(routes, "/workspace");
    assert.equal(error.status, 401);
    assert.equal(error.code, "E_WEB_UNAUTHENTICATED");
    assert.ok(!error.message.includes(SECRET_MARKERS.upstreamBody));
    assert.ok(!error.message.includes(SECRET_MARKERS.path));
  });

  test("a malformed upstream row is refused rather than rendered", async () => {
    // A row whose role is not one of the five, or whose subject is not subject
    // shaped, must fail loudly. Rendering it would put an unvalidated value on a
    // page under a column heading that asserts a constraint.
    const { routes } = routesFor({
      subject: OWNER_SUBJECT,
      memberships: [membership({ subject: OWNER_SUBJECT, role: "superuser" })],
      workspaces: [{ id: WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: NOW }],
    });
    const { body, error } = await settle(routes, "/workspace/members");
    assert.equal(body, undefined);
    assert.equal(error.status, 502);
    assert.equal(error.code, WORKSPACE_ROW_INVALID_CODE);
  });

  test("a subject carrying a path or a filter metacharacter is refused", () => {
    // Rule 6 is structural: a subject is validated against a shape, so a value
    // shaped like an absolute path cannot reach a rendered cell.
    const source = readFileSync(join(REPO_ROOT, "apps/web/server/workspace.ts"), "utf8");
    assert.match(source, /const SUBJECT = \/\^\[A-Za-z0-9/);
    assert.match(source, /readSubjectField/);
  });
});

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

describe("reads are bounded and an oversized request is refused", () => {
  test("every table read carries an explicit limit on the wire", async () => {
    const { routes, calls } = routesFor({ subject: OWNER_SUBJECT });
    await settle(routes, "/workspace/members");
    const reads = tableUrls(calls);
    assert.ok(reads.length >= 1);
    for (const url of reads) {
      assert.match(url, /[?&]limit=\d+/, `no explicit limit on ${url}`);
    }
  });

  test("a limit above the ceiling is refused, not clamped", async () => {
    const { routes, calls } = routesFor({ subject: OWNER_SUBJECT });
    const { body, error } = await settle(routes, "/workspace/members", { query: { limit: "5000" } });
    assert.equal(body, undefined);
    assert.equal(error.status, 400);
    assert.equal(error.code, WORKSPACE_QUERY_INVALID_CODE);
    assert.match(error.message, /refused rather than truncated/);
    // No roster read was attempted with the oversized limit.
    const reads = tableUrls(calls).filter((url) => url.includes("workspace_id=eq."));
    assert.equal(reads.length, 0);
  });

  test("a non-integer or zero limit is a 400, not a silent default", async () => {
    for (const limit of ["abc", "0", "-1", "1.5"]) {
      const { routes } = routesFor({ subject: OWNER_SUBJECT });
      const { error } = await settle(routes, "/workspace/members", { query: { limit } });
      assert.equal(error.status, 400, `limit=${limit}`);
      assert.equal(error.code, WORKSPACE_QUERY_INVALID_CODE, `limit=${limit}`);
    }
  });

  test("a limit at the ceiling is accepted and forwarded verbatim", async () => {
    const { routes, calls } = routesFor({ subject: OWNER_SUBJECT });
    const { error } = await settle(routes, "/workspace/members", { query: { limit: "200" } });
    assert.equal(error, undefined);
    const read = tableUrls(calls).find((url) => url.includes("workspace_id=eq."));
    assert.match(read, /limit=200/);
  });

  test("the default page size is the adapter's own ceiling", () => {
    assert.equal(MEMBERS_PAGE_LIMIT, 200);
  });

  test("a bounded read returns at most the requested page size", async () => {
    const many = Array.from({ length: 5 }, (_unused, index) =>
      membership({ subject: `user-${index}`, role: "viewer" }),
    );
    const { routes } = routesFor({ subject: OWNER_SUBJECT, memberships: many });
    const { body, error } = await settle(routes, "/workspace/members", { query: { limit: "3" } });
    assert.equal(error, undefined);
    // A short array is what a bounded read looks like. The page states the limit
    // it was given and never calls the result a complete roster.
    assert.equal(body.length, 3);
  });

  test("an upstream that ignores the limit is refused, not silently truncated", async () => {
    // The dangerous failure is a gateway that dropped `limit`: the console would
    // quietly drop rows at the far end of the page and render the rest as the
    // whole roster. The adapter refuses, and this route passes that refusal on.
    const many = Array.from({ length: 5 }, (_unused, index) =>
      membership({ subject: `user-${index}`, role: "viewer" }),
    );
    const { routes } = routesFor({ subject: OWNER_SUBJECT, memberships: many, ignoreLimit: true });
    const { body, error } = await settle(routes, "/workspace/members", { query: { limit: "3" } });
    assert.equal(body, undefined, "an over-limit response was truncated instead of refused");
    assert.equal(error.status, 502);
    assert.equal(error.code, "E_WEB_READ_UPSTREAM_MALFORMED");
  });
});

/* -------------------------------------------------------------------------- */
/* Response hygiene                                                            */
/* -------------------------------------------------------------------------- */

describe("no secret, path, or SQL reaches a response", async () => {
  test("a successful response body carries none of the markers", async () => {
    const { routes } = routesFor({
      subject: OWNER_SUBJECT,
      memberships: [membership({ subject: OWNER_SUBJECT, role: "owner" })],
      workspaces: [{ id: WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: NOW }],
    });
    for (const path of ["/workspace", "/workspace/members"]) {
      const { body } = await settle(routes, path);
      const serialized = JSON.stringify(body);
      for (const [label, marker] of Object.entries(SECRET_MARKERS)) {
        assert.ok(!serialized.includes(marker), `${path} leaked ${label}`);
      }
      assert.ok(!/select |where |insert |update /i.test(serialized), `${path} leaked SQL`);
      assert.ok(!/\/(?:srv|home|var|etc)\//.test(serialized), `${path} leaked an absolute path`);
    }
  });

  test("no refusal message carries a marker either", async () => {
    const cases = [
      routesFor({ memberships: [membership({ subject: MEMBER_SUBJECT })] }),
      routesFor({ subject: MEMBER_SUBJECT, memberships: [] }),
      routesFor({ supabaseUrl: null }),
    ];
    const paths = ["/workspace", "/workspace/members"];
    for (const { routes } of cases) {
      for (const path of paths) {
        const { error } = await settle(routes, path);
        if (error === undefined) continue;
        for (const [label, marker] of Object.entries(SECRET_MARKERS)) {
          assert.ok(!error.message.includes(marker), `${path} refusal leaked ${label}`);
        }
        assert.ok(!/\/(?:srv|home|var|etc)\//.test(error.message));
      }
    }
  });

  test("the pages render no mutation control and no write affordance", () => {
    for (const page of ["MembersPage.tsx", "WorkspaceOverviewPage.tsx"]) {
      const source = readFileSync(join(REPO_ROOT, "apps/web/src/pages", page), "utf8");
      for (const banned of [
        "<form",
        "<button",
        "method=\"post\"",
        "onSubmit",
        "Add member",
        "Remove",
        "Change role",
        "Transfer ownership",
        "Revoke",
        "Deactivate",
      ]) {
        assert.ok(!source.includes(banned), `${page} must not render ${banned}`);
      }
    }
  });

  test("the pages render no client-side widening of the visible rows", () => {
    for (const page of ["MembersPage.tsx", "WorkspaceOverviewPage.tsx"]) {
      const source = readFileSync(join(REPO_ROOT, "apps/web/src/pages", page), "utf8");
      // No filter over the received rows: any such control would have to run on
      // rows the session may not see and would read as a wider view.
      for (const banned of ["rows.filter", "rows.map", ".sort(", "useState<readonly MemberRow"]) {
        assert.ok(!source.includes(banned), `${page} must not transform the row set (${banned})`);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* States a page must be able to render                                        */
/* -------------------------------------------------------------------------- */

describe("every required page state has a rendering path", () => {
  test("both pages render through ResourceSection, which owns the state switch", async () => {
    for (const page of ["MembersPage.tsx", "WorkspaceOverviewPage.tsx"]) {
      const source = readFileSync(join(REPO_ROOT, "apps/web/src/pages", page), "utf8");
      assert.match(source, /<ResourceSection/, `${page} must render through ResourceSection`);
      // loading, error/unauthorized/unavailable, empty, and content are the four
      // branches ResourceSection implements; a page opting out of one cannot.
      assert.match(source, /loadingLabel=/);
      assert.match(source, /reload=\{resource\.reload\}/);
    }
  });

  test("loading, loaded, empty, unauthorized, unavailable, and error are all reachable", async () => {
    // loading/loaded/empty are client-side states driven by ResourceSection; the
    // server states are asserted here end to end.
    const states = {
      loaded: await settle(
        routesFor({
          subject: OWNER_SUBJECT,
          memberships: [membership({ subject: OWNER_SUBJECT, role: "owner" })],
          workspaces: [{ id: WORKSPACE_ID, owner_subject: OWNER_SUBJECT, created_at: NOW }],
        }).routes,
        "/workspace",
      ),
      empty: await settle(routesFor({ subject: OWNER_SUBJECT, roster: [] }).routes, "/workspace/members"),
      unauthorized: await settle(routesFor({ memberships: [membership({ subject: MEMBER_SUBJECT })] }).routes, "/workspace"),
      unavailable: await settle(routesFor({ supabaseUrl: null }).routes, "/workspace"),
      error: await (async () => {
        const transport = async (input, init) => {
          if (new URL(input).pathname === "/auth/v1/user") return jsonResponse(200, { id: MEMBER_SUBJECT });
          return jsonResponse(500, { msg: SECRET_MARKERS.upstreamBody });
        };
        const reader = createControlPlaneReader({ supabaseUrl: SUPABASE_URL, transport });
        return settle(buildWorkspaceRoutes(BOUNDS, reader), "/workspace/members");
      })(),
    };
    assert.equal(states.loaded.error, undefined);
    assert.ok(states.loaded.body.owner_subject === OWNER_SUBJECT);
    assert.deepEqual(states.empty.body, []);
    assert.equal(states.unauthorized.error.status, 403);
    assert.equal(states.unavailable.error.status, 503);
    assert.ok(states.error.error.status >= 500);
    assert.ok(!states.error.error.message.includes(SECRET_MARKERS.upstreamBody));
  });
});