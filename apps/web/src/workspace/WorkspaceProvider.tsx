import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../auth/supabase";
import {
  deriveWorkspaceRoleState,
  describeWorkspaceRole,
  describeWorkspaceRoleState,
  isWorkspaceRole,
  stateHasConsolePermission,
  workspaceRole,
  type ConsolePermission,
  type WorkspaceMembershipRef,
  type WorkspaceRole,
  type WorkspaceRoleState,
} from "../console-model";

export interface WorkspaceContextValue {
  /** Currently selected workspace, or `null` when none has been chosen. */
  readonly workspaceId: string | null;
  readonly state: WorkspaceRoleState;
  /** Effective role, or `null` unless a real active membership was resolved. */
  readonly role: WorkspaceRole | null;
  readonly roleLabel: string;
  readonly stateLabel: string;
  /** Fail-closed permission check against the resolved state. */
  readonly can: (permission: ConsolePermission) => boolean;
  /** All resolved memberships for the current user. */
  readonly memberships: readonly WorkspaceMembershipRef[];
  /** Switch to a different workspace. */
  readonly selectWorkspace: (workspaceId: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export interface WorkspaceProviderProps {
  readonly children: ReactNode;
  /**
   * Statically injected membership row, for tests and preview harnesses that do
   * not spin up Supabase. When supplied, overrides dynamic resolution.
   */
  readonly membership?: WorkspaceMembershipRef | null;
  /** Workspace the host selected statically. If omitted, resolved dynamically. */
  readonly workspaceId?: string | null;
  /** True while the host is resolving the membership row statically. */
  readonly loading?: boolean;
}

/**
 * Holds the current workspace selection and the viewer's own role.
 *
 * The role is never inferred, defaulted, or carried over between workspaces. It
 * only ever comes from a membership row read under the
 * `membership_self_or_admin_read` RLS policy for the exact authenticated user.
 * Until that row exists the state is `not_loaded`, and every permission-gated view
 * is withheld.
 */
export function WorkspaceProvider({
  children,
  membership: propMembership,
  workspaceId: propWorkspaceId,
  loading: propLoading,
}: WorkspaceProviderProps): ReactNode {
  const { status, userId, getAccessToken } = useAuth();
  const [resolvedMemberships, setResolvedMemberships] = useState<readonly WorkspaceMembershipRef[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  // When statically provided through props, bypass dynamic resolution.
  const isStatic = propMembership !== undefined || propWorkspaceId !== undefined || propLoading !== undefined;

  useEffect(() => {
    if (isStatic) return;

    // Clear old memberships immediately and synchronously on user or auth change
    setResolvedMemberships([]);
    setSelectedWorkspaceId(null);

    if (status !== "signed_in" || userId === null) {
      setIsResolving(false);
      return;
    }

    let cancelled = false;
    setIsResolving(true);

    void (async () => {
      try {
        const seenWorkspaces = new Set<string>();
        const loaded: WorkspaceMembershipRef[] = [];

        if (supabase) {
          // Filter bootstrap query strictly by .eq("subject", userId) so owner/admin
          // callers never derive roles from another member's row.
          const { data, error } = await supabase
            .from("workspace_memberships")
            .select("workspace_id, role, active, subject")
            .eq("subject", userId)
            .order("created_at", { ascending: true });

          if (!error && Array.isArray(data)) {
            for (const item of data) {
              if (item === null || typeof item !== "object") continue;
              const row = item as Record<string, unknown>;
              // Strict verification against caller subject, non-empty workspace_id, valid role, and boolean active
              if (row["subject"] !== userId) continue;
              const wsId = typeof row["workspace_id"] === "string" ? row["workspace_id"].trim() : "";
              if (!wsId) continue;
              const role = row["role"];
              if (!isWorkspaceRole(role)) continue;
              if (typeof row["active"] !== "boolean") continue;

              // Deduplicate by workspace_id
              if (seenWorkspaces.has(wsId)) continue;
              seenWorkspaces.add(wsId);

              loaded.push(
                Object.freeze({
                  workspaceId: wsId,
                  role,
                  active: row["active"],
                }),
              );
            }
          }
        }

        // If Supabase client wasn't configured or returned no rows, fall back to BFF probe
        if (loaded.length === 0) {
          const token = await getAccessToken();
          if (token) {
            const res = await fetch("/api/workspace/members", {
              headers: {
                authorization: `Bearer ${token}`,
                accept: "application/json",
              },
            });
            if (res.ok) {
              const membersRaw: unknown = await res.json();
              if (Array.isArray(membersRaw)) {
                // Strictly find the caller's row only. Never fallback to members[0].
                const myRow = membersRaw.find(
                  (m): m is { subject: string; role: WorkspaceRole; active: boolean } =>
                    m !== null &&
                    typeof m === "object" &&
                    (m as Record<string, unknown>)["subject"] === userId &&
                    isWorkspaceRole((m as Record<string, unknown>)["role"]) &&
                    typeof (m as Record<string, unknown>)["active"] === "boolean",
                );
                if (myRow) {
                  // If there's an active membership row, fetch workspace overview to get the id
                  const wsRes = await fetch("/api/workspace", {
                    headers: {
                      authorization: `Bearer ${token}`,
                      accept: "application/json",
                    },
                  });
                  if (wsRes.ok) {
                    const wsData: unknown = await wsRes.json();
                    if (
                      wsData !== null &&
                      typeof wsData === "object" &&
                      typeof (wsData as Record<string, unknown>)["workspace_id"] === "string"
                    ) {
                      const wsId = ((wsData as Record<string, unknown>)["workspace_id"] as string).trim();
                      if (wsId && !seenWorkspaces.has(wsId)) {
                        seenWorkspaces.add(wsId);
                        loaded.push(
                          Object.freeze({
                            workspaceId: wsId,
                            role: myRow.role,
                            active: myRow.active,
                          }),
                        );
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Discard late responses from superseded auth states or previous users
        if (cancelled) return;

        setResolvedMemberships(Object.freeze(loaded));

        const active = loaded.filter((m) => m.active);
        setSelectedWorkspaceId((current) => {
          if (current !== null && active.some((m) => m.workspaceId === current)) {
            return current;
          }
          const first = active[0];
          if (first !== undefined) {
            return first.workspaceId;
          }
          return null;
        });
      } catch {
        if (!cancelled) {
          setResolvedMemberships([]);
          setSelectedWorkspaceId(null);
        }
      } finally {
        if (!cancelled) {
          setIsResolving(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isStatic, status, userId, getAccessToken]);

  const selectWorkspace = useCallback((id: string) => {
    setSelectedWorkspaceId(id);
  }, []);

  const effectiveWorkspaceId = isStatic ? (propWorkspaceId ?? null) : selectedWorkspaceId;

  const effectiveMembership = useMemo(() => {
    if (isStatic) return propMembership ?? null;
    if (effectiveWorkspaceId === null) return null;
    return resolvedMemberships.find((m) => m.workspaceId === effectiveWorkspaceId) ?? null;
  }, [isStatic, propMembership, effectiveWorkspaceId, resolvedMemberships]);

  const effectiveLoading = isStatic ? Boolean(propLoading) : status === "loading" || isResolving;

  const state = useMemo(
    () =>
      deriveWorkspaceRoleState({
        workspaceId: effectiveWorkspaceId,
        membership: effectiveMembership,
        loading: effectiveLoading,
      }),
    [effectiveWorkspaceId, effectiveMembership, effectiveLoading],
  );

  const value = useMemo<WorkspaceContextValue>(() => {
    const role = workspaceRole(state);
    return {
      workspaceId: effectiveWorkspaceId,
      state,
      role,
      roleLabel: describeWorkspaceRole(role),
      stateLabel: describeWorkspaceRoleState(state),
      can: (permission: ConsolePermission) => stateHasConsolePermission(state, permission),
      memberships: resolvedMemberships,
      selectWorkspace,
    };
  }, [state, effectiveWorkspaceId, resolvedMemberships, selectWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return value;
}
