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
export interface StoredProjectContext {
  readonly contextId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly releaseDigest: string;
  readonly ownerSubject: string;
  readonly revoked: boolean;
}
export interface AuditEvent {
  readonly actor: string;
  readonly workspaceId: string;
  readonly operation: string;
  readonly targetId: string;
  readonly result: "allowed" | "denied";
}
export interface SourceCredentialReference {
  readonly sourceId: string;
  readonly secretReference: string;
}

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
  private readonly contexts = new Map<string, StoredProjectContext>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly quotas = new Map<string, { limit: number; used: number }>();
  private readonly sourceCredentials = new Map<string, SourceCredentialReference>();

  addMembership(workspaceId: string, membership: Membership): void { this.memberships.set(`${workspaceId}\0${membership.subject}`, membership); }
  setResource(resourceId: string, resource: AuthorizedResource): void { this.resources.set(resourceId, resource); }
  deny(resourceId: string): void { this.denies.add(resourceId); }
  revokeMembership(workspaceId: string, subject: string): void {
    const current = this.memberships.get(`${workspaceId}\0${subject}`);
    if (current) this.memberships.set(`${workspaceId}\0${subject}`, { ...current, active: false });
  }
  publishContext(context: Omit<StoredProjectContext, "revoked">): void {
    if (this.contexts.has(context.contextId)) throw new Error("context identity already exists");
    this.contexts.set(context.contextId, { ...context, revoked: false });
  }
  revokeContext(contextId: string): void {
    const context = this.contexts.get(contextId);
    if (context) this.contexts.set(contextId, { ...context, revoked: true });
  }
  resolveContext(contextId: string, subject: string): StoredProjectContext | null {
    const context = this.contexts.get(contextId);
    if (!context || context.revoked) return null;
    const membership = this.memberships.get(`${context.workspaceId}\0${subject}`);
    if (!authorizeWorkspace({
      subject,
      membership,
      resource: { workspaceId: context.workspaceId, visibility: "private", ownerSubject: context.ownerSubject },
      permission: "read_project",
    })) return null;
    return context;
  }
  recordAudit(event: AuditEvent): void { this.auditEvents.push(Object.freeze({ ...event })); }
  listAuditEvents(): readonly AuditEvent[] { return [...this.auditEvents]; }
  setQuota(key: string, limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("quota limit must be a non-negative safe integer");
    this.quotas.set(key, { limit, used: 0 });
  }
  consumeQuota(key: string, amount = 1): boolean {
    const quota = this.quotas.get(key);
    if (!quota || !Number.isSafeInteger(amount) || amount < 0 || quota.used + amount > quota.limit) return false;
    quota.used += amount;
    return true;
  }
  registerSourceCredential(reference: SourceCredentialReference): void {
    if (!reference.sourceId || !reference.secretReference || /secret|token|password/i.test(reference.secretReference)) {
      throw new Error("source credentials must be opaque secret references");
    }
    this.sourceCredentials.set(reference.sourceId, Object.freeze({ ...reference }));
  }
  sourceCredential(sourceId: string): SourceCredentialReference | null { return this.sourceCredentials.get(sourceId) ?? null; }
  authorize(resourceId: string, subject: string, permission: ControlPermission): boolean {
    const resource = this.resources.get(resourceId);
    if (!resource) return false;
    const membership = this.memberships.get(`${resource.workspaceId}\0${subject}`);
    return authorizeWorkspace({ subject, membership, resource, permission, denied: this.denies.has(resourceId) });
  }
}
