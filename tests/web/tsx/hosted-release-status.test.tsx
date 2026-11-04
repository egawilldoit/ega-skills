/**
 * Executed jsdom evidence for the hosted MCP release comparison panel.
 *
 * The production component and resource hook render unchanged; only the BFF
 * boundary (`useApiClient`) is replaced. Each state must name itself in visible
 * text, show full digests, and never turn a failed observation into a match.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HostedReleaseStatusPanel } from "../../../apps/web/src/components/HostedReleaseStatus";
import { createDom, type MountedDom } from "./helpers/dom";

const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../apps/web/src/api/useApiClient", () => ({
  useApiClient: () => client,
}));

const CONSOLE_DIGEST = `sha256:${"a".repeat(64)}`;
const HOSTED_DIGEST = `sha256:${"b".repeat(64)}`;
const OBSERVED_AT = "2026-11-04T12:00:00.000Z";
const CHECKED_AT = "2026-11-04T12:05:00.000Z";
const LATER_CHECKED_AT = "2026-11-04T12:05:15.000Z";

const status = (overrides = {}) => ({
  state: "matches",
  console_release_digest: CONSOLE_DIGEST,
  hosted_release_digest: CONSOLE_DIGEST,
  observed_at: OBSERVED_AT,
  checked_at: CHECKED_AT,
  reason: null,
  endpoint: "https://ega-skills-mcp.vercel.app/readyz",
  ...overrides,
});

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
  act(() => root!.render(<StrictMode>{element}</StrictMode>));
  return {
    container,
    text: () => container.textContent ?? "",
    button: (label: string) => {
      const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!found) throw new Error(`button missing: ${label}`);
      return found as HTMLButtonElement;
    },
    click: (label: string) => {
      const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!button) throw new Error(`button missing: ${label}`);
      act(() => dom!.click(button));
    },
  };
}

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("hosted MCP release status panel", () => {
  test("matching digests name the match and show accessible timestamps", async () => {
    client.get.mockResolvedValue(status());
    const view = mount(<HostedReleaseStatusPanel />);
    await settle();

    expect(view.text()).toContain("Hosted MCP release matches");
    expect(view.text()).toContain(CONSOLE_DIGEST);
    expect(view.text()).toContain(OBSERVED_AT);
    expect(view.text()).toContain("https://ega-skills-mcp.vercel.app/readyz");
    expect(view.text()).not.toContain("Hosted MCP status unknown");
    expect(view.text()).toContain("MCP observation time");
    expect(view.text()).toContain("Console status request time");
    const times = [...view.container.querySelectorAll("time")].map((node) =>
      node.getAttribute("dateTime"),
    );
    expect(times).toContain(OBSERVED_AT);
    expect(times).toContain(CHECKED_AT);
  });

  test("states that observations can be reused for up to 15 seconds", async () => {
    client.get.mockResolvedValue(status());
    const view = mount(<HostedReleaseStatusPanel />);
    await settle();

    expect(view.text()).toContain("Observations can be reused for up to 15 seconds");
    expect(view.text()).toContain("may reuse a cached observation");
    expect(view.button("Refresh status")).toBeTruthy();
  });

  test("Refresh status reuses a cached observation without changing observed_at", async () => {
    let current = status();
    client.get.mockImplementation(() => Promise.resolve(current));
    const view = mount(<HostedReleaseStatusPanel />);
    await settle();

    const initialCalls = client.get.mock.calls.length;
    current = status({ checked_at: LATER_CHECKED_AT });
    view.click("Refresh status");
    await settle();

    expect(client.get.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(view.text()).toContain(OBSERVED_AT);
    expect(view.text()).toContain(LATER_CHECKED_AT);
  });

  test("a failed refresh never leaves a false match on screen", async () => {
    let fail = false;
    client.get.mockImplementation(() =>
      fail ? Promise.reject(new Error("network down")) : Promise.resolve(status()),
    );
    const view = mount(<HostedReleaseStatusPanel />);
    await settle();
    expect(view.text()).toContain("Hosted MCP release matches");

    fail = true;
    view.click("Refresh status");
    await settle();

    expect(view.text()).toContain("Hosted MCP status unknown");
    expect(view.text()).not.toContain("Hosted MCP release matches");
  });

  test("different valid digests name the difference and show both", async () => {
    client.get.mockResolvedValue(
      status({ state: "different", hosted_release_digest: HOSTED_DIGEST }),
    );
    const view = mount(<HostedReleaseStatusPanel />);
    await settle();

    expect(view.text()).toContain("Hosted MCP release differs");
    expect(view.text()).toContain(CONSOLE_DIGEST);
    expect(view.text()).toContain(HOSTED_DIGEST);
  });

  test("unknown names the unknown state, the reason and the missing observation", async () => {
    client.get.mockResolvedValue(
      status({
        state: "unknown",
        hosted_release_digest: null,
        observed_at: null,
        reason: "The canonical hosted MCP readiness check timed out after 2000 ms.",
      }),
    );
    const view = mount(<HostedReleaseStatusPanel />);
    await settle();

    expect(view.text()).toContain("Hosted MCP status unknown");
    expect(view.text()).toContain("No successful observation");
    expect(view.text()).toContain("timed out");
  });

  test("a transport failure is unknown, never a false match", async () => {
    client.get.mockRejectedValue(new Error("network down"));
    const view = mount(<HostedReleaseStatusPanel />);
    await settle();

    expect(view.text()).toContain("Hosted MCP status unknown");
    expect(view.text()).not.toContain("Hosted MCP release matches");
  });
});
