/**
 * Cross-workspace isolation through the ACTUAL console read path, against a real
 * PostgreSQL 16, in both directions, for every implemented surface.
 *
 * ## Why this suite exists at all
 *
 * The previous reasoning — "no new tables, so no new isolation proof is needed" —
 * was rejected, and correctly. The console introduces **new access paths** to the
 * control plane. `tests/rls/contract-f.rls.mjs` proves the policies are correct
 * when SQL runs directly as a subject. It does not prove anything about the BFF:
 * a BFF that read with a service credential would show the caller rows that
 * subject genuinely cannot see, and every one of those RLS tests would still pass.
 *
 * So this suite drives `apps/web/server/supabase-read.ts` — the exact module the
 * console's routes call — as each seeded subject, against a real database, and
 * asserts that what the adapter returns is what RLS returns. That is the only
 * claim worth making, and it is a claim about the console, not about the policies.
 *
 * ## It FAILS LOUDLY without a database
 *
 * `EGA_RLS_DATABASE_URL` is required. If it is unset this file throws at module
 * load and the run exits non-zero. It does **not** skip. A silently skipped
 * isolation proof is worse than no proof, because the report says "pass".
 *
 * ## The `.rls.mjs` extension is load-bearing — do not rename it to `.test.mjs`
 *
 * `pnpm test:ci` runs `node --test` with no path filter, and Node's default
 * discovery picks up every file whose name ends in `.test.mjs`. Naming this file
 * `cross-workspace-isolation.test.mjs` therefore swept it into the general
 * suite, where no database exists, so it threw and took the whole `foundation`
 * job red with it:
 *
 *   Error: EGA_RLS_DATABASE_URL is required: the console's cross-workspace
 *   isolation proof runs against a real PostgreSQL and must not silently skip.
 *
 * That is the fail-loud rule above working as designed, pointed at the wrong
 * runner. `.rls.mjs` is outside Node's discovery patterns, exactly like
 * `tests/rls/contract-f.rls.mjs`, which is why the RLS suites have always needed
 * a job that provisions PostgreSQL and names them explicitly.
 *
 * The alternative — teaching the suite to skip when no database is configured —
 * would have made `pnpm test:ci` green while quietly dropping the security
 * proof from the default suite. The extension keeps both properties: the proof
 * still fails loudly if you run it directly without a database, and it still
 * runs on every PR in the `web-isolation` job, which provisions one.
 *
 * Start a disposable cluster and provide the URL:
 *
 * ```sh
 * PGBIN=/usr/lib/postgresql/16/bin
 * mkdir -p /tmp/opencode/ega-pg/sock
 * "$PGBIN/pg_ctl" -D /tmp/opencode/ega-pg/data -l /tmp/opencode/ega-pg/pg.log \
 *   -o "-p 55432 -c listen_addresses=127.0.0.1 \
 *       -c unix_socket_directories=/tmp/opencode/ega-pg/sock \
 *       -c fsync=off -c full_page_writes=off -c synchronous_commit=off" -w start
 * export EGA_RLS_DATABASE_URL="postgres://ega@127.0.0.1:55432/postgres"
 * node --test tests/web/cross-workspace-isolation.rls.mjs
 * ```
 *
 * The database is created with a unique name from the pid and a random suffix, the
 * migrations and the seed are applied to *it only*, and it is dropped in `after`.
 * A remote or production instance is never touched: the suite only ever issues
 * `create database` / `drop database` against the `postgres` database of the URL
 * it was given, and every statement against the fixture runs on the disposable
 * one.
 *
 * ## How a subject is presented
 *
 * PostgREST is not involved: the fixture transport translates the adapter's URL
 * into a `psql` invocation that does
 *
 * ```sql
 * begin;
 * set local role authenticated;
 * set local "request.jwt.claims" = '<the claims decoded from the token the
 *                                    adapter actually forwarded>';
 * select <projection> from public.<table> [where <filters>] limit <n>;
 * commit;
 * ```
 *
 * The claims come from the **bearer token the adapter sent**, decoded in this
 * file. That is deliberate and it is the load-bearing detail: if the adapter
 * swapped the caller's token for a privileged credential, the claims decoded here
 * would not be the caller's and RLS would decide the read for a different
 * principal. The suite cannot accidentally prove isolation for a subject the
 * console never presented. {@link assertTokenIsTheCallers} makes that explicit by
 * checking, on every single request, that the forwarded token is byte-identical to
 * the one handed to the adapter.
 *
 * ## Every assertion is on values, not counts
 *
 * Each check asserts the *absence of the other workspace's specific seeded
 * values*. A row count of zero would also pass if the table were empty; a leaked
 * `PROJECT_B` or `WS_B` in a result set fails regardless of how many rows
 * accompanied it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe } from "node:test";

import {
  CONTROL_PLANE_MAX_LIMIT,
  CONTROL_PLANE_TABLE_NAMES,
  assertTableAllowed,
  createControlPlaneReader,
  extractBearerToken,
} from "../../apps/web/server/supabase-read.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BASE_URL = process.env.EGA_RLS_DATABASE_URL;
if (!BASE_URL) {
  throw new Error(
    [
      "EGA_RLS_DATABASE_URL is required: the console's cross-workspace isolation proof",
      "runs against a real PostgreSQL and must not silently skip.",
      "",
      "Start a disposable cluster and re-run:",
      "  PGBIN=/usr/lib/postgresql/16/bin",
      "  mkdir -p /tmp/opencode/ega-pg/sock",
      `  "$PGBIN/pg_ctl" -D /tmp/opencode/ega-pg/data -l /tmp/opencode/ega-pg/pg.log \\
  -o "-p 55432 -c listen_addresses=127.0.0.1 \\
      -c unix_socket_directories=/tmp/opencode/ega-pg/sock \\
      -c fsync=off -c full_page_writes=off -c synchronous_commit=off" -w start`,
      '  export EGA_RLS_DATABASE_URL="postgres://ega@127.0.0.1:55432/postgres"',
      "  node --test tests/web/cross-workspace-isolation.rls.mjs",
    ].join("\n"),
  );
}

const DB_NAME = `ega_web_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const DB_URL = withDatabase(BASE_URL, DB_NAME);
const ADMIN_URL = withDatabase(BASE_URL, "postgres");

/* -------------------------------------------------------------------------- */
/* Seeded identities (tests/rls/seed.sql, Workspace A ...00a1 / B ...00b1)     */
/* -------------------------------------------------------------------------- */

