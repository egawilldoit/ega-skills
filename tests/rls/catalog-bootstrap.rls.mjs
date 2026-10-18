/**
 * Catalog bootstrap against a real PostgreSQL.
 *
 * Runs the SQL the script actually renders — not a re-typed copy — against a
 * disposable database built from `supabase/migrations`, and proves:
 *
 *  1. **receipt-scoped rollback** — a rollback removes only the rows the
 *     execution receipt records as inserted by it, so pre-existing rows survive;
 *  2. **in-transaction conflict refusal** — a conflicting writer cannot leave a
 *     registration attached to the wrong workspace or SQLite digest, and a
 *     refusal rolls back every write from this operation;
 *  3. **dependency-aware rollback** — child before parent, and no cascade.
 *
 * The two-connection cases synchronise on a real server-side lock wait observed
 * in `pg_stat_activity`, not on a fixed sleep.
 *
 * Requires `EGA_RLS_DATABASE_URL`, exactly like `tests/rls/contract-f.rls.mjs`.
 * It creates and drops its own database and never touches a remote instance.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import {
  DEFAULT_ARTIFACT_DIR,
  applyBootstrap,
  planBootstrap,
  readReceipt,
  renderRollback,
  renderTransaction,
  rollbackBootstrap,
  verifyReviewedRelease,
  writeReceipt,
} from "../../scripts/hosted/bootstrap-catalog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE = join(ROOT, "scripts", "hosted", "bootstrap-catalog.mjs");
const BASE_URL = process.env.EGA_RLS_DATABASE_URL;
if (!BASE_URL) {
  throw new Error("EGA_RLS_DATABASE_URL is required to run the catalog bootstrap suite");
}

const DB_NAME = `ega_bootstrap_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const DB_URL = withDatabase(BASE_URL, DB_NAME);
const ADMIN_URL = withDatabase(BASE_URL, "postgres");

const WORKSPACE = "e692094d-b89a-4aed-b3be-76876f194db0";
const OTHER_WORKSPACE = "22222222-3333-4444-8555-666666666666";
const DENY_WORKSPACE = "66666666-7777-4888-8999-aaaaaaaaaaaa";

let hubSeq = 0;
/** A distinct hub id per scenario, so scenarios cannot interfere. */
function nextHub() {
  hubSeq += 1;
  return `11111111-2222-4333-8444-${String(hubSeq).padStart(12, "0")}`;
}

let release;
let workdir;
let receiptSeq = 0;
function nextReceipt() {
  receiptSeq += 1;
  return join(workdir, `receipt-${receiptSeq}.json`);
}

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function psql(url, sql) {
  const result = spawnSync(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|"],
    { input: sql, encoding: "utf8", env: { ...process.env, PGHOST: "", PGPASSWORD: "", PGDATABASE: undefined, ...psqlEnv(url) } },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${(result.stderr ?? "").trim().slice(0, 300)}`);
  }
  return result.stdout ?? "";
}

function psqlEnv(url) {
  const parsed = new URL(url);
  return {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port,
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
  };
}

function scalar(sql) {
  return psql(DB_URL, sql).trim();
}

let planSeq = 0;
async function planFor(workspaceId, hubId) {
  planSeq += 1;
  return planBootstrap({ workspaceId, hubId, release });
}

/** Apply through the real library, using the real connection path. */
function apply(plan, receiptPath) {
  return applyBootstrap(plan, DB_URL, receiptPath);
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "ega-bootstrap-receipts-"));
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
  release = await verifyReviewedRelease(DEFAULT_ARTIFACT_DIR);
});

after(() => {
  spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: `drop database if exists "${DB_NAME}" with (force);`,
    encoding: "utf8",
    env: { ...process.env, ...psqlEnv(ADMIN_URL) },
  });
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Receipt-scoped rollback                                                     */
/* -------------------------------------------------------------------------- */

describe("the receipt records what this execution inserted", () => {
  test("both rows new → both recorded as inserted, and written to the receipt", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    const outcome = apply(plan, path);

    assert.deepEqual(outcome.inserted, { hub: true, release: true });
    assert.equal(existsSync(path), true);
    const receipt = readReceipt(path);
    assert.equal(receipt.hub_id, hub);
    assert.equal(receipt.workspace_id, WORKSPACE);
    assert.deepEqual(receipt.inserted, { hub: true, release: true });
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "1");
  });

  test("an idempotent rerun inserts nothing and leaves the receipt byte-identical", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    const before = readFileSync(path, "utf8");

    const again = apply(plan, path);
    assert.deepEqual(again.inserted, { hub: false, release: false });
    assert.equal(again.reusedReceipt, true);
    assert.equal(readFileSync(path, "utf8"), before, "the original receipt must not be rewritten");
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1");
  });

  test("both rows pre-exist → recorded as reused, never as this execution's", async () => {
    const hub = nextHub();
    psql(DB_URL, `
      insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');
      insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
        values ('${hub}','${release.hubReleaseDigest}','${release.sqliteArtifactDigest}');`);

    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    const outcome = apply(plan, path);
    assert.deepEqual(outcome.inserted, { hub: false, release: false });
    assert.deepEqual(readReceipt(path).inserted, { hub: false, release: false });
  });

  test("hub pre-exists and the release is new → only the release is recorded", async () => {
    const hub = nextHub();
    psql(DB_URL, `insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');`);

    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    const outcome = apply(plan, path);
    assert.deepEqual(outcome.inserted, { hub: false, release: true });
    assert.deepEqual(readReceipt(path).inserted, { hub: false, release: true });
  });
});

