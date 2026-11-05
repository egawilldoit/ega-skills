// Contract F — real PostgreSQL RLS verification.
//
// This suite runs only against a disposable PostgreSQL database whose URL is
// provided via EGA_RLS_DATABASE_URL. It creates a uniquely named database,
// applies supabase/migrations in order, seeds the Contract F matrix, and then
// exercises effective grants and RLS as `authenticated` subjects. It drops the
// database afterwards and never touches a remote or production instance.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "./apply-migrations.mjs";
import { InMemoryControlPlane } from "../../packages/control-plane/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = process.env.EGA_RLS_DATABASE_URL;
if (!BASE_URL) {
  throw new Error("EGA_RLS_DATABASE_URL is required to run the Contract F RLS suite");
}
const DB_NAME = `ega_rls_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const DB_URL = withDatabase(BASE_URL, DB_NAME);
const ADMIN_URL = withDatabase(BASE_URL, "postgres");

const WS_A = "00000000-0000-4000-8000-0000000000a1";
const WS_B = "00000000-0000-4000-8000-0000000000b1";
const HUB_PRIVATE = "00000000-0000-4000-8000-00000000a001";
const HUB_WORKSPACE = "00000000-0000-4000-8000-00000000a002";
const HUB_DENIED = "00000000-0000-4000-8000-00000000a003";
const HUB_PUBLIC = "00000000-0000-4000-8000-00000000a004";
const HUB_PUBLIC_RELEASE_DENIED = "00000000-0000-4000-8000-00000000a005";
const HUB_B_PRIVATE = "00000000-0000-4000-8000-00000000b001";
const HUB_B_PUBLIC = "00000000-0000-4000-8000-00000000b002";
const PROJECT_A = "00000000-0000-4000-8000-000000000a01";
const PROJECT_B = "00000000-0000-4000-8000-000000000b01";
const CONTEXT_A = "00000000-0000-4000-8000-000000000a11";
const CONTEXT_A_REVOKED = "00000000-0000-4000-8000-000000000a12";
const CONTEXT_A_TOMBSTONE = "00000000-0000-4000-8000-000000000a13";
const CONTEXT_B = "00000000-0000-4000-8000-000000000b11";

const digest = (hex) => `sha256:${hex.repeat(64)}`;
const RELEASE = { a1: digest("1"), a2: digest("2"), a3: digest("3"), a4: digest("4"), a5: digest("5"), b1: digest("6"), b2: digest("7") };
const OBJECT = {
  a1Release: digest("a"), a1Sqlite: digest("b"),
  a2Release: digest("c"), a2Sqlite: digest("d"),
  a3Release: digest("e"), a3Sqlite: digest("f"),
  a4Release: digest("8"), a4Sqlite: digest("9"),
  a5Release: digest("0"), a5Sqlite: digest("3"),
  b1Release: digest("4"), b1Sqlite: digest("5"),
  b2Release: digest("6"), b2Sqlite: digest("7"),
};

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function psql(url, sql) {
  return execFileSync(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|", url],
    { encoding: "utf8", input: sql, stdio: ["pipe", "pipe", "pipe"] },
  );
}

function asSubject(subject, sql) {
  const claims = JSON.stringify({ sub: subject });
  return psql(DB_URL, `begin; set local role authenticated; set local "request.jwt.claims" = '${claims}'; ${sql}; commit;`);
}

function asPreferenceWriter(sql) {
  return psql(DB_URL, `begin; set local role ega_skill_preferences_writer; ${sql}; commit;`);
}

function failsAsPreferenceWriter(sql, pattern) {
  let stderr = "";
  try {
    asPreferenceWriter(sql);
  } catch (error) {
    stderr = String(error?.stderr ?? error?.message ?? "");
  }
  assert.match(stderr, pattern, `expected the dedicated writer to be denied: ${sql}`);
}

function rows(subject, sql) {
  return asSubject(subject, sql)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("|"));
}

function scalar(subject, sql) {
  const result = rows(subject, sql);
  return result.length > 0 ? result[0][0] : undefined;
}

function count(subject, sql) {
  return Number(scalar(subject, sql) ?? 0);
}

function sees(subject, table, idColumn, id) {
  return count(subject, `select count(*) from public.${table} where ${idColumn} = '${id}'`);
}

before(() => {
  psql(ADMIN_URL, `create database "${DB_NAME}"`);
  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "bootstrap.sql"), "utf8"));
  applyMigrations(psql, DB_URL, ROOT);
  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "seed.sql"), "utf8"));
});

after(() => {
  psql(ADMIN_URL, `drop database if exists "${DB_NAME}" with (force)`);
});

test("RLS is enabled on every Contract F table", () => {
  const tables = [
    "personal_workspaces", "hubs", "hub_releases", "hub_stable_pointers", "security_denies", "audit_events",
    "workspace_memberships", "skill_preferences", "projects", "project_contexts", "context_revocations", "quota_policies",
    "immutable_objects", "hub_release_artifacts", "source_credentials", "quota_usage", "public_hub_publications",
  ];
  const enabled = psql(DB_URL, `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity order by relname`)
    .split("\n").map((line) => line.trim()).filter(Boolean);
  for (const table of tables) {
    assert.ok(enabled.includes(table), `RLS must be enabled on public.${table}`);
  }
});

test("private preferences are owner-scoped and have no PostgREST write path", () => {
  const insert = `select * from private.write_skill_preferences('${WS_A}', 'user-a', array['design/ux'], array['design/ux'], 0)`;
  assert.match(asPreferenceWriter(insert), /1\|\{design\/ux\}\|\{design\/ux\}\|/);
  assert.equal(scalar("user-a", "select relforcerowsecurity::text from pg_class where oid='public.skill_preferences'::regclass"), "true");
  assert.equal(count("user-a", `select count(*) from public.skill_preferences where workspace_id='${WS_A}'`), 1);
  assert.equal(count("user-b", `select count(*) from public.skill_preferences where workspace_id='${WS_A}'`), 0);
  assert.equal(count("admin-a", `select count(*) from public.skill_preferences where workspace_id='${WS_A}'`), 0);
  assert.equal(count("user-a", `select count(*) from public.skill_preferences where workspace_id='${WS_B}'`), 0);
  assert.equal(count("inactive-a", `select count(*) from public.skill_preferences where workspace_id='${WS_A}'`), 0);
  assert.equal(scalar("user-a", "select has_table_privilege('anon', 'public.skill_preferences', 'SELECT')::text"), "false");
  for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
    assert.equal(scalar("user-a", `select has_table_privilege('authenticated', 'public.skill_preferences', '${privilege}')::text`), "false");
    assert.equal(scalar("user-a", `select has_table_privilege('service_role', 'public.skill_preferences', '${privilege}')::text`), "false");
    assert.equal(scalar("user-a", `select has_table_privilege('anon', 'public.skill_preferences', '${privilege}')::text`), "false");
  }
  assert.equal(scalar("user-a", "select has_table_privilege('service_role', 'public.skill_preferences', 'SELECT')::text"), "false");
  assert.equal(scalar("user-a", "select has_function_privilege('authenticated', 'private.write_skill_preferences(uuid,text,text[],text[],bigint)', 'EXECUTE')::text"), "false");
  assert.equal(scalar("user-a", "select has_function_privilege('anon', 'private.write_skill_preferences(uuid,text,text[],text[],bigint)', 'EXECUTE')::text"), "false");
  assert.equal(scalar("user-a", "select has_function_privilege('service_role', 'private.write_skill_preferences(uuid,text,text[],text[],bigint)', 'EXECUTE')::text"), "false");
  assert.equal(scalar("user-a", "select has_function_privilege('ega_skill_preferences_writer', 'private.write_skill_preferences(uuid,text,text[],text[],bigint)', 'EXECUTE')::text"), "true");
  assert.equal(scalar("user-a", "select has_schema_privilege('ega_skill_preferences_writer', 'private', 'USAGE')::text"), "true");
  assert.equal(scalar("user-a", "select has_schema_privilege('ega_skill_preferences_writer', 'public', 'CREATE')::text"), "false");
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
    assert.equal(scalar("user-a", `select has_table_privilege('ega_skill_preferences_writer', 'public.skill_preferences', '${privilege}')::text`), "false");
  }
  assert.equal(scalar("user-a", "select has_function_privilege('ega_skill_preferences_writer', 'private.is_canonical_skill_id_array(text[],integer)', 'EXECUTE')::text"), "false");
  assert.equal(scalar("user-a", "select has_function_privilege('ega_skill_preferences_writer', 'private.has_workspace_role(uuid,text[])', 'EXECUTE')::text"), "false");
  failsAs("user-a", insert, /permission denied/);
  failsAs("user-a", `update public.skill_preferences set default_skill_ids=array['design/ux'] where workspace_id='${WS_A}'`, /permission denied/);
  failsAs("inactive-a", `select * from private.write_skill_preferences('${WS_A}', 'inactive-a', array[]::text[], array[]::text[], 0)`, /permission denied/);
  failsAs("user-a", `select * from private.write_skill_preferences('${WS_B}', 'user-a', array[]::text[], array[]::text[], 0)`, /permission denied/);
  failsAs("user-a", `select * from private.write_skill_preferences('${WS_A}', 'user-b', array[]::text[], array[]::text[], 0)`, /permission denied/);
  failsAsPreferenceWriter(`select * from private.write_skill_preferences('${WS_A}', 'inactive-a', array[]::text[], array[]::text[], 0)`, /active workspace owner required/);
  failsAsPreferenceWriter(`select * from private.write_skill_preferences('${WS_B}', 'user-a', array[]::text[], array[]::text[], 0)`, /active workspace owner required/);
  failsAsPreferenceWriter(`select * from private.write_skill_preferences('${WS_A}', 'user-b', array[]::text[], array[]::text[], 0)`, /active workspace owner required/);
});

test("revoking an Owner membership immediately removes reads and writes", () => {
  psql(DB_URL, `update public.workspace_memberships set active=false where workspace_id='${WS_A}' and subject='user-a' and role='owner'`);
  try {
    assert.equal(count("user-a", `select count(*) from public.skill_preferences where workspace_id='${WS_A}'`), 0);
    failsAsPreferenceWriter(`select * from private.write_skill_preferences('${WS_A}', 'user-a', array[]::text[], array[]::text[], 1)`, /active workspace owner required/);
  } finally {
    psql(DB_URL, `update public.workspace_memberships set active=true where workspace_id='${WS_A}' and subject='user-a' and role='owner'`);
  }
});

test("write authorization serializes against concurrent membership revocation (row lock)", async () => {
  // Hold the active-owner membership row; the writer takes FOR UPDATE on that
  // row and blocks/fails fast (lock_timeout), preventing check-then-write TOCTOU.
  const holder = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", DB_URL], { stdio: ["pipe", "pipe", "pipe"] });
  let holderErr = "";
  holder.stderr.on("data", (d) => { holderErr += String(d); });
  const locked = new Promise((resolve, reject) => {
    let out = "";
    holder.stdout.on("data", (d) => { out += String(d); if (out.includes("LOCKED")) resolve(null); });
    holder.on("error", reject);
    holder.on("close", (code) => { if (!out.includes("LOCKED")) reject(new Error(`holder closed ${code}: ${holderErr}`)); });
  });
  holder.stdin.write(`BEGIN; SELECT 1 FROM public.workspace_memberships WHERE workspace_id='${WS_A}' AND subject='user-a' AND role='owner' AND active FOR UPDATE; SELECT 'LOCKED';\n`);
  await locked;
  const rev = Number(scalar("user-a", `select coalesce((select revision from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'), 0)`));
  try {
    assert.throws(
      () => psql(DB_URL, `set role ega_skill_preferences_writer; select * from private.write_skill_preferences('${WS_A}', 'user-a', array['design/ux'], array['design/ux'], ${rev});`),
      (e) => /lock timeout|55P03|canceling statement due to lock timeout/i.test(String(e?.message ?? e)),
      "writer must serialize on membership row lock",
    );
  } finally {
    try { holder.stdin.write("ROLLBACK;\n"); } catch {}
    holder.stdin.end();
    await new Promise((resolve) => holder.on("close", resolve));
  }
});

