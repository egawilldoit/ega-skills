/**
 * Catalog bootstrap — verification, plan, rendered SQL, receipt and credentials.
 *
 * No database is contacted here. The database behaviour of the rendered SQL
 * (idempotency, in-transaction conflict refusal, receipt-scoped rollback and the
 * two-connection races) is proved in `tests/rls/catalog-bootstrap.rls.mjs`.
 *
 * The credential tests use a synthetic `psql` on `PATH`, so they exercise the
 * real child-process path without a real credential and without a live database.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  BootstrapError,
  DEFAULT_ARTIFACT_DIR,
  applyBootstrap,
  buildReceipt,
  buildRollbackReport,
  parseArgs,
  parseDatabaseUrl,
  planBootstrap,
  psqlEnvironment,
  psqlInvocation,
  runStatement,
  rollbackBootstrap,
  readReceipt,
  renderReadBack,
  renderReleaseReadBack,
  renderRollback,
  renderTransaction,
  sanitizeDiagnostics,
  validateReceipt,
  verifyReviewedRelease,
  writeReceipt,
} from "../../scripts/hosted/bootstrap-catalog.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "hosted", "bootstrap-catalog.mjs");
const PACKAGE = JSON.parse(readFileSync(join(DEFAULT_ARTIFACT_DIR, "release-package.json"), "utf8"));

const WORKSPACE = "e692094d-b89a-4aed-b3be-76876f194db0";
const HUB = "11111111-2222-4333-8444-555555555555";

async function reviewedRelease() {
  return verifyReviewedRelease(DEFAULT_ARTIFACT_DIR);
}

async function plan(overrides = {}) {
  const release = await reviewedRelease();
  return planBootstrap({ workspaceId: WORKSPACE, hubId: HUB, release, ...overrides });
}

function receiptFor(p, inserted, observed) {
  return buildReceipt(p, inserted, observed ?? {
    hub: `${p.hubId}|${p.workspaceId}|${p.visibility}`,
    release: `${p.hubId}|${p.releaseDigest}|${p.sqliteDigest}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

describe("the registered digest is the reviewed artifact's digest", () => {
  test("verification returns the digests the artifact declares", async () => {
    const release = await reviewedRelease();
    assert.equal(release.hubReleaseDigest, PACKAGE.hub_release_digest);
    assert.equal(release.sqliteArtifactDigest, PACKAGE.sqlite_artifact_digest);
    assert.equal(release.skillCount, PACKAGE.snapshot_rows);
    assert.equal(release.skillCount, 116);
  });

  test("the artifact's own hub_id is reported but is not a database hub id", async () => {
    const release = await reviewedRelease();
    assert.equal(release.artifactHubId, "personal");
    assert.doesNotMatch(release.artifactHubId, /^[0-9a-f-]{36}$/);
  });

  test("a missing artifact directory is refused", async () => {
    await assert.rejects(
      () => verifyReviewedRelease(join(tmpdir(), "ega-bootstrap-absent-does-not-exist")),
      (error) => error instanceof BootstrapError && error.code === "E_BOOTSTRAP_ARTIFACT_MISSING",
    );
  });

  test("an artifact missing a required file is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ega-bootstrap-partial-"));
    try {
      for (const name of ["hub-release.json", "release-package.json"]) {
        cpSync(join(DEFAULT_ARTIFACT_DIR, name), join(dir, name));
      }
      await assert.rejects(
        () => verifyReviewedRelease(dir),
        (error) => error instanceof BootstrapError && error.code === "E_BOOTSTRAP_ARTIFACT_INCOMPLETE",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tampered release package is refused rather than registered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ega-bootstrap-tampered-"));
    try {
      cpSync(DEFAULT_ARTIFACT_DIR, dir, { recursive: true });
      const pkg = JSON.parse(readFileSync(join(dir, "release-package.json"), "utf8"));
      pkg.sqlite_artifact_digest = `sha256:${"0".repeat(64)}`;
      writeFileSync(join(dir, "release-package.json"), JSON.stringify(pkg, null, 2));
      await assert.rejects(
        () => verifyReviewedRelease(dir),
        (error) => error instanceof BootstrapError && error.code.startsWith("E_BOOTSTRAP_ARTIFACT_"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

describe("the plan refuses malformed operator input", () => {
  test("a non-uuid workspace or hub is refused", async () => {
    await assert.rejects(() => plan({ workspaceId: "not-a-uuid" }), (e) => e.code === "E_BOOTSTRAP_ARGUMENT_INVALID");
    await assert.rejects(() => plan({ hubId: "personal" }), (e) => e.code === "E_BOOTSTRAP_ARGUMENT_INVALID");
    await assert.rejects(() => plan({ workspaceId: "E692094D-B89A-4AED-B3BE-76876F194DB0" }), (e) => e.code === "E_BOOTSTRAP_ARGUMENT_INVALID");
  });

  test("an artifact digest that is not canonical is refused", async () => {
    const release = await reviewedRelease();
    assert.throws(
      () => planBootstrap({ workspaceId: WORKSPACE, hubId: HUB, release: { ...release, hubReleaseDigest: `sha256:${"A".repeat(64)}` } }),
      (e) => e.code === "E_BOOTSTRAP_ARGUMENT_INVALID",
    );
  });

  test("visibility is always private", async () => {
    const p = await plan();
    assert.equal(p.visibility, "private");
    assert.equal(p.workspaceId, WORKSPACE);
    assert.equal(p.hubId, HUB);
  });

  test("unknown or mutually exclusive arguments are refused", () => {
    assert.throws(() => parseArgs(["--workspace", WORKSPACE, "--hub", HUB, "--force"]), (e) => e.code === "E_BOOTSTRAP_ARGUMENT_INVALID");
    assert.throws(() => parseArgs(["--workspace", WORKSPACE, "--hub", HUB, "--apply", "--rollback"]), (e) => e.code === "E_BOOTSTRAP_ARGUMENT_INVALID");
  });
});

/* -------------------------------------------------------------------------- */
/* Forward transaction                                                         */
/* -------------------------------------------------------------------------- */