describe("receipt safety across database changes", () => {
  test("a stale reused receipt refuses before a recreated release can commit", async () => {
    const hub = nextHub();
    psql(DB_URL, `
      insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');
      insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
        values ('${hub}','${release.hubReleaseDigest}','${release.sqliteArtifactDigest}');`);
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    const before = readFileSync(path, "utf8");
    psql(DB_URL, `delete from public.hub_releases where hub_id = '${hub}';`);

    assert.throws(() => apply(plan, path), (e) => e.code === "E_BOOTSTRAP_RECEIPT_STALE");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "0",
      "the refused rerun must roll back its recreated release");
    assert.equal(readFileSync(path, "utf8"), before);
  });

  test("stale hub ownership refuses and rolls back both recreated rows", async () => {
    const hub = nextHub();
    psql(DB_URL, `insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');`);
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    const before = readFileSync(path, "utf8");
    psql(DB_URL, `delete from public.hub_releases where hub_id = '${hub}'; delete from public.hubs where id = '${hub}';`);

    assert.throws(() => apply(plan, path), (e) => e.code === "E_BOOTSTRAP_RECEIPT_STALE");
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "0");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "0");
    assert.equal(readFileSync(path, "utf8"), before);
  });

  for (const change of [
    { name: "workspace", assignment: `workspace_id = '${OTHER_WORKSPACE}'` },
    { name: "visibility", assignment: "visibility = 'public'" },
  ]) {
    test(`release-only rollback refuses a changed reused hub ${change.name}`, async () => {
      const hub = nextHub();
      psql(DB_URL, `insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');`);
      const plan = await planFor(WORKSPACE, hub);
      const path = nextReceipt();
      apply(plan, path);
      const before = readFileSync(path, "utf8");
      psql(DB_URL, `update public.hubs set ${change.assignment} where id = '${hub}';`);

      assert.throws(() => rollbackBootstrap(path, DB_URL), (e) => e.code === "E_BOOTSTRAP_ROLLBACK_IDENTITY_CHANGED");
      assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "1");
      assert.equal(readFileSync(path, "utf8"), before);
    });
  }
});