test("concurrent membership revocation blocks while writer holds authorization lock (reverse ordering)", async () => {
  const rev = Number(scalar("user-a", `select coalesce((select revision from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'), 0)`));
  const writer = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", DB_URL], { stdio: ["pipe", "pipe", "pipe"] });
  let werr = "";
  writer.stderr.on("data", (d) => { werr += String(d); });
  const wrote = new Promise((resolve, reject) => {
    let out = "";
    writer.stdout.on("data", (d) => { out += String(d); if (/\d/.test(out)) resolve(out); });
    writer.on("error", reject);
    writer.on("close", (code) => { if (!/\d/.test(out)) reject(new Error(`writer closed ${code}: ${werr}\n${out}`)); });
  });
  writer.stdin.write(`BEGIN; SET ROLE ega_skill_preferences_writer; SELECT revision FROM private.write_skill_preferences('${WS_A}', 'user-a', array['design/ux']::text[], array[]::text[], ${rev});\n`);
  await wrote;
  try {
    assert.throws(
      () => psql(DB_URL, `SET lock_timeout='1s'; UPDATE public.workspace_memberships SET active=false WHERE workspace_id='${WS_A}' AND subject='user-a' AND role='owner';`),
      (e) => /lock timeout|55P03|canceling statement/i.test(String(e?.message ?? e)),
      "revocation must not commit while writer holds authorized membership lock",
    );
  } finally {
    try { writer.stdin.write("ROLLBACK;\n"); } catch {}
    writer.stdin.end();
    await new Promise((resolve) => writer.on("close", resolve));
  }
  assert.match(psql(DB_URL, `select active::text from public.workspace_memberships where workspace_id='${WS_A}' and subject='user-a' and role='owner'`).trim(), /^(t|true)$/);
});

