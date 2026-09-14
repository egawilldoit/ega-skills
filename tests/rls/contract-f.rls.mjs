// Contract F — real PostgreSQL RLS verification.
//
// This suite runs only against a disposable PostgreSQL database whose URL is
// provided via EGA_RLS_DATABASE_URL. It creates a uniquely named database,
// applies supabase/migrations in order, seeds the Contract F matrix, and then
// exercises effective grants and RLS as `authenticated` subjects. It drops the
// database afterwards and never touches a remote or production instance.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const migrations = readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    psql(DB_URL, readFileSync(join(ROOT, "supabase", "migrations", file), "utf8"));
  }
  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "seed.sql"), "utf8"));
});

after(() => {
  psql(ADMIN_URL, `drop database if exists "${DB_NAME}" with (force)`);
});

test("RLS is enabled on every Contract F table", () => {
  const tables = [
    "personal_workspaces", "hubs", "hub_releases", "hub_stable_pointers", "security_denies", "audit_events",
    "workspace_memberships", "projects", "project_contexts", "context_revocations", "quota_policies",
    "immutable_objects", "hub_release_artifacts", "source_credentials", "quota_usage", "public_hub_publications",
  ];
  const enabled = psql(DB_URL, `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity order by relname`)
    .split("\n").map((line) => line.trim()).filter(Boolean);
  for (const table of tables) {
    assert.ok(enabled.includes(table), `RLS must be enabled on public.${table}`);
  }
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
