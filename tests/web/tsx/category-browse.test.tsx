/**
 * Executed jsdom evidence for category browsing on the Skills page (EGA-724).
 *
 * The production `SkillsPage` and `CategoryBrowse` render unchanged; only the
 * BFF boundary (`useApiClient`) is replaced, so the panel, the query state and
 * the navigation are the real implementations. This is component evidence, not
 * browser/Preview acceptance.
 *
 * The journey asserted here is the acceptance journey:
 * category -> filtered list from the response -> existing skill detail route.
 * The negatives are that an empty result fabricates no row and is recoverable,
 * and that the panel cannot render a category or a skill the server did not send.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { SkillsPage } from "../../../apps/web/src/pages/SkillsPage";
import { shortDigest } from "../../../apps/web/src/components/release-status";
import { createDom, type MountedDom } from "./helpers/dom";

/**
 * A STABLE client object. `useApiClient` is read on every render, so a mock that
 * returned a fresh object each call would change the loader's identity, retrigger
 * the resource effect and loop. `client-behaviour.test.tsx` uses the same shape.
 */
const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../apps/web/src/api/useApiClient", () => ({
  useApiClient: () => client,
}));

const RELEASE_DIGEST = `sha256:${"a".repeat(64)}`;

const RELEASE = {
  release_digest: RELEASE_DIGEST,
  hub_id: "hub-1",
  status: "stable" as const,
  skill_count: 3,
  snapshot_rows: 3,
  sqlite_artifact_digest: `sha256:${"b".repeat(64)}`,
  mismatch_reason: null,
};

const row = (skill_id: string, name: string, namespace: string) => ({
  skill_id,
  name,
  namespace,
  description: `${name} description`,
  domains: [],
  frameworks: [],
  platforms: [],
  triggers: [],
  version_hash: `sha256:${"c".repeat(64)}`,
  l1_status: "MISSING" as const,
  l1_tokens: null,
  l2_tokens: 10,
  source_type: "local",
  provenance_status: "local-only" as const,
  schema_version: 1,
  content_digest: `sha256:${"d".repeat(64)}`,
});

const MATTPOCOCK = row("mattpocock/alpha", "Alpha", "mattpocock");
const EGA = row("egawilldoit/beta", "Beta", "egawilldoit");

const FACETS = {
  namespaces: [
    { value: "mattpocock", skill_count: 2 },
    { value: "egawilldoit", skill_count: 1 },
  ],
  domains: [],
  frameworks: [],
  platforms: [],
  triggers: [],
  aliases: [],
  sources: [{ value: "local", skill_count: 3 }],
  l1_statuses: [{ value: "MISSING", skill_count: 3 }],
  trust_levels: [],
};