test("deterministic revocation ordering A: revocation commits, writer fails (real PostgreSQL)", async () => {
  // Two-session ordering: R commits revocation first; W then must fail authorization.
  const rev = Number(scalar("user-a", `select coalesce((select revision from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'), 0)`));
  const R = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", DB_URL], { stdio: ["pipe", "pipe", "pipe"] });
  const rDone = new Promise((resolve, reject) => {
    let err = ""; R.stderr.on("data", (d) => { err += String(d); });
    R.on("error", reject); R.on("close", (code) => code === 0 ? resolve(null) : reject(new Error(err)));
  });
  R.stdin.write(`BEGIN; UPDATE public.workspace_memberships SET active=false WHERE workspace_id='${WS_A}' AND subject='user-a' AND role='owner'; COMMIT;\n\\q\n`);
  await rDone;
  try {
    assert.match(psql(DB_URL, `select active::text from public.workspace_memberships where workspace_id='${WS_A}' AND subject='user-a' AND role='owner'`).trim(), /^(f|false)$/, "revocation must be committed");
    failsAsPreferenceWriter(`select * from private.write_skill_preferences('${WS_A}', 'user-a', array[]::text[], array[]::text[], ${rev})`, /active workspace owner required/);
  } finally {
    psql(DB_URL, `UPDATE public.workspace_memberships SET active=true WHERE workspace_id='${WS_A}' AND subject='user-a' AND role='owner'`);
  }
});

test("deterministic revocation ordering B: writer commits authorized update, revocation is delayed until after commit (real PostgreSQL)", async () => {
  // Capture state for cleanup (admin). W holds FOR UPDATE lock while open.
  const before = psql(DB_URL, `select coalesce((select revision::text||'|'||favorite_skill_ids::text||'|'||default_skill_ids::text from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'), 'none')`).trim();
  const rev = before === "none" ? 0 : Number(before.split("|")[0]);
  const W = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", DB_URL], { stdio: ["pipe", "pipe", "pipe"] });
  let werr = ""; W.stderr.on("data", (d) => { werr += String(d); });
  const wrote = new Promise((resolve, reject) => {
    let out = ""; W.stdout.on("data", (d) => { out += String(d); if (/\d/.test(out)) resolve(out.trim()); });
    W.on("error", reject); W.on("close", (code) => { if (!/\d/.test(out)) reject(new Error(`writer closed ${code}: ${werr}\n${out}`)); });
  });
  W.stdin.write(`BEGIN; SET ROLE ega_skill_preferences_writer; SELECT revision FROM private.write_skill_preferences('${WS_A}', 'user-a', array['design/ux']::text[], array[]::text[], ${rev});\n`);
  const writerRev = (await wrote).trim();
  let committed = false;
  try {
    // Revocation delayed while W holds membership FOR UPDATE lock.
    assert.throws(
      () => psql(DB_URL, `SET lock_timeout='1s'; UPDATE public.workspace_memberships SET active=false WHERE workspace_id='${WS_A}' AND subject='user-a' AND role='owner';`),
      (e) => /lock timeout|55P03|canceling statement/i.test(String(e?.message ?? e)),
      "revocation must be delayed while writer holds authorized lock",
    );
    // W commits first: authorized write persists.
    W.stdin.write("COMMIT;\n");
    committed = true;
    W.stdin.end();
    await new Promise((resolve, reject) => W.on("close", (code) => code === 0 ? resolve(null) : reject(new Error(werr))));
    assert.equal(scalar("user-a", `select revision::text from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'`).trim(), writerRev, "writer commit must persist");
  } finally {
    if (!committed) { try { W.stdin.write("ROLLBACK;\n"); } catch {} }
    try { W.stdin.end(); } catch {}
    await Promise.race([new Promise((resolve) => W.on("close", resolve)), new Promise((r) => setTimeout(r, 1000))]);
    // Restore fixture state (admin cleanup in disposable DB).
    if (before === "none") psql(DB_URL, `DELETE FROM public.skill_preferences WHERE workspace_id='${WS_A}' AND subject='user-a'`);
    else {
      const [r, fav, def] = before.split("|");
      psql(DB_URL, `UPDATE public.skill_preferences SET revision=${Number(r)}, favorite_skill_ids='${fav}'::text[], default_skill_ids='${def}'::text[] WHERE workspace_id='${WS_A}' AND subject='user-a'`);
    }
    psql(DB_URL, `UPDATE public.workspace_memberships SET active=true WHERE workspace_id='${WS_A}' AND subject='user-a' AND role='owner'`);
  }
});

