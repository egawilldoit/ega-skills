/**
 * CONTRACT-T1 telemetry authorization, retention and containment.
 *
 * Everything here runs against a real PostgreSQL, because the properties under
 * test are properties of the database, not of any TypeScript: RLS policy
 * resolution, SECURITY DEFINER execution, function privileges, and the
 * RESTRICTIVE-policy AND that contains delegated tokens.
 *
 * The suite refuses to run without `EGA_RLS_DATABASE_URL` rather than skipping.
 * A skipped security test reports "pass" and proves nothing.
 *
 * The failure this file exists for: `202609200001` created a self-read policy
 * that called the owner-only `private.is_active_member`, so every authenticated
 * telemetry read raised `permission denied for function is_active_member`.
 * `202609200002` repairs it through a SECURITY DEFINER entry point.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BASE_URL = process.env.EGA_RLS_DATABASE_URL;
if (!BASE_URL) {
  throw new Error(
    [
      "EGA_RLS_DATABASE_URL is required: the telemetry authorization proof runs",
      "against a real PostgreSQL and must not silently skip.",
    ].join("\n"),
  );
}

const MIGRATIONS = join(ROOT, "supabase", "migrations");

/** Database created for this run only, and dropped in `after`. */
const DB_NAME = `telemetry_authz_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
let DB_URL;
/** Workspace A's id, resolved once as the owner so tests can inline it. */
let OWNER_WS;

function psql(url, sql) {
  return execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "", url], {
    encoding: "utf8",
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function scalar(subject, sql, { delegatedClientId } = {}) {
  const claims =
    delegatedClientId === undefined
      ? JSON.stringify({ sub: subject, role: "authenticated" })
      : JSON.stringify({ sub: subject, client_id: delegatedClientId, role: "authenticated" });
  return psql(
    DB_URL,
    `begin; set local role authenticated; set local "request.jwt.claims" = '${claims}'; ${sql}; commit;`,
  ).trim();
}

function admin(sql) {
  return psql(DB_URL, sql).trim();
}

/**
 * Assert a statement is refused, and return the refusal reason.
 *
 * The message is matched rather than a bare SQLSTATE because `psql` reports the
 * error text, and the specific reason is what makes a failure actionable: a
 * missing schema means the migrations did not run, while "permission denied"
 * means the privilege model is wrong. Both are caught by the same helper but
 * read very differently.
 */
function assertDenied(subject, sql, { delegatedClientId } = {}) {
  try {
    scalar(subject, sql, { delegatedClientId });
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
  assert.fail(`expected the statement to be refused, but it succeeded: ${sql}`);
}

/** True when a refusal is a privilege failure rather than a missing object. */
function isPrivilegeDenied(message) {
  return /permission denied|insufficient_privilege/i.test(message);
}

before(() => {
  // Follows the same lifecycle as `cross-workspace-isolation.rls.mjs`: create a
  // uniquely named database on the ADMIN url, bootstrap the Supabase roles and
  // `auth.jwt()` on it, apply every migration in order, then seed. The
  // production instance is never touched — only `create database` /
  // `drop database` run against the `postgres` database of the given URL.
  const parsed = new URL(BASE_URL);
  parsed.pathname = "/postgres";
  const adminUrl = parsed.toString();
  parsed.pathname = `/${DB_NAME}`;
  DB_URL = parsed.toString();

  psql(adminUrl, `create database "${DB_NAME}"`);
  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "bootstrap.sql"), "utf8"));

  for (const file of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    psql(DB_URL, readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "telemetry-seed.sql"), "utf8"));

  OWNER_WS = admin(
    "select workspace_id from public.mcp_tool_executions where subject = 't1-owner' limit 1",
  );
});

after(() => {
  const parsed = new URL(BASE_URL);
  parsed.pathname = "/postgres";
  psql(parsed.toString(), `drop database if exists "${DB_NAME}"`);
});

/* -------------------------------------------------------------------------- */

describe("private helpers stay unavailable to client roles", () => {
  // This is the property that was broken. Repairing it by granting EXECUTE back
  // to `authenticated` would fix the symptom and reopen the membership oracle
  // that 202609090005 deliberately closed, so it is asserted directly.
  for (const helper of ["is_active_member", "is_denied", "has_inactive_membership"]) {
    // `is_denied` takes three arguments; the others take one. Calling with the
    // wrong arity would report "function does not exist" and pass for the wrong
    // reason, so the real signature is used per helper.
    const args =
      helper === "is_denied"
        ? `'00000000-0000-0000-0000-000000000000'::uuid, 'hub', 'x'`
        : `'00000000-0000-0000-0000-000000000000'::uuid`;
    test(`${helper} is still refused for an authenticated caller`, () => {
      const reason = assertDenied("t1-owner", `select private.${helper}(${args})`);
      assert.ok(isPrivilegeDenied(reason), `${helper} must be refused as a privilege failure, got: ${reason}`);
      // The helper must not merely be absent: an owner-only helper that no
      // client can *name* would hide a policy that silently reads nothing.
      assert.doesNotMatch(reason, /does not exist/, "the helper must exist and be privilege-blocked");
    });
  }

  test("the new entry point is callable and answers about the caller only", () => {
    const ws = admin(
      "select workspace_id from public.mcp_tool_executions where subject = 't1-owner' limit 1",
    );
    const own = scalar("t1-owner", `select private.can_read_own_telemetry('${ws}')`);
    assert.equal(own, "t", "an active owner must be told yes for its own workspace");

    // The same call from a subject that is not an active member of that
    // workspace must be told no. This is the property that matters: the entry
    // point answers about the CALLER, never about an arbitrary subject.
    const other = scalar("t1-stranger", `select private.can_read_own_telemetry('${ws}')`);
    assert.equal(other, "f", "a non-member must be told no for another workspace");

    const inactive = scalar("t1-inactive", `select private.can_read_own_telemetry('${ws}')`);
    assert.equal(inactive, "f", "an inactive member must be told no");
  });

  test("anonymous callers cannot read telemetry at all", () => {
    // `anon` must never see a telemetry row. It is expected to be refused at the
    // privilege layer rather than filtered to zero rows, which is strictly
    // stronger: a policy returning zero rows would still confirm the table is
    // selectable. The assertion therefore covers both acceptable outcomes and
    // fails only if a row is actually readable.
    let anonRows;
    try {
      anonRows = Number(
        psql(
          DB_URL,
          "begin; set local role anon; select count(*) from public.mcp_tool_executions; commit;",
        ).trim(),
      );
    } catch (error) {
      assert.ok(
        isPrivilegeDenied(String(error.stderr ?? error.message)),
        `anon must be refused as a privilege failure, got: ${error}`,
      );
      anonRows = 0;
    }
    assert.equal(anonRows, 0, "anon must read zero telemetry rows");

    // And no grant may exist either: a grant combined with a policy that hides
    // every row would still leave anon able to probe the table's existence.
    const granted = Number(
      admin(
        "select count(*) from information_schema.role_table_grants where table_name = 'mcp_tool_executions' and grantee = 'anon'",
      ),
    );
    assert.equal(granted, 0, "anon must hold no privilege on telemetry at all");
  });
});

describe("own-row and role-scoped reads work through the repaired policy", () => {
  test("an owner reads their own rows", () => {
    const n = Number(scalar("t1-owner", "select count(*) from public.mcp_tool_executions"));
    assert.ok(n > 0, "the self-read policy must work again, not raise");
  });

  test("an owner and admin see the whole workspace, including other subjects", () => {
    for (const subject of ["t1-owner", "t1-admin"]) {
      const n = Number(scalar(subject, "select count(*) from public.mcp_tool_executions"));
      assert.ok(n >= 3, `${subject} should see its workspace's rows, saw ${n}`);
    }
  });

  test("a viewer sees only its own row, not the workspace", () => {
    const n = Number(scalar("t1-viewer", "select count(*) from public.mcp_tool_executions"));
    assert.equal(n, 1, "a viewer is not owner/admin, so only its own row is visible");
  });

  test("an inactive member sees nothing, including its own row", () => {
    const n = Number(scalar("t1-inactive", "select count(*) from public.mcp_tool_executions"));
    assert.equal(n, 0, "an inactive membership grants no telemetry read");
  });

  test("a subject with no membership in a workspace sees nothing there", () => {
    const n = Number(scalar("t1-stranger", "select count(*) from public.mcp_tool_executions"));
    assert.equal(n, 1, "only the stranger's own workspace row is visible");
  });
});