const WS_A = "00000000-0000-4000-8000-0000000000a1";
const WS_B = "00000000-0000-4000-8000-0000000000b1";
const HUB_A_PRIVATE = "00000000-0000-4000-8000-00000000a001";
const HUB_A_WORKSPACE = "00000000-0000-4000-8000-00000000a002";
const HUB_A_DENIED = "00000000-0000-4000-8000-00000000a003";
const HUB_A_PUBLIC = "00000000-0000-4000-8000-00000000a004";
const HUB_B_PRIVATE = "00000000-0000-4000-8000-00000000b001";
const HUB_B_PUBLIC = "00000000-0000-4000-8000-00000000b002";
const PROJECT_A = "00000000-0000-4000-8000-000000000a01";
const PROJECT_B = "00000000-0000-4000-8000-000000000b01";
const CONTEXT_A = "00000000-0000-4000-8000-000000000a11";
const CONTEXT_A_REVOKED = "00000000-0000-4000-8000-000000000a12";
const CONTEXT_A_TOMBSTONE = "00000000-0000-4000-8000-000000000a13";
const CONTEXT_B = "00000000-0000-4000-8000-000000000b11";
const digest = (hex) => `sha256:${hex.repeat(64)}`;
const RELEASE_A_PRIVATE = digest("1");
const RELEASE_A_PUBLIC = digest("4");
const RELEASE_B_PRIVATE = digest("6");
const RELEASE_B_PUBLIC = digest("7");

/** The two workspaces' own subjects, plus the roles the seed creates in A. */
const SUBJECTS = Object.freeze({
  "user-a": "user-a",
  "admin-a": "admin-a",
  "maintainer-a": "maintainer-a",
  "member-a": "member-a",
  "viewer-a": "viewer-a",
  "inactive-a": "inactive-a",
  "user-b": "user-b",
  outsider: "outsider",
});

/** Every control-plane table the adapter is allowed to read. */
const READABLE_TABLES = CONTROL_PLANE_TABLE_NAMES;

/**
 * Rows that are public *by policy* and therefore cross workspaces.
 *
 * `private.can_read_hub` grants `visibility = 'public'` to any authenticated
 * subject with no revoked membership in that workspace, and
 * `private.can_read_release` inherits that grant. So A's public hub, A's public
 * release, and B's public equivalents are visible to *both* workspaces' subjects
 * and to a non-member. `tests/rls/contract-f.rls.mjs:312-313` asserts exactly this
 * for `user-b`.
 *
 * Naming them here is what keeps the isolation assertions honest: a public hub row
 * is not a leak, and a test that failed on one would be asserting something the
 * contract does not say.
 */
const CROSS_WORKSPACE_PUBLIC = Object.freeze([
  HUB_A_PUBLIC,
  HUB_B_PUBLIC,
  RELEASE_A_PUBLIC,
  RELEASE_B_PUBLIC,
]);

/**
 * Values that must never appear when a caller reads `table` and does **not** hold
 * a membership in `ws`.
 *
 * Deliberately excludes that workspace's *public* hub and release rows, which
 * `private.can_read_hub` grants to every authenticated subject. So this set is
 * "the private and workspace-visibility data of `ws`, plus the row identity of
 * every workspace-scoped table", which is exactly the boundary the contract
 * draws.
 *
 * A `hubs` row carries its own `workspace_id`, so B's public hub legitimately
 * shows `WS_B` to a caller who is not a B member. That is the hub's attribution,
 * not workspace B's private data — and a per-table set is what keeps the
 * assertion from failing on it.
 */
function forbidden(table, ws) {
  const isA = ws === "A";
  const hubPrivate = isA ? HUB_A_PRIVATE : HUB_B_PRIVATE;
  const releasePrivate = isA ? RELEASE_A_PRIVATE : RELEASE_B_PRIVATE;
  const releaseWorkspace = isA ? digest("2") : digest("7");
  if (table === "hubs") {
    const markers = { "private hub": hubPrivate };
    if (isA) {
      markers["workspace hub"] = HUB_A_WORKSPACE;
      markers["denied hub"] = HUB_A_DENIED;
    }
    return markers;
  }
  if (table === "hub_releases" || table === "hub_stable_pointers") {
    const markers = { "private release": releasePrivate };
    if (isA) {
      markers["workspace release"] = releaseWorkspace;
      markers["denied release"] = digest("5");
    }
    return markers;
  }
  return isA
    ? {
        workspace: WS_A,
        project: PROJECT_A,
        context: CONTEXT_A,
        "revoked context": CONTEXT_A_REVOKED,
        "tombstoned context": CONTEXT_A_TOMBSTONE,
        owner: "user-a",
        admin: "admin-a",
        maintainer: "maintainer-a",
        member: "member-a",
        viewer: "viewer-a",
      }
    : {
        workspace: WS_B,
        project: PROJECT_B,
        context: CONTEXT_B,
        owner: "user-b",
      };
}

/**
 * Assert `rows` contains no occurrence of any forbidden marker for `ws`.
 *
 * The search is over `JSON.stringify(rows)`, so a leak into *any* projected
 * column is caught — not only the one a test author thought to check.
 */
function assertNoForbidden(rows, table, ws, label) {
  for (const [name, value] of Object.entries(forbidden(table, ws))) {
    assert.equal(
      occurrences(rows, value),
      0,
      `${label}: ${name} of workspace ${ws} (${value}) leaked into ${table}: ${JSON.stringify(rows)}`,
    );
  }
}

/** Assert `rows` contains nothing belonging to *either* workspace. */
function assertNoForbiddenEither(rows, table, label) {
  assertNoForbidden(rows, table, "A", label);
  assertNoForbidden(rows, table, "B", label);
}

/* -------------------------------------------------------------------------- */
/* psql plumbing                                                               */
/* -------------------------------------------------------------------------- */

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function psql(url, sql) {
  return execFileSync(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "", url],
    { encoding: "utf8", input: sql, stdio: ["pipe", "pipe", "pipe"] },
  );
}

/**
 * Run SQL and return its rows as JSON objects.
 *
 * The inner query projects a `json_build_object`, so every column is keyed by
 * name and a value-based leak assertion can search the whole row rather than one
 * column. Values are cast to `text` so a timestamp renders as a JSON string
 * instead of relying on the driver's encoding of `timestamptz`.
 */
function psqlJson(sql, claims) {
  const literal = JSON.stringify(claims).replaceAll("'", "''");
  const script =
    `begin;\n` +
    `set local role authenticated;\n` +
    // Exactly what Supabase's PostgREST layer sets. `auth.jwt()` reads this GUC,
    // so every policy and every `private.*` helper evaluates the real caller.
    `set local "request.jwt.claims" = '${literal}';\n` +
    `${sql};\n` +
    `commit;`;
  const out = execFileSync(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", DB_URL],
    { encoding: "utf8", input: script },
  );
  return JSON.parse(out.trim());
}

/* -------------------------------------------------------------------------- */
/* Session tokens: a real JWT shape the adapter will accept                     */
/* -------------------------------------------------------------------------- */

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

/**
 * An unsigned JWT carrying `sub` and, optionally, `client_id`.
 *
 * Unsigned on purpose: the transport decodes the payload, and no signature check
 * happens anywhere in this suite. The point is the *claims*, because that is what
 * `auth.jwt()` reads and therefore what RLS evaluates.
 */
function sessionToken(claims) {
  return [
    base64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    base64url(JSON.stringify({ role: "authenticated", ...claims })),
    "console-fixture-signature",
  ].join(".");
}