test("the writer is a bounded SECURITY DEFINER with a pinned search path", () => {
  const owner = rows("user-a", `select r.rolsuper::text, r.rolbypassrls::text from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid='private.write_skill_preferences(uuid,text,text[],text[],bigint)'::regprocedure`)[0];
  assert.ok(owner, "writer function has a catalog owner");
  assert.ok(owner[0] === "true" || owner[1] === "true", "the function owner must bypass RLS because the table forces RLS");
  const config = scalar("user-a", `select coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid='private.write_skill_preferences(uuid,text,text[],text[],bigint)'::regprocedure`);
  assert.match(config, /search_path=/);
  assert.match(config, /statement_timeout=3s/);
  assert.match(config, /lock_timeout=2s/);
});

test("the database rejects excess and duplicate IDs and serializes revision-checked writes", async () => {
  failsAsPreferenceWriter(`select * from private.write_skill_preferences('${WS_A}', 'user-a', array[]::text[], array['a/one','b/two','c/three','d/four'], 1)`, /invalid preference IDs/);
  failsAsPreferenceWriter(`select * from private.write_skill_preferences('${WS_A}', 'user-a', array[]::text[], array['a/one','a/one'], 1)`, /invalid preference IDs/);
  failsAs("user-a", `insert into public.skill_preferences(workspace_id, subject, revision, default_skill_ids) values ('${WS_A}', 'user-a', 2, array['a/one','a/one'])`, /permission denied/);
  const competing = `select revision, default_skill_ids from private.write_skill_preferences('${WS_A}', 'user-a', array['design/ux'], array['a/one','b/two','c/three'], 1)`;
  const runs = [0, 1].map(() => new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|", DB_URL], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    child.stdin.end(`begin; set local role ega_skill_preferences_writer; select pg_sleep(0.1); ${competing}; commit;`);
  }));
  const outputs = await Promise.all(runs);
  assert.equal(outputs.filter((output) => output.includes("2|{a/one,b/two,c/three}")).length, 1);
  assert.equal(count("user-a", `select cardinality(default_skill_ids) from public.skill_preferences where workspace_id='${WS_A}'`), 3);
  // An unavailable/retired default can be removed because the function validates
  // structural shape; only the API validates newly added catalog IDs.
  const removal = `select revision from private.write_skill_preferences('${WS_A}', 'user-a', array[]::text[], array['a/one','b/two'], 2)`;
  assert.match(asPreferenceWriter(removal), /3/);
});

test("concurrent first inserts serialize to one winner (no duplicate row)", async () => {
  const WS_B = "00000000-0000-4000-8000-0000000000b1";
  const first = `select revision from private.write_skill_preferences('${WS_B}', 'user-b', array['design/ux'], array['design/ux'], 0)`;
  const runs = [0, 1].map(() => new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|", DB_URL], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    child.stdin.end(`begin; set local role ega_skill_preferences_writer; select pg_sleep(0.1); ${first}; commit;`);
  }));
  const outputs = await Promise.all(runs);
  assert.equal(outputs.filter((output) => output === "1").length, 1, `one first-insert wins, got ${JSON.stringify(outputs)}`);
  assert.equal(outputs.filter((output) => output === "").length, 1, "losing first-insert returns no row (stale/conflict)");
  assert.equal(count("user-b", `select count(*) from public.skill_preferences where workspace_id='${WS_B}' and subject='user-b'`), 1);
});

test("owners are workspace-isolated; writer checks target authorization, not HTTP identity (trusted boundary)", () => {
  // Trusted writer identity boundary: the dedicated DB writer role validates that
  // p_subject is an active Owner of p_workspace_id and enforces structural/revision
  // rules, but it cannot prove HTTP session identity. The API must pass only the
  // authenticated caller's subject. The DB does not independently validate catalog.
  // Schema limit: workspace_memberships has one-owner-per-workspace uniqueness, so
  // this exercises two active owners on different workspaces plus owner isolation.
  const WS_B = "00000000-0000-4000-8000-0000000000b1";
  // user-b/WS_B row may already exist from the concurrent first-insert test (rev 1).
  const wsB = count("user-b", `select count(*) from public.skill_preferences where workspace_id='${WS_B}' and subject='user-b'`);
  if (wsB === 0) {
    assert.match(asPreferenceWriter(`select revision from private.write_skill_preferences('${WS_B}', 'user-b', array['design/ux'], array[]::text[], 0)`), /^1$/);
  } else {
    assert.match(asPreferenceWriter(`select revision, default_skill_ids from private.write_skill_preferences('${WS_B}', 'user-b', array['design/ux'], array[]::text[], 1)`).trim(), /^2\|\{\}$/);
  }
  assert.equal(count("user-b", `select count(*) from public.skill_preferences where workspace_id='${WS_B}' and subject='user-b'`), 1);
  assert.equal(count("user-a", `select count(*) from public.skill_preferences where workspace_id='${WS_B}'`), 0, "RLS isolates workspace B from user-a");
  assert.equal(count("user-b", `select count(*) from public.skill_preferences where workspace_id='${WS_A}'`), 0, "RLS isolates workspace A from user-b");
  // Writer validates target membership; it cannot bind to HTTP identity (API boundary).
  failsAsPreferenceWriter(`select * from private.write_skill_preferences('${WS_A}', 'admin-a', array[]::text[], array[]::text[], 0)`, /active workspace owner required/);
  failsAsPreferenceWriter(`select * from private.write_skill_preferences('${WS_A}', 'not-owner-a', array[]::text[], array[]::text[], 0)`, /active workspace owner required/);
});

