import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { AuditRow } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection } from "../components/StatePanel";

const COLUMNS: readonly Column<AuditRow>[] = [
  {
    key: "occurred_at",
    label: "Occurred",
    render: (row) => <time dateTime={row.occurred_at}>{row.occurred_at}</time>,
  },
  { key: "actor_subject", label: "Actor", mono: true, render: (row) => row.actor_subject },
  { key: "operation", label: "Operation", mono: true, render: (row) => row.operation },
  {
    key: "target_identity",
    label: "Target",
    mono: true,
    render: (row) => row.target_identity ?? "—",
  },
  {
    key: "old_identity",
    label: "Old identity",
    mono: true,
    render: (row) => row.old_identity ?? "—",
  },
  {
    key: "new_identity",
    label: "New identity",
    mono: true,
    render: (row) => row.new_identity ?? "—",
  },
  {
    key: "result",
    label: "Result",
    render: (row) => (
      <span className={`badge badge--${row.result === "allowed" ? "stable" : "mismatch"}`}>
        {row.result}
      </span>
    ),
  },
];

/**
 * `/audit` — control-plane audit events.
 *
 * Owner/admin only, per the `audit_admin_read` policy. Ordered as the API
 * returns it; the console does not re-sort or paginate, because inventing an
 * order it cannot guarantee would misstate the record.
 */
export function AuditPage(): ReactNode {
  const client = useApiClient();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<readonly AuditRow[]>(API_ENDPOINTS.auditEvents, { signal, timeoutMs: 20_000 }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  return (
    <ResourceSection
      state={resource.state}
      reload={resource.reload}
      loadingLabel="Loading audit events…"
      empty={(data) =>
        data.length === 0 ? (
          <EmptyState
            title="No audit events"
            reason="The control plane reports no audit events for this workspace."
          />
        ) : null
      }
    >
      {(data) => (
        <DataTable
          caption="Control-plane audit events"
          columns={COLUMNS}
          rows={data}
          rowKey={(row) => row.id}
        />
      )}
    </ResourceSection>
  );
}