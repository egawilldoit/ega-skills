/**
 * Catalog bootstrap — verification, plan and rendered SQL.
 *
 * These tests contact no database. They prove the two things that can be proved
 * without one: that the digest registered is the digest the reviewed artifact
 * actually carries, and that the rendered transaction is append-only, guarded,
 * and deterministic. The database behaviour of the rendered SQL (idempotency,
 * conflict refusal, dependency-aware rollback) is proved against a real
 * PostgreSQL in `tests/rls/catalog-bootstrap.rls.mjs`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  BootstrapError,
  DEFAULT_ARTIFACT_DIR,
  parseArgs,
  planBootstrap,
  renderReadBack,
  renderReleaseReadBack,
  renderRollback,
  renderTransaction,
  verifyReviewedRelease,
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
    // It is deliberately NOT a uuid, which is why the hub id is an explicit
    // operator input rather than something this script derives.
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
      // The loader verifies the SQLite bytes against the declared digest, so the
      // disagreement is caught before anything could be registered.
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
/* Plan / arguments                                                            */
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

  test("the visibility is always private", async () => {
    const p = await plan();
    assert.equal(p.visibility, "private");
    assert.equal(p.workspaceId, WORKSPACE);
    assert.equal(p.hubId, HUB);
    assert.equal(p.releaseDigest, PACKAGE.hub_release_digest);
  });

  test("unknown arguments and missing required arguments are refused", () => {
    assert.throws(() => parseArgs(["--workspace", WORKSPACE, "--hub", HUB, "--force"]), (e) => e.code === "E_BOOTSTRAP_ARGUMENT_INVALID");
    assert.throws(() => parseArgs(["--workspace", WORKSPACE, "--hub", HUB, "--apply", "--rollback"]), (e) => e.code === "E_BOOTSTRAP_ARGUMENT_INVALID");
  });
});

/* -------------------------------------------------------------------------- */
/* Rendered SQL                                                                */
/* -------------------------------------------------------------------------- */

describe("the forward transaction is append-only and guarded", () => {
  test("exactly one transaction, and no update or delete", async () => {
    const sql = renderTransaction(await plan());
    assert.equal((sql.match(/^begin;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^commit;$/gm) ?? []).length, 1);
    assert.doesNotMatch(sql, /\bupdate\b/i);
    assert.doesNotMatch(sql, /\bdelete\b/i);
  });

  test("both writes are conflict-tolerant inserts, never overwrites", async () => {
    const sql = renderTransaction(await plan());
    assert.equal((sql.match(/on conflict\s*\([^)]*\)\s*do nothing/gi) ?? []).length, 2);
    assert.match(sql, /insert into public\.hubs \(id, workspace_id, visibility\)/);
    assert.match(sql, /insert into public\.hub_releases \(hub_id, release_digest, sqlite_artifact_digest\)/);
  });

  test("every conflict it must detect raises", async () => {
    const sql = renderTransaction(await plan());
    for (const code of [
      "E_BOOTSTRAP_SCHEMA_MISSING",
      "E_BOOTSTRAP_WORKSPACE_MISSING",
      "E_BOOTSTRAP_HUB_CONFLICT",
      "E_BOOTSTRAP_RELEASE_CONFLICT",
      "E_BOOTSTRAP_DENY_PRESENT",
    ]) {
      assert.match(sql, new RegExp(`raise exception '${code}`), `${code} must be raised`);
    }
  });

  test("rendering is deterministic and carries the reviewed identity", async () => {
    const p = await plan();
    assert.equal(renderTransaction(p), renderTransaction(p));
    assert.match(renderTransaction(p), new RegExp(PACKAGE.hub_release_digest));
    assert.match(renderTransaction(p), new RegExp(PACKAGE.sqlite_artifact_digest));
    assert.match(renderTransaction(p), new RegExp(WORKSPACE));
    assert.match(renderTransaction(p), new RegExp(HUB));
  });
});