function failsAs(subject, sql, pattern) {
  let stderr = "";
  try {
    asSubject(subject, sql);
  } catch (error) {
    stderr = String(error?.stderr ?? error?.message ?? "");
  }
  assert.match(stderr, pattern, `expected ${subject} to be denied: ${sql}`);
}

const ENTRY_HELPERS = [
  ["has_workspace_role", "uuid,text[]"],
  ["can_read_hub", "uuid"],
  ["can_read_release", "uuid,text"],
  ["can_read_artifact", "uuid,text,text"],
  ["can_read_object", "text"],
  ["can_read_project", "uuid"],
  ["can_read_context", "uuid"],
  ["can_manage_context_revocations", "uuid"],
];

const INTERNAL_HELPERS = [
  ["is_active_member", "uuid"],
  ["has_inactive_membership", "uuid"],
  ["is_denied", "uuid,text,text"],
];

test("RLS entry-point helpers are the only executable authorization surface", () => {
  const functions = psql(DB_URL, "select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' order by p.proname")
    .split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.split("|"));
  for (const [name, args] of ENTRY_HELPERS) {
    const row = functions.find(([proname]) => proname === name);
    assert.ok(row, `private.${name} must exist`);
    assert.equal(row[1], "t", `private.${name} must be security definer`);
    assert.match(row[2], /search_path=/, `private.${name} must pin search_path`);
    assert.equal(
      scalar("user-a", `select has_function_privilege('anon', 'private.${name}(${args})', 'EXECUTE')::text`),
      "false",
      `anon must not execute private.${name}`,
    );
    assert.equal(
      scalar("user-a", `select has_function_privilege('authenticated', 'private.${name}(${args})', 'EXECUTE')::text`),
      "true",
      `authenticated must execute the RLS entry point private.${name}`,
    );
  }
  for (const [name, args] of INTERNAL_HELPERS) {
    const row = functions.find(([proname]) => proname === name);
    assert.ok(row, `private.${name} must exist`);
    assert.equal(row[1], "t", `private.${name} must be security definer`);
    assert.match(row[2], /search_path=/, `private.${name} must pin search_path`);
    assert.equal(
      scalar("user-a", `select has_function_privilege('anon', 'private.${name}(${args})', 'EXECUTE')::text`),
      "false",
      `anon must not execute private.${name}`,
    );
    assert.equal(
      scalar("user-a", `select has_function_privilege('authenticated', 'private.${name}(${args})', 'EXECUTE')::text`),
      "false",
      `implementation-only private.${name} must not be executable by authenticated`,
    );
  }
  assert.equal(scalar("user-a", `select has_schema_privilege('anon', 'private', 'USAGE')::text`), "false");
  assert.equal(scalar("user-a", `select has_table_privilege('anon', 'public.hubs', 'SELECT')::text`), "false");
  assert.equal(scalar("user-a", `select has_table_privilege('authenticated', 'public.hubs', 'SELECT')::text`), "true");
  for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
    assert.equal(
      scalar("user-a", `select has_table_privilege('authenticated', 'public.hubs', '${privilege}')::text`),
      "false",
      `authenticated must not hold ${privilege} on public.hubs`,
    );
  }
});

test("internal authorization helpers are not directly callable by ordinary members", () => {
  for (const subject of ["member-a", "viewer-a"]) {
    failsAs(subject, `select private.is_denied('${WS_A}', 'hub', '${HUB_DENIED}')`, /permission denied/);
    failsAs(subject, `select private.is_active_member('${WS_A}')`, /permission denied/);
    failsAs(subject, `select private.has_inactive_membership('${WS_A}')`, /permission denied/);
  }
  assert.equal(scalar("member-a", `select private.can_read_hub('${HUB_WORKSPACE}')::text`), "true", "the RLS entry-point surface stays callable");
});

test("owner reads every own-workspace grant without cross-workspace leakage", () => {
  assert.equal(sees("user-a", "hubs", "id", HUB_PRIVATE), 1);
  assert.equal(sees("user-a", "hubs", "id", HUB_WORKSPACE), 1);
  assert.equal(sees("user-a", "hubs", "id", HUB_PUBLIC), 1);
  assert.equal(sees("user-a", "hubs", "id", HUB_B_PRIVATE), 0);
  assert.equal(sees("user-a", "hubs", "id", HUB_B_PUBLIC), 1, "public visibility crosses workspaces");
  assert.equal(sees("user-a", "hub_releases", "release_digest", RELEASE.a1), 1);
  assert.equal(sees("user-a", "hub_releases", "release_digest", RELEASE.a3), 0, "denied hub release hidden");
  assert.equal(sees("user-a", "hub_releases", "release_digest", RELEASE.a5), 0, "denied release hidden");
  assert.equal(sees("user-a", "hub_releases", "release_digest", RELEASE.b1), 0);
  assert.equal(sees("user-a", "projects", "id", PROJECT_A), 1);
  assert.equal(sees("user-a", "projects", "id", PROJECT_B), 0);
  assert.equal(sees("user-a", "project_contexts", "id", CONTEXT_A), 1);
  assert.equal(sees("user-a", "project_contexts", "id", CONTEXT_A_REVOKED), 0);
  assert.equal(sees("user-a", "project_contexts", "id", CONTEXT_A_TOMBSTONE), 0);
  assert.equal(sees("user-a", "workspace_memberships", "subject", "user-b"), 0);
  assert.equal(count("user-a", "select count(*) from public.workspace_memberships"), 6);
  assert.equal(count("user-a", "select count(*) from public.security_denies"), 3);
  assert.equal(count("user-a", "select count(*) from public.quota_policies"), 1);
  assert.equal(count("user-a", "select count(*) from public.quota_usage"), 1);
  assert.equal(count("user-a", "select count(*) from public.source_credentials"), 1);
  assert.equal(count("user-a", "select count(*) from public.audit_events"), 1);
});