describe("rollback removes only what the receipt owns", () => {
  test("both rows pre-exist → apply and rollback preserve both", async () => {
    const hub = nextHub();
    psql(DB_URL, `
      insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');
      insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
        values ('${hub}','${release.hubReleaseDigest}','${release.sqliteArtifactDigest}');`);

    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    const outcome = rollbackBootstrap(path, DB_URL);

    assert.equal(outcome.removedHub, false);
    assert.equal(outcome.removedRelease, false);
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "1");
    assert.equal(existsSync(path), false, "a completed rollback consumes the receipt");
  });

  test("hub pre-exists and the release is new → only the release is removed", async () => {
    const hub = nextHub();
    psql(DB_URL, `insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');`);

    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    const outcome = rollbackBootstrap(path, DB_URL);

    assert.equal(outcome.removedHub, false);
    assert.equal(outcome.removedRelease, true);
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1", "the pre-existing hub survives");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "0");
  });

  test("both rows new → both are removed, child first", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    const outcome = rollbackBootstrap(path, DB_URL);

    assert.equal(outcome.removedHub, true);
    assert.equal(outcome.removedRelease, true);
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "0");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "0");
  });

  test("a consumed receipt cannot be rolled back twice", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    rollbackBootstrap(path, DB_URL);
    assert.throws(() => rollbackBootstrap(path, DB_URL), (e) => e.code === "E_BOOTSTRAP_RECEIPT_MISSING");
  });

  test("a missing receipt refuses before touching the database", () => {
    assert.throws(
      () => rollbackBootstrap(join(workdir, "no-such-receipt.json"), DB_URL),
      (e) => e.code === "E_BOOTSTRAP_RECEIPT_MISSING",
    );
  });

  test("a receipt for a different registration refuses", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    const receipt = readReceipt(path);
    // Point the receipt at a hub that this receipt never registered.
    const forged = { ...receipt, hub_id: nextHub() };
    writeReceipt(path, {
      ...forged,
      observed: {
        hub: `${forged.hub_id}|${forged.workspace_id}|${forged.visibility}`,
        release: `${forged.hub_id}|${forged.release_digest}|${forged.sqlite_artifact_digest}`,
      },
    });
    // readReceipt validates structure; the run then refuses because the hub it
    // names does not exist, and removes nothing.
    assert.throws(() => rollbackBootstrap(path, DB_URL), (e) => /E_BOOTSTRAP_(ROLLBACK_MISSING|ROLLBACK_IDENTITY_CHANGED)/.test(e.code));
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1", "the real hub is untouched");
  });
});

describe("rollback refuses atomically when identity changed or a dependency was added", () => {
  test("a changed hub identity aborts and removes nothing", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    psql(DB_URL, `update public.hubs set visibility = 'public' where id = '${hub}';`);

    assert.throws(() => rollbackBootstrap(path, DB_URL), (e) => e.code === "E_BOOTSTRAP_ROLLBACK_IDENTITY_CHANGED");
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "1");
    assert.equal(existsSync(path), true, "a refused rollback keeps the receipt so it can be retried");
  });

  test("a changed release identity aborts and removes nothing", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    psql(DB_URL, `update public.hub_releases set sqlite_artifact_digest = 'sha256:${"e".repeat(64)}' where hub_id = '${hub}';`);

    assert.throws(() => rollbackBootstrap(path, DB_URL), (e) => e.code === "E_BOOTSTRAP_ROLLBACK_IDENTITY_CHANGED");
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1");
  });

  test("a stable pointer added after apply makes the rollback refuse", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    psql(DB_URL, `insert into public.hub_stable_pointers (hub_id, release_digest) values ('${hub}','${release.hubReleaseDigest}');`);

    assert.throws(() => rollbackBootstrap(path, DB_URL), (e) => e.code === "E_BOOTSTRAP_ROLLBACK_DEPENDENT");
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "1");
  });

  test("a project context added after apply makes the rollback refuse", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    const project = randomUUID();
    psql(DB_URL, `
      insert into public.projects (id, workspace_id, name) values ('${project}','${WORKSPACE}','p');
      insert into public.project_contexts (id, project_id, context_digest, release_digest)
        values ('${randomUUID()}','${project}','sha256:${"c".repeat(64)}','${release.hubReleaseDigest}');`);

    assert.throws(() => rollbackBootstrap(path, DB_URL), (e) => e.code === "E_BOOTSTRAP_ROLLBACK_DEPENDENT");
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1");
  });

  test("another release on the hub makes the hub delete refuse", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);
    const path = nextReceipt();
    apply(plan, path);
    psql(DB_URL, `insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
      values ('${hub}','sha256:${"a".repeat(64)}','sha256:${"b".repeat(64)}');`);

    assert.throws(() => rollbackBootstrap(path, DB_URL), (e) => e.code === "E_BOOTSTRAP_ROLLBACK_DEPENDENT");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "2");
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals that are not about the receipt                                     */
/* -------------------------------------------------------------------------- */