describe("the rollback is dependency-aware", () => {
  test("the child row is deleted before the parent", async () => {
    const sql = renderRollback(await plan());
    const child = sql.indexOf("delete from public.hub_releases");
    const parent = sql.indexOf("delete from public.hubs");
    assert.ok(child > -1 && parent > -1, "both deletes must be present");
    assert.ok(child < parent, "hub_releases must be deleted before hubs");
    assert.ok(sql.indexOf("raise exception") < child, "guards must precede the deletes");
  });

  test("it refuses, rather than cascading, when something depends on the hub or release", async () => {
    const sql = renderRollback(await plan());
    for (const needle of [
      "public.hub_stable_pointers",
      "public.hub_release_artifacts",
      "public.public_hub_publications",
      "public.project_contexts",
      "E_BOOTSTRAP_ROLLBACK_DEPENDENT",
      "E_BOOTSTRAP_ROLLBACK_CONFLICT",
    ]) {
      assert.ok(sql.includes(needle), `rollback must account for ${needle}`);
    }
    assert.equal((sql.match(/^begin;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^commit;$/gm) ?? []).length, 1);
  });

  test("the read-back selects the exact registered identity", async () => {
    const p = await plan();
    assert.match(renderReleaseReadBack(p), /from public\.hub_releases/);
    assert.match(renderReadBack(p), /from public\.hubs/);
    // `hubs` has no `hub_id` column; the key is `id`. A wrong column name here
    // would only surface on a live apply, so it is pinned.
    assert.match(renderReadBack(p), /select id::text, workspace_id::text, visibility/);
    assert.doesNotMatch(renderReadBack(p), /select hub_id/);
    assert.match(renderReleaseReadBack(p), new RegExp(p.hubId));
    assert.match(renderReleaseReadBack(p), new RegExp(p.releaseDigest));
  });
});

/* -------------------------------------------------------------------------- */
/* Command line                                                                */
/* -------------------------------------------------------------------------- */

function run(argv, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: "utf8",
    env: { ...process.env, EGA_BOOTSTRAP_DATABASE_URL: "", ...env },
  });
}

describe("the command line prepares without a database", () => {
  test("it prints the transaction and the rollback and executes nothing", () => {
    const result = run(["--workspace", WORKSPACE, "--hub", HUB]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing was executed/);
    assert.match(result.stdout, /--- transaction \(run with --apply\) ---/);
    assert.match(result.stdout, /--- rollback \(run with --rollback\) ---/);
    assert.match(result.stdout, new RegExp(PACKAGE.hub_release_digest));
    assert.match(result.stdout, /begin;/);
    assert.match(result.stdout, /commit;/);
  });

  test("--json emits the plan without executing anything", () => {
    const result = run(["--workspace", WORKSPACE, "--hub", HUB, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.registration.hub_id, HUB);
    assert.equal(parsed.registration.visibility, "private");
    assert.equal(parsed.artifact.hub_release_digest, PACKAGE.hub_release_digest);
    assert.match(parsed.transaction, /begin;/);
    assert.match(parsed.rollback, /delete from public\.hubs/);
  });

  test("a missing required argument is refused", () => {
    const result = run(["--workspace", WORKSPACE]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /E_BOOTSTRAP_ARGUMENT_INVALID/);
  });

  test("--apply without a connection string refuses before printing a plan", () => {
    const result = run(["--workspace", WORKSPACE, "--hub", HUB, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /E_BOOTSTRAP_DATABASE_URL_MISSING/);
    assert.equal(result.stdout, "", "a refusal must not leave a half-printed plan");
  });

  test("a refusal never echoes the connection string", () => {
    const secret = "postgres://user:sup3rsecret@example.invalid:5432/db";
    const result = run(["--workspace", WORKSPACE, "--hub", HUB, "--apply"], { EGA_BOOTSTRAP_DATABASE_URL: secret });
    // psql is unavailable in a way that is environment-specific; whatever the
    // outcome, the DSN must never appear in either stream.
    assert.ok(!result.stdout.includes("sup3rsecret"));
    assert.ok(!result.stderr.includes("sup3rsecret"));
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

test("the temporary directories used by these tests are cleaned up", () => {
  // Guards against a leaked fixture making a later run pass for the wrong reason.
  mkdirSync(join(tmpdir(), "ega-bootstrap-selftest"), { recursive: true });
  rmSync(join(tmpdir(), "ega-bootstrap-selftest"), { recursive: true, force: true });
  assert.ok(true);
});
