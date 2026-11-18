/**
 * Executed jsdom evidence for the catalog-reset web console behavior.
 *
 * The production `SkillsPage`, `SavedSkillPreferencesPanel`, resource and
 * navigation logic all run unchanged; only the BFF boundary is replaced. This is
 * component evidence, not browser/Preview acceptance.
 *
 * Journey asserted: an empty readable release reports the exact empty-catalog
 * message and offers the existing management route; saved favorites/defaults
 * left behind by a reset are shown as stored-but-unavailable and never become a
 * live link or an active selection; the management affordance still works.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SkillsPage } from "../../../apps/web/src/pages/SkillsPage";
import { createDom, type MountedDom } from "./helpers/dom";

const boundary = vi.hoisted(() => {
  const get = vi.fn();
  const put = vi.fn();
  return { get, put, client: { get, put } };
});
vi.mock("../../../apps/web/src/api/useApiClient", () => ({
  useApiClient: () => boundary.client,
}));

const WORKSPACE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const RELEASE_DIGEST = `sha256:${"a".repeat(64)}`;
const RELEASE = {
  release_digest: RELEASE_DIGEST,
  hub_id: "hub-1",
  status: "stable" as const,
  skill_count: 0,
  snapshot_rows: 0,
  sqlite_artifact_digest: `sha256:${"b".repeat(64)}`,
  mismatch_reason: null,
};
const HOSTED_STATUS = {
  state: "unknown" as const,
  console_release_digest: RELEASE_DIGEST,
  hosted_release_digest: null,
  observed_at: null,
  checked_at: "2026-11-04T12:05:00.000Z",
  reason: "not checked in this component test",
  endpoint: "https://ega-skills-mcp.vercel.app/readyz",
};
const FACETS = {
  namespaces: [], domains: [], frameworks: [], groups: [], platforms: [],
  triggers: [], aliases: [], sources: [], l1_statuses: [], trust_levels: [],
};
const SKILL = {
  skill_id: "egawilldoit/live",
  name: "live",
  namespace: "egawilldoit",
  description: "A published skill",
  domains: [], frameworks: [], platforms: [], triggers: [],
  version_hash: `sha256:${"c".repeat(64)}`,
  l1_status: "MISSING" as const,
  l1_tokens: null,
  l2_tokens: 10,
  source_type: "local",
  provenance_status: "local-only" as const,
  schema_version: 1,
  content_digest: `sha256:${"d".repeat(64)}`,
};

const page = (options: {
  skills: readonly unknown[];
  total: number;
  skillTotal: number;
  workspaceId?: string;
  namespace?: string | null;
}): Record<string, unknown> => ({
  workspace_id: options.workspaceId ?? "unscoped-release",
  hub_id: "hub-1",
  release: RELEASE,
  release_unavailable_reason: null,
  skill_total: options.skillTotal,
  domain_total: 0,
  facets: FACETS,
  generated_at: "2026-10-17T00:00:00.000Z",
  skills: options.skills,
  total: options.total,
  limit: 50,
  offset: 0,
  sort: "name",
  sort_direction: "asc",
  applied_filters: {
    q: null, namespace: options.namespace ?? null, domain: null, framework: null,
    group: null, source: null, l1: null,
  },
});

const PREFERENCES = {
  revision: 7,
  favorite_skill_ids: ["egawilldoit/live", "egawilldoit/retired"],
  default_skill_ids: ["egawilldoit/retired"],
  updated_at: "2026-11-01T00:00:00.000Z",
};

let dom: MountedDom | null = null;
let root: Root | null = null;

beforeEach(() => {
  boundary.get.mockReset();
  boundary.put.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  dom?.restore();
  dom = null;
});

function Probe() {
  return <output data-testid="route">source management</output>;
}

function tree(): ReactElement {
  return (
    <MemoryRouter initialEntries={["/skills"]}>
      <Routes>
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/source-skills" element={<Probe />} />
      </Routes>
    </MemoryRouter>
  );
}

function mount(element: ReactElement) {
  dom = createDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<StrictMode>{cloneElement(element)}</StrictMode>));
  return {
    container,
    document: dom.document,
    text: () => container.textContent ?? "",
    click: (label: string) => {
      const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!button) throw new Error(`button missing: ${label}`);
      act(() => dom!.click(button));
    },
    clickLink: (label: string) => {
      const link = [...container.querySelectorAll("a")].find((a) => a.textContent === label);
      if (!link) throw new Error(`link missing: ${label}`);
      act(() => dom!.click(link));
    },
  };
}

/** Let the resource effects settle and the real promise chains resolve. */
async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function transport(catalog: Record<string, unknown>, preferences: unknown = undefined) {
  boundary.get.mockImplementation((path: string) => {
    if (path === "/hosted-release-status") return Promise.resolve(HOSTED_STATUS);
    if (path === "/skill-preferences") {
      if (preferences === undefined) return Promise.reject(new Error("preferences not expected"));
      return Promise.resolve(preferences);
    }
    if (path === "/skills") return Promise.resolve(catalog);
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
}

describe("empty-catalog web console", () => {
  test("an empty readable release shows the exact message and no skill suggestions", async () => {
    transport(page({ skills: [], total: 0, skillTotal: 0 }));
    const view = mount(tree());
    await settle();

    expect(view.text()).toContain("No skills in the current catalog.");
    expect(view.text()).not.toContain("No skills match");
    expect(view.container.querySelector("table")).toBeNull();
    // No example/placeholder skill is suggested: no skill detail links and no
    // fabricated rows. The only navigation offered is the management workflow.
    expect(view.container.querySelectorAll('a[href^="/skills/"]')).toHaveLength(0);
    expect(view.text()).not.toContain("egawilldoit/live");
    expect(boundary.get.mock.calls.some(([path]) => path === "/skill-preferences")).toBe(false);
  });

  test("a filter that matches nothing keeps the recoverable, honest zero", async () => {
    transport(page({ skills: [], total: 0, skillTotal: 1, namespace: "missing" }));
    const view = mount(tree());
    await settle();

    expect(view.text()).toContain("No skills match");
    expect(view.text()).not.toContain("No skills in the current catalog.");
    // The search/filter controls stay mounted so the zero is recoverable in
    // place; this is the honest zero, not the empty-catalog claim.
    expect(view.container.querySelector('input[type="search"]')).not.toBeNull();
    // Pagination may read more than one page; the contract is exactly one
    // filter request flow, not a fixed number of HTTP calls.
    expect(boundary.get.mock.calls.filter(([path]) => path === "/skills").length).toBeGreaterThanOrEqual(1);
  });

  test("the empty state preserves the management affordance", async () => {
    transport(page({ skills: [], total: 0, skillTotal: 0 }));
    const view = mount(tree());
    await settle();

    expect(view.text()).toContain("Manage source skills");
    view.clickLink("Manage source skills");
    expect(view.text()).toContain("source management");
  });

  test("stale favorites and defaults are stored-but-unavailable, never active or linked", async () => {
    transport(
      page({ skills: [SKILL], total: 1, skillTotal: 1, workspaceId: WORKSPACE }),
      PREFERENCES,
    );
    const view = mount(tree());
    await settle();

    // The live favorite keeps a working detail link and an active marker.
    const live = [...view.container.querySelectorAll("a")].find((a) => a.textContent === "egawilldoit/live");
    expect(live?.getAttribute("href")).toBe("/skills/egawilldoit%2Flive");
    expect(view.text()).toContain("Active favorite");

    // The retired id is still displayed (stored value preserved) but cannot be
    // mistaken for a live selection: no link, no "active" badge.
    expect(view.text()).toContain("egawilldoit/retired");
    expect(view.text()).toContain("Saved favorite · not in current catalog");
    expect(view.text()).toContain("Saved default · not in current catalog");
    expect(view.container.querySelector('a[href*="retired"]')).toBeNull();
    expect(view.text()).not.toContain("Active default");

    // Read-only panel: no preference write was issued.
    expect(boundary.put).not.toHaveBeenCalled();
    expect(boundary.get.mock.calls.some(([path]) => path === "/skill-preferences")).toBe(true);
    expect(boundary.get.mock.calls.find(([path]) => path === "/skill-preferences")?.[1]).toMatchObject({
      query: { workspace_id: WORKSPACE },
    });
  });

  test("an owner-scoped refusal does not turn the skills list into an error", async () => {
    boundary.get.mockImplementation((path: string) => {
      if (path === "/hosted-release-status") return Promise.resolve(HOSTED_STATUS);
      if (path === "/skill-preferences") return Promise.reject({ kind: "forbidden", message: "no", code: "E", status: 403, retryable: false });
      if (path === "/skills") return Promise.resolve(page({ skills: [SKILL], total: 1, skillTotal: 1, workspaceId: WORKSPACE }));
      return Promise.reject(new Error(`unexpected request ${path}`));
    });
    const view = mount(tree());
    await settle();

    expect(view.text()).toContain("egawilldoit/live");
    expect(view.text()).not.toContain("Could not load this view");
    expect(view.container.querySelector("table")).not.toBeNull();
  });
});
