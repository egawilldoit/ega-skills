/**
 * Mandatory clean-cluster proof for 202609210001_private_skill_preferences.sql.
 *
 * Runs BEFORE any fixture/setup that may create ega_skill_preferences_writer in
 * the same CI PostgreSQL 16 service container. Asserts the cluster-wide role is
 * absent, applies the RAW UNMODIFIED migration after prerequisites, and verifies
 * true production DDL success. No conditional fallback, no skipped green claim.
 *
 * This test creates the cluster-wide role as the production migration intends.
 * Subsequent suites in the same disposable container must use safe fixture
 * isolation (applyMigrations) when the role already exists. It drops only its
 * disposable database and never modifies/drops shared cluster roles.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = process.env.EGA_RLS_DATABASE_URL;
if (!BASE_URL) throw new Error("EGA_RLS_DATABASE_URL is required for clean-cluster migration proof");

function withDatabase(url, name) { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); }
function psql(url, sql) {
  const r = execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "|", url], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return r ?? "";
}

const ADMIN_URL = withDatabase(BASE_URL, "postgres");
const DB_NAME = `ega_prefs_clean_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const DB_URL = withDatabase(BASE_URL, DB_NAME);
const MIGRATION = "202609210001_private_skill_preferences.sql";

after(() => { try { psql(ADMIN_URL, `drop database if exists "${DB_NAME}" with (force)`); } catch {} });

test("unmodified private skill preferences migration succeeds on a clean isolated PostgreSQL cluster", () => {
  const roleExists = psql(ADMIN_URL, `select count(*) from pg_roles where rolname='ega_skill_preferences_writer'`).trim();
  assert.equal(roleExists, "0", "clean cluster required before fixture setup: ega_skill_preferences_writer must not already exist");

  psql(ADMIN_URL, `create database "${DB_NAME}"`);
  psql(DB_URL, readFileSync(join(ROOT, "tests", "rls", "bootstrap.sql"), "utf8"));
  for (const f of readdirSync(join(ROOT, "supabase", "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    if (f === MIGRATION) break;
    psql(DB_URL, readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }

  // Raw unmodified migration file (true production DDL path).
  psql(DB_URL, readFileSync(join(ROOT, "supabase", "migrations", MIGRATION), "utf8"));

  assert.equal(psql(ADMIN_URL, `select count(*) from pg_roles where rolname='ega_skill_preferences_writer'`).trim(), "1", "migration must create cluster-wide writer role");
  assert.match(psql(DB_URL, `select to_regclass('public.skill_preferences') is not null`).trim(), /^(t|true)$/);
  assert.match(psql(DB_URL, `select relrowsecurity::text from pg_class where oid='public.skill_preferences'::regclass`).trim(), /^(t|true)$/, "RLS must be enabled");
  assert.match(psql(DB_URL, `select relforcerowsecurity::text from pg_class where oid='public.skill_preferences'::regclass`).trim(), /^(t|true)$/, "RLS must be forced");
  assert.match(psql(DB_URL, `select pg_get_functiondef('private.write_skill_preferences(uuid,text,text[],text[],bigint)'::regprocedure)`), /for update of m/i, "authorization must serialize with FOR UPDATE");
  assert.match(psql(DB_URL, `select pg_get_functiondef('private.write_skill_preferences(uuid,text,text[],text[],bigint)'::regprocedure)`), /security definer/i);
  assert.match(psql(DB_URL, `select has_function_privilege('authenticated', 'private.write_skill_preferences(uuid,text,text[],text[],bigint)', 'EXECUTE')::text`).trim(), /^(f|false)$/);
});