function decodeClaims(token) {
  const segment = token.split(".")[1];
  assert.ok(segment, "a session token must have three segments");
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/* -------------------------------------------------------------------------- */
/* The fixture transport: PostgREST URL in, real psql out                      */
/* -------------------------------------------------------------------------- */

/** Every request the adapter made, for the not-vacuous assertions. */
const REQUESTS = [];

/**
 * Assert the adapter forwarded the caller's own token, byte for byte.
 *
 * Called on every single request. If the console ever swapped in a service
 * credential, this fails before any isolation assertion is evaluated — which is
 * the correct order: a proof that a privileged credential was never used has to
 * come before the proof that the privileged credential would have leaked.
 */
function assertTokenIsTheCallers(authorization) {
  assert.equal(typeof authorization, "string", "every request must carry an Authorization header");
  assert.match(authorization, /^Bearer /, "the credential must be a Bearer token");
  const token = authorization.slice("Bearer ".length);
  const known = TOKENS_BY_VALUE.get(token);
  assert.ok(
    known !== undefined,
    "the adapter forwarded a credential that no caller in this suite presented; a privileged credential would be indistinguishable here, so the proof is void",
  );
  REQUESTS.push(known);
}

/** `sub` -> the token handed to the adapter for that subject. */
const TOKENS_BY_VALUE = new Map();
const CALLERS = new Map();

for (const [name, subject] of Object.entries(SUBJECTS)) {
  const token = sessionToken({ sub: subject });
  TOKENS_BY_VALUE.set(token, name);
  CALLERS.set(name, Object.freeze({ subject, token }));
}

/** A delegated OAuth token: same subject, plus a `client_id` claim. */
const DELEGATED_CLIENT = "delegated-client-1";
const DELEGATED_TOKEN = sessionToken({ sub: "user-a", client_id: DELEGATED_CLIENT });
TOKENS_BY_VALUE.set(DELEGATED_TOKEN, "delegated:user-a");

/** A token for a client whose `exp` has passed: rejected by the session probe. */
const EXPIRED_TOKEN = [
  base64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  base64url(JSON.stringify({ role: "authenticated", sub: "user-a", exp: 1000 })),
  "console-fixture-signature",
].join(".");
TOKENS_BY_VALUE.set(EXPIRED_TOKEN, "expired");

/**
 * Translate the adapter's PostgREST URL into SQL for the named principal.
 *
 * Only the subset of PostgREST the adapter can emit is understood: `select`,
 * `eq.`, `in.(...)`, `limit`, `offset`. Anything else throws, so if the adapter
 * ever started emitting a construct this fixture cannot faithfully render, the
 * suite fails instead of silently reading the wrong rows.
 */
function translate(url) {
  const parsed = new URL(url);
  const match = /^\/rest\/v1\/([a-z_]+)$/.exec(parsed.pathname);
  assert.ok(match, `unexpected PostgREST path ${parsed.pathname}`);
  const table = match[1];
  assertTableAllowed(table);

  const select = parsed.searchParams.get("select");
  assert.ok(select, "the adapter must always send an explicit select");
  const columns = select.split(",");
  assert.ok(columns.length > 0 && columns.every((column) => /^[a-z_]+$/.test(column)));

  const limitRaw = parsed.searchParams.get("limit");
  assert.ok(limitRaw !== null, "the adapter must always send an explicit limit");
  const limit = Number(limitRaw);
  assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= CONTROL_PLANE_MAX_LIMIT);

  const where = [];
  for (const [name, value] of parsed.searchParams) {
    // `order` is a total-order directive, not a filter. The adapter sets it from a
    // fixed per-table table (never from the caller) so offset pagination is
    // deterministic; the fixture must honour it for the same reason.
    if (name === "order") {
      assert.match(value, /^[a-z_]+\.asc(,[a-z_]+\.asc)*$/, `unusable order clause ${value}`);
      continue;
    }
    if (["select", "limit", "offset"].includes(name)) continue;
    assert.ok(/^[a-z_]+$/.test(name), `unexpected query parameter ${name}`);
    if (value.startsWith("eq.")) {
      where.push(`${name} = '${value.slice(3).replaceAll("'", "''")}'`);
    } else if (value.startsWith("in.(") && value.endsWith(")")) {
      const list = value
        .slice(4, -1)
        .split(",")
        .map((item) => `'${item.replaceAll("'", "''")}'`);
      assert.ok(list.length > 0, "an in-filter must carry at least one value");
      where.push(`${name} in (${list.join(", ")})`);
    } else {
      throw new Error(`the fixture transport cannot render the filter ${name}=${value}`);
    }
  }

  const offset = Number(parsed.searchParams.get("offset") ?? "0");
  assert.ok(Number.isSafeInteger(offset) && offset >= 0, `unusable offset ${offset}`);
  // Keyed by name, all values cast to text: a value-based leak assertion can then
  // search the whole row, and a timestamptz renders as a JSON string rather than
  // depending on the driver's encoding.
  // The `as row` alias is required: `json_agg(row)` reads the subquery's column,
  // and an unaliased `json_build_object(...)` would be named `json_build_object`,
  // wrapping every value one level deeper than intended.
  const projection = `json_build_object(${columns.map((c) => `'${c}', ${c}::text`).join(", ")}) as row`;
  // Ordering is for determinism only; the adapter never requests one, and PostgREST
  // would not send one. It is applied to the first projected column *as text*
  // because `json` has no ordering operator, and to the cast form because the
  // first column of `audit_events` is a `bigint` identity that would otherwise
  // order differently from a lexicographic page.
  const orderColumn = columns[0];
  const sql =
    `select ${projection} from public.${table}` +
    (where.length > 0 ? ` where ${where.join(" and ")}` : "") +
    ` order by ${orderColumn}::text limit ${limit} offset ${offset}`;
  return { table, sql, limit };
}

/**
 * The transport the adapter reads through.
 *
 * `/auth/v1/user` is answered from the token's own claims — including refusing an
 * expired one — so `resolveCaller` is exercised for real. Every `/rest/v1/` read
 * runs as the principal the *forwarded token* names.
 */
const transport = async (input, init) => {
  assert.equal(init.method, "GET", "the console read path must be GET only");
  const authorization = init.headers["authorization"];
  assert.equal(init.headers["accept"], "application/json");
  const url = new URL(input);

  if (url.pathname === "/auth/v1/user") {
    assertTokenIsTheCallers(authorization);
    const claims = decodeClaims(authorization.slice("Bearer ".length));
    if (typeof claims["exp"] === "number" && claims["exp"] * 1000 < Date.now()) {
      return { ok: false, status: 401, json: async () => ({ message: "token expired" }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: claims["sub"] }) };
  }

  assertTokenIsTheCallers(authorization);
  const claims = decodeClaims(authorization.slice("Bearer ".length));
  const { sql, limit } = translate(input);
  const rows = psqlJson(
    `select coalesce(json_agg(row), '[]'::json) from (${sql}) as row`,
    claims,
  );
  // No trimming here. If the adapter asked for fewer rows than came back, it must
  // be the adapter that refuses (it asserts `rows.length <= plan.limit`), and this
  // suite must be the one that showed it.
  void limit;
  return { ok: true, status: 200, json: async () => rows };
};