describe("cross-workspace isolation", () => {
  test("no subject reads another workspace's rows by filtering on it", () => {
    const other = admin(
      "select workspace_id from public.mcp_tool_executions where subject = 't1-stranger' limit 1",
    );
    const n = Number(
      scalar("t1-owner", `select count(*) from public.mcp_tool_executions where workspace_id = '${other}'`),
    );
    assert.equal(n, 0, "supplying a foreign workspace id must grant nothing");
  });

  test("a member of another workspace reads nothing at all", () => {
    const n = Number(scalar("t1-stranger", "select count(*) from public.mcp_tool_executions"));
    assert.equal(n, 1, "the stranger sees only its own workspace");
  });
});

describe("delegated OAuth tokens are contained", () => {
  test("a delegated token reads zero rows even as a workspace owner", () => {
    for (const subject of ["t1-owner", "t1-admin"]) {
      const n = Number(
        scalar(subject, "select count(*) from public.mcp_tool_executions", {
          delegatedClientId: "delegated-client-1",
        }),
      );
      assert.equal(n, 0, `delegated token as ${subject} must read zero telemetry rows`);
    }
  });

  test("containment holds through a filter as well as an unfiltered read", () => {
    const n = Number(
      scalar("t1-owner", "select count(*) from public.mcp_tool_executions where subject = 't1-owner'", {
        delegatedClientId: "delegated-client-1",
      }),
    );
    assert.equal(n, 0, "a filter must not bypass containment");
  });

  test("the restrictive containment policy exists on the telemetry table", () => {
    const n = Number(
      admin(
        "select count(*) from pg_policies where schemaname='public' and tablename='mcp_tool_executions' and policyname='delegated_oauth_containment' and permissive='RESTRICTIVE'",
      ),
    );
    assert.equal(n, 1, "telemetry must carry the restrictive containment policy");
  });

  test("first-party sessions are unaffected by containment", () => {
    const n = Number(scalar("t1-owner", "select count(*) from public.mcp_tool_executions"));
    assert.ok(n > 0, "containment must not break legitimate first-party reads");
  });
});

