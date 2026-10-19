import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { UsageSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { DataTable, Field, type Column } from "../components/DataTable";
import { DailyMcpExecutionsChart } from "../components/DailyMcpExecutionsChart";
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
 * The console draws one chart — a daily execution-count series for the
 * CONTRACT-T1 telemetry section, and only when the server actually returned
 * points. It is never a placeholder: a window with no recorded executions
 * renders the empty state, not an axis. The chart is paired with an accessible
 * table carrying the same points, so the series is never chart-only.
 */
export function UsagePage(): ReactNode {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<UsageSummary>(API_ENDPOINTS.analyticsUsage(), {
        signal,
        timeoutMs: 20_000,
        ...(workspaceId ? { query: { workspace: workspaceId, workspace_id: workspaceId } } : {}),
      }),
    [client, workspaceId],
  );
  const resource = useApiResource(load, [client, workspaceId]);

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
              They are <strong>not</strong> per-tool MCP execution telemetry. When read-path MCP
              telemetry (CONTRACT-T1) is not recorded for a window, per-tool activity is{" "}
              <strong>unavailable</strong>, not zero. An absence of numbers here means
              nothing has been recorded against the quota, and says nothing at all about
              which MCP tools ran.
            </p>
          </section>

          <section className="panel" aria-labelledby="telemetry-section">
            <h2 id="telemetry-section">MCP Read-Path Usage Telemetry (CONTRACT-T1)</h2>
            {data.telemetry && data.telemetry.total_executions > 0 ? (
              <>
                <div className="telemetry-funnel">
                  <FunnelMetric label="1. Searched (Discovery)" value={data.telemetry.funnel.searched} />
                  <FunnelMetric label="2. Resolved (Resolution)" value={data.telemetry.funnel.resolved} />
                  <FunnelMetric label="3. Inspected (Metadata)" value={data.telemetry.funnel.inspected} />
                  <FunnelMetric label="4. Content Retrieved" value={data.telemetry.funnel.content_retrieved} />
                </div>

                <dl className="fields">
                  <Field label="Total Executions" mono>
                    {data.telemetry.total_executions}
                  </Field>
                  <Field label="Successful Executions" mono>
                    {data.telemetry.success_count}
                  </Field>
                  <Field label="Failed/Denied Executions" mono>
                    {data.telemetry.error_count}
                  </Field>
                  <Field label="Average Latency" mono>
                    {data.telemetry.average_latency_ms} ms
                  </Field>
                  <Field label="Tools Breakdown" mono>
                    {`search: ${data.telemetry.tools.search}, resolve: ${data.telemetry.tools.resolve}, inspect: ${data.telemetry.tools.inspect}, get_content: ${data.telemetry.tools.get_content}`}
                  </Field>
                </dl>

                {data.telemetry.daily.length > 0 ? (
                  <DailyMcpExecutionsChart
                    daily={data.telemetry.daily}
                    partial={data.telemetry.partial}
                    windowStarted={data.telemetry.window_started}
                    windowEndsAt={data.telemetry.window_ends_at}
                  />
                ) : null}
              </>
            ) : (
              <EmptyState
                title="No tool telemetry recorded"
                reason={
                  data.telemetry?.telemetry_unavailable_reason ??
                  "Read-path MCP telemetry (CONTRACT-T1) is unavailable, not zero."
                }
              />
            )}
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

          {/*
            Partial coverage is stated in words, not implied by a smaller
            number. Without this a truncated scan renders exactly like a complete
            one, and an operator concludes usage dropped.
          */}
          {data.telemetry?.partial === true ? (
            <p className="page__lede" role="status">
              <strong>Partial coverage.</strong> This window holds more activity than one
              response carries, so the figures below are a lower bound, not a total.{" "}
              {data.telemetry.rows_scanned.toLocaleString()} events were scanned.
            </p>
          ) : null}

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

/** One step of the read path, with its measured count. */
function FunnelMetric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number;
}): ReactNode {
  return (
    <div className="metric-card">
      <div className="metric-card__label">{label}</div>
      <div className="metric-card__value">{value.toLocaleString("en-US")}</div>
    </div>
  );
}

const WINDOW_COLUMNS: readonly Column<UsageSummary["windows"][number]>[] = [  {
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