/** Build the reader, with the HTTPS URL the fixture stands in for. */
const reader = createControlPlaneReader({
  supabaseUrl: "https://console-isolation-fixture.supabase.co",
  publishableKey: "sb_publishable_fixture-key",
  transport,
});

/** Resolve a caller through the real adapter, from a real token. */
async function callerFor(name) {
  const known = CALLERS.get(name);
  assert.ok(known, `no token for ${name}`);
  return reader.resolveCaller({
    method: "GET",
    headers: { authorization: `Bearer ${known.token}` },
  });
}

async function callerFromToken(token) {
  return reader.resolveCaller({ method: "GET", headers: { authorization: `Bearer ${token}` } });
}

/** Read a table as a caller, through the adapter. Never via psql directly. */
async function readAs(name, table, options) {
  const caller = name === "delegated:user-a" || name === "expired"
    ? await callerFromToken(TOKENS_BY_VALUE.get(name) === "delegated:user-a" ? DELEGATED_TOKEN : EXPIRED_TOKEN)
    : await callerFor(name);
  return await reader.readAsCaller(caller, table, options);
}

async function readAsToken(token, table, options) {
  const caller = await callerFromToken(token);
  return await reader.readAsCaller(caller, table, options);
}

/* -------------------------------------------------------------------------- */
/* Fixture lifecycle                                                           */
/* -------------------------------------------------------------------------- */

before(() => {
  psql(ADMIN_URL, `create database "${DB_NAME}"`);
  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "bootstrap.sql"), "utf8"));
  const migrations = readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    psql(DB_URL, readFileSync(join(ROOT, "supabase", "migrations", file), "utf8"));
  }
  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "seed.sql"), "utf8"));
  // Two rows the shared Contract F seed does not have, and which
  // `tests/rls/contract-f.rls.mjs:224` would break if added there (it asserts
  // exactly 3 security_denies, all in workspace A). Both make an otherwise
  // *vacuous* direction non-vacuous:
  //
  // - a workspace B `security_denies` row, so "A's owner sees no B deny" is a real
  //   assertion. Without it the table is empty for B and the absence proves
  //   nothing.
  // - a workspace B audit event with a distinctive actor, so the B -> A direction
  //   has a specific value to search for rather than only a workspace id that
  //   appears in several tables.
  //
  // Applied as the database owner, after the migrations, exactly like seed.sql.
  psql(
    DB_URL,
    [
      "insert into public.security_denies (workspace_id, kind, identity, reason) values",
      // Deny a `source` identity in B rather than a release digest: denying
      // `digest("6")` would hide B's *private* release from B's own owner, which is
      // a different (also correct) policy but would leave the "B's private release
      // is visible to B's owner" assertion with nothing to assert on.
      `  ('${WS_B}', 'source', '${digest("6")}', 'workspace-b-isolation-fixture'),`,
      `  ('${WS_A}', 'skill', '${digest("e")}', 'workspace-a-isolation-fixture');`,
      "insert into public.audit_events (workspace_id, actor_subject, operation, result) values",
      `  ('${WS_B}', 'audit-b-fixture-subject', 'rotate_source', 'denied');`,
    ].join("\n"),
  );
});

after(() => {
  psql(ADMIN_URL, `drop database if exists "${DB_NAME}" with (force)`);
});

/* -------------------------------------------------------------------------- */
/* Value-level assertions                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every occurrence of `needle` in `haystack`, wherever it appears.
 *
 * Searched across `JSON.stringify(rows)` rather than a chosen column, so a leak
 * into any projected field is caught — including one the adapter did not expect.
 */
function occurrences(haystack, needle) {
  const text = JSON.stringify(haystack);
  return text.split(needle).length - 1;
}

