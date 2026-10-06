import { createContext, useContext, useMemo, type ReactNode } from "react";

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
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export interface WorkspaceProviderProps {
  readonly children: ReactNode;
  /**
   * The viewer's own `workspace_memberships` row, resolved by the host. `null`
   * until Builder 5 wires the real query; the console then stays in the
   * `not_loaded` state and renders no permission-gated destination.
   */
  readonly membership?: WorkspaceMembershipRef | null;
  /** Workspace the host selected. `null` while the selection is unknown. */
  readonly workspaceId?: string | null;
  /** True while the host is resolving the membership row. */
  readonly loading?: boolean;
}

/**
 * Holds the current workspace selection and the viewer's own role.
 *
 * The role is never inferred, defaulted, or carried over between workspaces. It
 * only ever comes from a membership row the host read under the
 * `membership_self_or_admin_read` RLS policy. Until that row exists the state
 * is `not_loaded`, and every permission-gated view is withheld.
 */
export function WorkspaceProvider({
  children,
  membership = null,
  workspaceId = null,
  loading = false,
}: WorkspaceProviderProps): ReactNode {
  const state = useMemo(
    () => deriveWorkspaceRoleState({ workspaceId, membership, loading }),
    [workspaceId, membership, loading],
  );

  const value = useMemo<WorkspaceContextValue>(() => {
    const role = workspaceRole(state);
    return {
      workspaceId,
      state,
      role,
      roleLabel: describeWorkspaceRole(role),
      stateLabel: describeWorkspaceRoleState(state),
      can: (permission: ConsolePermission) => stateHasConsolePermission(state, permission),
    };
  }, [state, workspaceId]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return value;
}