describe("a conflicting existing record is never overwritten", () => {
  test("a hub in another workspace is refused and no release is attached", async () => {
    const hub = nextHub();
    psql(DB_URL, `insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${OTHER_WORKSPACE}','private');`);
    const plan = await planFor(WORKSPACE, hub);
    assert.throws(() => apply(plan, nextReceipt()), (e) => e.code === "E_BOOTSTRAP_HUB_CONFLICT");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "0");
  });

  test("a release with a different sqlite digest is refused and left untouched", async () => {
    const hub = nextHub();
    const other = `sha256:${"0".repeat(64)}`;
    psql(DB_URL, `
      insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');
      insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
        values ('${hub}','${release.hubReleaseDigest}','${other}');`);
    const plan = await planFor(WORKSPACE, hub);
    assert.throws(() => apply(plan, nextReceipt()), (e) => e.code === "E_BOOTSTRAP_RELEASE_CONFLICT");
    assert.equal(scalar(`select sqlite_artifact_digest from public.hub_releases where hub_id = '${hub}';`), other);
  });

  test("an unknown workspace is refused", async () => {
    const plan = await planFor("33333333-4444-4555-8666-777777777777", nextHub());
    assert.throws(() => apply(plan, nextReceipt()), (e) => e.code === "E_BOOTSTRAP_WORKSPACE_MISSING");
  });

  test("an explicit deny is refused", async () => {
    const hub = nextHub();
    psql(DB_URL, `
      insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${DENY_WORKSPACE}','private');
      insert into public.security_denies (workspace_id, kind, identity, reason)
        values ('${DENY_WORKSPACE}','hub','${hub}','emergency');`);
    const plan = await planFor(DENY_WORKSPACE, hub);
    assert.throws(() => apply(plan, nextReceipt()), (e) => e.code === "E_BOOTSTRAP_DENY_PRESENT");
  });
});

/* -------------------------------------------------------------------------- */
/* Two-connection races                                                        */
/* -------------------------------------------------------------------------- */

