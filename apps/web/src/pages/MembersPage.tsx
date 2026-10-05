import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { MemberRow } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection } from "../components/StatePanel";
import { useWorkspace } from "../workspace/WorkspaceProvider";

const COLUMNS: readonly Column<MemberRow>[] = [
  { key: "subject", label: "Subject", mono: true, render: (row) => row.subject },
  { key: "role", label: "Role", mono: true, render: (row) => row.role },
  {
    key: "active",
    label: "Active",
    render: (row) => (row.active ? "Yes" : "No"),
  },
  {
    key: "created_at",
    label: "Member since",
    render: (row) => <time dateTime={row.created_at}>{row.created_at}</time>,
  },
];

/** Roles that `membership_self_or_admin_read` admits *all* rows for. */
const FULL_ROSTER_ROLES: readonly string[] = Object.freeze(["owner", "admin"]);

/**
 * `/workspace/members` — membership rows, as RLS returned them.
 *
 * ## The one row is a correct answer, not a broken table
 *
 * `membership_self_or_admin_read`
 * (`supabase/migrations/202609090004_contract_f_rls.sql:243`) admits a
 * `workspace_memberships` row when `subject = auth.jwt() ->> 'sub'` **or**
 * `private.has_workspace_role(workspace_id, array['owner','admin'])`, and
 * `has_workspace_role` also requires `active`. An ordinary `maintainer`,
 * `member`, or `viewer` therefore reads **exactly one row: their own** — and so
 * does an admin whose membership is inactive, because the self branch carries no
 * `active` condition.
 *
 * That is the policy working, not a truncated list. So the page renders the
 * returned rows and states *why* that is the complete visible set. It never
 * widens the result client-side: the response is shown as received.
 *
 * ## What this page deliberately does not do
 *
 * - No filter, sort, or search control. Every control here would have to run
 *   client-side over rows the session may not see, which would read as a wider
 *   view than the policy grants.
 * - No add/remove/change-role control. There is no `INSERT`/`UPDATE`/`DELETE`
 *   grant to `authenticated` on this table, so a membership change is impossible
 *   by privilege; rendering a button would be a lie about what the console can do.
 * - No zero-member metric anywhere. An empty result is a statement about policy,
 *   and it is reported as one.
 */
export function MembersPage(): ReactNode {
  const client = useApiClient();
  const { role } = useWorkspace();

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<readonly MemberRow[]>(API_ENDPOINTS.members, { signal, timeoutMs: 15_000 }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  return (
    <>
      <p className="page__lede">
        Read-only. Membership changes are control-plane transactions and are not performed
        from this console.
      </p>
      <ResourceSection
        state={resource.state}
        reload={resource.reload}
        loadingLabel="Loading members…"
        empty={(data) =>
          data.length === 0 ? (
            <EmptyState
              title="No membership rows are readable for this workspace"
              reason="Row-level security returned no rows, which is a statement about your session's authority rather than about the workspace. Either your subject holds no membership row in this workspace, or the workspace_memberships rows that exist for it are not ones this policy admits for you."
            />
          ) : null
        }
      >
        {(data) => {
          const fullRoster = role !== null && FULL_ROSTER_ROLES.includes(role);
          return (
            <>
              <p className="page__lede">
                The rows below are exactly what the{" "}
                <span className="mono">membership_self_or_admin_read</span> policy admitted for your
                session, in the order the API returned them after its role ordering. Nothing here is
                filtered, searched, or widened in the browser.
              </p>
              <DataTable
                caption="Workspace members"
                columns={COLUMNS}
                rows={data}
                rowKey={(row) => row.subject}
              />
              {fullRoster ? (
                <p className="state state--muted" role="status">
                  {data.length} membership row{data.length === 1 ? "" : "s"} readable. As{" "}
                  {role}, this policy admits every row in the workspace, so these are all the rows
                  it admits — within the page limit the API applied, which is not a claim that the
                  workspace has no further members.
                </p>
              ) : (
                <p className="state state--muted" role="status">
                  {data.length === 1
                    ? "One membership row is readable: your own. "
                    : `${data.length} membership rows are readable. `}
                  Your resolved role does not let{" "}
                  <span className="mono">membership_self_or_admin_read</span> admit other members'
                  rows, so{" "}
                  {data.length === 1
                    ? "the single row above is your own membership row"
                    : "the rows above are the only ones this policy admits"}{" "}
                  — a scoped view, not a truncated roster. An owner or an active admin sees every
                  member; an <span className="mono">inactive</span> admin does not, because the
                  policy's owner/admin branch requires an active membership row.
                </p>
              )}
            </>
          );
        }}
      </ResourceSection>
    </>
  );
}