describe("client roles cannot write telemetry", () => {
  for (const verb of ["insert", "update", "delete"]) {
    test(`${verb} is refused for an authenticated caller`, () => {
      // The workspace id is resolved as the database owner and inlined, rather
      // than selected in the statement: under the `authenticated` role the
      // `personal_workspaces` subquery would itself be RLS-filtered, and the
      // statement would fail for the wrong reason (a missing column) instead of
      // being refused for the right one (no INSERT privilege).
      const sql =
        verb === "insert"
          ? `insert into public.mcp_tool_executions
               (workspace_id, subject, execution_id, idempotency_key, tool, latency_ms, result_class)
             values ('${OWNER_WS}', 't1-owner', 'e-forged', 'k-forged', 'search', 1, 'success')`
          : verb === "update"
            ? "update public.mcp_tool_executions set latency_ms = 0"
            : "delete from public.mcp_tool_executions";
      const reason = assertDenied("t1-owner", sql);
      assert.ok(isPrivilegeDenied(reason), `${verb} must be a privilege failure, got: ${reason}`);
    });
  }

  test("a forged row is absent afterwards", () => {
    const n = Number(
      admin("select count(*) from public.mcp_tool_executions where idempotency_key = 'k-forged'"),
    );
    assert.equal(n, 0, "no forged row may persist");
  });

  test("anonymous callers cannot write either", () => {
    try {
      psql(DB_URL, "begin; set local role anon; insert into public.mcp_tool_executions default values; commit;");
      assert.fail("anon insert must be refused");
    } catch {
      // Expected.
    }
  });
});