test("active workspace members receive exactly the documented workspace and public reads", () => {
  for (const subject of ["admin-a", "maintainer-a", "member-a", "viewer-a"]) {
    assert.equal(sees(subject, "hubs", "id", HUB_WORKSPACE), 1, `${subject} reads its workspace hub`);
    assert.equal(sees(subject, "hubs", "id", HUB_PUBLIC), 1, `${subject} reads the public hub`);
    assert.equal(sees(subject, "hubs", "id", HUB_PRIVATE), 0, `${subject} must not read the private hub`);
    assert.equal(sees(subject, "hubs", "id", HUB_B_PRIVATE), 0);
    assert.equal(sees(subject, "hubs", "id", HUB_B_PUBLIC), 1);
    assert.equal(sees(subject, "hub_releases", "release_digest", RELEASE.a2), 1);
    assert.equal(sees(subject, "hub_releases", "release_digest", RELEASE.a1), 0);
    assert.equal(sees(subject, "hub_releases", "release_digest", RELEASE.b2), 1);
    assert.equal(sees(subject, "projects", "id", PROJECT_A), 1);
    assert.equal(sees(subject, "project_contexts", "id", CONTEXT_A), 1);
    assert.equal(sees(subject, "hub_release_artifacts", "object_digest", OBJECT.a2Release), 1);
    assert.equal(sees(subject, "hub_release_artifacts", "object_digest", OBJECT.a4Sqlite), 1);
    assert.equal(sees(subject, "hub_release_artifacts", "object_digest", OBJECT.a4Release), 0, "blob deny hides the inventory row");
  }
});

test("inactive membership denies every workspace-scoped resource", () => {
  assert.equal(sees("inactive-a", "hubs", "id", HUB_PUBLIC), 0, "revoked membership overrides public visibility");
  assert.equal(sees("inactive-a", "hubs", "id", HUB_WORKSPACE), 0);
  assert.equal(sees("inactive-a", "hub_releases", "release_digest", RELEASE.a2), 0);
  assert.equal(sees("inactive-a", "projects", "id", PROJECT_A), 0);
  assert.equal(sees("inactive-a", "project_contexts", "id", CONTEXT_A), 0);
  assert.equal(sees("inactive-a", "workspace_memberships", "subject", "member-a"), 0);
  assert.equal(count("inactive-a", "select count(*) from public.security_denies"), 0);
  assert.equal(count("inactive-a", "select count(*) from public.quota_policies"), 0);
  assert.equal(count("inactive-a", "select count(*) from public.source_credentials"), 0);
});

test("non-members can read only public visibility resources", () => {
  assert.equal(sees("outsider", "hubs", "id", HUB_PUBLIC), 1);
  assert.equal(sees("outsider", "hubs", "id", HUB_B_PUBLIC), 1);
  assert.equal(sees("outsider", "hubs", "id", HUB_WORKSPACE), 0);
  assert.equal(sees("outsider", "hubs", "id", HUB_PRIVATE), 0);
  assert.equal(sees("outsider", "hub_releases", "release_digest", RELEASE.a4), 1);
  assert.equal(sees("outsider", "hub_releases", "release_digest", RELEASE.b2), 1);
  assert.equal(sees("outsider", "hub_releases", "release_digest", RELEASE.a2), 0);
  assert.equal(sees("outsider", "hub_release_artifacts", "object_digest", OBJECT.a4Sqlite), 1);
  assert.equal(sees("outsider", "projects", "id", PROJECT_A), 0);
  assert.equal(sees("outsider", "project_contexts", "id", CONTEXT_A), 0);
  assert.equal(count("outsider", "select count(*) from public.workspace_memberships"), 0);
  assert.equal(sees("outsider", "public_hub_publications", "hub_id", HUB_PUBLIC), 1);
  assert.equal(sees("outsider", "public_hub_publications", "hub_id", HUB_B_PUBLIC), 1);
});

test("explicit deny overrides otherwise valid grants", () => {
  assert.equal(sees("member-a", "hubs", "id", HUB_WORKSPACE), 1, "control: un-denied workspace hub is readable");
  assert.equal(sees("member-a", "hubs", "id", HUB_DENIED), 0, "hub deny overrides membership");
  assert.equal(sees("user-a", "hubs", "id", HUB_DENIED), 0, "hub deny overrides ownership");
  assert.equal(sees("outsider", "hubs", "id", HUB_PUBLIC_RELEASE_DENIED), 1, "hub stays readable");
  assert.equal(sees("outsider", "hub_releases", "release_digest", RELEASE.a5), 0, "release deny hides the release");
  assert.equal(sees("outsider", "hub_release_artifacts", "object_digest", OBJECT.a5Release), 0);
  assert.equal(sees("outsider", "hub_release_artifacts", "object_digest", OBJECT.a4Release), 0, "blob deny hides the object");
  assert.equal(sees("outsider", "hub_release_artifacts", "object_digest", OBJECT.a4Sqlite), 1, "non-denied object stays visible");
  assert.equal(sees("outsider", "immutable_objects", "object_digest", OBJECT.a4Release), 0, "blob deny hides the immutable object");
  assert.equal(sees("outsider", "immutable_objects", "object_digest", OBJECT.a4Sqlite), 1);
  assert.equal(sees("member-a", "security_denies", "identity", HUB_DENIED), 0, "members do not read deny metadata");
  assert.equal(sees("admin-a", "security_denies", "identity", HUB_DENIED), 1, "admins read deny metadata");
});

