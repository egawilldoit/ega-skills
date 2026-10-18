/**
 * Catalog bootstrap against a real PostgreSQL.
 *
 * Runs the SQL the script actually renders — not a re-typed copy — against a
 * disposable database built from `supabase/migrations`, and proves the three
 * properties that cannot be proved without a database:
 *
 *  1. **idempotent** — a second apply writes nothing and does not fail;
 *  2. **never overwrites** — any disagreement with an existing row raises and
 *     aborts, leaving the database exactly as it was;
 *  3. **dependency-aware rollback** — the release row goes before the hub row,
 *     and the rollback refuses (removing nothing) when a stable pointer, another
 *     release, an artifact row, a publication or a project context depends on
 *     what it would delete.
 *
 * Requires a disposable database URL in `EGA_RLS_DATABASE_URL`, exactly like
 * `tests/rls/contract-f.rls.mjs`. It creates and drops its own database and never
 * touches a remote or production instance.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import {
  DEFAULT_ARTIFACT_DIR,
  planBootstrap,
  renderReadBack,
  renderReleaseReadBack,
  renderRollback,
  renderTransaction,
  verifyReviewedRelease,
} from "../../scripts/hosted/bootstrap-catalog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = process.env.EGA_RLS_DATABASE_URL;
if (!BASE_URL) {
  throw new Error("EGA_RLS_DATABASE_URL is required to run the catalog bootstrap suite");
}

const DB_NAME = `ega_bootstrap_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const DB_URL = withDatabase(BASE_URL, DB_NAME);
const ADMIN_URL = withDatabase(BASE_URL, "postgres");

/** The owner's workspace, and a second workspace for conflict cases. */
const WORKSPACE = "e692094d-b89a-4aed-b3be-76876f194db0";
const OTHER_WORKSPACE = "22222222-3333-4444-8555-666666666666";
/**
 * A workspace of its own for the release-scoped deny case: a `release` deny is
 * keyed on the digest and the workspace, so recording one in this suite's main
 * workspace would (correctly) refuse every later scenario that registers the
 * same reviewed digest. Isolating it keeps each scenario independent.
 */
const DENY_WORKSPACE = "66666666-7777-4888-8999-aaaaaaaaaaaa";

