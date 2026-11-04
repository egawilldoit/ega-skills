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
  test("matching digests name the match and show the observation time", async () => {
    client.get.mockResolvedValue(status());
    const view = mount(<HostedReleaseStatusPanel />);
    await settle();

    expect(view.text()).toContain("Hosted MCP release matches");
    expect(view.text()).toContain(CONSOLE_DIGEST);
    expect(view.text()).toContain(OBSERVED_AT);
    expect(view.text()).toContain("https://ega-skills-mcp.vercel.app/readyz");
    expect(view.text()).not.toContain("Hosted MCP status unknown");
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