const page = (skills: readonly unknown[], total: number, namespace: string | null) => ({
  workspace_id: "unscoped-release",
  hub_id: "hub-1",
  release: RELEASE,
  release_unavailable_reason: null,
  skill_total: 3,
  domain_total: 0,
  facets: FACETS,
  generated_at: "2026-10-17T00:00:00.000Z",
  skills,
  total,
  limit: 50,
  offset: 0,
  sort: "name",
  sort_direction: "asc",
  applied_filters: { q: null, namespace, domain: null, framework: null, source: null, l1: null },
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

function SkillProbe() {
  const { skillId } = useParams<{ skillId: string }>();
  return <output>{skillId}</output>;
}

function tree(): ReactElement {
  return (
    <MemoryRouter initialEntries={["/skills"]}>
      <Routes>
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/skills/:skillId" element={<SkillProbe />} />
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
    clickLink: (text: string) => {
      const link = [...container.querySelectorAll("a")].find((a) => a.textContent === text);
      if (!link) throw new Error(`link missing: ${text}`);
      act(() => dom!.click(link));
    },
  };
}

/** Let the resource effect settle and the real promise chain resolve. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("category browsing on the Skills page", () => {
  test("renders the categories the server sent, with the server's counts", async () => {
    client.get.mockResolvedValue(page([MATTPOCOCK, EGA], 3, null));
    const view = mount(tree());
    await settle();

    expect(view.text()).toContain("Browse by category");
    expect(view.text()).toContain("Publisher");
    expect(view.text()).toContain("mattpocock (2)");
    expect(view.text()).toContain("egawilldoit (1)");
    // No domain or framework value exists in this release, so those axes are not
    // offered in the panel at all rather than rendered empty. (The catalog's own
    // filter controls still list every axis; that is the existing control.)
    const axisTitles = [...view.container.querySelectorAll(".category-browse__axis-title")].map(
      (node) => node.textContent,
    );
    expect(axisTitles).toEqual(["Publisher"]);
    // The only request is the catalog itself; the panel reads no endpoint.
    expect(client.get.mock.calls.at(-1)?.[0]).toBe("/skills");
    expect(view.text()).toContain("mattpocock/alpha");
    expect(view.text()).toContain("egawilldoit/beta");
  });

  test("choosing a category re-reads the list through the catalog's own filter", async () => {
    client.get.mockImplementation((_path: string, options: { query: Record<string, unknown> }) =>
      Promise.resolve(
        options.query.namespace === "mattpocock"
          ? page([MATTPOCOCK], 2, "mattpocock")
          : page([MATTPOCOCK, EGA], 3, null),
      ),
    );
    const view = mount(tree());
    await settle();
    expect(view.text()).toContain("egawilldoit/beta");

    view.click("mattpocock (2)");
    await settle();

    const last = client.get.mock.calls.at(-1) as [string, { query: Record<string, unknown> }];
    expect(last[0]).toBe("/skills");
    expect(last[1].query).toEqual({ sort: "name", limit: 50, offset: 0, namespace: "mattpocock" });
    expect(view.button("mattpocock (2)").getAttribute("aria-pressed")).toBe("true");
    // The list is the server's answer for that category, not a client-side slice.
    expect(view.text()).toContain("mattpocock/alpha");
    expect(view.text()).not.toContain("egawilldoit/beta");
    // And the active category is attributed to the readable release digest.
    expect(view.text()).toContain("Category Publisher: mattpocock");
    expect(view.text()).toContain(shortDigest(RELEASE_DIGEST));
  });

  test("choosing the active category again clears it", async () => {
    client.get.mockImplementation((_path: string, options: { query: Record<string, unknown> }) =>
      Promise.resolve(
        options.query.namespace === "mattpocock"
          ? page([MATTPOCOCK], 2, "mattpocock")
          : page([MATTPOCOCK, EGA], 3, null),
      ),
    );
    const view = mount(tree());
    await settle();
    view.click("mattpocock (2)");
    await settle();
    view.click("mattpocock (2)");
    await settle();

    const last = client.get.mock.calls.at(-1) as [string, { query: Record<string, unknown> }];
    expect(last[1].query).toEqual({ sort: "name", limit: 50, offset: 0 });
    expect(view.text()).toContain("egawilldoit/beta");
  });

  test("a category with no matching skills reports an honest zero and stays recoverable", async () => {
    client.get.mockImplementation((_path: string, options: { query: Record<string, unknown> }) =>
      Promise.resolve(
        options.query.namespace === "mattpocock"
          ? page([], 0, "mattpocock")
          : page([MATTPOCOCK, EGA], 3, null),
      ),
    );
    const view = mount(tree());
    await settle();

    view.click("mattpocock (2)");
    await settle();

    expect(view.text()).toContain("No skills match");
    // No row is invented for the empty result.
    expect(view.container.querySelector("table")).toBeNull();
    expect(view.text()).not.toContain("mattpocock/alpha");

    // The controls stay mounted, so the operator can get back without editing
    // the URL.
    view.click("Clear filters");
    await settle();
    expect(view.text()).toContain("egawilldoit/beta");
  });

  test("clicking a category's skill opens the existing skill detail route", async () => {
    client.get.mockResolvedValue(page([MATTPOCOCK, EGA], 3, null));
    const view = mount(tree());
    await settle();

    const beforeNavigation = client.get.mock.calls.length;
    view.clickLink("mattpocock/alpha");
    await settle();

    // The existing `/skills/:skillId` route received the exact released id, and
    // navigating issued no further catalog read.
    expect(view.container.querySelector("output")?.textContent).toBe("mattpocock/alpha");
    expect(client.get.mock.calls.length).toBe(beforeNavigation);
  });
});
