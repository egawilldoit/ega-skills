/**
 * Evidence that source-management stages stay distinct: a proposed PR, an
 * accepted (merged) PR and a published active skill are three different labels.
 * The exported helpers are the exact functions the management page renders; the
 * list assertions below run the production page with only its BFF/role seams
 * replaced.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SourceSkillsPage } from "../../../apps/web/src/pages/SourceSkillsPage";
import {
  sourceItemLifecycle,
  sourceProposalLifecycle,
} from "../../../apps/web/src/pages/sourceLifecycle";
import { createDom, type MountedDom } from "./helpers/dom";

const boundary = vi.hoisted(() => {
  const get = vi.fn();
  return { get, client: { get } };
});
vi.mock("../../../apps/web/src/api/useApiClient", () => ({
  useApiClient: () => boundary.client,
}));
vi.mock("../../../apps/web/src/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => ({ role: "owner" }),
}));
vi.mock("yaml", () => ({ parse: () => ({}) }));

const SOURCE_SHA = "a".repeat(40);
const RELEASE = {
  release_digest: `sha256:${"b".repeat(64)}`,
  hub_id: "hub-1",
  status: "stable" as const,
  skill_count: 1,
  snapshot_rows: 1,
  sqlite_artifact_digest: `sha256:${"c".repeat(64)}`,
  mismatch_reason: null,
};

const sourceIndex = {
  sha: SOURCE_SHA,
  total: 1,
  items: [{ name: "alpha", description: "Alpha skill", provenance: "original" }],
};

const catalog = (withAlpha: boolean): Record<string, unknown> => ({
  workspace_id: "unscoped-release",
  hub_id: "hub-1",
  release: RELEASE,
  release_unavailable_reason: null,
  skill_total: withAlpha ? 1 : 0,
  domain_total: 0,
  facets: {
    namespaces: [], domains: [], frameworks: [], groups: [], platforms: [],
    triggers: [], aliases: [], sources: [], l1_statuses: [], trust_levels: [],
  },
  generated_at: "2026-10-17T00:00:00.000Z",
  skills: withAlpha
    ? [{
        skill_id: "egawilldoit/alpha", name: "alpha", namespace: "egawilldoit",
        description: "Alpha", domains: [], frameworks: [], platforms: [], triggers: [],
        version_hash: `sha256:${"d".repeat(64)}`, l1_status: "MISSING", l1_tokens: null,
        l2_tokens: 1, source_type: "local", provenance_status: "local-only",
        schema_version: 1, content_digest: `sha256:${"e".repeat(64)}`,
      }]
    : [],
  total: withAlpha ? 1 : 0,
  limit: 200,
  offset: 0,
  sort: "name",
  sort_direction: "asc",
  applied_filters: {
    q: null, namespace: null, domain: null, framework: null,
    group: null, source: null, l1: null,
  },
});

let dom: MountedDom | null = null;
let root: Root | null = null;

beforeEach(() => {
  boundary.get.mockReset();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  dom?.restore();
  dom = null;
});

function tree(): ReactElement {
  return (
    <MemoryRouter initialEntries={["/source-skills"]}>
      <Routes><Route path="/source-skills" element={<SourceSkillsPage />} /></Routes>
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
    text: () => container.textContent ?? "",
  };
}

async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

describe("source lifecycle labels", () => {
  test("a PR that is not merged is a proposed source change", () => {
    const stage = sourceProposalLifecycle({ state: "open", mergeSha: null });
    expect(stage).toEqual({ stage: "proposed", label: "Proposed source change" });
  });

  test("a merged PR is an accepted source change, not a publication", () => {
    const stage = sourceProposalLifecycle({ state: "merged", mergeSha: "f".repeat(40) });
    expect(stage?.stage).toBe("accepted");
    expect(stage?.label).toBe("Accepted source change");
    expect(stage?.label).not.toContain("Published");
  });

  test("a published row is the only stage called a published active skill", () => {
    expect(sourceItemLifecycle(true)).toEqual({ stage: "published", label: "Published active skill" });
    expect(sourceItemLifecycle(false)).toEqual({ stage: "unpublished", label: "Source change not published" });
  });
});

describe("source management list publication state", () => {
  test("a skill present in the catalog is marked published and links to its detail", async () => {
    boundary.get.mockImplementation((path: string) => {
      if (path === "/source-skills") return Promise.resolve(sourceIndex);
      if (path === "/skills") return Promise.resolve(catalog(true));
      return Promise.reject(new Error(`unexpected request ${path}`));
    });
    const view = mount(tree());
    await settle();

    expect(view.text()).toContain("Published active skill");
    expect(view.text()).not.toContain("Source change not published");
    const link = [...view.container.querySelectorAll("a")].find((a) => a.textContent === "View published skill");
    expect(link?.getAttribute("href")).toBe("/skills/egawilldoit%2Falpha");
    // Management affordances remain present.
    expect(view.text()).toContain("Add skill");
    expect(view.text()).toContain("Edit skill");
    expect(view.text()).toContain("Remove from next catalog");
  });

  test("a source-only skill is not advertised as published", async () => {
    boundary.get.mockImplementation((path: string) => {
      if (path === "/source-skills") return Promise.resolve(sourceIndex);
      if (path === "/skills") return Promise.resolve(catalog(false));
      return Promise.reject(new Error(`unexpected request ${path}`));
    });
    const view = mount(tree());
    await settle();

    expect(view.text()).toContain("Source change not published");
    expect(view.text()).not.toContain("Published active skill");
    expect(view.container.querySelector('a[href*="egawilldoit%2Falpha"]')).toBeNull();
    expect(view.text()).toContain("Add skill");
  });
});
