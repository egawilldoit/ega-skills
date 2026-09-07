import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260907120000_restrict_public_rls_auto_enable.sql",
  ),
  "utf8",
);

test("hosted Supabase migration revokes public execution without assuming the helper exists", () => {
  assert.match(migration, /to_regprocedure\('public\.rls_auto_enable\(\)'\)/);
  assert.match(migration, /revoke execute on function public\.rls_auto_enable\(\) from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /grant execute/i);
});
