/**
 * EGA Skills Web Console — console authorization and navigation model.
 *
 * This module is deliberately dependency-free and side-effect-free so the repo
 * runner can exercise it directly with `node --test tests/web/console-model.test.mjs`
 * (Node 24 strips these types natively). Do not add imports here without
 * re-checking that the test still resolves.
 *
 * Authorization vocabulary
 * ------------------------
 * `CONSOLE_PERMISSIONS` mirrors the *read* surfaces that the hosted control
 * plane actually grants. Each entry names the tables it stands for and the RLS
 * policy that enforces it, so the client-side nav filter can never claim a
 * wider read than the database allows:
 *
 * | permission        | tables                                              | enforcing policy                                  |
 * | ----------------- | --------------------------------------------------- | ------------------------------------------------- |
 * | `catalog_read`    | hubs, hub_releases, hub_stable_pointers             | `private.can_read_hub` (202609090004)               |
 * |                   | public_hub_publications, hub_release_artifacts      | `can_read_artifact` / `can_read_hub` (202609090004) |
 * | `projects_read`   | projects                                            | `project_member_read` (202609090004)                |
 * |                   | personal_workspaces                                 | active-membership predicate (202609090004)         |
 * | `contexts_read`   | project_contexts, context_revocations               | `context_member_read` (202609090004)                |
 * | `members_read`    | workspace_memberships (rows other than your own)     | `membership_self_or_admin_read` (202609090004)      |
 * | `quotas_read`     | quota_policies, quota_usage                         | `quota_policy_admin_read` / `quota_usage_admin_read`|
 * | `security_read`   | security_denies                                     | `security_deny_admin_read` (202609090004)           |
 * | `audit_read`      | audit_events                                        | `audit_admin_read` (202609090004)                   |
 *
 * The role ladder is copied from `packages/control-plane/src/index.ts`
 * (`WORKSPACE_ROLES` and `ROLE_PERMISSIONS`) so the console cannot drift from
 * the server-side policy evaluator. Because the console is strictly read-only,
 * `publish_release`, `manage_source`, `publish_context`, `revoke_context`, and
 * `change_visibility` are intentionally absent: there is no UI that performs
 * them, so no client-side gate is needed for them.
 *
 * Client-side gating is presentation only. It never authorizes anything: the
 * BFF and the RLS policies remain the only authority, and every failure path
 * here fails closed (an unknown role or `null` role sees nothing).
 */

