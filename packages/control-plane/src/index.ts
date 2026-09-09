export const WORKSPACE_ROLES = ["owner", "admin", "maintainer", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type HubVisibility = "private" | "workspace" | "public";
export type ControlPermission =
  | "read_hub" | "publish_release" | "manage_source" | "read_project"
  | "publish_context" | "revoke_context" | "change_visibility" | "manage_members";

const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<ControlPermission>> = {
  owner: new Set(["read_hub", "publish_release", "manage_source", "read_project", "publish_context", "revoke_context", "change_visibility", "manage_members"]),
  admin: new Set(["read_hub", "publish_release", "manage_source", "read_project", "publish_context", "revoke_context", "change_visibility", "manage_members"]),
  maintainer: new Set(["read_hub", "publish_release", "manage_source", "read_project", "publish_context", "revoke_context"]),
  member: new Set(["read_hub", "read_project", "publish_context"]),
  viewer: new Set(["read_hub", "read_project"]),
};

export interface Membership { readonly subject: string; readonly role: WorkspaceRole; readonly active: boolean; }
export interface AuthorizedResource { readonly workspaceId: string; readonly visibility: HubVisibility; readonly ownerSubject: string; }

export function can(role: WorkspaceRole, permission: ControlPermission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function authorizeWorkspace(input: {
  subject: string;
  membership: Membership | undefined;
  resource: AuthorizedResource;
  permission: ControlPermission;
  denied?: boolean;
}): boolean {
  if (input.denied || !input.membership?.active || input.membership.subject !== input.subject) return false;
  if (input.resource.visibility === "public" && input.permission === "read_hub") return true;
  return can(input.membership.role, input.permission);
}

export class InMemoryControlPlane {
  private readonly memberships = new Map<string, Membership>();
  private readonly denies = new Set<string>();
  private readonly resources = new Map<string, AuthorizedResource>();

  addMembership(workspaceId: string, membership: Membership): void { this.memberships.set(`${workspaceId}\0${membership.subject}`, membership); }
  setResource(resourceId: string, resource: AuthorizedResource): void { this.resources.set(resourceId, resource); }
  deny(resourceId: string): void { this.denies.add(resourceId); }
  revokeMembership(workspaceId: string, subject: string): void {
    const current = this.memberships.get(`${workspaceId}\0${subject}`);
    if (current) this.memberships.set(`${workspaceId}\0${subject}`, { ...current, active: false });
  }
  authorize(resourceId: string, subject: string, permission: ControlPermission): boolean {
    const resource = this.resources.get(resourceId);
    if (!resource) return false;
    const membership = this.memberships.get(`${resource.workspaceId}\0${subject}`);
    return authorizeWorkspace({ subject, membership, resource, permission, denied: this.denies.has(resourceId) });
  }
}
