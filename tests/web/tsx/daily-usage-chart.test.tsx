/**
 * Executed jsdom evidence for the daily MCP execution chart (EGA-727).
 *
 * The real `UsagePage` and `DailyMcpExecutionsChart` render unchanged; only the
 * BFF boundary (`useApiClient`) and the workspace context are replaced, so the
 * page, the chart and the table are the real implementations. This is component
 * evidence, not browser/Preview acceptance.
 *
 * The acceptance journey asserted here: the server's daily sums are drawn as one
 * accessible chart AND offered as an accessible table, with the empty and
 * partial states labelled rather than drawn as zero.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { UsagePage } from "../../../apps/web/src/pages/UsagePage";
import { createDom, type MountedDom } from "./helpers/dom";

const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../apps/web/src/api/useApiClient", () => ({
  useApiClient: () => client,
}));

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
vi.mock("../../../apps/web/src/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
}));

const TELEMETRY_FUNNEL = { searched: 4, resolved: 3, inspected: 2, content_retrieved: 1 };

function usageSummary({
  daily = [],
  partial = false,
  totalExecutions = daily.reduce((sum, bucket) => sum + bucket.executions, 0),
  reason = null,
}: {
  daily?: { date: string; executions: number }[];
  partial?: boolean;
  totalExecutions?: number;
  reason?: string | null;
} = {}) {
  return {
    workspace_id: WORKSPACE,
    window_started: "2026-07-19T00:00:00.000Z",
    window_ends_at: "2026-10-17T00:00:00.000Z",
    request_count: 0,
    bandwidth_bytes: 0,
    windows: [],
    policy: null,
    windows_unavailable_reason: "No quota usage has been recorded.",
    telemetry: {
      total_executions: totalExecutions,
      success_count: totalExecutions,
      error_count: 0,
      funnel: TELEMETRY_FUNNEL,
      tools: { search: totalExecutions, resolve: 0, inspect: 0, get_content: 0 },
      total_latency_ms: totalExecutions * 10,
      average_latency_ms: 10,
      telemetry_unavailable_reason: reason,
      window_started: "2026-07-19T00:00:00.000Z",
      window_ends_at: "2026-10-17T00:00:00.000Z",
      partial,
      rows_scanned: totalExecutions,
      daily,
    },
  };
}

let dom: MountedDom | null = null;
let root: Root | null = null;

beforeEach(() => {
  client.get.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  dom?.restore();
  dom = null;
});

function mount(element: ReactElement) {
  dom = createDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<StrictMode>{cloneElement(element)}</StrictMode>));
  return {
    container,
    text: () => container.textContent ?? "",
    // The chart specifically, not "any <svg>": the empty and error states carry
    // a state icon, and a bare `querySelector("svg")` would count that icon as
    // a drawn chart.
    svg: () => container.querySelector("svg.daily-chart__svg"),
    table: () => container.querySelector("table"),
  };
}

function tree(): ReactElement {
  return (
    <MemoryRouter initialEntries={["/analytics"]}>
      <UsagePage />
    </MemoryRouter>
  );
}

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const SYNTHETIC_DAILY = [
  { date: "2026-10-14", executions: 2 },
  { date: "2026-10-15", executions: 5 },
  { date: "2026-10-16", executions: 1 },
];

describe("the daily MCP execution chart on the Usage page", () => {
  test("renders one accessible chart and an accessible table of the same points", async () => {
    // A clearly-labelled SYNTHETIC fixture: no real telemetry data is available
    // in this environment, so these are not real execution counts.
    client.get.mockResolvedValue(usageSummary({ daily: SYNTHETIC_DAILY }));
    const view = mount(tree());
    await settle();

    const svg = view.svg();
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("role")).toBe("img");

    // The chart is labelled and described by real elements, not by a title
    // attribute alone.
    const labelledBy = svg!.getAttribute("aria-labelledby");
    const describedBy = svg!.getAttribute("aria-describedby");
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(view.container.querySelector(`#${labelledBy}`)?.textContent).toContain(
      "Daily MCP executions (UTC)",
    );
    expect(view.container.querySelector(`#${describedBy}`)?.textContent).toContain(
      "Days with no recorded execution are not drawn",
    );

    // One rect per recorded day — three bars for three days.
    expect(view.container.querySelectorAll("svg rect.daily-chart__bar").length).toBe(
      SYNTHETIC_DAILY.length,
    );

    // The table equivalent carries the exact points, so the series is not
    // chart-only and a screen reader can read each value.
    expect(view.table()).not.toBeNull();
    for (const bucket of SYNTHETIC_DAILY) {
      expect(view.text()).toContain(bucket.date);
      expect(view.text()).toContain(String(bucket.executions));
    }
    // The busiest day is named in the summary, not left to the bar heights.
    expect(view.text()).toContain("Busiest day 2026-10-15 with 5 executions");

    // The honesty label is rendered in the UI.
    expect(view.text()).toContain("no recorded execution are omitted");
    expect(view.text()).toContain("not a measured zero");
  });

  test("a partial scan is labelled as a lower bound, not a total", async () => {
    client.get.mockResolvedValue(usageSummary({ daily: SYNTHETIC_DAILY, partial: true }));
    const view = mount(tree());
    await settle();

    expect(view.text()).toContain("Partial coverage");
    expect(view.text()).toContain("lower bound, not a total");
  });

  test("an empty window draws no chart and states the absence instead of zeroing", async () => {
    client.get.mockResolvedValue(
      usageSummary({ daily: [], totalExecutions: 0, reason: "No read-path MCP executions were recorded in this window. Telemetry is enabled for this workspace, so this is a genuine zero." }),
    );
    const view = mount(tree());
    await settle();

    // No chart, no bars: an empty series is an empty state, not a flat line.
    expect(view.svg()).toBeNull();
    expect(view.text()).toContain("No tool telemetry recorded");
    // The absence is explained, not implied as a measured zero.
    expect(view.text()).toContain("genuine zero");
  });

  test("the chart cannot render a day the server did not send", async () => {
    // The negative: a fixture containing an unrelated/foreign day must not
    // appear because the payload never carried it. The chart draws exactly the
    // server's authorized daily sums.
    client.get.mockResolvedValue(usageSummary({ daily: SYNTHETIC_DAILY }));
    const view = mount(tree());
    await settle();

    expect(view.container.querySelectorAll("svg rect.daily-chart__bar").length).toBe(3);
    expect(view.text()).not.toContain("2026-10-13");
    expect(view.text()).not.toContain("2026-01-01");
  });
});