function assertHasOwn(rows, value, label) {
  assert.ok(
    occurrences(rows, value) > 0,
    `${label}: the fixture must be visible, but ${value} is absent from ${JSON.stringify(rows)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* 1. The control is real: the fixture is not vacuous                          */
/* -------------------------------------------------------------------------- */

describe("the fixture is not vacuous", () => {
  test("the seed really put two workspaces, two identities, and two of everything in the database", () => {
    // Everything below runs as the database owner, bypassing RLS on purpose. It is
    // a statement about the FIXTURE, not about any subject's visibility.
    const scalar = (sql) => psql(DB_URL, sql).trim();
    assert.equal(scalar("select count(*) from public.personal_workspaces"), "2");
    assert.equal(scalar(`select count(*) from public.personal_workspaces where id = ${q(WS_A)}`), "1");
    assert.equal(scalar(`select count(*) from public.personal_workspaces where id = ${q(WS_B)}`), "1");
    assert.equal(scalar("select count(*) from public.projects"), "2");
    assert.equal(scalar("select count(*) from public.project_contexts"), "4");
    assert.equal(scalar("select count(*) from public.workspace_memberships"), "7");
    assert.equal(scalar("select count(*) from public.quota_policies"), "2");
    assert.equal(scalar("select count(*) from public.quota_usage"), "2");
    // Three from `tests/rls/seed.sql`, plus the two this suite adds.
    assert.equal(scalar("select count(*) from public.security_denies"), "5");
    // Two from `tests/rls/seed.sql`, plus the one this suite adds.
    assert.equal(scalar("select count(*) from public.audit_events"), "3");
    assert.equal(
      scalar(`select count(*) from public.quota_usage where workspace_id = ${q(WS_B)}`),
      "1",
      "workspace B must have its own quota_usage row for the direction-B assertions to mean anything",
    );
    assert.equal(
      scalar(`select count(*) from public.audit_events where workspace_id = ${q(WS_B)}`),
      "2",
      "one from seed.sql plus the distinctively-attributed row this suite adds",
    );
    assert.equal(
      scalar(`select count(*) from public.security_denies where workspace_id = ${q(WS_A)}`),
      "4",
      "workspace A must have its own deny rows, including the one this suite adds",
    );
    assert.equal(
      scalar(`select count(*) from public.security_denies where workspace_id = ${q(WS_B)}`),
      "1",
      "workspace B must have a deny row or the A -> B deny assertion would be vacuous",
    );
    assert.equal(
      scalar(`select count(*) from public.audit_events where actor_subject = 'audit-b-fixture-subject'`),
      "1",
      "workspace B must have a distinctively-attributed audit event for the reverse direction",
    );
  });

  test("NEGATIVE CONTROL: a privileged read sees rows the callers cannot see", async () => {
    // If a service-role read returned exactly what the callers see, this suite
    // would pass even if the console used that credential everywhere. So prove the
    // opposite: the privileged view is strictly larger, on every surface, in both
    // directions. That is what makes the caller-direction assertions meaningful.
    //
    // `service_role` is `bypassrls` (tests/rls/bootstrap.sql:11), which is the
    // privilege the console must never use. It is read here only to prove the
    // difference exists.
    // Read as the database owner, which is the practical equivalent of a
    // `bypassrls` credential for this comparison. The privilege the console must
    // never hold is `service_role`, asserted to be `bypassrls` in the next test.
    const privileged = (table, column) =>
      psql(
        DB_URL,
        `select coalesce(json_agg(c), '[]'::json) from (select '${column}', ${column}::text from public.${table}) c;`,
      ).trim();

    // `[table, column, a value that exists only in workspace B]`. The privileged
    // read must surface that value; the console read by workspace A's owner must
    // not. If the privileged read did NOT surface it, the contrast would be
    // vacuous and the whole suite would prove nothing.
    const wider = [
      ["projects", "id", PROJECT_B],
      ["project_contexts", "id", CONTEXT_B],
      ["workspace_memberships", "subject", "user-b"],
      ["quota_usage", "workspace_id", WS_B],
      ["security_denies", "workspace_id", WS_B],
      ["audit_events", "workspace_id", WS_B],
      ["personal_workspaces", "id", WS_B],
      ["quota_policies", "workspace_id", WS_B],
      ["hubs", "id", HUB_B_PRIVATE],
      ["hub_releases", "release_digest", RELEASE_B_PRIVATE],
    ];

    // Markers are chosen to be values the caller can never legitimately see. A
    // `workspace_id` is *not* a safe marker on `hubs`: a public hub's row carries
    // its own owning workspace, and `private.can_read_hub` hands that row to every
    // subject, so WS_B legitimately appears in an A member's result. The private
    // hub *id* is the marker there instead.
    for (const [table, column, bValue] of wider) {
      const asPrivileged = privileged(table, column);
      assert.ok(
        occurrences(asPrivileged, bValue) > 0,
        `the privileged view of ${table}.${column} must contain ${bValue}, so the contrast against the caller is real`,
      );
      // And the owner of workspace A, through the console, does not get it. Driven
      // through the adapter, not psql.
      const viaConsole = await readAs("user-a", table, { limit: CONTROL_PLANE_MAX_LIMIT });
      assert.equal(
        occurrences(viaConsole, bValue),
        0,
        `user-a reading ${table} through the console saw ${bValue}, which the privileged view also sees: the console read is not RLS-limited`,
      );
    }

    // And the reverse direction, so the control is not one-sided.
    for (const [table, column, aValue] of [
      ["projects", "id", PROJECT_A],
      ["project_contexts", "id", CONTEXT_A],
      ["workspace_memberships", "subject", "admin-a"],
      ["audit_events", "workspace_id", WS_A],
    ]) {
      assert.ok(
        occurrences(privileged(table, column), aValue) > 0,
        `the privileged view of ${table} must contain workspace A's ${aValue}`,
      );
      const viaConsole = await readAs("user-b", table, { limit: CONTROL_PLANE_MAX_LIMIT });
      assert.equal(
        occurrences(viaConsole, aValue),
        0,
        `user-b reading ${table} through the console saw workspace A's ${aValue}`,
      );
    }
  });

  test("the privileged role really does bypass RLS, so the contrast above is a privilege difference", () => {
    const bypass = (role) =>
      psql(DB_URL, `select rolbypassrls::text from pg_roles where rolname = '${role}';`).trim();
    assert.equal(
      bypass("service_role"),
      "true",
      "service_role must be bypassrls for the negative control to mean anything",
    );
    assert.equal(
      bypass("authenticated"),
      "false",
      "authenticated must not bypass RLS; the console's caller is this role",
    );
  });

  test("every request the adapter made carried a caller token this suite issued", () => {
    assert.ok(REQUESTS.length > 0, "no request was recorded, so nothing was actually driven");
    for (const name of REQUESTS) {
      assert.notEqual(name, "expired", "an expired token must never reach a read");
    }
  });

  test("an expired session is 401 and reads nothing at all", async () => {
    await assert.rejects(callerFromToken(EXPIRED_TOKEN), (error) => {
      assert.equal(error.status, 401);
      return true;
    });
    await assert.rejects(
      readAsToken(EXPIRED_TOKEN, "projects"),
      (error) => error.status === 401,
    );
  });
});

function q(value) {
  return `'${value}'`;
}

/* -------------------------------------------------------------------------- */
/* 2. Both directions, every surface                                           */
/* -------------------------------------------------------------------------- */

