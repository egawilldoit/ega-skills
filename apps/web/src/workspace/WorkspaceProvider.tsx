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
   * The viewer's own `workspace_memberships` row, if supplied statically.
   * If omitted, resolved dynamically from the authenticated session.
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
 * `membership_self_or_admin_read` RLS policy. Until that row exists the state
 * is `not_loaded`, and every permission-gated view is withheld.
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

    if (status !== "signed_in" || userId === null) {
      setResolvedMemberships([]);
      setSelectedWorkspaceId(null);
      setIsResolving(false);
      return;
    }

    let cancelled = false;
    setIsResolving(true);

    void (async () => {
      try {
        let loaded: WorkspaceMembershipRef[] = [];

        if (supabase) {
          const { data, error } = await supabase
            .from("workspace_memberships")
            .select("workspace_id, role, active")
            .order("created_at", { ascending: true });

          if (!error && Array.isArray(data)) {
            loaded = data.map((row) => ({
              workspaceId: row.workspace_id as string,
              role: row.role as WorkspaceRole,
              active: Boolean(row.active),
            }));
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
              const members = (await res.json()) as Array<{
                subject: string;
                role: WorkspaceRole;
                active: boolean;
              }>;
              const myRow = members.find((m) => m.subject === userId) ?? members[0];
              if (myRow) {
                // If there's an active membership row, fetch workspace overview to get the id
                const wsRes = await fetch("/api/workspace", {
                  headers: {
                    authorization: `Bearer ${token}`,
                    accept: "application/json",
                  },
                });
                if (wsRes.ok) {
                  const wsData = (await wsRes.json()) as { workspace_id: string };
                  if (wsData.workspace_id) {
                    loaded = [
                      {
                        workspaceId: wsData.workspace_id,
                        role: myRow.role,
                        active: myRow.active,
                      },
                    ];
                  }
                }
              }
            }
          }
        }

        if (cancelled) return;

        setResolvedMemberships(loaded);

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