/** One hub UUID per scenario, so scenarios cannot interfere with each other. */
const HUB = "11111111-2222-4333-8444-555555555550";
const HUB_CONFLICT = "11111111-2222-4333-8444-555555555551";
const HUB_RELEASE_CONFLICT = "11111111-2222-4333-8444-555555555552";
const HUB_NO_WORKSPACE = "11111111-2222-4333-8444-555555555553";
const HUB_DENIED = "11111111-2222-4333-8444-555555555554";
const HUB_ROLLBACK = "11111111-2222-4333-8444-555555555555";
const HUB_POINTER = "11111111-2222-4333-8444-555555555556";
const HUB_SECOND_RELEASE = "11111111-2222-4333-8444-555555555557";
const HUB_CONTEXT = "11111111-2222-4333-8444-555555555558";

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/** Run SQL, refusing (throwing) when psql reports a failure. */
function psql(url, sql) {
  const result = spawnSync(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|", url],
    { input: sql, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${(result.stderr ?? "").trim().slice(0, 400)}`);
  }
  return result.stdout ?? "";
}

/** Run SQL and return the outcome instead of throwing. */
function attempt(url, sql) {
  return spawnSync(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|", url],
    { input: sql, encoding: "utf8" },
  );
}

/** Assert the statement was refused with a specific stable code. */
function expectRefusal(code, sql) {
  const result = attempt(DB_URL, sql);
  assert.notEqual(result.status, 0, `expected ${code} but the statement succeeded`);
  assert.match(result.stderr ?? "", new RegExp(code));
}

function scalar(sql) {
  return psql(DB_URL, sql).trim();
}

let release;
async function planFor(workspaceId, hubId) {
  return planBootstrap({ workspaceId, hubId, release });
}

before(async () => {
  psql(ADMIN_URL, `create database "${DB_NAME}"`);
  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "bootstrap.sql"), "utf8"));
  const migrations = readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    psql(DB_URL, readFileSync(join(ROOT, "supabase", "migrations", file), "utf8"));
  }
  psql(
    DB_URL,
    `insert into public.personal_workspaces (id, owner_subject) values
       ('${WORKSPACE}', 'owner-a'),
       ('${OTHER_WORKSPACE}', 'owner-b'),
       ('${DENY_WORKSPACE}', 'owner-c');`,
  );

  // The plan under test is derived from the committed, reviewed artifact, so the
  // digest these tests register is the digest the deployment actually serves.
  release = await verifyReviewedRelease(DEFAULT_ARTIFACT_DIR);
});

after(() => {
  spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", ADMIN_URL], {
    input: `drop database if exists "${DB_NAME}" with (force);`,
    encoding: "utf8",
  });
});

test("the reviewed artifact verifies and carries the expected identity", () => {
  assert.match(release.hubReleaseDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(release.sqliteArtifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(release.skillCount, 116);
});

describe("apply", () => {
  test("registers a private hub and the reviewed release", async () => {
    const plan = await planFor(WORKSPACE, HUB);
    psql(DB_URL, renderTransaction(plan));

    // The script's own read-back is what apply() asserts on, so the test runs
    // the same statement: a column that does not exist would fail here rather
    // than only in a live apply.
    assert.equal(scalar(renderReadBack(plan)), `${HUB}|${WORKSPACE}|private`);
    assert.equal(
      scalar(renderReleaseReadBack(plan)),
      `${HUB}|${release.hubReleaseDigest}|${release.sqliteArtifactDigest}`,
    );
  });

  test("re-running writes nothing new", async () => {
    const plan = await planFor(WORKSPACE, HUB);
    const before_ = scalar(
      `select (select count(*) from public.hubs)::text || '|' || (select count(*) from public.hub_releases)::text;`,
    );
    psql(DB_URL, renderTransaction(plan));
    psql(DB_URL, renderTransaction(plan));
    const after_ = scalar(
      `select (select count(*) from public.hubs)::text || '|' || (select count(*) from public.hub_releases)::text;`,
    );
    assert.equal(after_, before_, "a second and third apply must be no-ops");
  });
});

describe("refusals — an existing record is never overwritten", () => {
  test("a hub that already exists with a different workspace is refused", async () => {
    psql(
      DB_URL,
      `insert into public.hubs (id, workspace_id, visibility) values ('${HUB_CONFLICT}', '${OTHER_WORKSPACE}', 'private');`,
    );
    const plan = await planFor(WORKSPACE, HUB_CONFLICT);
    expectRefusal("E_BOOTSTRAP_HUB_CONFLICT", renderTransaction(plan));
    // Nothing was registered for the hub that was refused.
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${HUB_CONFLICT}';`), "0");
  });

  test("a hub that already exists with a different visibility is refused", async () => {
    const hub = "11111111-2222-4333-8444-555555555559";
    psql(DB_URL, `insert into public.hubs (id, workspace_id, visibility) values ('${hub}', '${WORKSPACE}', 'public');`);
    const plan = await planFor(WORKSPACE, hub);
    expectRefusal("E_BOOTSTRAP_HUB_CONFLICT", renderTransaction(plan));
  });

  test("a release already registered with a different sqlite digest is refused", async () => {
    psql(
      DB_URL,
      `insert into public.hubs (id, workspace_id, visibility) values ('${HUB_RELEASE_CONFLICT}', '${WORKSPACE}', 'private');
       insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
         values ('${HUB_RELEASE_CONFLICT}', '${release.hubReleaseDigest}', 'sha256:${"0".repeat(64)}');`,
    );
    const plan = await planFor(WORKSPACE, HUB_RELEASE_CONFLICT);
    expectRefusal("E_BOOTSTRAP_RELEASE_CONFLICT", renderTransaction(plan));
    // The pre-existing row is untouched, not overwritten.
    assert.equal(
      scalar(`select sqlite_artifact_digest from public.hub_releases where hub_id = '${HUB_RELEASE_CONFLICT}';`),
      `sha256:${"0".repeat(64)}`,
    );
  });

  test("a workspace that does not exist is refused", async () => {
    const plan = await planFor("33333333-4444-4555-8666-777777777777", HUB_NO_WORKSPACE);
    expectRefusal("E_BOOTSTRAP_WORKSPACE_MISSING", renderTransaction(plan));
    assert.equal(scalar(`select count(*) from public.hubs where id = '${HUB_NO_WORKSPACE}';`), "0");
  });

  test("an explicit deny covering the hub is refused", async () => {
    psql(
      DB_URL,
      `insert into public.hubs (id, workspace_id, visibility) values ('${HUB_DENIED}', '${WORKSPACE}', 'private');
       insert into public.security_denies (workspace_id, kind, identity, reason)
         values ('${WORKSPACE}', 'hub', '${HUB_DENIED}', 'emergency');`,
    );
    const plan = await planFor(WORKSPACE, HUB_DENIED);
    expectRefusal("E_BOOTSTRAP_DENY_PRESENT", renderTransaction(plan));
  });

  test("an explicit deny covering the release is refused", async () => {
    const hub = "11111111-2222-4333-8444-55555555555a";
    psql(
      DB_URL,
      `insert into public.hubs (id, workspace_id, visibility) values ('${hub}', '${DENY_WORKSPACE}', 'private');
       insert into public.security_denies (workspace_id, kind, identity, reason)
         values ('${DENY_WORKSPACE}', 'release', '${release.hubReleaseDigest}', 'emergency');`,
    );
    const plan = await planFor(DENY_WORKSPACE, hub);
    expectRefusal("E_BOOTSTRAP_DENY_PRESENT", renderTransaction(plan));
  });
});