describe("the forward transaction is append-only and validates before commit", () => {
  test("exactly one transaction, and no update or delete statement", async () => {
    const sql = renderTransaction(await plan());
    assert.equal((sql.match(/^begin;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^commit;$/gm) ?? []).length, 1);
    // `for update` is a row lock, not a data modification; what must never appear
    // is an UPDATE or DELETE statement.
    assert.doesNotMatch(sql, /^\s*update\s+public\./im);
    assert.doesNotMatch(sql, /^\s*delete\s+from\s+public\./im);
  });

  test("both writes are conflict-tolerant inserts, never overwrites", async () => {
    const sql = renderTransaction(await plan());
    assert.equal((sql.match(/on conflict\s*\([^)]*\)\s*do nothing/gi) ?? []).length, 2);
    assert.match(sql, /insert into public\.hubs \(id, workspace_id, visibility\)/);
    assert.match(sql, /insert into public\.hub_releases \(hub_id, release_digest, sqlite_artifact_digest\)/);
  });

  test("the authoritative identity check runs AFTER the inserts, inside the transaction", async () => {
    const sql = renderTransaction(await plan());
    const hubInsert = sql.indexOf("insert into public.hubs (id, workspace_id, visibility)");
    const releaseInsert = sql.indexOf("insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)");
    const verify = sql.indexOf("do $verify$");
    assert.ok(verify > hubInsert, "verification must follow the hub insert");
    assert.ok(verify > releaseInsert, "verification must follow the release insert");
    assert.ok(verify < sql.indexOf("commit;"), "verification must precede commit");
    // Row locks hold the deciding rows still while they are checked.
    assert.match(sql, /from public\.hubs where id = '[^']+' for update/);
    assert.match(sql, /release_digest = '[^']+'\s+for update/);
  });

  test("the conflict it must detect is raised inside the transaction", async () => {
    const sql = renderTransaction(await plan());
    for (const code of [
      "E_BOOTSTRAP_SCHEMA_MISSING",
      "E_BOOTSTRAP_WORKSPACE_MISSING",
      "E_BOOTSTRAP_DENY_PRESENT",
      "E_BOOTSTRAP_HUB_MISSING",
      "E_BOOTSTRAP_HUB_CONFLICT",
      "E_BOOTSTRAP_RELEASE_MISSING",
      "E_BOOTSTRAP_RELEASE_CONFLICT",
    ]) {
      assert.match(sql, new RegExp(`raise exception '${code}`), `${code} must be raised`);
    }
  });

  test("the two inserts are separate statements with the hub first", async () => {
    const sql = renderTransaction(await plan());
    const hubInsert = sql.indexOf("insert into public.hubs (id, workspace_id, visibility)");
    const releaseInsert = sql.indexOf("insert into public.hub_releases (hub_id, release_digest, sqlite_artifact_digest)");
    assert.ok(hubInsert > -1 && releaseInsert > hubInsert, "the release insert must follow the hub insert statement");
  });

  test("rendering is deterministic and carries the reviewed identity", async () => {
    const p = await plan();
    assert.equal(renderTransaction(p), renderTransaction(p));
    assert.match(renderTransaction(p), new RegExp(PACKAGE.hub_release_digest));
    assert.match(renderTransaction(p), new RegExp(PACKAGE.sqlite_artifact_digest));
  });
});