/** Roles exactly as stored in `public.workspace_memberships.role`. */
export const WORKSPACE_ROLES = ["owner", "admin", "maintainer", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Every read surface the console can display. */
export const CONSOLE_PERMISSIONS = [
  "catalog_read",
  "projects_read",
  "contexts_read",
  "members_read",
  "quotas_read",
  "security_read",
  "audit_read",
] as const;
export type ConsolePermission = (typeof CONSOLE_PERMISSIONS)[number];

/**
 * Role to read-permission map.
 *
 * `catalog_read`, `projects_read`, and `contexts_read` reach every active
 * member because their policies call `private.can_read_hub`,
 * `private.is_active_member`, and `private.can_read_context` respectively, which
 * all accept any active membership regardless of role. The remaining four are
 * restricted to owner/admin by explicit role arrays in the policies above.
 *
 * Note that `can_read_hub` additionally permits any authenticated subject to
 * read a `public` hub. That grant is per-object and lives in the policy; this
 * table only expresses the workspace-membership floor.
 */
const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, ReadonlySet<ConsolePermission>>> = {
  owner: new Set<ConsolePermission>(CONSOLE_PERMISSIONS),
  admin: new Set<ConsolePermission>(CONSOLE_PERMISSIONS),
  maintainer: new Set<ConsolePermission>(["catalog_read", "projects_read", "contexts_read"]),
  member: new Set<ConsolePermission>(["catalog_read", "projects_read", "contexts_read"]),
  viewer: new Set<ConsolePermission>(["catalog_read", "projects_read", "contexts_read"]),
};

/** Narrowing guard for values coming back from the database. */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/**
 * Fail-closed permission check.
 *
 * A `null` role means the membership has not been loaded yet (or failed to
 * load). It grants nothing: until the real role is known the console hides
 * every permission-gated destination rather than guessing.
 */
export function hasConsolePermission(role: WorkspaceRole | null, permission: ConsolePermission): boolean {
  if (role === null) return false;
  return ROLE_PERMISSIONS[role].has(permission);
}

export interface NavItem {
  /** Absolute in-app path. Used as the React Router `to` value. */
  readonly path: string;
  /** Visible label. Must be a plain noun; no action verbs (read-only console). */
  readonly label: string;
  /** Permission required before the item is rendered. */
  readonly permission: ConsolePermission;
  /** Short purpose line used as the item's accessible description. */
  readonly description: string;
}

export interface NavSection {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NavItem[];
}

/**
 * The full navigation tree, including destinations a given role may not see.
 * Filtering happens in `visibleNavSections` so that adding a route is a single
 * edit and the gate can never be forgotten.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "catalog",
    label: "Catalog",
    items: [
      {
        path: "/",
        label: "Overview",
        permission: "catalog_read",
        description: "Release identity and catalog totals for the selected workspace",
      },
      {
        path: "/skills",
        label: "Skills",
        permission: "catalog_read",
        description: "Skills published in the currently readable Hub release",
      },
      {
        path: "/releases",
        label: "Releases",
        permission: "catalog_read",
        description: "Published releases and their stable pointer",
      },
      {
        path: "/releases/compare",
        label: "Compare releases",
        permission: "catalog_read",
        description: "Diff two release digests inside this deployment",
      },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    items: [
      {
        path: "/projects",
        label: "Projects",
        permission: "projects_read",
        description: "Projects in the selected workspace",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        path: "/workspace",
        label: "Overview",
        permission: "contexts_read",
        description: "Workspace identity and the viewer's own membership role",
      },
      {
        path: "/workspace/members",
        label: "Members",
        permission: "members_read",
        description: "Membership rows visible to owner and admin",
      },
      {
        path: "/workspace/quotas",
        label: "Quotas",
        permission: "quotas_read",
        description: "Quota policy and observed usage windows",
      },
      {
        path: "/workspace/security",
        label: "Security",
        permission: "security_read",
        description: "Recorded deny rows for this workspace",
      },
    ],
  },
  {
    id: "observability",
    label: "Observability",
    items: [
      {
        path: "/analytics",
        label: "Usage",
        permission: "quotas_read",
        description: "Request and bandwidth usage against the quota policy",
      },
      {
        path: "/audit",
        label: "Audit",
        permission: "audit_read",
        description: "Control-plane audit events",
      },
      {
        path: "/settings",
        label: "Settings",
        permission: "catalog_read",
        description: "Read-only deployment and session diagnostics",
      },
    ],
  },
];

/**
 * Filter the navigation tree down to what the given role may reach.
 *
 * Sections whose items are all filtered out are dropped entirely, so a viewer
 * never sees an empty "Workspace" or "Observability" heading. `null` role
 * yields an empty list.
 */
export function visibleNavSections(role: WorkspaceRole | null): readonly NavSection[] {
  if (role === null) return [];
  const sections: NavSection[] = [];
  for (const section of NAV_SECTIONS) {
    const items = section.items.filter((item) => hasConsolePermission(role, item.permission));
    if (items.length > 0) sections.push({ id: section.id, label: section.label, items });
  }
  return sections;
}

/** Visible nav paths for the given role, in declaration order. */
export function visibleNavPaths(role: WorkspaceRole | null): readonly string[] {
  return visibleNavSections(role).flatMap((section) => section.items.map((item) => item.path));
}

/**
 * Nav item for an exact path, if any. Detail routes (`/skills/:skillId`) are not
 * nav items and therefore intentionally return `undefined`.
 */
export function navItemForPath(path: string): NavItem | undefined {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (item.path === path) return item;
    }
  }
  return undefined;
}

/**
 * Pick the nav section that owns a path prefix, so page headings can name their
 * section. Uses longest-prefix matching so `/workspace/quotas` beats
 * `/workspace`.
 */
