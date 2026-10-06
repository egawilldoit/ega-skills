/**
 * Tests for the console authorization and navigation model.
 *
 * These run under the repo's real runner (`node --test`, root `pnpm test`),
 * unlike the `*.spec.ts` files in `packages/oauth-ui` which Node never picks up.
 * Node 24 strips the TypeScript types natively, so the module is imported
 * directly with no build step.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSOLE_PERMISSIONS,
  NAV_SECTIONS,
  WORKSPACE_ROLES,
  deriveWorkspaceRoleState,
  describeWorkspaceRole,
  describeWorkspaceRoleState,
  hasConsolePermission,
  isWorkspaceRole,
  navItemForPath,
  navSectionForPath,
  stateHasConsolePermission,
  visibleNavPaths,
  visibleNavSections,
  workspaceRole,
} from "../../apps/web/src/console-model.ts";

test("the role vocabulary matches the workspace_memberships check constraint", () => {
  // supabase/migrations/202609090002_multi_user_authorization.sql pins the
  // allowed role set. The console must not add or drop a role.
  assert.deepEqual([...WORKSPACE_ROLES], ["owner", "admin", "maintainer", "member", "viewer"]);
});

test("owner and admin hold every console read permission", () => {
  for (const role of ["owner", "admin"]) {
    for (const permission of CONSOLE_PERMISSIONS) {
      assert.equal(
        hasConsolePermission(role, permission),
        true,
        `${role} must retain ${permission}`,
      );
    }
  }
});

test("only owner and admin hold the admin-only read surfaces", () => {
  // audit_admin_read, security_deny_admin_read, quota_policy_admin_read, and
  // quota_usage_admin_read all name array['owner','admin'] explicitly.
  const adminOnly = ["members_read", "quotas_read", "security_read", "audit_read"];
  for (const role of ["maintainer", "member", "viewer"]) {
    for (const permission of adminOnly) {
      assert.equal(
        hasConsolePermission(role, permission),
        false,
        `${role} must not hold ${permission}`,
      );
    }
  }
});

test("every non-admin role can read the catalog, projects, and contexts", () => {
  for (const role of ["maintainer", "member", "viewer"]) {
    for (const permission of ["catalog_read", "projects_read", "contexts_read"]) {
      assert.equal(hasConsolePermission(role, permission), true, `${role} must hold ${permission}`);
    }
  }
});

test("a null role grants nothing, so navigation stays empty until the role resolves", () => {
  for (const permission of CONSOLE_PERMISSIONS) {
    assert.equal(hasConsolePermission(null, permission), false);
  }
  assert.deepEqual(visibleNavSections(null), []);
  assert.deepEqual(visibleNavPaths(null), []);
});

test("viewer navigation excludes every admin-only destination", () => {
  const paths = visibleNavPaths("viewer");
  assert.ok(paths.includes("/"), "viewer keeps the catalog overview");
  assert.ok(paths.includes("/skills"), "viewer keeps skills");
  assert.ok(!paths.includes("/audit"), "audit must be withheld from viewer");
  assert.ok(!paths.includes("/workspace/security"), "security must be withheld from viewer");
  assert.ok(!paths.includes("/workspace/members"), "members must be withheld from viewer");
  assert.ok(!paths.includes("/workspace/quotas"), "quotas must be withheld from viewer");
  assert.ok(!paths.includes("/analytics"), "usage is quota-gated and withheld from viewer");
});

test("owner navigation includes every declared nav item", () => {
  const declared = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.path));
  assert.deepEqual([...visibleNavPaths("owner")], declared);
});

test("a section with no visible items is dropped entirely", () => {
  // Every declared role holds catalog_read, and /settings is catalog-gated, so
  // no real role empties "Observability". The rule is still enforced for the
  // null-role case and for any future admin-only-only section, so assert it
  // against the declared tree directly rather than relying on a role existing.
  for (const role of WORKSPACE_ROLES) {
    const sections = visibleNavSections(role);
    for (const section of sections) {
      assert.ok(section.items.length > 0, `${role}: ${section.id} must not render empty`);
    }
  }

  // A viewer loses Members/Quotas/Security but keeps Workspace Overview.
  const viewerWorkspace = visibleNavSections("viewer").find((s) => s.id === "workspace");
  assert.deepEqual(
    viewerWorkspace.items.map((item) => item.path),
    ["/workspace"],
  );

  // Every section in the filtered tree must be one that was declared.
  for (const role of WORKSPACE_ROLES) {
    const declared = new Set(NAV_SECTIONS.map((section) => section.id));
    for (const section of visibleNavSections(role)) {
      assert.ok(declared.has(section.id), `${section.id} must be declared`);
    }
  }
});

test("/releases/compare is declared before /releases/:releaseDigest is used as a path", () => {
  // navItemForPath matches exact paths, so the literal compare path must exist
  // as its own item rather than being represented by a digest pattern.
  assert.equal(navItemForPath("/releases/compare")?.label, "Compare releases");
  const releaseIndex = NAV_SECTIONS[0].items.findIndex((item) => item.path === "/releases");
  const compareIndex = NAV_SECTIONS[0].items.findIndex((item) => item.path === "/releases/compare");
  assert.ok(compareIndex > releaseIndex, "compare follows the releases index entry");
});

test("navSectionForPath picks the longest matching prefix", () => {
  assert.equal(navSectionForPath("/workspace/quotas")?.id, "workspace");
  assert.equal(navSectionForPath("/releases/compare")?.id, "catalog");
  assert.equal(navSectionForPath("/projects/abc")?.id, "projects");
});

test("isWorkspaceRole narrows only the five real roles", () => {
  for (const role of WORKSPACE_ROLES) assert.equal(isWorkspaceRole(role), true);
  for (const value of ["superuser", "", "Owner", null, undefined, 7, {}]) {
    assert.equal(isWorkspaceRole(value), false, `${String(value)} is not a role`);
  }
});

test("deriveWorkspaceRoleState reports not_loaded when no membership is supplied", () => {
  const state = deriveWorkspaceRoleState({ workspaceId: "ws-1", membership: null, loading: false });
  assert.equal(state.kind, "not_loaded");
  assert.equal(workspaceRole(state), null, "no role may be invented");
  assert.equal(stateHasConsolePermission(state, "catalog_read"), false);
});

test("deriveWorkspaceRoleState reports loading without granting permissions", () => {
  const state = deriveWorkspaceRoleState({ workspaceId: "ws-1", membership: null, loading: true });
  assert.equal(state.kind, "loading");
  assert.equal(workspaceRole(state), null);
  assert.equal(stateHasConsolePermission(state, "catalog_read"), false);
});

test("deriveWorkspaceRoleState loads an active membership", () => {
  const state = deriveWorkspaceRoleState({
    workspaceId: "ws-1",
    membership: { workspaceId: "ws-1", role: "admin", active: true },
    loading: false,
  });
  assert.deepEqual(state, { kind: "loaded", workspaceId: "ws-1", role: "admin" });
  assert.equal(workspaceRole(state), "admin");
  assert.equal(stateHasConsolePermission(state, "audit_read"), true);
});

test("deriveWorkspaceRoleState treats an inactive membership as granting nothing", () => {
  const state = deriveWorkspaceRoleState({
    workspaceId: "ws-1",
    membership: { workspaceId: "ws-1", role: "owner", active: false },
    loading: false,
  });
  // private.is_active_member requires active, so an inactive row must not
  // authorize even an owner.
  assert.equal(state.kind, "inactive");
  assert.equal(workspaceRole(state), null);
  assert.equal(stateHasConsolePermission(state, "catalog_read"), false);
});

test("deriveWorkspaceRoleState rejects a membership from a different workspace", () => {
  const state = deriveWorkspaceRoleState({
    workspaceId: "ws-2",
    membership: { workspaceId: "ws-1", role: "admin", active: true },
    loading: false,
  });
  assert.equal(state.kind, "mismatched");
  assert.equal(workspaceRole(state), null);
  assert.equal(stateHasConsolePermission(state, "catalog_read"), false);
});

test("deriveWorkspaceRoleState withholds a membership while no workspace is selected", () => {
  const state = deriveWorkspaceRoleState({
    workspaceId: null,
    membership: { workspaceId: "ws-1", role: "viewer", active: true },
    loading: false,
  });
  assert.equal(state.kind, "not_loaded");
  assert.equal(workspaceRole(state), null);
});

test("every role state has a distinct human explanation", () => {
  const states = [
    deriveWorkspaceRoleState({ workspaceId: null, membership: null, loading: false }),
    deriveWorkspaceRoleState({ workspaceId: "ws-1", membership: null, loading: true }),
    deriveWorkspaceRoleState({
      workspaceId: "ws-1",
      membership: { workspaceId: "ws-1", role: "member", active: true },
      loading: false,
    }),
    deriveWorkspaceRoleState({
      workspaceId: "ws-1",
      membership: { workspaceId: "ws-1", role: "member", active: false },
      loading: false,
    }),
    deriveWorkspaceRoleState({
      workspaceId: "ws-2",
      membership: { workspaceId: "ws-1", role: "member", active: true },
      loading: false,
    }),
  ];
  const labels = states.map(describeWorkspaceRoleState);
  assert.equal(new Set(labels).size, states.length, "each state must read differently");
  for (const label of labels) assert.notEqual(label, "");
});

test("describeWorkspaceRole names the resolved role and admits when there is none", () => {
  assert.equal(describeWorkspaceRole("owner"), "Owner");
  assert.equal(describeWorkspaceRole("admin"), "Administrator");
  assert.equal(describeWorkspaceRole(null), "Role not loaded");
});