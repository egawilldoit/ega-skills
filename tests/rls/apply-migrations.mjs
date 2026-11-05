import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROLE_MIGRATION = "202609210001_private_skill_preferences.sql";
const ROLE_NAME = "ega_skill_preferences_writer";

function psqlScalar(psql, dbUrl, sql) {
  return psql(dbUrl, sql).trim().replaceAll(/\s+/g, "");
}

function isSafeExistingWriterRole(psql, dbUrl) {
  // Read-only cluster-wide safety checks. Query fields individually to stay
  // independent of the caller's psql field separator/output formatting.
  try {
    const exists = psqlScalar(psql, dbUrl, `select count(*) from pg_roles where rolname='${ROLE_NAME}'`);
    if (exists !== "1") return false;
    const unsafe = psqlScalar(psql, dbUrl, `select count(*) from pg_roles where rolname='${ROLE_NAME}'
      and (rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication or rolinherit)`);
    if (unsafe !== "0") return false;
    const members = psqlScalar(psql, dbUrl, `select count(*) from pg_auth_members m join pg_roles r on r.oid=m.roleid where r.rolname='${ROLE_NAME}'`);
    const memberOf = psqlScalar(psql, dbUrl, `select count(*) from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname='${ROLE_NAME}'`);
    return members === "0" && memberOf === "0";
  } catch {
    return false;
  }
}

function perDatabaseSkillPreferencesSql(sql) {
  // Strip cluster-wide role creation/alter; keep all per-database objects/grants.
  // Starts at the first non-role DDL after the role block.
  const marker = "create or replace function private.is_canonical_skill_id_array";
  const idx = sql.indexOf(marker);
  if (idx < 0) throw new Error("skill preferences migration marker not found for fixture isolation");
  return sql.slice(idx);
}

export function applyMigrations(psql, dbUrl, root) {
  const migrations = readdirSync(join(root, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    const sql = readFileSync(join(root, "supabase", "migrations", file), "utf8");
    try {
      psql(dbUrl, sql);
    } catch (error) {
      const msg = String(error?.stderr ?? error?.message ?? error);
      if (file === ROLE_MIGRATION && msg.includes("ega_skill_preferences_writer already exists; refusing reuse")) {
        if (!isSafeExistingWriterRole(psql, dbUrl)) throw error;
        // Safe fixture isolation: apply per-database objects/grants only. No shared
        // role attributes/memberships modified, no other databases touched.
        psql(dbUrl, perDatabaseSkillPreferencesSql(sql));
      } else {
        throw error;
      }
    }
  }
}
