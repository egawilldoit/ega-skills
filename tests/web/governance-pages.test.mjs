/**
 * Builder C — quotas, security denies, audit events.
 *
 * ## What this suite proves, and what it deliberately cannot
 *
 * There is no DOM test harness in this repository and this builder is not adding
 * one: introducing jsdom or a React testing library means editing
 * `apps/web/package.json`, which is a shared file outside this builder's file
 * set. So the coverage splits honestly in two, and the split is stated rather
 * than papered over:
 *
 * - **The server routes are driven for real.** `createGovernanceRoutes` is built
 *   with the real `createControlPlaneReader` from
 *   `apps/web/server/supabase-read.ts` and a recording transport, exactly as
 *   `tests/web/supabase-read.test.mjs` does, so every HTTP state, every status
 *   code, every refusal-before-network, and every recorded header is asserted
 *   against code that will actually run.
 * - **The React components are read as source.** The page `.tsx` files are
 *   scanned for the copy and wiring that carry the honesty rules, because that
 *   copy *is* the rule: a page that renders `0 requests` is wrong in a way no
 *   amount of server-side testing detects. `.tsx` cannot be imported by
 *   `node --test` without a JSX transform, so the filter predicates inside
 *   `AuditPage.tsx` are covered statically rather than behaviourally. That gap is
 *   real and is reported to the lead rather than hidden.
 *
 * Nothing here is a smoke test written to pass. The assertions that matter most
 * are the ones that would fail on a plausible wrong implementation.
 *
 * ## The headline assertion
 *
 * `describe("an empty table is an absence, never a zero")`. `quota_usage`,
 * `security_denies`, and `audit_events` have **no production writer anywhere in
 * this repository** — the only `insert into` statements naming them are in
 * `tests/rls/seed.sql` and `tests/web/cross-workspace-isolation.test.mjs`. An
 * empty result set is therefore the expected state of a real deployment, and
 * rendering it as `0 requests` or `0 events` would assert a measurement that was
 * never taken. This suite checks the payload carries a stated reason instead of a
 * zero, and that the page renders that reason rather than a number.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import { errorKindForStatus, isRetryableStatus } from "../../apps/web/src/api/client.ts";
import { isApiError } from "../../apps/web/src/api/contracts.ts";
import {
  AUDIT_NOT_ANALYTICS_NOTE,
  EMPTY_AUDIT_REASON,
  EMPTY_DENY_REASON,
  EMPTY_USAGE_REASON,
  GOVERNANCE_ROUTE_IDS,
  GOVERNANCE_ROUTE_PATHS,
  NULL_POLICY_REASON,
  POLICY_ENFORCEMENT_NOTE,
  createGovernanceRoutes,
} from "../../apps/web/server/governance.ts";
import {
  CONTROL_PLANE_MAX_LIMIT,
  CONTROL_PLANE_MAX_OFFSET,
  createControlPlaneReader,
} from "../../apps/web/server/supabase-read.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The server module under test, read for the static assertions. */
const SERVER_MODULE = join(REPO_ROOT, "apps", "web", "server", "governance.ts");

/** Read one of the three governance pages as source. */
function pageSource(name) {
  return readFileSync(join(REPO_ROOT, "apps", "web", "src", "pages", `${name}.tsx`), "utf8");
}

/** A syntactically plausible but entirely fictional session token. */
const CALLER_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyL2MiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.not-a-real-signature-part";

/** A second fictional token, so "the caller's own" is actually testable. */
const OTHER_CALLER_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyL2QiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.not-a-real-signature-part";

const CALLER_SUBJECT = "user-c";
const OTHER_CALLER_SUBJECT = "user-d";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";

/** The privileged credential that must never be used. Never a real value. */
const SERVICE_SECRET = "c-fixture-privileged-supabase-secret-value";
const ABSOLUTE_PATH = "/srv/app/supabase-project/secret-notes.txt";

/** Values that must never appear in a URL, a response body, or rendered copy. */
const SECRET_MARKERS = Object.freeze({
  secret: SERVICE_SECRET,
  path: ABSOLUTE_PATH,
  upstreamBody: "upstream-body-must-not-be-echoed",
  upstreamHost: "internal-postgrest.fixture.invalid",
});

/** Bounds small enough to keep the suite fast; the real defaults live in `api.ts`. */
const BOUNDS = Object.freeze({
  maxResponseBytes: 65_536,
  requestTimeoutMs: 5_000,
  maxConcurrentRequests: 4,
});

/* -------------------------------------------------------------------------- */
/* Fixture transport                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Recording transport.
 *
 * Every call is stored with its URL and headers so a test asserts what the
 * adapter *did*, not what it intended. `respond` returns the "upstream" reply.
 */
