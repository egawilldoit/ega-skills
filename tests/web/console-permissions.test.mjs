/**
 * Nav must reflect ACTUAL authority, not an optimistic guess.
 *
 * The console gates its navigation with `CONSOLE_PERMISSIONS`. If a nav entry is
 * gated on a permission a role holds, but the underlying RLS policy is narrower,
 * that role is shown a link that answers 403 when opened. That is a dead end, and
 * it is exactly the kind of defect a permission-aware UI is supposed to prevent.
 *
 * Each case below pins one real policy from supabase/migrations, so the table and
 * the database cannot drift apart silently.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  CONSOLE_PERMISSIONS,
  NAV_SECTIONS,
  WORKSPACE_ROLES,
  hasConsolePermission,
  navItemForPath,
  visibleNavPaths,
} from "../../apps/web/src/console-model.ts";

/** The permission gating a nav path, or undefined when the path is not in the nav. */
const permissionForPath = (path) => navItemForPath(path)?.permission;

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RLS = readFileSync(
  join(REPO, "supabase", "migrations", "202609090004_contract_f_rls.sql"),
  "utf8",
);

/** Every nav path, so a new entry cannot escape the audit. */
const NAV_PATHS = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.path));

describe("nav permissions match the RLS policies they front", () => {
  test("every nav entry declares a known permission", () => {
    for (const path of NAV_PATHS) {
      const permission = permissionForPath(path);
      assert.ok(permission, `nav entry ${path} declares no permission`);
      assert.ok(
        CONSOLE_PERMISSIONS.includes(permission),
        `nav entry ${path} uses unknown permission ${permission}`,
      );
    }
  });

  test("personal_workspaces is owner-only, so /workspace is owner-only", () => {
    // The real policy, quoted from the migration rather than restated.
    assert.match(
      RLS,
      /create policy personal_workspace_owner_read on public\.personal_workspaces\s+for select using \(owner_subject = auth\.jwt\(\) ->> 'sub'\)/,
      "the personal_workspaces policy no longer matches what this test assumes",
    );
    assert.equal(permissionForPath("/workspace"), "workspace_read");
    assert.equal(hasConsolePermission("owner", "workspace_read"), true);
    // The regression this pins: every one of these roles was previously SHOWN a
    // /workspace link that answered 403.
    for (const role of WORKSPACE_ROLES.filter((r) => r !== "owner")) {
      assert.equal(
        hasConsolePermission(role, "workspace_read"),
        false,
        `${role} must not be granted workspace_read: the policy is owner-only`,
      );
    }
  });

  test("workspace_memberships roster is owner/admin, so /workspace/members is too", () => {
    assert.match(
      RLS,
      /membership_self_or_admin_read/,
      "the membership policy no longer exists under this name",
    );
    assert.equal(permissionForPath("/workspace/members"), "members_read");
    assert.equal(hasConsolePermission("owner", "members_read"), true);
    assert.equal(hasConsolePermission("admin", "members_read"), true);
    // An admin sees the roster but NOT the workspace summary. That asymmetry is
    // real and is the whole reason workspace_read is separate.
    assert.equal(hasConsolePermission("admin", "workspace_read"), false);
  });

  test("the three workspace-wide reads reach every active member", () => {
    // can_read_hub / is_active_member / can_read_context all accept any active
    // membership, so these must not be narrowed to owner/admin.
    for (const permission of ["catalog_read", "projects_read", "contexts_read"]) {
      for (const role of WORKSPACE_ROLES) {
        assert.equal(
          hasConsolePermission(role, permission),
          true,
          `${permission} should reach every role including ${role}`,
        );
      }
    }
  });

  test("owner and admin both hold every owner/admin-scoped permission", () => {
    for (const permission of ["quotas_read", "security_read", "audit_read"]) {
      assert.equal(hasConsolePermission("owner", permission), true, `owner lacks ${permission}`);
      assert.equal(hasConsolePermission("admin", permission), true, `admin lacks ${permission}`);
      assert.equal(
        hasConsolePermission("viewer", permission),
        false,
        `viewer must not hold ${permission}: these policies use an explicit owner/admin role array`,
      );
    }
  });

  test("workspace_read is owner-only, so owner is the only role holding every permission", () => {
    const complete = WORKSPACE_ROLES.filter((role) =>
      CONSOLE_PERMISSIONS.every((permission) => hasConsolePermission(role, permission)),
    );
    assert.deepEqual(
      complete,
      ["owner"],
      "exactly one role may hold the complete permission set, or the asymmetry has widened",
    );
  });
});