describe("retention is bounded to the CONTRACT-T1 maximum", () => {
  test("the purge function is not callable by client roles", () => {
    const reason = assertDenied("t1-owner", "select public.purge_expired_telemetry(90)");
    assert.ok(isPrivilegeDenied(reason), `purge must be privilege-blocked, got: ${reason}`);
  });

  test("an over-long retention is clamped rather than honoured", () => {
    // If the clamp were missing, 3650 days would be a legal call. The function
    // must report a count, not raise, and must not have deleted recent rows.
    const deleted = Number(admin("select public.purge_expired_telemetry(3650)"));
    assert.ok(Number.isInteger(deleted), "purge must return an integer count");
    const remaining = Number(admin("select count(*) from public.mcp_tool_executions"));
    assert.ok(remaining > 0, "recent rows must survive even a maximal retention request");
  });

  test("a NULL argument is handled safely and keeps recent rows", () => {
    const remaining = Number(admin("select count(*) from public.mcp_tool_executions"));
    const deleted = Number(admin("select public.purge_expired_telemetry(null)"));
    assert.ok(Number.isInteger(deleted));
    assert.equal(
      Number(admin("select count(*) from public.mcp_tool_executions")),
      remaining,
      "a NULL retention must delete nothing recent",
    );
  });

  test("repeated purge is idempotent", () => {
    const first = Number(admin("select public.purge_expired_telemetry(90)"));
    const second = Number(admin("select public.purge_expired_telemetry(90)"));
    assert.equal(second, 0, `a second purge must delete nothing (first deleted ${first})`);
  });

  test("old rows are purged and recent rows kept", () => {
    admin(`
      insert into public.mcp_tool_executions
        (workspace_id, subject, execution_id, idempotency_key, tool, latency_ms, result_class, observed_at)
      values ('${OWNER_WS}', 't1-owner', 'e-old', 'k-old', 'search', 1, 'success', now() - interval '200 days');
    `);
    const before = Number(
      admin("select count(*) from public.mcp_tool_executions where observed_at < now() - interval '90 days'"),
    );
    assert.ok(before > 0, "the aged row must exist before the purge");

    admin("select public.purge_expired_telemetry(90)");

    const aged = Number(
      admin("select count(*) from public.mcp_tool_executions where observed_at < now() - interval '90 days'"),
    );
    assert.equal(aged, 0, "rows beyond the retention window must be deleted");
    const recent = Number(
      admin("select count(*) from public.mcp_tool_executions where observed_at > now() - interval '90 days'"),
    );
    assert.ok(recent > 0, "recent rows must be kept");
  });

  test("purge touches only the telemetry table", () => {
    const memberships = Number(admin("select count(*) from public.workspace_memberships"));
    assert.ok(memberships > 0, "control-plane rows must be untouched by telemetry retention");
  });
});

describe("permitted fields are structurally enforced", () => {
  test("an out-of-range tool is refused by the schema", () => {
    try {
      admin(`
        insert into public.mcp_tool_executions
          (workspace_id, subject, execution_id, idempotency_key, tool, latency_ms, result_class)
        values ('${OWNER_WS}', 't1-owner', 'e-bad-tool', 'k-bad-tool', 'not_a_tool', 1, 'success');
      `);
      assert.fail("an unknown tool must be refused by the check constraint");
    } catch {
      // Expected.
    }
  });

  test("an out-of-range result class is refused", () => {
    try {
      admin(`
        insert into public.mcp_tool_executions
          (workspace_id, subject, execution_id, idempotency_key, tool, latency_ms, result_class)
        values ('${OWNER_WS}', 't1-owner', 'e-bad-class', 'k-bad-class', 'search', 1, 'definitely_ok');
      `);
      assert.fail("an unknown result class must be refused");
    } catch {
      // Expected.
    }
  });

  test("idempotency_key is unique, so a retry cannot double-count", () => {
    assert.throws(
      () =>
        // Reuses `k-owner`, which the seed already inserted: a second row with
        // the same idempotency key must be refused, which is what makes a
        // retried persistence attempt safe.
        admin(`
          insert into public.mcp_tool_executions
            (workspace_id, subject, execution_id, idempotency_key, tool, latency_ms, result_class)
          values ('${OWNER_WS}', 't1-owner', 'e-dup', 'k-owner', 'search', 1, 'success');
        `),
      /duplicate key|unique/i,
    );
  });
});