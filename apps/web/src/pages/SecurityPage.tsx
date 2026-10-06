import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { SecurityDenyRow } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection } from "../components/StatePanel";

const COLUMNS: readonly Column<SecurityDenyRow>[] = [
  { key: "kind", label: "Kind", mono: true, render: (row) => row.kind },
  { key: "identity", label: "Identity", mono: true, render: (row) => row.identity },
  { key: "reason", label: "Reason", render: (row) => row.reason },
  {
    key: "created_at",
    label: "Recorded",
    render: (row) => <time dateTime={row.created_at}>{row.created_at}</time>,
  },
];

/**
 * `/workspace/security` — recorded deny rows.
 *
 * Owner/admin only, per the `security_deny_admin_read` policy. Deny precedence
 * is enforced in `private.is_denied`, which these rows feed, so an identity
 * listed here is unreadable through the catalog regardless of workspace role.
 * The console never offers a way to clear a deny.
 */
export function SecurityPage(): ReactNode {
  const client = useApiClient();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<readonly SecurityDenyRow[]>(API_ENDPOINTS.securityDenies, {
        signal,
        timeoutMs: 15_000,
      }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  return (
    <>
      <p className="page__lede">
        Read-only. Removing a deny is a control-plane change and is not performed from this
        console.
      </p>
      <ResourceSection
        state={resource.state}
        reload={resource.reload}
        loadingLabel="Loading security denies…"
        empty={(data) =>
          data.length === 0 ? (
            <EmptyState
              title="No deny rows"
              reason="Nothing in security_denies applies to this workspace, so no identity here is currently denied."
            />
          ) : null
        }
      >
        {(data) => (
          <DataTable
            caption="Security deny rows for this workspace"
            columns={COLUMNS}
            rows={data}
            rowKey={(row) => row.id}
          />
        )}
      </ResourceSection>
    </>
  );
}