export function navSectionForPath(path: string): NavSection | undefined {
  let best: NavSection | undefined;
  let bestLength = -1;
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      const prefix = item.path === "/" ? "/" : item.path;
      const matches = prefix === "/" ? path.startsWith("/") : path.startsWith(prefix);
      if (matches && prefix.length > bestLength) {
        best = section;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** Plain-language role label for the top bar. No invented privilege wording. */
export function describeWorkspaceRole(role: WorkspaceRole | null): string {
  if (role === null) return "Role not loaded";
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Administrator";
    case "maintainer":
      return "Maintainer";
    case "member":
      return "Member";
    case "viewer":
      return "Viewer";
  }
}

/* -------------------------------------------------------------------------- */
/* Workspace role resolution                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The viewer's own row in `public.workspace_memberships`, readable under the
 * `membership_self_or_admin_read` policy even by a non-admin.
 */
export interface WorkspaceMembershipRef {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  /** `workspace_memberships.active`. An inactive row authorizes nothing. */
  readonly active: boolean;
}

/**
 * Resolution state of the viewer's own role.
 *
 * `not_loaded` is the deliberate starting state: the console refuses to render
 * any permission-gated destination until a real membership row has been read
 * from the database. Nothing in this type is a placeholder value.
 */
export type WorkspaceRoleState =
  /** No membership has been resolved yet. Grants nothing. */
  | { readonly kind: "not_loaded"; readonly reason: string }
  /** A membership query is in flight. Grants nothing. */
  | { readonly kind: "loading" }
  /** An active membership row for the selected workspace. */
  | { readonly kind: "loaded"; readonly workspaceId: string; readonly role: WorkspaceRole }
  /** The membership row exists but `active` is false. Grants nothing. */
  | { readonly kind: "inactive"; readonly workspaceId: string; readonly role: WorkspaceRole }
  /** The membership belongs to a different workspace than the selection. */
  | { readonly kind: "mismatched"; readonly workspaceId: string; readonly membershipWorkspaceId: string };

export const WORKSPACE_ROLE_NOT_LOADED_REASON =
  "This console has not resolved your workspace membership yet. Permission-gated views stay hidden until it does.";

/**
 * Pure resolution step for `deriveWorkspaceRoleState`. Kept separate from the
 * React provider so `tests/web/console-model.test.mjs` can cover every branch.
 */
export function deriveWorkspaceRoleState(input: {
  readonly workspaceId: string | null;
  readonly membership: WorkspaceMembershipRef | null;
  readonly loading: boolean;
}): WorkspaceRoleState {
  const { workspaceId, membership, loading } = input;
  if (membership === null) {
    return loading
      ? { kind: "loading" }
      : { kind: "not_loaded", reason: WORKSPACE_ROLE_NOT_LOADED_REASON };
  }
  if (workspaceId === null) {
    return { kind: "not_loaded", reason: WORKSPACE_ROLE_NOT_LOADED_REASON };
  }
  if (membership.workspaceId !== workspaceId) {
    return {
      kind: "mismatched",
      workspaceId,
      membershipWorkspaceId: membership.workspaceId,
    };
  }
  if (!membership.active) {
    return { kind: "inactive", workspaceId, role: membership.role };
  }
  return { kind: "loaded", workspaceId, role: membership.role };
}

/**
 * The effective role, or `null` whenever the console must not assume one.
 * Only `loaded` yields a role; `inactive`, `mismatched`, `loading`, and
 * `not_loaded` all fail closed.
 */
export function workspaceRole(state: WorkspaceRoleState): WorkspaceRole | null {
  return state.kind === "loaded" ? state.role : null;
}

/** Permission check that goes through the resolved state, never a raw role. */
export function stateHasConsolePermission(
  state: WorkspaceRoleState,
  permission: ConsolePermission,
): boolean {
  return hasConsolePermission(workspaceRole(state), permission);
}

/** Operator-facing explanation of the current role-resolution state. */
export function describeWorkspaceRoleState(state: WorkspaceRoleState): string {
  switch (state.kind) {
    case "not_loaded":
      return state.reason;
    case "loading":
      return "Resolving your workspace membership…";
    case "loaded":
      return `Active membership in workspace ${state.workspaceId} as ${describeWorkspaceRole(state.role)}.`;
    case "inactive":
      return `Your membership in workspace ${state.workspaceId} is marked inactive, so no workspace data is shown.`;
    case "mismatched":
      return `Resolved membership belongs to workspace ${state.membershipWorkspaceId}, not the selected ${state.workspaceId}.`;
  }
}