test("workspace A and B resources are isolated except public visibility", () => {
  for (const [table, column, value] of [
    ["hubs", "id", HUB_B_PRIVATE],
    ["hub_releases", "release_digest", RELEASE.b1],
    ["projects", "id", PROJECT_B],
    ["project_contexts", "id", CONTEXT_B],
    ["workspace_memberships", "subject", "user-b"],
  ]) {
    assert.equal(sees("user-a", table, column, value), 0, `workspace B ${table} leaks to user-a`);
    assert.equal(sees("member-a", table, column, value), 0, `workspace B ${table} leaks to member-a`);
  }
  for (const [table, column, value] of [
    ["hubs", "id", HUB_PRIVATE],
    ["hub_releases", "release_digest", RELEASE.a1],
    ["projects", "id", PROJECT_A],
    ["project_contexts", "id", CONTEXT_A],
    ["workspace_memberships", "subject", "user-a"],
  ]) {
    assert.equal(sees("user-b", table, column, value), 0, `workspace A ${table} leaks to user-b`);
  }
  assert.equal(sees("user-b", "hubs", "id", HUB_PUBLIC), 1);
  assert.equal(sees("user-b", "hub_releases", "release_digest", RELEASE.a4), 1);
});

test("context revocation is enforced and revocation metadata is owner/admin scoped", () => {
  assert.equal(sees("member-a", "project_contexts", "id", CONTEXT_A), 1);
  assert.equal(sees("member-a", "project_contexts", "id", CONTEXT_A_REVOKED), 0, "revoked_at denies");
  assert.equal(sees("member-a", "project_contexts", "id", CONTEXT_A_TOMBSTONE), 0, "revocation row denies");
  assert.equal(sees("member-a", "context_revocations", "context_id", CONTEXT_A_TOMBSTONE), 0);
  assert.equal(sees("admin-a", "context_revocations", "context_id", CONTEXT_A_TOMBSTONE), 1);
  assert.equal(sees("user-a", "context_revocations", "context_id", CONTEXT_A_TOMBSTONE), 1);
});