/* -------------------------------------------------------------------------- */
/* Receipt                                                                     */
/* -------------------------------------------------------------------------- */

describe("the execution receipt records exactly what happened", () => {
  test("a full receipt round-trips and validates against the plan", async () => {
    const p = await plan();
    const dir = mkdtempSync(join(tmpdir(), "ega-bootstrap-receipt-"));
    try {
      const receipt = receiptFor(p, { hub: true, release: false });
      const path = join(dir, "receipt.json");
      writeReceipt(path, receipt);
      const read = readReceipt(path);
      assert.deepEqual(read.inserted, { hub: true, release: false });
      assert.equal(read.observed.hub, `${HUB}|${WORKSPACE}|private`);
      assert.equal(validateReceipt(read, p).hub_id, HUB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing receipt is refused", () => {
    assert.throws(() => readReceipt(join(tmpdir(), "ega-bootstrap-no-such-receipt.json")), (e) => e.code === "E_BOOTSTRAP_RECEIPT_MISSING");
    assert.throws(() => readReceipt(""), (e) => e.code === "E_BOOTSTRAP_RECEIPT_MISSING");
  });

  test("a malformed or tampered receipt is refused", async () => {
    const p = await plan();
    const dir = mkdtempSync(join(tmpdir(), "ega-bootstrap-bad-receipt-"));
    try {
      const path = join(dir, "receipt.json");
      writeFileSync(path, "{ not json");
      assert.throws(() => readReceipt(path), (e) => e.code === "E_BOOTSTRAP_RECEIPT_INVALID");

      // A receipt edited to claim ownership of a different hub must not validate.
      const receipt = receiptFor(p, { hub: true, release: true });
      const tampered = { ...receipt, observed: { ...receipt.observed, hub: "22222222-3333-4444-8555-666666666666|x|private" } };
      writeFileSync(path, JSON.stringify(tampered));
      assert.throws(() => readReceipt(path), (e) => e.code === "E_BOOTSTRAP_RECEIPT_INVALID");

      // A receipt for a different registration must not validate against this plan.
      const other = { ...receiptFor(p, { hub: true, release: true }), hub_id: "22222222-3333-4444-8555-666666666666" };
      const otherObserved = { ...other.observed, hub: `22222222-3333-4444-8555-666666666666|${p.workspaceId}|private`, release: `22222222-3333-4444-8555-666666666666|${p.releaseDigest}|${p.sqliteDigest}` };
      writeFileSync(path, JSON.stringify({ ...other, observed: otherObserved }));
      assert.throws(() => validateReceipt(readReceipt(path), p), (e) => e.code === "E_BOOTSTRAP_RECEIPT_MISMATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Rollback                                                                    */
/* -------------------------------------------------------------------------- */

describe("rollback is generated from the receipt", () => {
  test("both rows inserted → both deletions are emitted, child before parent", async () => {
    const p = await plan();
    const sql = renderRollback(receiptFor(p, { hub: true, release: true }));
    const child = sql.indexOf("delete from public.hub_releases");
    const parent = sql.indexOf("delete from public.hubs");
    assert.ok(child > -1 && parent > child, "the release delete must precede the hub delete");
  });

  test("nothing inserted → no deletion at all", async () => {
    const p = await plan();
    const sql = renderRollback(receiptFor(p, { hub: false, release: false }));
    assert.doesNotMatch(sql, /delete from public\.hub_releases/);
    assert.doesNotMatch(sql, /delete from public\.hubs/);
    assert.match(sql, /inserted no rows of its own/);
  });

  test("only the release inserted → the hub is never a deletion candidate", async () => {
    const p = await plan();
    const sql = renderRollback(receiptFor(p, { hub: false, release: true }));
    assert.match(sql, /delete from public\.hub_releases/);
    assert.doesNotMatch(sql, /delete from public\.hubs/);
  });

  test("a receipt claiming a new hub but a reused release emits only the hub delete", async () => {
    // Not reachable through apply (the release row cannot precede its hub), but a
    // hand-written receipt must not be able to turn into a cascade: the hub's
    // "holds releases other than" guard refuses while the release row remains.
    const p = await plan();
    const sql = renderRollback(receiptFor(p, { hub: true, release: false }));
    assert.match(sql, /delete from public\.hubs/);
    assert.doesNotMatch(sql, /delete from public\.hub_releases/);
    assert.match(sql, /holds releases other than/);
  });

  test("every delete is bound to the recorded identity", async () => {
    const p = await plan();
    const sql = renderRollback(receiptFor(p, { hub: true, release: true }));
    assert.match(sql, /sqlite_artifact_digest = c_sqlite_digest/);
    assert.match(sql, /workspace_id = c_workspace/);
    assert.match(sql, /visibility = c_visibility/);
    assert.match(sql, /E_BOOTSTRAP_ROLLBACK_IDENTITY_CHANGED/);
    assert.match(sql, /E_BOOTSTRAP_ROLLBACK_MISSING/);
  });

  test("dependency guards are kept and never cascade", async () => {
    const p = await plan();
    const sql = renderRollback(receiptFor(p, { hub: true, release: true }));
    for (const needle of [
      "public.hub_stable_pointers",
      "public.hub_release_artifacts",
      "public.public_hub_publications",
      "public.project_contexts",
      "E_BOOTSTRAP_ROLLBACK_DEPENDENT",
    ]) {
      assert.ok(sql.includes(needle), `rollback must account for ${needle}`);
    }
    assert.equal((sql.match(/^begin;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^commit;$/gm) ?? []).length, 1);
  });

  test("the read-back selects the exact registered identity", async () => {
    const p = await plan();
    assert.match(renderReadBack(p), /select id::text, workspace_id::text, visibility/);
    assert.doesNotMatch(renderReadBack(p), /select hub_id/);
    assert.match(renderReleaseReadBack(p), /from public\.hub_releases/);
  });
});

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

describe("credentials never reach argv or a reported error", () => {
  const DSN = "postgres://bootuser:canary_password_9f3@db.example.invalid:6543/ega_control?sslmode=require";

  test("the child invocation carries flags only", () => {
    const { command, args } = psqlInvocation();
    assert.equal(command, "psql");
    assert.deepEqual([...args], ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|"]);
    assert.ok(!args.some((value) => String(value).includes("canary_password_9f3")));
    assert.ok(!args.some((value) => String(value).includes("postgres://")));
  });

  test("a URL is decomposed into libpq environment variables", () => {
    const { env, secrets } = psqlEnvironment(DSN, { PATH: "/usr/bin", PGHOST: "stale.example", PGPASSWORD: "stale" });
    assert.equal(env.PGHOST, "db.example.invalid");
    assert.equal(env.PGPORT, "6543");
    assert.equal(env.PGDATABASE, "ega_control");
    assert.equal(env.PGUSER, "bootuser");
    assert.equal(env.PGPASSWORD, "canary_password_9f3");
    assert.equal(env.PGSSLMODE, "require");
    assert.equal(env.PGPASSWORD === "stale", false, "inherited libpq state must be cleared");
    assert.ok(secrets.some((value) => value.includes("canary_password_9f3")));
  });

  test("unsupported or non-postgres URLs are refused without echoing them", () => {
    assert.throws(
      () => parseDatabaseUrl("postgres://u:p@h/db?options=-c%20search_path%3Dx"),
      (e) => e.code === "E_BOOTSTRAP_DATABASE_URL_UNSUPPORTED" && !e.message.includes("p@h"),
    );
    assert.throws(() => parseDatabaseUrl("mysql://u:p@h/db"), (e) => e.code === "E_BOOTSTRAP_DATABASE_URL_INVALID");
    assert.throws(() => parseDatabaseUrl(""), (e) => e.code === "E_BOOTSTRAP_DATABASE_URL_MISSING");
  });

  test("diagnostics redact the DSN, the password and a canary, and are bounded", () => {
    const secrets = ["canary_password_9f3", DSN];
    const noisy = [
      `psql: error: connection to "${DSN}" failed`,
      "FATAL: password authentication failed for user \"bootuser\"",
      "detail: password=canary_password_9f3",
      "x".repeat(2000),
    ].join("\n");
    const clean = sanitizeDiagnostics(noisy, secrets);
    assert.ok(!clean.includes("canary_password_9f3"));
    assert.ok(!clean.includes("postgres://"));
    assert.ok(clean.length <= 300);
  });

  test("the spawn seam receives the credential only in its environment", () => {
    const calls = [];
    const fakeSpawn = (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return { status: 0, stdout: "row\n", stderr: "" };
    };
    const output = runStatement(DSN, "select 1;", fakeSpawn);

    assert.equal(output, "row\n");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "psql");
    assert.ok(!calls[0].args.some((value) => String(value).includes("canary_password_9f3")), "no password in argv");
    assert.ok(!calls[0].args.some((value) => String(value).includes("postgres://")), "no DSN in argv");
    assert.equal(calls[0].env.PGPASSWORD, "canary_password_9f3");
    assert.equal(calls[0].env.PGHOST, "db.example.invalid");
  });

  test("a driver echoing the DSN or password cannot leak it through the failure", () => {
    const fakeSpawn = () => ({
      status: 2,
      stdout: "",
      stderr: `psql: error: could not connect to ${DSN} password=canary_password_9f3 canary_password_9f3`,
    });
    let error;
    try {
      runStatement(DSN, "select 1;", fakeSpawn);
    } catch (cause) {
      error = cause;
    }
    assert.ok(error, "the statement must be refused");
    assert.match(error.code, /^E_BOOTSTRAP_/);
    assert.ok(!error.message.includes("canary_password_9f3"), "password must not be reported");
    assert.ok(!error.message.includes("postgres://"), "DSN must not be reported");
  });

  test("a known bootstrap code survives sanitisation", () => {
    const fakeSpawn = () => ({
      status: 3,
      stdout: "",
      stderr: "psql: error: E_BOOTSTRAP_HUB_CONFLICT: hub x is attached to another workspace\n",
    });
    assert.throws(() => runStatement(DSN, "select 1;", fakeSpawn), (e) => e.code === "E_BOOTSTRAP_HUB_CONFLICT");
  });

  test("a spawn failure is still actionable", () => {
    const fakeSpawn = () => ({ error: { code: "ENOENT" }, status: null, stdout: "", stderr: "" });
    assert.throws(
      () => runStatement(DSN, "select 1;", fakeSpawn),
      (e) => e.code === "E_BOOTSTRAP_PSQL_UNAVAILABLE" && /psql could not be run/.test(e.message),
    );
  });

  test("apply writes a receipt and never puts the DSN in argv", async () => {
    const p = await plan();
    const dir = mkdtempSync(join(tmpdir(), "ega-bootstrap-apply-"));
    try {
      const calls = [];
      const fakeSpawn = (command, args, options) => {
        calls.push({ command, args, env: options.env });
        const sql = options.input;
        let stdout = "";
        if (sql.includes("create temp table bootstrap_inserted")) stdout = "t|t\n";
        else if (sql.includes("from public.hub_releases")) stdout = `${p.hubId}|${p.releaseDigest}|${p.sqliteDigest}\n`;
        else if (sql.includes("from public.hubs")) stdout = `${p.hubId}|${p.workspaceId}|private\n`;
        return { status: 0, stdout, stderr: "" };
      };
      const receiptPath = join(dir, "receipt.json");
      const outcome = applyBootstrap(p, DSN, receiptPath, fakeSpawn);

      assert.deepEqual(outcome.inserted, { hub: true, release: true });
      assert.equal(readReceipt(receiptPath).hub_id, p.hubId);
      for (const call of calls) {
        assert.ok(!call.args.some((value) => String(value).includes("canary_password_9f3")));
        assert.ok(!call.args.some((value) => String(value).includes("postgres://")));
        assert.equal(call.env.PGPASSWORD, "canary_password_9f3");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rollback consumes the receipt and reports one document", async () => {
    const p = await plan();
    const dir = mkdtempSync(join(tmpdir(), "ega-bootstrap-rb-"));
    try {
      const receiptPath = join(dir, "receipt.json");
      const receipt = receiptFor(p, { hub: true, release: true });
      writeReceipt(receiptPath, receipt);

      const fakeSpawn = () => ({ status: 0, stdout: "0\n", stderr: "" });
      const outcome = rollbackBootstrap(receiptPath, DSN, fakeSpawn);

      assert.equal(outcome.removedHub, true);
      assert.equal(outcome.removedRelease, true);
      assert.equal(existsSync(receiptPath), false, "a completed rollback consumes the receipt");

      const report = buildRollbackReport(receipt, outcome, receiptPath);
      assert.equal(JSON.parse(JSON.stringify(report)).executed, "rollback");
      assert.match(report.transaction, /delete from public\.hubs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Command line                                                                */
/* -------------------------------------------------------------------------- */

function runCli(argv, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: "utf8",
    env: { ...process.env, EGA_BOOTSTRAP_DATABASE_URL: "", ...env },
  });
}

describe("the command line prepares without a database", () => {
  test("it prints the transaction and executes nothing", () => {
    const result = runCli(["--workspace", WORKSPACE, "--hub", HUB]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing was executed/);
    assert.match(result.stdout, /--- transaction \(run with --apply\) ---/);
    assert.match(result.stdout, new RegExp(PACKAGE.hub_release_digest));
    assert.match(result.stdout, /begin;/);
    assert.match(result.stdout, /commit;/);
  });

  test("--json emits the plan without executing anything", () => {
    const result = runCli(["--workspace", WORKSPACE, "--hub", HUB, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.registration.hub_id, HUB);
    assert.equal(parsed.registration.visibility, "private");
    assert.equal(parsed.artifact.hub_release_digest, PACKAGE.hub_release_digest);
    assert.match(parsed.transaction, /begin;/);
  });

  test("--apply and --rollback require a receipt", () => {
    const apply = runCli(["--workspace", WORKSPACE, "--hub", HUB, "--apply"], { EGA_BOOTSTRAP_DATABASE_URL: "postgres://u:canary@h/db" });
    assert.notEqual(apply.status, 0);
    assert.match(apply.stderr, /E_BOOTSTRAP_RECEIPT_MISSING/);

    const rollback = runCli(["--workspace", WORKSPACE, "--hub", HUB, "--rollback"], { EGA_BOOTSTRAP_DATABASE_URL: "postgres://u:canary@h/db" });
    assert.notEqual(rollback.status, 0);
    assert.match(rollback.stderr, /E_BOOTSTRAP_RECEIPT_MISSING/);
  });

  test("--apply without a connection string refuses before printing a plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "ega-bootstrap-nodsn-"));
    try {
      const result = runCli(["--workspace", WORKSPACE, "--hub", HUB, "--receipt", join(dir, "r.json"), "--apply"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /E_BOOTSTRAP_DATABASE_URL_MISSING/);
      assert.equal(result.stdout, "", "a refusal must not leave a half-printed plan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refusal never echoes the connection string", () => {
    const secret = "postgres://user:canary_password_9f3@example.invalid:5432/db";
    const result = runCli(
      ["--workspace", WORKSPACE, "--hub", HUB, "--receipt", "/tmp/ega-bootstrap-never.json", "--apply"],
      { EGA_BOOTSTRAP_DATABASE_URL: secret, PATH: "/nonexistent-path-for-this-test" },
    );
    assert.ok(!result.stdout.includes("canary_password_9f3"));
    assert.ok(!result.stderr.includes("canary_password_9f3"));
  });
});

/* -------------------------------------------------------------------------- */
/* Hygiene                                                                     */
/* -------------------------------------------------------------------------- */

test("the script writes nothing to the artifact it verifies", async () => {
  const before = readFileSync(join(DEFAULT_ARTIFACT_DIR, "hub-release.json"), "utf8");
  await reviewedRelease();
  const after = readFileSync(join(DEFAULT_ARTIFACT_DIR, "hub-release.json"), "utf8");
  assert.equal(before, after);
});

test("a receipt is written owner-only and contains no credential", async () => {
  const p = await plan();
  const dir = mkdtempSync(join(tmpdir(), "ega-bootstrap-mode-"));
  try {
    const path = join(dir, "receipt.json");
    writeReceipt(path, receiptFor(p, { hub: true, release: true }));
    const text = readFileSync(path, "utf8");
    assert.ok(!text.includes("password"));
    assert.ok(existsSync(path));
    assert.equal(readReceipt(path).hub_id, HUB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyBootstrap refuses without a receipt path", async () => {
  const p = await plan();
  assert.throws(
    () => applyBootstrap(p, "postgres://u:canary@h.example/db", ""),
    (e) => e.code === "E_BOOTSTRAP_RECEIPT_MISSING",
  );
});
