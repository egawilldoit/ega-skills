import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { UsageSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, Field, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection, UnavailableState } from "../components/StatePanel";

/**
 * `/analytics` — request and bandwidth usage against the quota policy.
 *
 * ## These numbers are NOT MCP tool telemetry
 *
 * CONTRACT-T1 specifies read-path MCP usage telemetry, which would make
 * per-tool execution counts available here. It is **not implemented**: there is
 * no telemetry store, no writer, and nothing instruments the four MCP tools. So
 * this page shows `quota_usage` rows — aggregate counters the control plane
 * records against a workspace's quota policy — and nothing more.
 *
 * That distinction is stated in the UI rather than left for the reader to
 * infer, because the route is named `/analytics` and sits under
 * "Observability". An operator looking for per-tool activity and finding a
 * request count would otherwise conclude the deployment records tool usage and
 * is idle, when the truth is that it does not record tool usage at all.
 *
 * The empty state already distinguishes this the other way round: it reports
 * the server's own reason rather than showing zeros, so an absent series is
 * never presented as genuine zero usage.
 *
 * The console draws no chart. A chart needs a series it can trust, and this
 * deployment has no verified series yet; the numbers below are the raw rows the
 * API returned, and the totals are the API's own rollup, not a client
 * computation.
 */
export function UsagePage(): ReactNode {
  const client = useApiClient();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<UsageSummary>(API_ENDPOINTS.analyticsUsage(), { signal, timeoutMs: 20_000 }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  return (
    <ResourceSection
      state={resource.state}
      reload={resource.reload}
      loadingLabel="Loading usage…"
    >
      {(data) => (
        <>
          {/* Rendered on the page, not only in the source, because the route is
              named `/analytics` and this is the one place an operator could
              reasonably mistake quota counters for MCP tool telemetry. */}
          <section className="panel" aria-labelledby="usage-scope">
            <h2 id="usage-scope">What this page measures</h2>
            <p className="page__lede">
              These are <strong>quota accounting counters</strong> recorded against this
              workspace&apos;s quota policy — total requests and bandwidth in a time window.
              They are <strong>not</strong> per-tool MCP execution telemetry. Read-path MCP
              telemetry (CONTRACT-T1) is not implemented in this deployment: no telemetry is
              recorded, so per-tool activity is <strong>unavailable</strong>, not zero. An
              absence of numbers here means nothing has been recorded against the quota,
              and says nothing at all about which MCP tools ran.
            </p>
          </section>

          <section className="panel" aria-labelledby="usage-rollup">
            <h2 id="usage-rollup">Reported window</h2>
            <dl className="fields">
              <Field label="Workspace" mono>
                {data.workspace_id}
              </Field>
              <Field label="From" mono>
                <time dateTime={data.window_started}>{data.window_started}</time>
              </Field>
              <Field label="To" mono>
                <time dateTime={data.window_ends_at}>{data.window_ends_at}</time>
              </Field>
              <Field label="Requests" mono>
                {data.request_count}
              </Field>
              <Field label="Bandwidth (bytes)" mono>
                {data.bandwidth_bytes}
              </Field>
              <Field label="Policy in force" mono>
                {data.policy === null
                  ? "No quota policy recorded"
                  : `${data.policy.requests_per_minute} req/min, ${data.policy.concurrent_requests} concurrent, ${data.policy.bandwidth_bytes} bytes`}
              </Field>
            </dl>
          </section>

          <h2>Windows</h2>
          {data.windows.length === 0 ? (
            <EmptyState
              title="No usage windows in range"
              reason={
                data.windows_unavailable_reason ??
                "The API returned no quota_usage rows for this workspace and window."
              }
            />
          ) : (
            <DataTable
              caption="Quota usage windows in range"
              columns={WINDOW_COLUMNS}
              rows={data.windows}
              rowKey={(row) => row.window_started}
            />
          )}

          <p className="page__lede">
            Need the policy itself? <Link to="/workspace/quotas">Quotas</Link>
          </p>
        </>
      )}
    </ResourceSection>
  );
}

const WINDOW_COLUMNS: readonly Column<UsageSummary["windows"][number]>[] = [
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