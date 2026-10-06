import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { MemberRow } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection } from "../components/StatePanel";

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

/**
 * `/workspace/members` — membership rows.
 *
 * This route is owner/admin only, both in the navigation filter and in the
 * `membership_self_or_admin_read` policy that backs it. The console exposes no
 * way to add, remove, or change a role: membership changes are control-plane
 * transactions, not console actions.
 */
export function MembersPage(): ReactNode {
  const client = useApiClient();
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
              title="No membership rows visible"
              reason="RLS returned no rows. If your role is not owner or admin, you can read only your own row, which the API does not expose on this route."
            />
          ) : null
        }
      >
        {(data) => (
          <DataTable
            caption="Workspace members"
            columns={COLUMNS}
            rows={data}
            rowKey={(row) => row.subject}
          />
        )}
      </ResourceSection>
    </>
  );
}