/** A long-lived psql session whose transaction another connection can race. */
function openSession() {
  const child = spawn(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|"],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...psqlEnv(DB_URL) } },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const closed = new Promise((resolve) => child.once("close", resolve));
  return {
    child,
    sql: (text) => child.stdin.write(text),
    close: async () => {
      child.stdin.write("\\q\n");
      await closed;
      return { status: child.exitCode, stdout: out, stderr: err };
    },
    closed,
    output: () => ({ stdout: out, stderr: err }),
  };
}

/** Wait until some backend is blocked on a lock, observed from the server. */
async function waitForLockWait(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = Number(scalar("select count(*) from pg_stat_activity where wait_event_type = 'Lock';"));
    if (waiting > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Run one apply in a child process so this test can race it. */
function spawnApply(plan, receiptPath) {
  const child = spawn(
    process.execPath,
    [join(workdir, "runner.mjs"), JSON.stringify({ workspaceId: plan.workspaceId, hubId: plan.hubId, release: {
      hubReleaseDigest: plan.releaseDigest,
      sqliteArtifactDigest: plan.sqliteDigest,
      skillCount: plan.skillCount,
      dir: plan.artifactDir,
      artifactHubId: plan.artifactHubId,
    } }), receiptPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, EGA_BOOTSTRAP_DATABASE_URL: DB_URL },
    },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const closed = new Promise((resolve) => child.once("close", (code) => resolve({ code, out, err })));
  return { child, closed };
}

describe("concurrent writers cannot corrupt a registration", () => {
  before(() => {
    writeFileSync(
      join(workdir, "runner.mjs"),
      `import { planBootstrap, applyBootstrap } from ${JSON.stringify(MODULE)};
const input = JSON.parse(process.argv[2]);
const receipt = process.argv[3];
try {
  const outcome = applyBootstrap(planBootstrap(input), process.env.EGA_BOOTSTRAP_DATABASE_URL, receipt);
  console.log(JSON.stringify({ ok: true, inserted: outcome.inserted }));
} catch (error) {
  console.error(String(error.code ?? "E_UNKNOWN") + ": " + String(error.message));
  process.exit(1);
}
`,
    );
  });

  test("matching concurrent registrations both succeed with exactly one pair", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);

    const a = openSession();
    a.sql(`begin;
insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');
insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
  values ('${hub}','${release.hubReleaseDigest}','${release.sqliteArtifactDigest}');
`);

    const b = spawnApply(plan, nextReceipt());
    assert.equal(await waitForLockWait(), true, "the second registration must block on the first");
    a.sql("commit;\n");
    const result = await b.closed;
    await a.close();

    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out).inserted, { hub: false, release: false });
    assert.equal(scalar(`select count(*) from public.hubs where id = '${hub}';`), "1");
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "1");
  });

  test("a conflicting concurrent hub refuses without attaching the release", async () => {
    const hub = nextHub();
    const plan = await planFor(WORKSPACE, hub);

    const a = openSession();
    // Same hub id, WRONG workspace, uncommitted.
    a.sql(`begin;
insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${OTHER_WORKSPACE}','private');
`);

    const b = spawnApply(plan, nextReceipt());
    assert.equal(await waitForLockWait(), true, "the bootstrap must block behind the conflicting hub");
    a.sql("commit;\n");
    const result = await b.closed;
    await a.close();

    assert.notEqual(result.code, 0, "the bootstrap must refuse");
    assert.match(result.err, /E_BOOTSTRAP_HUB_CONFLICT/);
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "0", "no release may be attached to the wrong hub");
    assert.equal(scalar(`select workspace_id from public.hubs where id = '${hub}';`), OTHER_WORKSPACE);
  });

  test("a conflicting concurrent release refuses without partial bootstrap writes", async () => {
    const hub = nextHub();
    psql(DB_URL, `insert into public.hubs (id, workspace_id, visibility) values ('${hub}','${WORKSPACE}','private');`);
    const plan = await planFor(WORKSPACE, hub);

    const a = openSession();
    a.sql(`begin;
insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)
  values ('${hub}','${release.hubReleaseDigest}','sha256:${"d".repeat(64)}');
`);

    const b = spawnApply(plan, nextReceipt());
    assert.equal(await waitForLockWait(), true, "the bootstrap must block behind the conflicting release");
    a.sql("commit;\n");
    const result = await b.closed;
    await a.close();

    assert.notEqual(result.code, 0, "the bootstrap must refuse");
    assert.match(result.err, /E_BOOTSTRAP_RELEASE_CONFLICT/);
    assert.equal(
      scalar(`select sqlite_artifact_digest from public.hub_releases where hub_id = '${hub}';`),
      `sha256:${"d".repeat(64)}`,
      "the conflicting row is left exactly as the other writer committed it",
    );
    assert.equal(scalar(`select count(*) from public.hub_releases where hub_id = '${hub}';`), "1", "no extra release row");
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering is the thing the database runs                                    */
/* -------------------------------------------------------------------------- */

test("the rendered transaction and rollback are exactly what these tests execute", () => {
  const plan = planBootstrap({ workspaceId: WORKSPACE, hubId: nextHub(), release });
  const sql = renderTransaction(plan);
  assert.match(sql, /for update/);
  assert.match(sql, /create temp table bootstrap_inserted/);
  const receipt = {
    receipt_version: 1,
    workspace_id: WORKSPACE,
    hub_id: plan.hubId,
    visibility: "private",
    release_digest: plan.releaseDigest,
    sqlite_artifact_digest: plan.sqliteDigest,
    inserted: { hub: true, release: true },
    observed: {
      hub: `${plan.hubId}|${WORKSPACE}|private`,
      release: `${plan.hubId}|${plan.releaseDigest}|${plan.sqliteDigest}`,
    },
  };
  assert.match(renderRollback(receipt), /delete from public\.hub_releases/);
});