function spyTransport(respond) {
  const calls = [];
  const transport = async (input, init) => {
    calls.push({ url: input, method: init.method, headers: init.headers });
    return await respond(input, init, calls.length - 1);
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

/**
 * Strip comments so a static assertion sees code, not prose.
 *
 * Several assertions below scan for tokens that are *also* words in an
 * explanatory comment: "insert into" in a paragraph about which tables have a
 * writer, "utilisation" in a sentence explaining why there is no utilisation bar,
 * `target_identity` in a note about the filter that does not exist. Without this
 * helper those tests would fail on the explanation and pass on broken code, which
 * is exactly backwards. Comments are documentation; the assertions are about
 * behaviour.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** One page with its comments removed. */
function pageCode(name) {
  return stripComments(pageSource(name));
}

/** The server module with its comments removed. */
function serverCode() {
  return stripComments(readFileSync(SERVER_MODULE, "utf8"));
}

/**
 * Collapse a multi-line string concatenation into the text it evaluates to.
 *
 * The server copy is an *evaluated* value -- `"a " + "b"` has already become
 * `"a b"` by the time a test imports it. The same copy sitting in a page is still
 * source text, quotes and `+` and line breaks included. Comparing raw source
 * against a value can therefore never match, and would fail for a reason that has
 * nothing to do with drift. This puts both sides in the same form.
 */
function flattenLiterals(source) {
  return source
    .replace(/"\s*\+\s*"/g, "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Answer the session probe, then each table from a per-table fixture — **applying
 * the URL's own equality and membership filters**.
 *
 * Honouring the filters is not cosmetic. A fixture that returned every row
 * regardless of `workspace_id=eq.<other>` would make every isolation assertion in
 * this file pass for the wrong reason: the row would come back, so the route's
 * honest handling of an empty result would never be exercised. It also models RLS
 * correctly, since RLS filters rows rather than refusing the query.
 */
function tableRespond(fixtures) {
  return (input) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return jsonResponse(200, { id: CALLER_SUBJECT, role: "authenticated" });
    }
    const table = url.pathname.replace("/rest/v1/", "");
    const rows = Object.prototype.hasOwnProperty.call(fixtures, table) ? fixtures[table] : [];
    // `select` is a projection, not a filter, and `limit`/`offset` bound the page.
    // Every other parameter is an `eq.<value>` or an `in.(a,b)` list, which is all
    // `readAsCaller` builds. Anything else would mean the adapter grew a filter
    // form this fixture does not model, so it fails loudly rather than silently
    // returning the wrong rows.
    const filtered = rows.filter((row) => {
      for (const [column, expression] of url.searchParams) {
        if (column === "select" || column === "limit" || column === "offset") continue;
        const value = String(row[column]);
        if (expression.startsWith("eq.")) {
          if (value !== expression.slice(3)) return false;
        } else if (expression.startsWith("in.(") && expression.endsWith(")")) {
          if (!expression.slice(4, -1).split(",").includes(value)) return false;
        } else {
          throw new Error(`fixture received an unexpected filter expression: ${expression}`);
        }
      }
      return true;
    });
    return jsonResponse(200, filtered);
  };
}

/** Only the table reads — the session probe is not a data read. */
function tableReads(transport) {
  return transport.calls.filter((recorded) => recorded.url.includes("/rest/v1/"));
}

/** The four tables, all empty unless a test says otherwise. */
function fixture({ quota_policies = [], quota_usage = [], security_denies = [], audit_events = [] } = {}) {
  return { quota_policies, quota_usage, security_denies, audit_events };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Build the three routes against a spy transport.
 *
 * The reader is the *real* adapter with an injected transport, not a stub, so
 * every assertion below exercises the allow-list, the URL builder, and the
 * caller-forwarding the whole security argument rests on.
 */
function routesWith(respond, { supabaseUrl = "https://console-fixture.supabase.co", bounds = BOUNDS } = {}) {
  const transport = spyTransport(respond);
  const reader = createControlPlaneReader({ supabaseUrl, transport });
  const routes = createGovernanceRoutes({ bounds, reader });
  return { routes, transport, byPath: new Map(routes.map((route) => [route.path, route])) };
}

const AUTH_HEADERS = Object.freeze({ authorization: `Bearer ${CALLER_TOKEN}` });

function contextFor(pathname, { query = "", method = "GET", headers = AUTH_HEADERS } = {}) {
  return {
    method,
    pathname,
    query: new URLSearchParams(query),
    params: {},
    request: { headers },
  };
}

/** Call a route and return `{ ok, status, body, error }`. Never throws. */
async function call(byPath, pathname, options = {}) {
  const route = byPath.get(pathname);
  assert.ok(route !== undefined, `no route registered at ${pathname}`);
  try {
    const body = await route.handle(contextFor(pathname, options));
    return { ok: true, status: 200, body, error: null };
  } catch (error) {
    return {
      ok: false,
      status: typeof error?.status === "number" ? error.status : 0,
      body: null,
      error,
    };
  }
}

/** A query string carrying the workspace filter. */
function workspaceQuery(extra = "") {
  const parts = [`workspace_id=${WORKSPACE}`];
  if (extra !== "") parts.push(extra);
  return parts.join("&");
}

/* -------------------------------------------------------------------------- */
/* Fixtures shaped exactly like the migration columns                          */
/* -------------------------------------------------------------------------- */

const POLICY_ROW = {
  workspace_id: WORKSPACE,
  requests_per_minute: 120,
  concurrent_requests: 8,
  bandwidth_bytes: 2_147_483_648,
};

const USAGE_ROW = {
  workspace_id: WORKSPACE,
  window_started: "2026-09-09T00:00:00.000Z",
  request_count: 4211,
  bandwidth_bytes: 88_412_331,
};

const DENY_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  workspace_id: WORKSPACE,
  kind: "skill",
  identity: "anthropic/claude-api",
  reason: "withdrawn by the publisher",
  created_at: "2026-09-09T12:00:00.000Z",
};

/** `audit_events.id` is `bigint`; PostgREST serializes it as a JSON number. */
const AUDIT_ROW = {
  id: 1042,
  workspace_id: WORKSPACE,
  actor_subject: CALLER_SUBJECT,
  operation: "context.publish",
  target_identity: `sha256:${"a".repeat(64)}`,
  old_identity: null,
  new_identity: null,
  request_id: "req-0000-1111",
  result: "allowed",
  created_at: "2026-09-09T12:00:00.000Z",
};

/* -------------------------------------------------------------------------- */
/* 1. Route registration                                                       */
/* -------------------------------------------------------------------------- */

describe("the governance route table", () => {
  test("registers exactly the three declared routes, at the client's paths", () => {
    const { routes } = routesWith(tableRespond(fixture()));
    assert.deepEqual(
      routes.map((route) => [route.id, route.path]),
      [
        ["workspace-quotas", "/workspace/quotas"],
        ["security-denies", "/workspace/security/denies"],
        ["audit-events", "/audit"],
      ],
    );
    // The exports the lead wires against must agree with the table itself.
    assert.deepEqual(GOVERNANCE_ROUTE_IDS, ["workspace-quotas", "security-denies", "audit-events"]);
    assert.deepEqual(GOVERNANCE_ROUTE_PATHS, [
      "/workspace/quotas",
      "/workspace/security/denies",
      "/audit",
    ]);
  });

  test("every route answers GET and nothing else", () => {
    const { byPath } = routesWith(tableRespond(fixture()));
    for (const [path, route] of byPath) {
      assert.deepEqual([...route.methods], ["GET"], `${path} is not GET-only`);
    }
  });

  test("the paths match API_ENDPOINTS, so the SPA and the BFF cannot disagree", () => {
    const client = readFileSync(join(REPO_ROOT, "apps", "web", "src", "api", "client.ts"), "utf8");
    // Asserted against the client's own declarations rather than a copy of them,
    // so a rename on either side breaks here.
    assert.match(client, /workspaceQuotas:\s*\(\)\s*=>\s*"\/workspace\/quotas"/);
    assert.match(client, /securityDenies:\s*"\/workspace\/security\/denies"/);
    assert.match(client, /auditEvents:\s*"\/audit"/);
  });

  test("a write verb is refused before the session probe reaches the network", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    for (const path of GOVERNANCE_ROUTE_PATHS) {
      const result = await call(byPath, path, { method: "POST" });
      assert.equal(result.status, 405, `${path} accepted POST`);
      assert.equal(result.error.code, "E_METHOD_NOT_ALLOWED");
    }
    assert.equal(transport.calls.length, 0, "a write verb reached the database");
  });

  test("an unauthenticated request is refused before any handler runs", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    for (const path of GOVERNANCE_ROUTE_PATHS) {
      const result = await call(byPath, path, { headers: {} });
      assert.equal(result.status, 401, `${path} served an unauthenticated caller`);
      assert.equal(result.error.code, "E_WEB_UNAUTHENTICATED");
    }
    assert.equal(transport.calls.length, 0, "an unauthenticated request reached the database");
  });

  test("a non-Bearer credential is refused without reaching the network", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    for (const presented of [
      { authorization: "Basic dXNlcjpwYXNz" },
      { authorization: CALLER_TOKEN },
      { authorization: "Bearer " },
      { authorization: `Bearer ${CALLER_TOKEN}, Bearer ${OTHER_CALLER_TOKEN}` },
    ]) {
      const result = await call(byPath, "/audit", { headers: presented });
      assert.equal(result.status, 401, `${JSON.stringify(presented)} was accepted`);
    }
    assert.equal(transport.calls.length, 0);
  });

  test("a rejected session is a 401, and the upstream body is dropped", async () => {
    const { byPath } = routesWith((input) =>
      new URL(input).pathname === "/auth/v1/user"
        ? jsonResponse(401, { detail: SECRET_MARKERS.secret, hint: ABSOLUTE_PATH })
        : jsonResponse(200, []),
    );
    const result = await call(byPath, "/audit");
    assert.equal(result.status, 401);
    assert.doesNotMatch(result.error.message, /fixture-supabase-secret/);
    assert.doesNotMatch(result.error.message, /\/srv\/app/);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. No privileged credential, ever                                           */
/* -------------------------------------------------------------------------- */

describe("the caller's own token is the only credential", () => {
  test("every recorded request carries exactly accept and authorization", async () => {
    // This is the assertion the whole control-plane argument rests on. The
    // adapter's `callerHeaders` builds one frozen record; if a route, a later
    // edit, or a stray default ever added `apikey` or a service header, this
    // fails with the offending header name in the diff.
    const { byPath, transport } = routesWith(
      tableRespond(
        fixture({
          quota_policies: [POLICY_ROW],
          quota_usage: [USAGE_ROW],
          security_denies: [DENY_ROW],
          audit_events: [AUDIT_ROW],
        }),
      ),
    );

    await call(byPath, "/workspace/quotas", { query: workspaceQuery() });
    await call(byPath, "/workspace/security/denies");
    await call(byPath, "/audit");

    assert.ok(tableReads(transport).length > 0, "no request was recorded, so nothing was asserted");
    for (const recorded of transport.calls) {
      assert.deepEqual(Object.keys(recorded.headers).sort(), ["accept", "authorization"]);
      assert.equal(recorded.headers["accept"], "application/json");
      assert.match(recorded.headers["authorization"], /^Bearer /);
      // The only tokens that may appear are the two fictional callers'.
      assert.ok(
        recorded.headers["authorization"] === `Bearer ${CALLER_TOKEN}` ||
          recorded.headers["authorization"] === `Bearer ${OTHER_CALLER_TOKEN}`,
        `unexpected credential: ${recorded.headers["authorization"]}`,
      );
      assert.doesNotMatch(recorded.headers["authorization"], /service|secret|apikey/i);
    }
  });

  test("EGA_SUPABASE_SECRET_KEY appears nowhere in the governance module", () => {
    // Static rather than behavioural: the strongest form of this claim is that the
    // identifier is absent, so there is nothing to thread and no code path that
    // could read it.
    const source = readFileSync(SERVER_MODULE, "utf8");
    assert.doesNotMatch(source, /EGA_SUPABASE_SECRET_KEY/);
    assert.doesNotMatch(source, /supabaseSecretKey/);
    assert.doesNotMatch(source, /service[_-]?role/i);
    // Nor a browser-substituted key.
    assert.doesNotMatch(source, /["'`]VITE_[A-Z0-9_]+["'`]/);
  });

  test("each caller's own token is forwarded, not a shared one", async () => {
    // Two callers, one reader each. If the route cached a caller or reached for a
    // deployment-wide token, the second request would carry the first's.
    const first = routesWith(tableRespond(fixture()));
    await call(first.byPath, "/audit");
    assert.ok(
      first.transport.calls.some((c) => c.headers["authorization"] === `Bearer ${CALLER_TOKEN}`),
      "the first caller's token was not forwarded",
    );

    const second = routesWith(
      (input) =>
        new URL(input).pathname === "/auth/v1/user"
          ? jsonResponse(200, { id: OTHER_CALLER_SUBJECT })
          : jsonResponse(200, []),
    );
    await call(second.byPath, "/audit", {
      headers: { authorization: `Bearer ${OTHER_CALLER_TOKEN}` },
    });
    assert.ok(
      second.transport.calls.some((c) => c.headers["authorization"] === `Bearer ${OTHER_CALLER_TOKEN}`),
      "the second caller's own token was not forwarded",
    );
    assert.ok(
      !second.transport.calls.some((c) => c.headers["authorization"] === `Bearer ${CALLER_TOKEN}`),
      "the first caller's token leaked into the second caller's request",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. THE HEADLINE: an empty table is an absence, never a zero                 */
/* -------------------------------------------------------------------------- */

describe("an empty table is an absence, never a zero", () => {
  test("empty quota_usage reports a stated reason and no count at all", async () => {
    const { byPath } = routesWith(tableRespond(fixture({ quota_policies: [POLICY_ROW] })));
    const result = await call(byPath, "/workspace/quotas", { query: workspaceQuery() });

    assert.ok(result.ok, `expected 200, got ${result.status}`);
    assert.deepEqual(result.body.usage, [], "usage should be an empty array");
    assert.equal(result.body.usage_unavailable_reason, EMPTY_USAGE_REASON);

    // The reason must name the absence and refuse the zero reading.
    assert.match(EMPTY_USAGE_REASON, /No quota usage has been recorded/);
    assert.match(EMPTY_USAGE_REASON, /not a measurement of zero/);

    // Nothing anywhere in the payload may look like a measured zero. A
    // `request_count: 0` or a `total_requests: 0` anywhere in the body is the exact
    // failure this rule exists to prevent.
    const serialised = JSON.stringify(result.body);
    assert.doesNotMatch(
      serialised,
      /"(request_count|bandwidth_bytes|total_requests|requests|events)"\s*:\s*0\b/,
    );
    assert.doesNotMatch(serialised, /0 requests/i);
    assert.doesNotMatch(serialised, /0 events/i);
  });

  test("a missing policy row says so, and denies that no limit applies", async () => {
    const { byPath } = routesWith(tableRespond(fixture()));
    const result = await call(byPath, "/workspace/quotas", { query: workspaceQuery() });

    assert.equal(result.body.policy, null);
    assert.equal(result.body.policy_unavailable_reason, NULL_POLICY_REASON);
    // The load-bearing clause: "no policy row" must never read as "no limit".
    assert.match(NULL_POLICY_REASON, /Neither means the runtime applies no limit/);
    // A null policy is not three zeros.
    assert.doesNotMatch(JSON.stringify(result.body), /:\s*0\b/);
  });

  test("both reasons are non-null exactly when their subject is absent", async () => {
    const { byPath } = routesWith(
      tableRespond(fixture({ quota_policies: [POLICY_ROW], quota_usage: [USAGE_ROW] })),
    );
    const populated = await call(byPath, "/workspace/quotas", { query: workspaceQuery() });
    assert.equal(populated.body.policy_unavailable_reason, null, "a present policy carried a reason");
    assert.equal(populated.body.usage_unavailable_reason, null, "a present series carried a reason");
    assert.equal(populated.body.usage.length, 1);
  });

  test("empty audit_events returns an empty array and the page states why", async () => {
    const { byPath } = routesWith(tableRespond(fixture()));
    const result = await call(byPath, "/audit");
    assert.deepEqual(result.body, [], "an empty log should be an empty array");
    assert.match(EMPTY_AUDIT_REASON, /No audit events have been recorded/);
    assert.match(EMPTY_AUDIT_REASON, /not a count of zero events/);
    // A viewer who legitimately sees none is told the role is a likely cause.
    assert.match(EMPTY_AUDIT_REASON, /owner and admin/);
  });

  test("empty security_denies returns an empty array and never claims nothing is denied", async () => {
    const { byPath } = routesWith(tableRespond(fixture()));
    const result = await call(byPath, "/workspace/security/denies");
    assert.deepEqual(result.body, []);
    // The load-bearing claim: these rows are not the whole enforced policy.
    assert.match(EMPTY_DENY_REASON, /not the whole enforced policy/);
    assert.doesNotMatch(EMPTY_DENY_REASON, /no identity is currently denied/i);
  });

  test("no page renders a zero metric in any render position", () => {
    // The crude version of this test banned the words "0 requests" and
    // "0 events" anywhere in a page -- which failed on this file's own copy
    // saying "not a measurement of zero requests". That is the wrong instrument:
    // the rule is about what a page *renders*, not about which words appear in a
    // sentence that denies the zero reading. So this asserts the render positions
    // instead, and leaves the prose to the assertions above.
    for (const name of ["QuotasPage", "SecurityPage", "AuditPage"]) {
      const code = pageCode(name);
      // No JSX expression may render a bare zero.
      assert.doesNotMatch(code, /\{0\}/, `${name} renders a literal zero`);
      assert.doesNotMatch(code, />0</, `${name} renders a literal zero as cell text`);
      assert.doesNotMatch(code, /\{zero\}/i, `${name} renders a zero variable`);
      // No label may be paired with a zero.
      assert.doesNotMatch(
        code,
        /\b(requests?|events?|denies|bandwidth|count|total)\s*[:=]\s*0\b/i,
        `${name} pairs a metric label with a zero`,
      );
      // Every empty-state title and reason is a sentence, not a number. The
      // reason matters as much as the title: a page can title an empty state
      // honestly and then explain it with "0 requests" in the body.
      for (const match of code.matchAll(/(?:title|reason)="([^"]*)"/g)) {
        assert.doesNotMatch(
          match[1],
          /\b0\b/,
          `${name} renders an empty-state string containing a zero: ${match[1]}`,
        );
      }
    }
  });

  test("a count is only rendered where the empty branch has already fired", () => {
    // The structural form of "never a zero": the array length that would render 0
    // is behind a guard that shows an EmptyState first, so the 0 is unreachable.
    const quotas = pageCode("QuotasPage");
    assert.match(
      quotas,
      /data\.usage\.length === 0 \? \(\s*<EmptyState/,
      "the usage count is not guarded by an empty state",
    );
    assert.match(
      quotas,
      /data\.policy === null \? \(\s*<UnavailableState/,
      "the policy is not guarded by an unavailable state",
    );
    const audit = pageCode("AuditPage");
    assert.match(
      audit,
      /data\.length === 0 \? \(\s*<EmptyState/,
      "the audit event count is not guarded by an empty state",
    );
    const security = pageCode("SecurityPage");
    assert.match(
      security,
      /data\.length === 0 \? \(\s*<EmptyState/,
      "the deny count is not guarded by an empty state",
    );
  });

  test("each page renders the server's stated reason, not a paraphrase of it", () => {
    // A paraphrase is where a zero creeps back in, so the page must render the
    // server's own `*_unavailable_reason` rather than re-deriving a sentence.
    assert.match(
      pageCode("QuotasPage"),
      /data\.usage_unavailable_reason \?\? USAGE_FALLBACK_REASON/,
      "QuotasPage does not render the server's usage reason",
    );
    assert.match(
      pageCode("QuotasPage"),
      /data\.policy_unavailable_reason \?\? POLICY_FALLBACK_REASON/,
      "QuotasPage does not render the server's policy reason",
    );
    // The fallbacks exist for the case where the server sent a loaded view with
    // no reason, and they deny the zero reading just as firmly.
    for (const [label, fallback] of [
      ["USAGE_FALLBACK_REASON", "No quota usage has been recorded"],
      ["POLICY_FALLBACK_REASON", "applies no limit"],
    ]) {
      const block = new RegExp(`const ${label} =([\\s\\S]*?);`).exec(pageSource("QuotasPage"));
      assert.ok(block !== null, `${label} is missing`);
      assert.ok(
        block[1].includes(fallback),
        `${label} does not carry "${fallback}"`,
      );
    }
  });

  test("the pages state the exact empty messages", () => {
    assert.match(pageSource("QuotasPage"), /title="No quota usage has been recorded"/);
    assert.match(pageSource("AuditPage"), /title="No audit events have been recorded"/);
    assert.match(pageSource("SecurityPage"), /title="No recorded deny rows"/);
  });

  test("the pages that own their copy keep it identical to the server's", () => {
    // `SecurityDenyRow[]` is a flat array with no reason field, so SecurityPage
    // and AuditPage own the sentence and it must stay identical to the server's
    // exported copy. QuotasPage is deliberately excluded: `WorkspaceQuotaView`
    // carries `usage_unavailable_reason`, so that page renders the server's
    // string at runtime and embeds only a fallback -- asserted separately above.
    for (const [name, serverCopy] of [
      ["SecurityPage", EMPTY_DENY_REASON],
      ["AuditPage", EMPTY_AUDIT_REASON],
    ]) {
      assert.ok(
        flattenLiterals(pageSource(name)).includes(serverCopy.replace(/\s+/g, " ").trim()),
        `${name}'s empty-state copy drifted from the server's`,
      );
    }
  });

  test("the pages carry no production writer for these tables, so empty is expected", () => {
    // The premise the whole rule rests on, verified rather than assumed. If a
    // writer appeared, the empty-state copy would need revisiting — so this test
    // is also the canary for that.
    const code = serverCode();
    for (const verb of ["insert into", "update ", "delete from", "upsert"]) {
      assert.doesNotMatch(code, new RegExp(verb, "i"), `governance.ts contains "${verb}"`);
    }
    const runtime = readFileSync(
      join(REPO_ROOT, "packages", "mcp", "src", "hosted-runtime.ts"),
      "utf8",
    );
    for (const table of ["quota_usage", "security_denies", "audit_events"]) {
      assert.doesNotMatch(runtime, new RegExp(table), `the hosted runtime writes ${table}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. quota_policies is displayed, not enforced                                 */
/* -------------------------------------------------------------------------- */

describe("the quota page cannot imply an enforcement mechanism that does not exist", () => {
  test("the enforcement note names the environment values that are real", () => {
    assert.match(POLICY_ENFORCEMENT_NOTE, /the hosted runtime does not read quota_policies/);
    assert.match(POLICY_ENFORCEMENT_NOTE, /EGA_HOSTED_MAX_BODY_BYTES/);
    assert.match(POLICY_ENFORCEMENT_NOTE, /EGA_HOSTED_MAX_RESPONSE_BYTES/);
    assert.match(POLICY_ENFORCEMENT_NOTE, /EGA_HOSTED_MAX_CONCURRENT_REQUESTS/);
    assert.match(POLICY_ENFORCEMENT_NOTE, /EGA_HOSTED_REQUEST_TIMEOUT_MS/);
    assert.match(
      POLICY_ENFORCEMENT_NOTE,
      /would not change a single served request/,
      "the note must say editing the row changes nothing",
    );
    assert.match(POLICY_ENFORCEMENT_NOTE, /no requests-per-minute enforcement/);
  });

  test("the page puts that note above the numbers, with no utilisation bar", () => {
    const source = pageSource("QuotasPage");
    const code = pageCode("QuotasPage");
    const noteAt = source.indexOf("QUOTA_POLICY_ENFORCEMENT_NOTE}");
    const numbersAt = source.indexOf("Requests per minute");
    assert.ok(noteAt > 0 && numbersAt > 0, "the note or the numbers are missing");
    // Rendered before the policy fields, not after them as a footnote: a footnote
    // below three large numbers does not stop the wrong reading.
    assert.ok(noteAt < numbersAt, "the enforcement note is rendered below the policy numbers");

    // A utilisation bar would be usage/policy — a real denominator over a
    // fabricated numerator, since quota_usage has no writer.
    for (const banned of ["progress", "<meter", "utilization", "utilisation", "percentUsed", "ratio"]) {
      assert.ok(!code.toLowerCase().includes(banned.toLowerCase()), `QuotasPage renders a ${banned}`);
    }
    // The page's copy must make the same claim as the server's, character for
    // character once both sides are flattened.
    assert.ok(
      flattenLiterals(source).includes(POLICY_ENFORCEMENT_NOTE.replace(/\s+/g, " ").trim()),
      "the page's enforcement note drifted from the server's",
    );
  });

  test("nothing outside this console reads or enforces quota_policies", () => {
    // The claim is only honest if it is true. Anything under packages/ that
    // enforced these numbers would contradict the note.
    const runtime = readFileSync(
      join(REPO_ROOT, "packages", "mcp", "src", "hosted-runtime.ts"),
      "utf8",
    );
    assert.doesNotMatch(runtime, /quota_policies/);
    assert.doesNotMatch(runtime, /requests_per_minute/);
    // And the process-level values the note names are genuinely read.
    for (const name of [
      "EGA_HOSTED_MAX_BODY_BYTES",
      "EGA_HOSTED_MAX_RESPONSE_BYTES",
      "EGA_HOSTED_MAX_CONCURRENT_REQUESTS",
      "EGA_HOSTED_REQUEST_TIMEOUT_MS",
    ]) {
      assert.ok(runtime.includes(name), `${name} is named in the note but is not read by the runtime`);
    }
  });

  test("the security page separates the recorded rows from the enforced policy", () => {
    const source = pageSource("SecurityPage");
    assert.match(source, /recorded control-plane denies/i);
    assert.match(source, /not the whole enforced policy/i);
    assert.match(source, /EGA_HOSTED_AUTHZ_JSON/);
    // Must not claim an empty table means nothing is denied.
    assert.doesNotMatch(source, /so no identity here is currently denied/i);
  });

  test("the security note is true: the runtime enforces a separate process-level policy", () => {
    const runtime = readFileSync(
      join(REPO_ROOT, "packages", "mcp", "src", "hosted-runtime.ts"),
      "utf8",
    );
    assert.ok(runtime.includes("EGA_HOSTED_AUTHZ_JSON"), "EGA_HOSTED_AUTHZ_JSON is not read by the runtime");
    assert.match(runtime, /EGA_HOSTED_AUTHZ_JSON.*must fail closed|required; hosted authorization/);
  });

  test("the audit page is labelled control history, not usage analytics", () => {
    const source = pageSource("AuditPage");
    assert.match(source, /not usage analytics/i);
    assert.match(AUDIT_NOT_ANALYTICS_NOTE, /not usage analytics/);
    assert.match(AUDIT_NOT_ANALYTICS_NOTE, /no credential, token, or secret value/);
    // No charting affordance, and no read of a volume column. The banned tokens
    // are deliberately identifiers and element names rather than English words:
    // the banner legitimately says "bandwidth belong to the quota surfaces", so
    // banning the word would fail on the very sentence that keeps the page from
    // being analytics.
    const code = pageCode("AuditPage");
    for (const banned of [
      "<svg",
      "<meter",
      "<canvas",
      "<progress",
      "bandwidth_bytes",
      "request_count",
      "window_started",
      "quota_usage",
    ]) {
      assert.ok(!code.toLowerCase().includes(banned.toLowerCase()), `AuditPage uses ${banned}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Ids are filters, never capabilities                                       */
/* -------------------------------------------------------------------------- */

describe("an id in a request is a filter, never a capability", () => {
  test("another workspace's id yields no rows and a stated reason, not a 403", async () => {
    const { byPath, transport } = routesWith(
      tableRespond(fixture({ quota_policies: [POLICY_ROW], quota_usage: [USAGE_ROW] })),
    );
    const result = await call(byPath, "/workspace/quotas", { query: `workspace_id=${OTHER_WORKSPACE}` });

    // 200 with the honest empty states. A 403 would confirm the workspace exists,
    // which CONTRACT-D §6 forbids; a fabricated row would be worse.
    assert.ok(result.ok, `expected 200 for a filtered-away workspace, got ${result.status}`);
    assert.equal(result.body.policy, null);
    assert.equal(result.body.usage.length, 0);
    assert.equal(result.body.policy_unavailable_reason, NULL_POLICY_REASON);
    assert.equal(result.body.usage_unavailable_reason, EMPTY_USAGE_REASON);

    // The id really was used as a filter, and none of the other workspace's
    // values leaked into the response.
    const readUrl = tableReads(transport).find((c) => c.url.includes("/quota_policies"));
    assert.ok(readUrl, "no policy read was recorded");
    assert.ok(readUrl.url.includes(`workspace_id=eq.${OTHER_WORKSPACE}`), "the id was not sent as a filter");
    assert.ok(
      !JSON.stringify(result.body).includes(String(POLICY_ROW.requests_per_minute)),
      "another workspace's policy number leaked",
    );
    assert.ok(
      !JSON.stringify(result.body).includes(String(USAGE_ROW.request_count)),
      "another workspace's usage leaked",
    );
  });

  test("a security_denies filter for another workspace returns no rows", async () => {
    const { byPath } = routesWith(tableRespond(fixture({ security_denies: [DENY_ROW] })));
    const result = await call(byPath, "/workspace/security/denies", {
      query: `workspace_id=${OTHER_WORKSPACE}`,
    });
    assert.deepEqual(result.body, []);
    assert.ok(!JSON.stringify(result.body).includes(DENY_ROW.identity));
  });

  test("an audit filter for another workspace returns no rows", async () => {
    const { byPath } = routesWith(tableRespond(fixture({ audit_events: [AUDIT_ROW] })));
    const result = await call(byPath, "/audit", { query: `workspace_id=${OTHER_WORKSPACE}` });
    assert.deepEqual(result.body, []);
    assert.ok(!JSON.stringify(result.body).includes(AUDIT_ROW.operation));
  });

  test("workspace_id is required for quotas because the DTO describes one workspace", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    const result = await call(byPath, "/workspace/quotas");
    // A 400, never a default workspace the console invented.
    assert.equal(result.status, 400);
    assert.equal(result.error.code, "E_WEB_QUERY_INVALID");
    assert.match(result.error.message, /workspace_id is required/);
    assert.equal(tableReads(transport).length, 0, "the read was attempted without a scope");
  });

  test("a non-uuid workspace id is refused before the network", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    for (const bad of ["not-a-uuid", "'; drop table audit_events; --", "../../etc/passwd", "1111"]) {
      const result = await call(byPath, "/workspace/quotas", {
        query: `workspace_id=${encodeURIComponent(bad)}`,
      });
      assert.equal(result.status, 400, `${bad} was accepted`);
    }
    assert.equal(tableReads(transport).length, 0, "a malformed id reached the database");
  });

  test("the caller's own filter values are the only ones forwarded, as eq filters", async () => {
    // The plumbing the page's client-side filters rely on at the server boundary:
    // an allow-listed value becomes an `eq.` filter, never a raw fragment.
    const { byPath, transport } = routesWith(tableRespond(fixture({ audit_events: [AUDIT_ROW] })));
    await call(byPath, "/audit", {
      query: `actor=${CALLER_SUBJECT}&operation=context.publish&result=allowed`,
    });
    const read = tableReads(transport).find((c) => c.url.includes("/audit_events"));
    const url = new URL(read.url);
    assert.equal(url.searchParams.get("actor_subject"), `eq.${CALLER_SUBJECT}`);
    assert.equal(url.searchParams.get("operation"), "eq.context.publish");
    assert.equal(url.searchParams.get("result"), "eq.allowed");
    assert.equal(url.searchParams.get("select"), url.searchParams.get("select"));
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Bounded, and refused rather than truncated                                */
/* -------------------------------------------------------------------------- */

describe("every read is bounded and an oversized page is refused, not clamped", () => {
  test("limit above the ceiling is refused on all three routes", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    const oversized = `limit=${CONTROL_PLANE_MAX_LIMIT + 1}`;
    for (const path of GOVERNANCE_ROUTE_PATHS) {
      const query = path === "/workspace/quotas" ? workspaceQuery(oversized) : oversized;
      const result = await call(byPath, path, { query });
      assert.equal(result.status, 400, `${path} accepted limit=${CONTROL_PLANE_MAX_LIMIT + 1}`);
      assert.match(result.error.message, /refused rather than truncated/);
    }
    assert.equal(tableReads(transport).length, 0, "an oversized limit reached the database");
  });

  test("a malformed or out-of-range limit is refused; a blank one falls back to the default", async () => {
    const { byPath } = routesWith(tableRespond(fixture()));
    for (const bad of ["100000", "0", "-5", "2.5", "abc", "1e3", "NaN"]) {
      const result = await call(byPath, "/audit", { query: `limit=${encodeURIComponent(bad)}` });
      assert.equal(result.status, 400, `limit=${bad} was accepted`);
    }
    // A blank value is treated as absent, not as zero, so it serves the default
    // page rather than erroring or clamping.
    const blank = await call(byPath, "/audit", { query: "limit=" });
    assert.ok(blank.ok, "a blank limit should fall back to the default page");
  });

  test("an offset beyond the ceiling is refused", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    for (const bad of [String(CONTROL_PLANE_MAX_OFFSET + 1), "-1", "abc"]) {
      const result = await call(byPath, "/audit", { query: `offset=${bad}` });
      assert.equal(result.status, 400, `offset=${bad} was accepted`);
    }
    assert.equal(tableReads(transport).length, 0);
  });

  test("every request the routes build carries an explicit, non-zero limit", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    await call(byPath, "/workspace/quotas", { query: workspaceQuery() });
    await call(byPath, "/workspace/security/denies");
    await call(byPath, "/audit");
    const reads = tableReads(transport);
    assert.ok(reads.length >= 4, "expected at least one read per route");
    for (const read of reads) {
      assert.match(read.url, /[?&]limit=\d+/, `no explicit limit on ${read.url}`);
      assert.doesNotMatch(read.url, /[?&]limit=0\b/);
    }
  });

  test("the quota policy read asks for one row, because workspace_id is the primary key", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    await call(byPath, "/workspace/quotas", { query: workspaceQuery("limit=200") });
    const policyRead = tableReads(transport).find((c) => c.url.includes("/quota_policies"));
    assert.match(policyRead.url, /[?&]limit=1\b/);
    // The usage read honours the caller's own limit.
    const usageRead = tableReads(transport).find((c) => c.url.includes("/quota_usage"));
    assert.match(usageRead.url, /[?&]limit=200\b/);
  });

  test("the audit page asks for the largest page the adapter permits", () => {
    // Filtering is client-side over one page, so the page must ask for the
    // ceiling rather than the 50-row default, or an operator filtering a window
    // is silently capped below it.
    const source = pageSource("AuditPage");
    assert.match(source, /limit:\s*200/);
  });

  test("a gateway that ignores the limit is refused rather than silently truncated", async () => {
    // The adapter's own row-count guard. A page rendered from a silently truncated
    // array would present an incomplete log as complete.
    const { byPath } = routesWith((input) =>
      new URL(input).pathname === "/auth/v1/user"
        ? jsonResponse(200, { id: CALLER_SUBJECT })
        : jsonResponse(200, [AUDIT_ROW, AUDIT_ROW]),
    );
    const result = await call(byPath, "/audit", { query: "limit=1" });
    assert.equal(result.status, 502);
    assert.match(result.error.message, /more rows than the requested limit/);
  });

  test("too many query parameters is refused", async () => {
    const { byPath } = routesWith(tableRespond(fixture()));
    const many = Array.from({ length: 20 }, (_, i) => `p${i}=1`).join("&");
    const result = await call(byPath, "/audit", { query: many });
    assert.equal(result.status, 400);
  });

  test("an over-long query parameter value is refused", async () => {
    const { byPath } = routesWith(tableRespond(fixture()));
    const result = await call(byPath, "/audit", { query: `actor=${"a".repeat(600)}` });
    assert.equal(result.status, 400);
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Every required state is reachable and rendered distinctly                */
/* -------------------------------------------------------------------------- */

describe("every required state renders, and none of them is a blank screen", () => {
  /** Drive a status into the real client classifier the pages switch on. */
  function asApiError(status, code, message) {
    return {
      kind: errorKindForStatus(status),
      status,
      code,
      message,
      retryable: isRetryableStatus(status),
    };
  }

  test("each server status maps to the ApiError kind the page switches on", async () => {
    // Covers the failure states end to end from the real classifier
    // `ErrorPanel` reads. 200/empty is exercised by the headline block above.
    const cases = [
      { kind: "unauthorized", status: 401, code: "E_WEB_UNAUTHENTICATED" },
      { kind: "forbidden", status: 403, code: "E_WEB_CONTROL_PLANE_FORBIDDEN" },
      { kind: "not_found", status: 404, code: "E_NOT_FOUND" },
      { kind: "unavailable", status: 503, code: "E_WEB_READ_UNAVAILABLE" },
      { kind: "server", status: 502, code: "E_WEB_READ_UPSTREAM_MALFORMED" },
    ];
    for (const testCase of cases) {
      const error = asApiError(testCase.status, testCase.code, "reason");
      assert.equal(error.kind, testCase.kind, `${testCase.status} did not map to ${testCase.kind}`);
      assert.ok(isApiError(error), `${testCase.status} produced an unrecognised error shape`);
    }
  });

  test("a 503 is retriable and a 4xx is not, so the retry affordance is honest", () => {
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(502), true);
    assert.equal(isRetryableStatus(504), true);
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(403), false);
  });

  test("unavailable (Supabase not configured) is a 503 with a reason, never an empty list", async () => {
    // The most important failure mode: a deployment with no Supabase configured
    // must not look like a workspace with no data.
    const { byPath } = routesWith(tableRespond(fixture()), { supabaseUrl: null });
    const result = await call(byPath, "/workspace/quotas", { query: workspaceQuery() });
    assert.equal(result.status, 503);
    assert.equal(result.error.code, "E_WEB_READ_UNAVAILABLE");
    assert.match(result.error.message, /EGA_SUPABASE_URL is not configured/);
    assert.match(result.error.message, /Control-plane data is unavailable/);
    // Explicitly not a 200 with an empty array.
    assert.equal(result.body, null);
  });

  test("every route reports unavailable rather than empty when Supabase is unconfigured", async () => {
    const { byPath } = routesWith(tableRespond(fixture()), { supabaseUrl: null });
    for (const path of GOVERNANCE_ROUTE_PATHS) {
      const query = path === "/workspace/quotas" ? workspaceQuery() : "";
      const result = await call(byPath, path, { query });
      assert.equal(result.status, 503, `${path} did not report unavailable`);
      assert.equal(result.body, null, `${path} returned a body for an unavailable read`);
    }
  });

  test("an unreachable database is a 503, and the transport error is not echoed", async () => {
    const { byPath } = routesWith(() => {
      throw new Error(`connect ECONNREFUSED ${SECRET_MARKERS.upstreamHost} ${ABSOLUTE_PATH}`);
    });
    const result = await call(byPath, "/audit");
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.error.message, /fixture\.invalid/);
    assert.doesNotMatch(result.error.message, /\/srv\/app/);
  });

  test("a table missing from the deployment is a 503, not a 404 that implies no data", async () => {
    const { byPath } = routesWith((input) =>
      new URL(input).pathname === "/auth/v1/user"
        ? jsonResponse(200, { id: CALLER_SUBJECT })
        : jsonResponse(404, { hint: SECRET_MARKERS.upstreamBody }),
    );
    const result = await call(byPath, "/audit");
    assert.equal(result.status, 503);
    assert.match(result.error.message, /not available on this deployment/);
    assert.doesNotMatch(result.error.message, /must-not-be-echoed/);
  });

  test("an unexpected upstream status is a 502 and nothing upstream leaks", async () => {
    const { byPath } = routesWith((input) =>
      new URL(input).pathname === "/auth/v1/user"
        ? jsonResponse(200, { id: CALLER_SUBJECT })
        : jsonResponse(500, { detail: SECRET_MARKERS.upstreamBody }),
    );
    const result = await call(byPath, "/audit");
    assert.equal(result.status, 502);
    assert.equal(result.error.code, "E_WEB_READ_UPSTREAM");
    assert.doesNotMatch(result.error.message, /must-not-be-echoed/);
  });

  test("a malformed upstream body is a 502, never rendered", async () => {
    for (const body of [{ not: "an array" }, "a string", 42, null]) {
      const { byPath } = routesWith((input) =>
        new URL(input).pathname === "/auth/v1/user"
          ? jsonResponse(200, { id: CALLER_SUBJECT })
          : jsonResponse(200, body),
      );
      const result = await call(byPath, "/audit");
      assert.equal(result.status, 502, `${JSON.stringify(body)} was rendered`);
      assert.match(result.error.message, /unexpected shape/);
    }
  });

  test("an unreadable body is a 502 and nothing upstream leaks", async () => {
    const { byPath } = routesWith((input) =>
      new URL(input).pathname === "/auth/v1/user"
        ? jsonResponse(200, { id: CALLER_SUBJECT })
        : {
            ok: true,
            status: 200,
            json: async () => {
              throw new Error(SECRET_MARKERS.upstreamBody);
            },
          },
    );
    const result = await call(byPath, "/audit");
    assert.equal(result.status, 502);
    assert.doesNotMatch(result.error.message, /must-not-be-echoed/);
  });

  test("a session response with no usable subject is a 502", async () => {
    for (const session of [{ id: "" }, {}, { id: 42 }, { id: "x".repeat(300) }]) {
      const { byPath } = routesWith(() => jsonResponse(200, session));
      const result = await call(byPath, "/audit");
      assert.equal(result.status, 502, `${JSON.stringify(session)} was accepted`);
    }
  });

  test("a slow read is cut off by the deadline rather than hanging the page", async () => {
    // The console must never render a blank screen because a read never settles.
    const { byPath } = routesWith(
      (input) =>
        new Promise((resolve) => {
          if (new URL(input).pathname === "/auth/v1/user") {
            resolve(jsonResponse(200, { id: CALLER_SUBJECT }));
            return;
          }
          // The table read never settles.
        }),
      { bounds: { ...BOUNDS, requestTimeoutMs: 25 } },
    );
    const result = await call(byPath, "/audit");
    assert.equal(result.status, 504);
    assert.equal(result.error.code, "E_WEB_REQUEST_TIMEOUT");
  });

  test("the concurrency cap is a real 503, not a hang", async () => {
    const { byPath } = routesWith(
      (input) =>
        new Promise((resolve) => {
          if (new URL(input).pathname === "/auth/v1/user") {
            resolve(jsonResponse(200, { id: CALLER_SUBJECT }));
            return;
          }
        }),
      { bounds: { ...BOUNDS, maxConcurrentRequests: 1, requestTimeoutMs: 5_000 } },
    );
    const inFlight = call(byPath, "/audit");
    const refused = await call(byPath, "/audit");
    assert.equal(refused.status, 503);
    assert.equal(refused.error.code, "E_WEB_TOO_MANY_REQUESTS");
    await inFlight;
  });

  test("each governance page routes its read through the shared state surfaces", () => {
    // `ResourceSection` renders loading, then `ErrorPanel`, which maps
    // unavailable, forbidden and unauthorized to distinct surfaces and falls
    // through to `ErrorState`.
    for (const name of ["QuotasPage", "SecurityPage", "AuditPage"]) {
      const source = pageSource(name);
      assert.match(source, /ResourceSection/, `${name} does not use ResourceSection`);
      assert.match(source, /loadingLabel=/, `${name} has no loading state`);
      assert.match(source, /reload=/, `${name} has no reload affordance`);
      assert.match(source, /useApiResource/, `${name} does not use the shared resource hook`);
    }
    assert.match(pageSource("QuotasPage"), /EmptyState/);
  });

  test("StatePanel renders a distinct surface for every state it must distinguish", () => {
    const source = readFileSync(join(REPO_ROOT, "apps", "web", "src", "components", "StatePanel.tsx"), "utf8");
    for (const surface of [
      "state--loading",
      "state--unavailable",
      "state--forbidden",
      "state--error",
      "state--empty",
      "state--muted",
    ]) {
      assert.ok(source.includes(surface), `StatePanel has no ${surface} surface`);
    }
    // A loaded body is rendered, never replaced by a placeholder metric.
    assert.match(source, /return children\(state\.data\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Sanitized                                                                */
/* -------------------------------------------------------------------------- */

describe("nothing sensitive reaches a response", () => {
  test("a row carrying an unexpected column is not echoed into the response", async () => {
    // The strongest form of the sanitization claim: the decoders build each DTO
    // field by field, so a column the console never asked for cannot appear even
    // if an upstream returns it.
    const leaky = {
      ...AUDIT_ROW,
      secret_reference: SECRET_MARKERS.secret,
      api_key: SECRET_MARKERS.secret,
      note: ABSOLUTE_PATH,
    };
    const { byPath } = routesWith(tableRespond(fixture({ audit_events: [leaky] })));
    const result = await call(byPath, "/audit");
    assert.ok(result.ok);
    const serialised = JSON.stringify(result.body);
    assert.doesNotMatch(serialised, /secret_reference/);
    assert.doesNotMatch(serialised, /api_key/);
    assert.doesNotMatch(serialised, /fixture-supabase-secret/);
    assert.doesNotMatch(serialised, /\/srv\/app/);
    // The nine declared `AuditRow` fields are what remain.
    assert.deepEqual(Object.keys(result.body[0]).sort(), [
      "actor_subject",
      "id",
      "new_identity",
      "occurred_at",
      "old_identity",
      "operation",
      "request_id",
      "result",
      "target_identity",
    ]);
  });

  test("a malformed row value is refused, and the value is not in the message", async () => {
    const cases = [
      { table: "audit_events", row: { ...AUDIT_ROW, result: 42 }, path: "/audit" },
      { table: "audit_events", row: { ...AUDIT_ROW, id: "not-a-number" }, path: "/audit" },
      { table: "audit_events", row: { ...AUDIT_ROW, actor_subject: null }, path: "/audit" },
      { table: "security_denies", row: { ...DENY_ROW, kind: "not-a-kind" }, path: "/workspace/security/denies" },
      { table: "security_denies", row: { ...DENY_ROW, identity: 7 }, path: "/workspace/security/denies" },
      { table: "quota_policies", row: { ...POLICY_ROW, requests_per_minute: "many" }, path: "/workspace/quotas" },
      { table: "quota_policies", row: { ...POLICY_ROW, bandwidth_bytes: 1.5 }, path: "/workspace/quotas" },
      { table: "quota_usage", row: { ...USAGE_ROW, window_started: null }, path: "/workspace/quotas" },
    ];
    for (const testCase of cases) {
      const { byPath } = routesWith(tableRespond(fixture({ [testCase.table]: [testCase.row] })));
      const result = await call(byPath, testCase.path, {
        query: testCase.path === "/workspace/quotas" ? workspaceQuery() : "",
      });
      assert.equal(result.status, 502, `${testCase.table} rendered a malformed row`);
      assert.equal(result.error.code, "E_WEB_GOVERNANCE_ROW_INVALID");
      // The message names the column, never the value.
      assert.match(result.error.message, /the value is not reported/);
      assert.doesNotMatch(result.error.message, new RegExp(String(testCase.row.result ?? "not-a-kind")));
    }
  });

  test("more than one policy row for one workspace is refused, not arbitrarily chosen", async () => {
    // Unreachable under the primary key. Refused so a future schema change cannot
    // silently mislabel a workspace's policy.
    const { byPath } = routesWith(
      tableRespond(
        fixture({
          quota_policies: [POLICY_ROW, { ...POLICY_ROW, requests_per_minute: 999 }],
        }),
      ),
    );
    const result = await call(byPath, "/workspace/quotas", { query: workspaceQuery() });
    assert.equal(result.status, 502);
    // Two guards exist: the adapter's row-count check (the policy read is bounded
    // at one row) and this module's defence-in-depth check on the primary key.
    // The adapter's fires first, so the message is its. The unreachable one is
    // still worth having — it is what a future schema change would hit.
    assert.match(
      result.error.message,
      /more rows than the requested limit|primary key is workspace_id/,
      "two policy rows for one workspace were neither refused nor explained",
    );
    assert.doesNotMatch(JSON.stringify(result.body ?? null), /999/, "an arbitrary policy row was reported");
  });

  test("an oversized identity is refused rather than truncated", async () => {
    // Truncating an identity would put a different identity on the screen.
    const { byPath } = routesWith(
      tableRespond(fixture({ audit_events: [{ ...AUDIT_ROW, new_identity: "x".repeat(5_000) }] })),
    );
    const result = await call(byPath, "/audit");
    assert.equal(result.status, 502);
  });

  test("a value beyond exact integer range is refused rather than rounded", async () => {
    // `bandwidth_bytes` is `bigint`; past 2^53 a JavaScript number cannot hold it
    // exactly, and rounding would put a wrong byte count on an operator's screen.
    const { byPath } = routesWith(
      tableRespond(fixture({ quota_usage: [{ ...USAGE_ROW, bandwidth_bytes: 2 ** 53 + 1 }] })),
    );
    const result = await call(byPath, "/workspace/quotas", { query: workspaceQuery() });
    assert.equal(result.status, 502);
  });

  test("a decimal-form bigint count is accepted, because that is how PostgREST renders it", async () => {
    const { byPath } = routesWith(
      tableRespond(fixture({ quota_usage: [{ ...USAGE_ROW, request_count: "4211", bandwidth_bytes: "88412331" }] })),
    );
    const result = await call(byPath, "/workspace/quotas", { query: workspaceQuery() });
    assert.ok(result.ok);
    assert.equal(result.body.usage[0].request_count, 4211);
    assert.equal(result.body.usage[0].bandwidth_bytes, 88_412_331);
  });

  test("no request URL carries a secret, an absolute path, or SQL", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    await call(byPath, "/workspace/quotas", { query: workspaceQuery() });
    await call(byPath, "/workspace/security/denies", { query: "kind=skill" });
    await call(byPath, "/audit", { query: "operation=context.publish" });
    // The session probe lives on /auth/v1/user; every other request is a data
    // read, and those must name an allow-listed table rather than a
    // caller-controlled fragment.
    const reads = tableReads(transport);
    assert.ok(reads.length > 0, "no data read was recorded, so nothing was asserted");
    for (const recorded of [...reads, ...transport.calls]) {
      assert.doesNotMatch(recorded.url, /fixture-supabase-secret/);
      assert.doesNotMatch(recorded.url, /\/srv\/app/);
      assert.doesNotMatch(recorded.url, /\bselect\b[^&]*\bfrom\b/i, "a URL assembled raw SQL");
    }
    for (const recorded of reads) {
      assert.match(
        recorded.url,
        /\/rest\/v1\/(quota_policies|quota_usage|security_denies|audit_events)\b/,
      );
    }
  });

  test("a filter metacharacter in a query value is refused before the network", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    for (const bad of ["context.publish,drop", "a(b)", 'a"b', "a b", "a;b", "*", "a%20b"]) {
      const result = await call(byPath, "/audit", { query: `operation=${encodeURIComponent(bad)}` });
      assert.equal(result.status, 400, `operation=${bad} was accepted`);
    }
    assert.equal(tableReads(transport).length, 0, "a filter metacharacter reached the database");
  });

  test("a bad deny kind is refused before the network", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture()));
    for (const bad of ["everything", "HUB", "skill;drop"]) {
      const result = await call(byPath, "/workspace/security/denies", { query: `kind=${bad}` });
      assert.equal(result.status, 400, `kind=${bad} was accepted`);
    }
    assert.equal(tableReads(transport).length, 0);
  });

  test("every one of the five allow-listed deny kinds is accepted", async () => {
    for (const kind of ["hub", "release", "skill", "source", "blob"]) {
      const { byPath } = routesWith(tableRespond(fixture({ security_denies: [{ ...DENY_ROW, kind }] })));
      const result = await call(byPath, "/workspace/security/denies", { query: `kind=${kind}` });
      assert.ok(result.ok, `kind=${kind} was refused`);
      assert.equal(result.body[0].kind, kind);
    }
  });

  test("no repo path or absolute path appears in any response body", async () => {
    const { byPath } = routesWith(
      tableRespond(
        fixture({
          quota_policies: [POLICY_ROW],
          quota_usage: [USAGE_ROW],
          security_denies: [DENY_ROW],
          audit_events: [AUDIT_ROW],
        }),
      ),
    );
    const results = [
      await call(byPath, "/workspace/quotas", { query: workspaceQuery() }),
      await call(byPath, "/workspace/security/denies"),
      await call(byPath, "/audit"),
    ];
    for (const result of results) {
      const text = JSON.stringify(result.body ?? result.error?.message ?? "");
      assert.doesNotMatch(text, /\/home\//);
      assert.doesNotMatch(text, /\/srv\/app/);
      assert.doesNotMatch(text, /apps\/web/);
      assert.doesNotMatch(text, /supabase\.co/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 9. Read-only                                                                */
/* -------------------------------------------------------------------------- */

describe("no mutation control exists", () => {
  test("the database makes a mutation impossible by privilege", () => {
    // `authenticated` holds SELECT only and no write policy exists on any of
    // these tables. Asserted from the migration because that is the authority.
    const migration = readFileSync(
      join(REPO_ROOT, "supabase", "migrations", "202609090004_contract_f_rls.sql"),
      "utf8",
    );
    assert.match(migration, /grant select on table/);
    for (const table of ["quota_policies", "quota_usage", "security_denies", "audit_events"]) {
      assert.ok(migration.includes(`public.${table},`), `${table} is not in the SELECT grant`);
      assert.doesNotMatch(
        migration,
        new RegExp(`for\\s+(insert|update|delete|all)\\s+on\\s+public\\.${table}`),
        `${table} has a write policy`,
      );
    }
    // Every policy over these tables is a SELECT policy.
    for (const policy of [
      "quota_policy_admin_read",
      "quota_usage_admin_read",
      "security_deny_admin_read",
      "audit_admin_read",
    ]) {
      const line = new RegExp(`create policy ${policy}[\\s\\S]{0,80}?for\\s+(\\w+)`).exec(migration);
      assert.ok(line !== null, `${policy} is missing from the migration`);
      assert.equal(line[1], "select", `${policy} is not a SELECT policy`);
    }
  });

  test("no page renders a form, a submitting button, or a non-GET request", () => {
    for (const name of ["QuotasPage", "SecurityPage", "AuditPage"]) {
      const source = pageSource(name);
      assert.doesNotMatch(source, /<form/i, `${name} renders a form`);
      assert.doesNotMatch(
        source,
        /method\s*=\s*["'](post|put|patch|delete)["']/i,
        `${name} submits a mutation`,
      );
      for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
        assert.ok(
          !new RegExp(`method\\s*:\\s*["']${verb}["']`).test(source),
          `${name} issues a ${verb}`,
        );
      }
      // The only network call is the shared typed client, which is GET-only.
      assert.doesNotMatch(source, /fetch\(/, `${name} bypasses the API client`);
    }
  });

  test("the one button on the audit page resets filters and submits nothing", () => {
    const source = pageSource("AuditPage");
    const buttons = [...source.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    assert.equal(buttons.length, 1, `expected exactly one button, found ${buttons.length}`);
    assert.match(buttons[0], /type="button"/, "the button must not submit");
    assert.match(source, /Clear filters/);
    assert.match(source, /setFilters\(NO_AUDIT_FILTERS\)/, "the button does not clear the filters");
  });

  test("the routes expose no verb but GET", () => {
    const { byPath } = routesWith(tableRespond(fixture()));
    for (const [path, route] of byPath) {
      assert.deepEqual([...route.methods], ["GET"], `${path} exposes another verb`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 10. Audit is control history, and never a credential                        */
/* -------------------------------------------------------------------------- */

describe("the audit read is control history with no credential reachable", () => {
  test("the projection is exactly the ten allow-listed columns", async () => {
    const { byPath, transport } = routesWith(tableRespond(fixture({ audit_events: [AUDIT_ROW] })));
    const result = await call(byPath, "/audit");
    assert.ok(result.ok);

    // The `select` on the wire is the allow-list, verbatim.
    const read = tableReads(transport).find((c) => c.url.includes("/audit_events"));
    const select = new URL(read.url).searchParams.get("select");
    assert.deepEqual(select.split(",").sort(), [
      "actor_subject",
      "created_at",
      "id",
      "new_identity",
      "old_identity",
      "operation",
      "request_id",
      "result",
      "target_identity",
      "workspace_id",
    ]);

    // `workspace_id` is allow-listed and filterable but is absent from `AuditRow`,
    // so it is used as a filter and never serialized.
    assert.ok(!Object.keys(result.body[0]).includes("workspace_id"));
  });

  test("created_at is renamed to occurred_at, so the page never sees a column name", async () => {
    const { byPath } = routesWith(tableRespond(fixture({ audit_events: [AUDIT_ROW] })));
    const result = await call(byPath, "/audit");
    assert.equal(result.body[0].occurred_at, AUDIT_ROW.created_at);
    assert.ok(!("created_at" in result.body[0]));
  });

  test("the bigint id crosses the wire as a string, so JSON.stringify cannot throw", async () => {
    // `audit_events.id` is `bigint generated always as identity`, and
    // `JSON.stringify` throws on a BigInt.
    for (const id of [1042, Number.MAX_SAFE_INTEGER, "1042"]) {
      const { byPath } = routesWith(tableRespond(fixture({ audit_events: [{ ...AUDIT_ROW, id }] })));
      const result = await call(byPath, "/audit");
      assert.ok(result.ok, `id=${id} broke the read`);
      assert.equal(typeof result.body[0].id, "string", `id=${id} did not become a string`);
      assert.doesNotThrow(() => JSON.stringify(result.body));
    }
  });

  test("an unrecognised result is passed through, not coerced to allowed or denied", async () => {
    // `audit_events.result` is `text not null` with no check constraint, so a
    // value outside the declared union is representable. Coercing it would invent
    // a security judgement.
    const { byPath } = routesWith(
      tableRespond(fixture({ audit_events: [{ ...AUDIT_ROW, result: "deferred" }] })),
    );
    const result = await call(byPath, "/audit");
    assert.ok(result.ok);
    assert.equal(result.body[0].result, "deferred");

    // And the page renders it unclassified rather than colouring it.
    const source = pageSource("AuditPage");
    assert.match(source, /badge--muted/);
    assert.match(source, /does not classify/);
    assert.match(source, /case "other"/, "no filter isolates an unrecognised result");
  });

  test("the audit schema really does leave result unconstrained, as the report says", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "supabase", "migrations", "202609090001_hosted_control_plane.sql"),
      "utf8",
    );
    assert.match(migration, /result text not null/);
    assert.doesNotMatch(
      migration,
      /result text not null check/i,
      "result gained a check constraint; the pass-through design can be revisited",
    );
  });

  test("nullable columns stay null and are never coerced to an empty string", async () => {
    const { byPath } = routesWith(
      tableRespond(
        fixture({
          audit_events: [
            {
              ...AUDIT_ROW,
              old_identity: null,
              new_identity: null,
              request_id: null,
              target_identity: null,
            },
          ],
        }),
      ),
    );
    const result = await call(byPath, "/audit");
    assert.ok(result.ok);
    for (const column of ["old_identity", "new_identity", "request_id", "target_identity"]) {
      assert.equal(result.body[0][column], null, `${column} was coerced`);
    }
  });

  test("the deny and quota rows render every column the brief names", async () => {
    const denies = routesWith(tableRespond(fixture({ security_denies: [DENY_ROW] })));
    const denyResult = await call(denies.byPath, "/workspace/security/denies");
    // `security_denies.workspace_id` is allow-listed and filterable but is not a
    // `SecurityDenyRow` field, so the decoded row is the table row minus that
    // one column. Asserted explicitly so the difference is visible rather than
    // accommodated.
    const { workspace_id: _denyWorkspace, ...expectedDeny } = DENY_ROW;
    assert.deepEqual(denyResult.body, [expectedDeny]);
    assert.deepEqual(Object.keys(denyResult.body[0]).sort(), [
      "created_at",
      "id",
      "identity",
      "kind",
      "reason",
    ]);

    const quotas = routesWith(
      tableRespond(fixture({ quota_policies: [POLICY_ROW], quota_usage: [USAGE_ROW] })),
    );
    const quotaResult = await call(quotas.byPath, "/workspace/quotas", { query: workspaceQuery() });
    assert.deepEqual(quotaResult.body.policy, POLICY_ROW);
    assert.deepEqual(quotaResult.body.usage, [USAGE_ROW]);
    assert.deepEqual(Object.keys(quotaResult.body.policy).sort(), [
      "bandwidth_bytes",
      "concurrent_requests",
      "requests_per_minute",
      "workspace_id",
    ]);
    assert.deepEqual(Object.keys(quotaResult.body.usage[0]).sort(), [
      "bandwidth_bytes",
      "request_count",
      "window_started",
      "workspace_id",
    ]);
  });

  test("the RLS policies behind these reads are admin-scoped, as the pages state", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "supabase", "migrations", "202609090004_contract_f_rls.sql"),
      "utf8",
    );
    for (const [policy, table] of [
      ["security_deny_admin_read", "security_denies"],
      ["audit_admin_read", "audit_events"],
      ["quota_policy_admin_read", "quota_policies"],
      ["quota_usage_admin_read", "quota_usage"],
    ]) {
      assert.ok(migration.includes(policy), `${policy} is missing from the migration`);
      assert.match(
        migration,
        new RegExp(`create policy ${policy}\\s*on\\s+public\\.${table}[\\s\\S]{0,220}?owner[\\s\\S]{0,80}?admin`),
        `${policy} is not scoped to owner and admin`,
      );
    }
    // `audit_admin_read` additionally requires a non-null workspace_id.
    assert.match(
      migration,
      /create policy audit_admin_read[\s\S]{0,220}?workspace_id is not null/,
      "audit_admin_read does not exclude workspace-less events",
    );
  });

  test("the pages name the admin-scoped policies their copy refers to", () => {
    assert.match(pageSource("QuotasPage"), /quota_policy_admin_read/);
    assert.match(pageSource("QuotasPage"), /quota_usage_admin_read/);
    assert.match(pageSource("SecurityPage"), /security_deny_admin_read/);
    assert.match(pageSource("AuditPage"), /audit_admin_read/);
  });
});

/* -------------------------------------------------------------------------- */
/* 11. The audit page's five client-side filters                              */
/* -------------------------------------------------------------------------- */

describe("the audit page filters over time, actor, operation, result and target", () => {
  test("all five filter dimensions are present and wired", () => {
    const source = pageSource("AuditPage");
    // A control exists for each dimension…
    for (const id of ["audit-from", "audit-to", "audit-actor", "audit-operation", "audit-target", "audit-result"]) {
      assert.match(source, new RegExp(`id="${id}"`), `no control for ${id}`);
      assert.match(source, new RegExp(`htmlFor="${id}"`), `${id} has no label`);
    }
    // …and each one feeds the shared filter state.
    for (const field of ["from", "to", "actor", "operation", "target", "result"]) {
      assert.match(source, new RegExp(`set\\(\\{ ${field}:`), `${field} is not wired to the filter state`);
    }
  });

  test("the predicate covers every dimension, and treats a null target as absent", () => {
    const source = pageSource("AuditPage");
    assert.match(source, /function auditRowMatches/);
    for (const field of ["occurred_at", "actor_subject", "operation", "target_identity", "result"]) {
      assert.ok(source.includes(field), `${field} is not read by the predicate`);
    }
    // A null target must not match a text search, or a one-letter search would
    // return every identity-less row.
    assert.match(source, /if \(haystack === null\) return false;/);
  });

  test("the result filter distinguishes the two known results from the rest", () => {
    const source = pageSource("AuditPage");
    assert.match(source, /case "allowed"/);
    assert.match(source, /case "denied"/);
    assert.match(source, /row\.result !== "allowed" && row\.result !== "denied"/);
  });

  test("a narrow filter says it applies to the page read, not the whole log", () => {
    // Without this, "no matches" reads as "nothing happened".
    const source = pageSource("AuditPage");
    assert.match(source, /not about the whole audit log/);
    assert.match(source, /on this page/);
  });

  test("the server offers no time-range or target filter, which is why this is client-side", () => {
    // The premise of the design. If the adapter gained one, this test is the canary.
    const code = serverCode();
    assert.doesNotMatch(code, new RegExp("created_at[.]gte"));
    assert.doesNotMatch(code, /column: "target_identity"/);
    assert.doesNotMatch(code, new RegExp("created_at[.]lte"));
    const read = readFileSync(
      join(REPO_ROOT, "apps", "web", "server", "supabase-read.ts"),
      "utf8",
    );
    // Only the `filterable` block matters: `created_at` is legitimately in the
    // projection (the page renders it as `occurred_at`) and must not be in the
    // filter list.
    const entry = /audit_events:\s*\{[\s\S]*?\n {4}\},\n/.exec(read);
    assert.ok(entry !== null, "the audit_events allow-list entry was not found");
    const filterable = /filterable:\s*\{([\s\S]*?)\n {4}\}/.exec(entry[0]);
    assert.ok(filterable !== null, "the audit_events filterable block was not found");
    for (const column of ["created_at", "target_identity"]) {
      assert.ok(
        !filterable[1].includes(column),
        `audit_events gained a filterable ${column}; the client-side design can be revisited`,
      );
    }
    // And the four it does allow are the ones the route forwards.
    for (const column of ["workspace_id", "actor_subject", "operation", "result"]) {
      assert.ok(filterable[1].includes(column), `audit_events lost the ${column} filter`);
    }
  });
});