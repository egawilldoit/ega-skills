import type { ReactNode } from "react";

import type { McpDailyExecutionCount } from "../api/contracts";
import { DataTable, type Column } from "./DataTable";

/**
 * One accessible time-series chart of daily MCP execution counts (EGA-727).
 *
 * The chart is an SVG with `role="img"` and a `<title>`/`<desc>`, and it is
 * paired with a real `<table>` carrying the same points, so the data is never
 * chart-only. A reader using a screen reader (or printing the page) can read the
 * exact point values from the table; the chart is the visual summary.
 *
 * ## Absence is not zero
 *
 * The series carries only days that recorded at least one execution. A day with
 * no entry is omitted — no bar is drawn for it — because the console cannot
 * distinguish "no execution happened" from "nothing was recorded" for that day.
 * The copy below says this explicitly so a reader does not infer a zero from the
 * empty space, which is the misreading a zero-filled series would create.
 *
 * `partial` propagates CONTRACT-T1's coverage flag: when the server's scan hit
 * its ceiling the counts are a floor, and the chart says so rather than drawing a
 * lower bound as if it were the total.
 */
export interface DailyMcpExecutionsChartProps {
  /** Ascending, non-empty. Days with no recorded execution are absent. */
  readonly daily: readonly McpDailyExecutionCount[];
  /** True when the aggregate scan reached its ceiling, so these counts are a floor. */
  readonly partial: boolean;
  /** Inclusive start of the window the series covers, ISO-8601. */
  readonly windowStarted: string;
  /** Inclusive end of the window the series covers, ISO-8601. */
  readonly windowEndsAt: string;
}

const COLUMNS: readonly Column<McpDailyExecutionCount>[] = Object.freeze([
  {
    key: "date",
    label: "UTC date",
    mono: true,
    render: (row) => <time dateTime={row.date}>{row.date}</time>,
  },
  {
    key: "executions",
    label: "Executions",
    numeric: true,
    render: (row) => row.executions,
  },
]);

/** Chart geometry. Fixed viewBox so the SVG scales without a layout measurement. */
const CHART_WIDTH = 720;
const CHART_HEIGHT = 200;
const PLOT_TOP = 12;
const PLOT_BOTTOM = 28;
const PLOT_LEFT = 8;
const PLOT_RIGHT = 8;
const DAY_MS = 86_400_000;

/**
 * Static ids, because exactly one chart is rendered per page. They are named
 * constants so the aria references and the title/desc elements cannot drift.
 */
const CHART_TITLE_ID = "daily-mcp-executions-chart-title";
const CHART_DESC_ID = "daily-mcp-executions-chart-desc";

export function DailyMcpExecutionsChart({
  daily,
  partial,
  windowStarted,
  windowEndsAt,
}: DailyMcpExecutionsChartProps): ReactNode {
  // No points means no chart: the caller renders the honest empty state instead
  // of an axis with nothing on it, which would read as a zeroed period.
  if (daily.length === 0) return null;

  const first = daily[0] as McpDailyExecutionCount;
  const last = daily[daily.length - 1] as McpDailyExecutionCount;
  const firstMs = Date.parse(first.date);
  const lastMs = Date.parse(last.date);
  const span =
    Number.isFinite(firstMs) && Number.isFinite(lastMs)
      ? Math.max(1, Math.round((lastMs - firstMs) / DAY_MS) + 1)
      : daily.length;

  const peak = daily.reduce((max, bucket) => Math.max(max, bucket.executions), 0);
  const total = daily.reduce((sum, bucket) => sum + bucket.executions, 0);
  const peakBucket = daily.find((bucket) => bucket.executions === peak) ?? last;

  const plotWidth = CHART_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const plotHeight = CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM;
  const slot = plotWidth / span;
  const barWidth = Math.max(1, Math.min(slot * 0.8, 48));
  const baselineY = PLOT_TOP + plotHeight;

  const summary = `${total} MCP ${total === 1 ? "execution" : "executions"} across ${
    daily.length
  } recorded ${daily.length === 1 ? "day" : "days"} between ${first.date} and ${last.date}. Busiest day ${
    peakBucket.date
  } with ${peak} ${peak === 1 ? "execution" : "executions"}.`;
  const description = `${summary} The window runs from ${windowStarted} to ${windowEndsAt}. Days with no recorded execution are not drawn.`;

  return (
    <figure className="daily-chart">
      <figcaption id={CHART_TITLE_ID} className="daily-chart__caption">
        Daily MCP executions (UTC)
      </figcaption>
      <svg
        className="daily-chart__svg"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        width="100%"
        height={CHART_HEIGHT}
        role="img"
        aria-labelledby={CHART_TITLE_ID}
        aria-describedby={CHART_DESC_ID}
      >
        <desc id={CHART_DESC_ID}>{description}</desc>
        {/* Baseline: the counts sit on it; it is not a zero datum of its own. */}
        <line
          x1={PLOT_LEFT}
          y1={baselineY}
          x2={CHART_WIDTH - PLOT_RIGHT}
          y2={baselineY}
          className="daily-chart__axis"
        />
        {daily.map((bucket, index) => {
          const at = Date.parse(bucket.date);
          const offset =
            Number.isFinite(firstMs) && Number.isFinite(at)
              ? Math.round((at - firstMs) / DAY_MS)
              : index;
          const height = peak > 0 ? Math.max(1, (bucket.executions / peak) * plotHeight) : 1;
          const x = PLOT_LEFT + offset * slot + (slot - barWidth) / 2;
          const y = baselineY - height;
          return (
            <rect
              key={bucket.date}
              className="daily-chart__bar"
              x={x}
              y={y}
              width={barWidth}
              height={height}
            />
          );
        })}
      </svg>
      <p className="daily-chart__summary">{summary}</p>

      {/* The accessible equivalent: the same points as text, not chart-only. */}
      <DataTable
        caption="Daily MCP execution counts by UTC date (table equivalent of the chart above)"
        columns={COLUMNS}
        rows={daily}
        rowKey={(row) => row.date}
      />

      <p className="daily-chart__note" role="note">
        Days in this window with <strong>no recorded execution are omitted</strong> rather than drawn
        as zero: an absent day is an absence of records, not a measured zero.
        {partial ? (
          <>
            {" "}
            <strong>Partial coverage.</strong> The window held more activity than one response
            carries, so these daily counts are a lower bound, not a total.
          </>
        ) : null}
      </p>
    </figure>
  );
}
