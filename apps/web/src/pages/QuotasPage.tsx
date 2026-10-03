import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { WorkspaceQuotaView } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, Field, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection, UnavailableState } from "../components/StatePanel";

/**
 * `/workspace/quotas` — quota policy plus observed usage windows.
 *
 * Owner/admin only, per `quota_policy_admin_read` and `quota_usage_admin_read`.
 * An absent policy row and an empty usage series are both real states and are
 * reported as such with the server's own reason, never as zeros.
 */
export function QuotasPage(): ReactNode {
  const client = useApiClient();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<WorkspaceQuotaView>(API_ENDPOINTS.workspaceQuotas(), {
        signal,
        timeoutMs: 15_000,
      }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  return (
    <ResourceSection
      state={resource.state}
      reload={resource.reload}
      loadingLabel="Loading quotas…"
    >
      {(data) => (
        <>
          <h2>Policy</h2>
          {data.policy === null ? (
            <UnavailableState
              title="No quota policy recorded"
              reason={
                data.policy_unavailable_reason ??
                "This workspace has no row in quota_policies."
              }
            />
          ) : (
            <dl className="fields">
              <Field label="Requests per minute" mono>
                {data.policy.requests_per_minute}
              </Field>
              <Field label="Concurrent requests" mono>
                {data.policy.concurrent_requests}
              </Field>
              <Field label="Bandwidth bytes" mono>
                {data.policy.bandwidth_bytes}
              </Field>
            </dl>
          )}

          <h2>Usage windows</h2>
          {data.usage.length === 0 ? (
            <EmptyState
              title="No usage windows recorded"
              reason={
                data.usage_unavailable_reason ??
                "No rows exist in quota_usage for this workspace yet."
              }
            />
          ) : (
            <DataTable
              caption="Quota usage windows"
              columns={USAGE_COLUMNS}
              rows={data.usage}
              rowKey={(row) => row.window_started}
            />
          )}
        </>
      )}
    </ResourceSection>
  );
}

const USAGE_COLUMNS: readonly Column<WorkspaceQuotaView["usage"][number]>[] = [
  {
    key: "window_started",
    label: "Window started",
    render: (row) => <time dateTime={row.window_started}>{row.window_started}</time>,
  },
  {
    key: "request_count",
    label: "Requests",
    numeric: true,
    render: (row) => row.request_count,
  },
  {
    key: "bandwidth_bytes",
    label: "Bandwidth (bytes)",
    numeric: true,
    render: (row) => row.bandwidth_bytes,
  },
];