describe("workspace A cannot read any workspace B row, through any console surface", () => {
  test("projects: A's owner sees only project A", async () => {
    const rows = await readAs("user-a", "projects");
    assertHasOwn(rows, PROJECT_A, "user-a reading projects");
    assertNoForbidden(rows, "projects", "B", "user-a reading projects");
  });

  test("project_contexts: A's owner sees A's live context and not B's", async () => {
    const rows = await readAs("user-a", "project_contexts");
    assertHasOwn(rows, CONTEXT_A, "user-a reading project_contexts");
    assertNoForbidden(rows, "project_contexts", "B", "user-a reading project_contexts");
    // A revoked context and one carrying a revocation row are hidden from A too:
    // the adapter must not resurrect them on the way through. Checked by id,
    // because A's one *live* context legitimately carries A's own `project_id`.
    for (const hidden of [CONTEXT_A_REVOKED, CONTEXT_A_TOMBSTONE]) {
      assert.equal(
        occurrences(rows, hidden),
        0,
        `A's revoked or tombstoned context ${hidden} must be hidden from its own owner: ${JSON.stringify(rows)}`,
      );
    }
    assert.equal(occurrences(rows, CONTEXT_A), 1, "exactly the one live context of A");
  });

  test("workspace_memberships: A's owner sees A's members and not B's owner", async () => {
    const rows = await readAs("user-a", "workspace_memberships");
    assert.ok(rows.length >= 6, `expected A's memberships, got ${JSON.stringify(rows)}`);
    assertHasOwn(rows, "viewer-a", "user-a reading workspace_memberships");
    assert.equal(occurrences(rows, "user-b"), 0, "B's owner must not appear in A's roster");
  });

  test("quota_policies, quota_usage, security_denies and audit_events carry no B row", async () => {
    for (const table of ["quota_policies", "quota_usage", "security_denies", "audit_events"]) {
      const rows = await readAs("user-a", table);
      assert.ok(rows.length > 0, `${table} must be visible to its owner or the assertion is vacuous`);
      assertNoForbidden(rows, table, "B", `user-a reading ${table}`);
    }
  });

  test("personal_workspaces: A's owner sees A's own workspace and nothing of B's", async () => {
    const rows = await readAs("user-a", "personal_workspaces");
    assertHasOwn(rows, WS_A, "user-a reading personal_workspaces");
    assertNoForbidden(rows, "personal_workspaces", "B", "user-a reading personal_workspaces");
  });

  test("hubs: A's owner sees no private or workspace hub of B's", async () => {
    const rows = await readAs("user-a", "hubs");
    assertHasOwn(rows, HUB_A_PRIVATE, "user-a reading hubs");
    assertNoForbidden(rows, "hubs", "B", "user-a reading hubs");
    // B's *public* hub is legitimately visible: `private.can_read_hub` grants
    // public visibility to everyone. Asserted explicitly so the exception is
    // documented rather than assumed, and so removing it would fail here.
    assertHasOwn(rows, HUB_B_PUBLIC, "user-a reading hubs (public visibility crosses workspaces)");
    // The one genuinely non-public B row is absent.
    assert.equal(occurrences(rows, HUB_B_PRIVATE), 0, "B's private hub must be hidden from A's owner");
  });

  test("hub_releases and hub_stable_pointers carry no B release", async () => {
    const releases = await readAs("user-a", "hub_releases");
    assertHasOwn(releases, RELEASE_A_PRIVATE, "user-a reading hub_releases");
    assertNoForbidden(releases, "hub_releases", "B", "user-a reading hub_releases");
    assert.equal(occurrences(releases, RELEASE_B_PRIVATE), 0, "B's private release must be hidden");

    const pointers = await readAs("user-a", "hub_stable_pointers");
    assert.ok(pointers.length > 0, "the owner must see its own stable pointers");
    assertNoForbidden(pointers, "hub_stable_pointers", "B", "user-a reading hub_stable_pointers");
  });

  test("an inactive member of A reads nothing of A, let alone of B", async () => {
    // `workspace_memberships` is excluded from the blanket assertion and handled
    // on its own just below, for a stated policy reason.
    for (const table of READABLE_TABLES.filter((name) => name !== "workspace_memberships")) {
      const rows = await readAs("inactive-a", table, { limit: CONTROL_PLANE_MAX_LIMIT });
      // A revoked membership in A overrides public visibility *for A's resources*
      // (`private.has_inactive_membership` is evaluated against the resource's own
      // workspace). It does not reach B's, so a public B hub release may legitimately
      // appear. What must never appear is anything of A.
      assertNoForbidden(rows, table, "A", `inactive-a reading ${table}`);
      assertNoForbidden(rows, table, "B", `inactive-a reading ${table}`);
    }
    // The one row RLS still grants an inactive member is its *own* membership:
    // `membership_self_or_admin_read` uses `subject = auth.jwt() ->> 'sub'`, which
    // does not test `active`, so the row's own `workspace_id` legitimately appears.
    // Asserted rather than waved away, because it is the only thing that makes
    // "an inactive member reads nothing" not literally true.
    const own = await readAs("inactive-a", "workspace_memberships", {
      limit: CONTROL_PLANE_MAX_LIMIT,
    });
    assert.deepEqual(
      own.map((row) => row["subject"]),
      ["inactive-a"],
      `inactive-a must see only its own membership row, got ${JSON.stringify(own)}`,
    );
    assert.equal(own[0]["active"], "false", "and the row must report itself inactive");
    // Every *other* A subject must be invisible to it.
    for (const subject of ["user-a", "admin-a", "maintainer-a", "member-a", "viewer-a"]) {
      assert.equal(
        occurrences(own, subject),
        0,
        `inactive-a must not see ${subject}'s membership`,
      );
    }
    // Every workspace-scoped surface is empty, and A's own hubs are empty too.
    // `workspace_memberships` is excluded: the inactive member sees its own row,
    // asserted immediately above.
    for (const table of [
      "personal_workspaces",
      "projects",
      "project_contexts",
      "context_revocations",
      "quota_policies",
      "quota_usage",
      "security_denies",
      "audit_events",
    ]) {
      assert.deepEqual(
        await readAs("inactive-a", table, { limit: CONTROL_PLANE_MAX_LIMIT }),
        [],
        `inactive-a must read zero rows from ${table}`,
      );
    }
    const hubs = await readAs("inactive-a", "hubs", { limit: CONTROL_PLANE_MAX_LIMIT });
    for (const hub of [HUB_A_PRIVATE, HUB_A_WORKSPACE, HUB_A_DENIED, HUB_A_PUBLIC]) {
      assert.equal(occurrences(hubs, hub), 0, `inactive-a must not read A's hub ${hub}`);
    }
  });

  test("a subject with no membership in either workspace reads nothing of either", async () => {
    for (const table of READABLE_TABLES) {
      const rows = await readAs("outsider", table, { limit: CONTROL_PLANE_MAX_LIMIT });
      assertNoForbiddenEither(rows, table, `outsider reading ${table}`);
    }
    // The genuinely private rows are unreachable.
    assert.equal(occurrences(await readAs("outsider", "hubs"), HUB_A_PRIVATE), 0);
    assert.equal(occurrences(await readAs("outsider", "hubs"), HUB_A_WORKSPACE), 0);
    assert.equal(occurrences(await readAs("outsider", "hubs"), HUB_B_PRIVATE), 0);
    for (const table of [
      "projects",
      "project_contexts",
      "context_revocations",
      "workspace_memberships",
      "audit_events",
      "security_denies",
      "quota_policies",
      "quota_usage",
      "personal_workspaces",
    ]) {
      assert.deepEqual(
        await readAs("outsider", table, { limit: CONTROL_PLANE_MAX_LIMIT }),
        [],
        `a non-member must read zero rows from ${table}`,
      );
    }
  });
});