describe("rollback", () => {
  test("removes the release before the hub, and is itself idempotent", async () => {
    const plan = await planFor(WORKSPACE, HUB_ROLLBACK);
    psql(DB_URL, renderTransaction(plan));
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${HUB_ROLLBACK}';`), "1");

    psql(DB_URL, renderRollback(plan));
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${HUB_ROLLBACK}';`), "0");
    assert.equal(scalar(`select count(*) from public.hubs where id = '${HUB_ROLLBACK}';`), "0");

    // A second rollback removes nothing and must not fail.
    psql(DB_URL, renderRollback(plan));
    assert.equal(scalar(`select count(*) from public.hubs where id = '${HUB_ROLLBACK}';`), "0");
  });

  test("refuses, and removes nothing, when a stable pointer depends on the hub", async () => {
    const plan = await planFor(WORKSPACE, HUB_POINTER);
    psql(DB_URL, renderTransaction(plan));
    psql(
      DB_URL,
      `insert into public.hub_stable_pointers (hub_id, release_digest)
         values ('${HUB_POINTER}', '${release.hubReleaseDigest}');`,
    );

    expectRefusal("E_BOOTSTRAP_ROLLBACK_DEPENDENT", renderRollback(plan));
    assert.equal(scalar(`select count(*) from public.hubs where id = '${HUB_POINTER}';`), "1");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${HUB_POINTER}';`), "1");
  });

  test("refuses, and removes nothing, when the hub holds another release", async () => {
    const plan = await planFor(WORKSPACE, HUB_SECOND_RELEASE);
    psql(DB_URL, renderTransaction(plan));
    psql(
      DB_URL,
      `insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
         values ('${HUB_SECOND_RELEASE}', 'sha256:${"a".repeat(64)}', 'sha256:${"b".repeat(64)}');`,
    );

    expectRefusal("E_BOOTSTRAP_ROLLBACK_DEPENDENT", renderRollback(plan));
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${HUB_SECOND_RELEASE}';`), "2");
  });

  test("refuses, and removes nothing, when a project context pins the release", async () => {
    const plan = await planFor(WORKSPACE, HUB_CONTEXT);
    psql(DB_URL, renderTransaction(plan));
    const project = "44444444-5555-4666-8777-888888888888";
    psql(
      DB_URL,
      `insert into public.projects (id, workspace_id, name) values ('${project}', '${WORKSPACE}', 'p');
       insert into public.project_contexts (id, project_id, context_digest, release_digest)
         values ('55555555-6666-4777-8888-999999999999', '${project}', 'sha256:${"c".repeat(64)}', '${release.hubReleaseDigest}');`,
    );

    expectRefusal("E_BOOTSTRAP_ROLLBACK_DEPENDENT", renderRollback(plan));
    assert.equal(scalar(`select count(*) from public.hubs where id = '${HUB_CONTEXT}';`), "1");
  });

  test("refuses when the recorded hub belongs to a different workspace", async () => {
    const hub = "11111111-2222-4333-8444-55555555555b";
    psql(DB_URL, `insert into public.hubs (id, workspace_id, visibility) values ('${hub}', '${OTHER_WORKSPACE}', 'private');`);
    // A plan that names the same hub but the other workspace is already refused
    // by the forward transaction; the rollback guards on the same fact so a
    // mismatched rollback cannot delete someone else's hub.
    const plan = await planFor(OTHER_WORKSPACE, hub);
    psql(DB_URL, renderTransaction(plan));
    const mismatched = await planFor(WORKSPACE, hub);
    expectRefusal("E_BOOTSTRAP_ROLLBACK_CONFLICT", renderRollback(mismatched));
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1");
  });
});