test("database and in-memory authorization agree for equivalent read scenarios", () => {
  const plane = new InMemoryControlPlane();
  const hubs = [
    [HUB_PRIVATE, WS_A, "private", "user-a"],
    [HUB_WORKSPACE, WS_A, "workspace", "user-a"],
    [HUB_DENIED, WS_A, "workspace", "user-a"],
    [HUB_PUBLIC, WS_A, "public", "user-a"],
    [HUB_B_PRIVATE, WS_B, "private", "user-b"],
    [HUB_B_PUBLIC, WS_B, "public", "user-b"],
  ];
  for (const [hubId, workspaceId, visibility, owner] of hubs) {
    plane.setResource(hubId, { workspaceId, visibility, ownerSubject: owner });
  }
  plane.deny(HUB_DENIED);
  for (const [workspaceId, subject, role, active] of [
    [WS_A, "user-a", "owner", true],
    [WS_A, "admin-a", "admin", true],
    [WS_A, "maintainer-a", "maintainer", true],
    [WS_A, "member-a", "member", true],
    [WS_A, "viewer-a", "viewer", true],
    [WS_A, "inactive-a", "member", false],
    [WS_B, "user-b", "owner", true],
  ]) {
    plane.addMembership(workspaceId, { subject, role, active });
  }
  for (const [hubId] of hubs) {
    for (const subject of ["user-a", "admin-a", "maintainer-a", "member-a", "viewer-a", "inactive-a", "outsider", "user-b"]) {
      const memory = plane.authorize(hubId, subject, "read_hub");
      const database = sees(subject, "hubs", "id", hubId) === 1;
      assert.equal(database, memory, `hub ${hubId} subject ${subject}: database ${database} vs memory ${memory}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Delegated OAuth token containment (release gate)
// ---------------------------------------------------------------------------

const CONTROL_PLANE_TABLES = [
  "personal_workspaces",
  "hubs",
  "hub_releases",
  "hub_stable_pointers",
  "security_denies",
  "audit_events",
  "workspace_memberships",
  "projects",
  "project_contexts",
  "context_revocations",
  "quota_policies",
  "immutable_objects",
  "hub_release_artifacts",
  "source_credentials",
  "quota_usage",
  "skill_preferences",
  "public_hub_publications",
  // Contract T1 telemetry. Present here so the count assertion below and the
  // delegated-token loop both cover it: a new control-plane table that misses
  // the containment migration would otherwise read as "no restrictive policy"
  // and pass a test that never looked at it.
  "mcp_tool_executions",
];

function asDelegated(subject, clientId, sql) {
  const claims = JSON.stringify({ sub: subject, client_id: clientId, role: "authenticated" });
  return psql(DB_URL, `begin; set local role authenticated; set local "request.jwt.claims" = '${claims}'; ${sql}; commit;`);
}

test("delegated OAuth tokens read zero control-plane rows even for workspace owners", () => {
  const restrictive = scalar(
    "user-a",
    "select count(*) from pg_policies where schemaname = 'public' and policyname = 'delegated_oauth_containment' and permissive = 'RESTRICTIVE'",
  );
  assert.equal(Number(restrictive), CONTROL_PLANE_TABLES.length, "every control-plane table needs a restrictive policy");

  // The owner sees rows through a first-party session...
  assert.ok(count("user-a", "select count(*) from public.hubs") > 0, "fixture must be visible to the first-party owner");
  assert.ok(
    count("user-a", "select count(*) from public.workspace_memberships") > 0,
    "fixture memberships must be visible to the first-party owner",
  );
  assert.ok(count("user-a", `select count(*) from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'`) > 0, "first-party owner must see own preferences");

  // ...and exactly zero rows through a delegated OAuth client token.
  for (const table of CONTROL_PLANE_TABLES) {
    const delegated = asDelegated("user-a", "delegated-client-1", `select count(*) from public.${table}`)
      .trim();
    assert.equal(delegated, "0", `delegated token must not read public.${table}`);
  }
  const otherClient = asDelegated("user-b", "another-client", "select count(*) from public.hubs").trim();
  assert.equal(otherClient, "0", "containment is independent of subject or client id");
});

test("delegated OAuth token with Owner subject cannot read private skill preferences (real PostgreSQL)", () => {
  assert.ok(count("user-a", `select count(*) from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'`) > 0, "first-party owner reads own preferences");
  const delegated = asDelegated("user-a", "delegated-client-1", `select count(*) from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'`).trim();
  assert.equal(delegated, "0", "delegated token must not read skill_preferences via PostgREST/RLS path");
});

test("delegated OAuth tokens cannot mutate control-plane state", () => {
  for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
    assert.equal(
      scalar("user-a", `select has_table_privilege('authenticated', 'public.hubs', '${privilege}')::text`),
      "false",
      `authenticated must not hold ${privilege} on public.hubs`,
    );
  }
  assert.throws(() =>
    asDelegated(
      "user-a",
      "delegated-client-1",
      `insert into public.hubs (workspace_id, visibility) values ('00000000-0000-4000-8000-0000000000a1', 'public')`,
    ),
  );
  assert.throws(() =>
    asDelegated("user-a", "delegated-client-1", `delete from public.workspace_memberships`),
  );
});

test("first-party sessions keep their existing control-plane reads", () => {
  assert.ok(count("user-a", "select count(*) from public.projects") > 0);
  assert.ok(count("user-a", "select count(*) from public.project_contexts") > 0);
  assert.ok(count("user-a", "select count(*) from public.immutable_objects") > 0);
});

test("skill_preferences rollback removes table/function without dropping shared cluster-wide role", () => {
  const name = `ega_prefs_rb_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const dbUrl = withDatabase(BASE_URL, name);
  try {
    psql(ADMIN_URL, `create database "${name}"`);
    psql(dbUrl, readFileSync(join(ROOT, "tests", "rls", "bootstrap.sql"), "utf8"));
    applyMigrations(psql, dbUrl, ROOT);
    assert.equal(psql(dbUrl, `select to_regclass('public.skill_preferences') is not null`).trim(), "t");
    psql(dbUrl, `DROP TABLE IF EXISTS public.skill_preferences; DROP FUNCTION IF EXISTS private.write_skill_preferences(uuid, text, text[], text[], bigint); DROP FUNCTION IF EXISTS private.is_canonical_skill_id_array(text[], integer); REVOKE ALL ON SCHEMA private FROM ega_skill_preferences_writer;`);
    assert.equal(psql(dbUrl, `select to_regclass('public.skill_preferences')`).trim(), "");
    assert.equal(psql(dbUrl, `select count(*) from pg_roles where rolname='ega_skill_preferences_writer'`).trim(), "1", "cluster-wide role must not be dropped by rollback");
  } finally {
    try { psql(ADMIN_URL, `drop database if exists "${name}"`); } catch {}
  }
});

test("API route uses authenticated caller subject against real PostgreSQL writer (no request-subject spoofing)", async () => {
  const { buildSkillPreferenceRoutes } = await import("../../apps/web/server/skill-preferences.ts");
  let calls = 0;
  const store = {
    async update(input) {
      calls += 1;
      assert.equal(input.subject, "user-a", "API must pass resolved caller subject to the real writer boundary");
      assert.equal(input.workspaceId, WS_A);
      const sql = `select revision, favorite_skill_ids, default_skill_ids, updated_at::text from private.write_skill_preferences('${input.workspaceId}', '${input.subject}', array[${input.favorites.map((id) => `'${id}'`).join(",")}]::text[], array[${input.defaults.map((id) => `'${id}'`).join(",")}]::text[], ${input.expectedRevision})`;
      const out = psql(DB_URL, `begin; set local role ega_skill_preferences_writer; ${sql}; commit;`).trim();
      if (out === "") return null;
      const [revision, favorites, defaults, updatedAt] = out.split("|");
      const parseArray = (value) => value === "{}" ? [] : value.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
      return { revision: Number(revision), favorite_skill_ids: parseArray(favorites), default_skill_ids: parseArray(defaults), updated_at: updatedAt };
    },
  };
  const reader = {
    async resolveCaller() { return { subject: "user-a" }; },
    async readAsCaller(_caller, table) {
      if (table === "workspace_memberships") return [{ workspace_id: WS_A, subject: "user-a", role: "owner", active: true }];
      if (table === "skill_preferences") {
        const out = psql(DB_URL, `select revision, favorite_skill_ids, default_skill_ids, updated_at::text from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'`).trim();
        if (out === "") return [];
        const [revision, favorites, defaults, updatedAt] = out.split("|");
        const parseArray = (value) => value === "{}" ? [] : value.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
        return [{ revision: Number(revision), favorite_skill_ids: parseArray(favorites), default_skill_ids: parseArray(defaults), updated_at: updatedAt }];
      }
      return [];
    },
  };
  const route = buildSkillPreferenceRoutes({
    bounds: { maxResponseBytes: 64_000, requestTimeoutMs: 2_000, maxConcurrentRequests: 4 },
    reader, store, isPublicPolicy: () => true,
  })[0];
  const current = reader.readAsCaller ? (await reader.readAsCaller({ subject: "user-a" }, "skill_preferences"))[0] : undefined;
  const expected = current?.revision ?? 0;
  const body = Buffer.from(JSON.stringify({ workspace_id: WS_A, expected_revision: expected, favorite_skill_ids: ["design/ux"], default_skill_ids: [] }));
  const result = await route.handle({
    method: "PUT", pathname: "/api/skill-preferences", query: new URLSearchParams(), params: {},
    request: { headers: { authorization: "Bearer test", "content-type": "application/json", "content-length": String(body.length) }, async *[Symbol.asyncIterator]() { yield body; } },
  });
  assert.equal(result.favorite_skill_ids.includes("design/ux"), true);
  assert.equal(calls, 1);
  assert.equal(Number(psql(DB_URL, `select count(*) from public.skill_preferences where workspace_id='${WS_A}' and subject='user-a'`).trim()), 1);
});

test("platform RLS provisioning helpers are not callable by clients", () => {
  const result = scalar(
    "user-a",
    "select case when to_regprocedure('public.rls_auto_enable()') is null then 'absent' "
      + "else has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE')::text end",
  );
  assert.ok(result === "absent" || result === "false", `rls_auto_enable must not be executable, got ${result}`);
});