describe("workspace B cannot read any workspace A row, through any console surface", () => {
  test("projects: B's owner sees only project B", async () => {
    const rows = await readAs("user-b", "projects");
    assertHasOwn(rows, PROJECT_B, "user-b reading projects");
    assertNoForbidden(rows, "projects", "A", "user-b reading projects");
  });

  test("project_contexts: B's owner sees B's context and not A's", async () => {
    const rows = await readAs("user-b", "project_contexts");
    assertHasOwn(rows, CONTEXT_B, "user-b reading project_contexts");
    assertNoForbidden(rows, "project_contexts", "A", "user-b reading project_contexts");
  });

  test("memberships, quotas, denies, audit, workspaces and pointers carry no A row", async () => {
    for (const table of [
      "workspace_memberships",
      "quota_policies",
      "quota_usage",
      "audit_events",
      "personal_workspaces",
      "hub_stable_pointers",
      "projects",
      "project_contexts",
    ]) {
      const rows = await readAs("user-b", table, { limit: CONTROL_PLANE_MAX_LIMIT });
      assert.ok(rows.length > 0, `${table} must be visible to B's owner or the assertion is vacuous`);
      assertNoForbidden(rows, table, "A", `user-b reading ${table}`);
    }
  });

  test("hubs: B's owner sees no private or workspace hub of A's", async () => {
    const rows = await readAs("user-b", "hubs");
    assertHasOwn(rows, HUB_B_PRIVATE, "user-b reading hubs");
    assertNoForbidden(rows, "hubs", "A", "user-b reading hubs");
    // A's public hub is legitimately visible, for the same policy reason.
    assertHasOwn(rows, HUB_A_PUBLIC, "user-b reading hubs (public visibility crosses workspaces)");
    assert.equal(occurrences(rows, HUB_A_PRIVATE), 0, "A's private hub must be hidden from B's owner");
  });

  test("hub_releases carry no private A release digest", async () => {
    const rows = await readAs("user-b", "hub_releases");
    assertHasOwn(rows, RELEASE_B_PRIVATE, "user-b reading hub_releases");
    assertNoForbidden(rows, "hub_releases", "A", "user-b reading hub_releases");
    // A's *public* hub release is visible by policy; A's private one is not. Assert
    // both, so the boundary is stated rather than inferred from a single absence.
    assertHasOwn(rows, RELEASE_A_PUBLIC, "user-b reading A's public release");
    assert.equal(occurrences(rows, RELEASE_A_PRIVATE), 0, "A's private release must be hidden");
  });

  test("A's explicitly denied hub and release are hidden from A's own owner", async () => {
    // Not an isolation assertion, but it belongs here: it proves the console's read
    // path can express a deny at all, which is what makes the "no leak" assertions
    // above more than a column filter.
    const hubs = await readAs("user-a", "hubs");
    assert.equal(occurrences(hubs, HUB_A_DENIED), 0, "an explicit deny must hide the row from its owner");
    const releases = await readAs("user-a", "hub_releases");
    assert.equal(occurrences(releases, digest("5")), 0, "a denied release must be hidden from its owner");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Role-scoped surfaces                                                     */
/* -------------------------------------------------------------------------- */

describe("owner and admin see the owner-scoped tables; a viewer sees none of them", () => {
  test("security_denies, audit_events, quota_usage and quota_policies are owner/admin only", async () => {
    for (const table of ["security_denies", "audit_events", "quota_usage", "quota_policies"]) {
      const owner = await readAs("user-a", table);
      const admin = await readAs("admin-a", table);
      const viewer = await readAs("viewer-a", table);
      const member = await readAs("member-a", table);
      const maintainer = await readAs("maintainer-a", table);
      assert.ok(owner.length > 0, `${table}: the owner must see rows`);
      assert.ok(admin.length > 0, `${table}: an admin must see rows`);
      assert.deepEqual(viewer, [], `${table}: a viewer must see nothing (owner/admin scoped)`);
      assert.deepEqual(member, [], `${table}: a member must see nothing (owner/admin scoped)`);
      assert.deepEqual(maintainer, [], `${table}: a maintainer must see nothing (owner/admin scoped)`);
      // And neither privileged role ever sees the other workspace.
      assertNoForbidden(owner, table, "B", `user-a reading ${table}`);
      assertNoForbidden(admin, table, "B", `admin-a reading ${table}`);
    }
  });

  test("a viewer sees exactly the surfaces its role permits", async () => {
    // Member-visible: projects, contexts, memberships (self or admin), hubs.
    assert.ok((await readAs("viewer-a", "projects")).length > 0, "a viewer reads its workspace projects");
    assert.ok((await readAs("viewer-a", "project_contexts")).length > 0, "a viewer reads its workspace contexts");
    assert.ok((await readAs("viewer-a", "hubs")).length > 0, "a viewer reads visible hubs");
    // Memberships: a viewer sees only its OWN row, not the workspace's roster.
    const memberships = await readAs("viewer-a", "workspace_memberships");
    assert.equal(occurrences(memberships, "viewer-a"), 1, "a viewer sees its own membership");
    assert.equal(occurrences(memberships, "admin-a"), 0, "a viewer must not read the roster");
    assert.equal(occurrences(memberships, "user-a"), 0, "a viewer must not read the owner");
    assertNoForbidden(memberships, "workspace_memberships", "B", "viewer-a reading memberships");
    // Revocation metadata is owner/admin only.
    assert.deepEqual(await readAs("viewer-a", "context_revocations"), []);
    const adminRevocations = await readAs("admin-a", "context_revocations");
    assert.ok(adminRevocations.length > 0, "an admin reads revocation metadata");
    assertNoForbidden(adminRevocations, "context_revocations", "B", "admin-a reading context_revocations");
    // A viewer reads only its own personal workspace row.
    const workspaces = await readAs("viewer-a", "personal_workspaces");
    assert.deepEqual(workspaces, [], "personal_workspaces is owner_subject-scoped");
  });

  test("every role in workspace A leaks nothing of workspace B on any surface", async () => {
    for (const subject of ["admin-a", "maintainer-a", "member-a", "viewer-a"]) {
      for (const table of READABLE_TABLES) {
        const rows = await readAs(subject, table, { limit: CONTROL_PLANE_MAX_LIMIT });
        assertNoForbidden(rows, table, "B", `${subject} reading ${table}`);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. A delegated OAuth token reads zero rows                                  */
/* -------------------------------------------------------------------------- */

describe("a delegated OAuth token reads zero control-plane rows through the console", () => {
  test("the delegated token is accepted as a session but sees nothing at all", async () => {
    // Accepted: the console must not special-case the token shape. The containment
    // is a database policy, and the console must not reimplement it. If the console
    // *did* special-case it, the proof would be about the console's own check
    // rather than about the containment policy.
    const caller = await callerFromToken(DELEGATED_TOKEN);
    assert.equal(caller.subject, "user-a", "the delegated token resolves to the same subject");

    // The owner, through a first-party session, sees rows. So the fixture is real.
    assert.ok((await readAs("user-a", "projects")).length > 0, "the first-party owner must see rows");
    assert.ok(
      (await readAs("user-a", "workspace_memberships")).length > 0,
      "the first-party owner must see memberships",
    );

    // The same subject, with a `client_id` claim, sees exactly zero.
    for (const table of READABLE_TABLES) {
      const rows = await readAsToken(DELEGATED_TOKEN, table, { limit: CONTROL_PLANE_MAX_LIMIT });
      assert.deepEqual(
        rows,
        [],
        `a delegated OAuth token must read zero rows from ${table}, got ${JSON.stringify(rows)}`,
      );
    }
  });

  test("containment holds through a filter as well as an unfiltered read", async () => {
    const rows = await readAsToken(DELEGATED_TOKEN, "projects", {
      filters: [{ column: "workspace_id", values: [WS_A] }],
      limit: CONTROL_PLANE_MAX_LIMIT,
    });
    assert.deepEqual(rows, [], "a filter must not defeat the containment policy");
  });

  test("every control-plane table carries the RESTRICTIVE containment policy", () => {
    const count = Number(
      psql(
        DB_URL,
        "select count(*) from pg_policies where schemaname = 'public' and policyname = 'delegated_oauth_containment' and permissive = 'RESTRICTIVE';",
      ).trim(),
    );
    assert.ok(
      count >= READABLE_TABLES.length,
      `expected the containment policy on all sixteen tables, found ${count}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 5. A client-supplied id is a filter, never a capability                     */
/* -------------------------------------------------------------------------- */

describe("supplying another workspace's id as a filter grants nothing", () => {
  test("A filtering projects by B's workspace id gets zero rows", async () => {
    const rows = await readAs("user-a", "projects", {
      filters: [{ column: "workspace_id", values: [WS_B] }],
      limit: CONTROL_PLANE_MAX_LIMIT,
    });
    assert.deepEqual(rows, [], `A filtered by B's workspace must get nothing, got ${JSON.stringify(rows)}`);
  });

  test("A filtering by B's exact project id gets zero rows", async () => {
    const rows = await readAs("user-a", "projects", {
      filters: [{ column: "id", values: [PROJECT_B] }],
      limit: CONTROL_PLANE_MAX_LIMIT,
    });
    assert.deepEqual(rows, [], `A filtered by B's project id must get nothing, got ${JSON.stringify(rows)}`);
  });

  test("A filtering by B's exact context id gets zero rows, and B's own read still works", async () => {
    const asA = await readAs("user-a", "project_contexts", {
      filters: [{ column: "id", values: [CONTEXT_B] }],
      limit: CONTROL_PLANE_MAX_LIMIT,
    });
    assert.deepEqual(asA, [], "A filtered by B's context id must get nothing");
    const asB = await readAs("user-b", "project_contexts", {
      filters: [{ column: "id", values: [CONTEXT_B] }],
      limit: CONTROL_PLANE_MAX_LIMIT,
    });
    assertHasOwn(asB, CONTEXT_B, "B filtered by B's context id");
  });

  test("A filtering memberships, quotas, denies and audit by B's workspace gets zero rows", async () => {
    // Every table whose RLS policy is workspace-scoped. `hubs` is excluded: a public
    // hub legitimately carries its owning `workspace_id`, so filtering `hubs` by
    // WS_B correctly returns B's *public* hub and only that. It is asserted
    // separately below, which is a stronger statement than "zero rows".
    // `personal_workspaces` is keyed by `id`, not `workspace_id`, so it is filtered
    // on `id`. Asserted here so the allow-list's naming is exercised rather than
    // assumed.
    const byColumn = {
      workspace_memberships: "workspace_id",
      quota_policies: "workspace_id",
      quota_usage: "workspace_id",
      security_denies: "workspace_id",
      audit_events: "workspace_id",
      personal_workspaces: "id",
    };
    for (const [table, column] of Object.entries(byColumn)) {
      const rows = await readAs("user-a", table, {
        filters: [{ column, values: [WS_B] }],
        limit: CONTROL_PLANE_MAX_LIMIT,
      });
      assert.deepEqual(rows, [], `A filtered ${table} by B's workspace must get nothing, got ${JSON.stringify(rows)}`);
    }
  });

  test("filtering hubs by B's workspace returns exactly B's public hub and nothing private", async () => {
    const rows = await readAs("user-a", "hubs", {
      filters: [{ column: "workspace_id", values: [WS_B] }],
      limit: CONTROL_PLANE_MAX_LIMIT,
    });
    // This is the interesting case rather than a nuisance: a filter on another
    // workspace's id is honoured to the extent RLS permits, which for a *public*
    // hub means the row is legitimately returned. The point proven is that the
    // filter cannot widen anything: B's private hub is still absent.
    assert.deepEqual(
      rows.map((row) => row["id"]),
      [HUB_B_PUBLIC],
      `filtering hubs by B's workspace must yield only B's public hub, got ${JSON.stringify(rows)}`,
    );
    assertNoForbidden(rows, "hubs", "B", "A filtering hubs by B's workspace");
  });

  test("filtering hubs by B's private hub id gets nothing even though the row exists", async () => {
    const rows = await readAs("user-a", "hubs", {
      filters: [{ column: "id", values: [HUB_B_PRIVATE] }],
      limit: CONTROL_PLANE_MAX_LIMIT,
    });
    assert.deepEqual(rows, [], "naming B's private hub id directly must not reveal the row");
  });

  test("the same filter in the other direction is equally powerless", async () => {
    for (const table of ["projects", "project_contexts", "workspace_memberships", "quota_usage"]) {
      const column = table === "projects" || table === "project_contexts" ? "id" : "workspace_id";
      const value =
        table === "projects"
          ? PROJECT_A
          : table === "project_contexts"
            ? CONTEXT_A
            : WS_A;
      const rows = await readAs("user-b", table, {
        filters: [{ column, values: [value] }],
        limit: CONTROL_PLANE_MAX_LIMIT,
      });
      assert.deepEqual(rows, [], `B filtered ${table} by A's value must get nothing, got ${JSON.stringify(rows)}`);
    }
  });

  test("a multi-value filter spanning both workspaces returns only the caller's own rows", async () => {
    const rows = await readAs("user-a", "projects", {
      filters: [{ column: "workspace_id", values: [WS_A, WS_B] }],
      limit: CONTROL_PLANE_MAX_LIMIT,
    });
    assertHasOwn(rows, PROJECT_A, "A filtering by both workspaces");
    assertNoForbidden(rows, "projects", "B", "A filtering projects by both workspaces");
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The adapter's own refusals still hold against a real database            */
/* -------------------------------------------------------------------------- */

describe("adapter refusals are refusals, not empty results", () => {
  test("an un-allow-listed table raises, even though the database would serve it", async () => {
    // `source_credentials` is readable by an admin and exists in the database. The
    // console must refuse it at the allow-list, *before* any request, so RLS never
    // gets the chance to be the thing that says no.
    const caller = await callerFor("user-a");
    const before = REQUESTS.length;
    await assert.rejects(reader.readAsCaller(caller, "source_credentials"), (error) => {
      assert.equal(error.code, "E_WEB_READ_TABLE_NOT_ALLOWED");
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(REQUESTS.length, before, "a refused table still reached the database");
  });

  test("an oversized page is refused by the adapter before the database is asked", async () => {
    const caller = await callerFor("user-a");
    const before = REQUESTS.length;
    await assert.rejects(
      reader.readAsCaller(caller, "projects", { limit: CONTROL_PLANE_MAX_LIMIT + 1 }),
      (error) => {
        assert.equal(error.code, "E_WEB_READ_LIMIT_INVALID");
        return true;
      },
    );
    assert.equal(REQUESTS.length, before, "an oversized page still reached the database");
  });

  test("a value that is not of the declared kind is refused before the database is asked", async () => {
    const caller = await callerFor("user-a");
    const before = REQUESTS.length;
    for (const value of ["not-a-uuid", "' or '1'='1", WS_A + "'; drop table projects; --"]) {
      await assert.rejects(
        reader.readAsCaller(caller, "projects", {
          filters: [{ column: "workspace_id", values: [value] }],
        }),
        (error) => error.code === "E_WEB_READ_FILTER_INVALID",
      );
    }
    assert.equal(REQUESTS.length, before, "a malformed value still reached the database");
  });

  test("the fixture can still read a large page, so the bound is the adapter's and not the fixture's", async () => {
    // The assertion above could be vacuous if this transport refused every limit.
    // This proves the fixture serves an explicit limit faithfully.
    const rows = await readAs("user-a", "workspace_memberships", { limit: 2 });
    assert.equal(rows.length, 2, "a limit of 2 must return exactly 2 rows through the fixture");
  });
});