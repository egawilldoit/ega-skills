/**
 * Executed jsdom evidence for EGA-822 source navigation.
 *
 * The production SkillDetailPage and SourceSkillsPage render unchanged. Only the
 * BFF client boundary and the workspace role are replaced, so the exact-match
 * rule, the pinned revision check, the existing update form and the existing
 * role gate are the real implementations.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { SkillDetailPage } from "../../../apps/web/src/pages/SkillDetailPage";
import { SourceSkillsPage } from "../../../apps/web/src/pages/SourceSkillsPage";
import { createDom, type MountedDom } from "./helpers/dom";

const boundary = vi.hoisted(() => {
  const get = vi.fn();
  return { get, client: { get }, role: "owner" as string };
});
vi.mock("../../../apps/web/src/api/useApiClient", () => ({
  useApiClient: () => boundary.client,
}));
vi.mock("../../../apps/web/src/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => ({ role: boundary.role }),
}));
// The source page's parser is an external dependency. The fixture YAML is
// deliberately simple, so parse it here instead of asking Vitest to transform
// the whole YAML package for this navigation test.
vi.mock("yaml", () => ({
  parse: (text: string) => {
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (name && description) return { name, description };
    return {
      triggers: ["source"],
      anti_triggers: [],
      domains: [],
      platforms: [],
      frameworks: [],
      aliases: [],
    };
  },
}));

const SOURCE_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const RELEASE = {
  release_digest: `sha256:${"c".repeat(64)}`,
  hub_id: "hub-1",
  status: "stable" as const,
  skill_count: 1,
  snapshot_rows: 1,
  sqlite_artifact_digest: `sha256:${"d".repeat(64)}`,
  mismatch_reason: null,
};
const ALPHA = { name: "alpha", description: "Alpha skill", provenance: "original" };
const BETA = { name: "beta", description: "Beta skill", provenance: "adapted" };

const sourceIndex = (items: readonly unknown[], sha = SOURCE_SHA) => ({ sha, total: items.length, items });

const skillDetail = (skillId: string, name: string) => ({
  release: RELEASE,
  summary: {
    skill_id: skillId,
    namespace: skillId.split("/")[0],
    name,
    description: "fixture",
    schema_version: 1,
    version_hash: `sha256:${"e".repeat(64)}`,
    content_digest: "digest",
    l1_tokens: null,
    l2_tokens: 2,
    l1_status: "MISSING",
  },
  routing: { domains: [], triggers: [], exclude_patterns: [] },
  sources: [],
  files: [],
});

const sourceDetail = (name: string) => ({
  sha: SOURCE_SHA,
  files: [
    {
      path: "SKILL.md",
      contentBase64: Buffer.from(`---\nname: ${name}\ndescription: Source ${name}\n---\n\n# ${name}\n`).toString("base64"),
    },
    {
      path: "ega.yaml",
      contentBase64: Buffer.from("triggers:\n  - source\nanti_triggers: []\ndomains: []\nplatforms: []\nframeworks: []\naliases: []\n").toString("base64"),
    },
  ],
});

const CATALOG = {
  workspace_id: "unscoped-release",
  hub_id: "hub-1",
  release: RELEASE,
  release_unavailable_reason: null,
  skill_total: 0,
  domain_total: 0,
  facets: {
    namespaces: [],
    domains: [],
    frameworks: [],
    groups: [],
    platforms: [],
    triggers: [],
    aliases: [],
    sources: [],
    l1_statuses: [],
    trust_levels: [],
  },
  generated_at: "2026-11-04T00:00:00.000Z",
  skills: [],
  total: 0,
  limit: 200,
  offset: 0,
  sort: "name",
  sort_direction: "asc",
  applied_filters: { q: null, namespace: "egawilldoit", domain: null, framework: null, group: null, source: null, l1: null },
};

let dom: MountedDom | null = null;
let root: Root | null = null;

beforeEach(() => {
  boundary.get.mockReset();
  boundary.role = "owner";
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
  return { container, text: () => container.textContent ?? "" };
}

async function settle(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function detailTree(skillId: string) {
  return (
    <MemoryRouter initialEntries={[`/skills/${encodeURIComponent(skillId)}`]}>
      <Routes>
        <Route path="/skills/:skillId" element={<SkillDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function detailTransport(skillId: string, name: string, index: unknown, sourceFailure?: unknown) {
  boundary.get.mockImplementation((path: string) => {
    if (path === `/skills/${encodeURIComponent(skillId)}`) return Promise.resolve(skillDetail(skillId, name));
    if (path === "/source-skills") return sourceFailure ? Promise.reject(sourceFailure) : Promise.resolve(index);
    if (path === "/hosted-release-status") {
      return Promise.resolve({
        state: "unknown",
        console_release_digest: RELEASE.release_digest,
        hosted_release_digest: null,
        observed_at: null,
        checked_at: "2026-11-04T00:00:00.000Z",
        reason: "not checked in this component test",
        endpoint: "https://ega-skills-mcp.vercel.app/readyz",
      });
    }
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
}

function sourceTree(search: string) {
  return (
    <MemoryRouter initialEntries={[`/source-skills${search}`]}>
      <LocationProbe />
      <Routes>
        <Route path="/source-skills" element={<SourceSkillsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function sourceTransport(index: unknown, calls: string[]) {
  boundary.get.mockImplementation((path: string) => {
    if (path === "/source-skills") return Promise.resolve(index);
    if (path === "/skills") return Promise.resolve(CATALOG);
    if (path.startsWith("/source-skills/")) {
      calls.push(path);
      return Promise.resolve(sourceDetail(path.slice("/source-skills/".length)));
    }
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
}

describe("SkillDetailPage source navigation", () => {
  test("a released skill with an exact source match links to the matching pinned editor", async () => {
    detailTransport("egawilldoit/alpha", "alpha", sourceIndex([ALPHA]));
    const view = mount(detailTree("egawilldoit/alpha"));
    await settle();

    expect(view.text()).toContain("Source");
    expect(view.text()).toContain("Editing source creates a pull request proposal. It does not publish a release.");
    const link = [...view.container.querySelectorAll("a")].find(node => node.textContent === "Manage source");
    expect(link?.getAttribute("href")).toBe(`/source-skills?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`);
  });

  test("a missing source name shows unavailable and never links to a similar item", async () => {
    detailTransport("egawilldoit/alpha", "alpha", sourceIndex([BETA]));
    const view = mount(detailTree("egawilldoit/alpha"));
    await settle();

    expect(view.text()).toContain('No exact source skill named "alpha"');
    expect(view.text()).not.toContain("Manage source");
    expect(view.container.querySelector('a[href*="beta"]')).toBeNull();
  });

  test("an unsupported namespace shows unavailable and offers no editor link", async () => {
    detailTransport("mattpocock/alpha", "alpha", sourceIndex([ALPHA]));
    const view = mount(detailTree("mattpocock/alpha"));
    await settle();

    expect(view.text()).toContain("Source editing supports egawilldoit skills only");
    expect(view.text()).not.toContain("Manage source");
  });

  test("a forbidden source index shows the account refusal and offers no editor link", async () => {
    detailTransport("egawilldoit/alpha", "alpha", null, {
      kind: "forbidden",
      message: "This account cannot manage source skills.",
      code: "E_SOURCE_FORBIDDEN",
      status: 403,
      retryable: false,
    });
    const view = mount(detailTree("egawilldoit/alpha"));
    await settle();

    expect(view.text()).toContain("Source editing is unavailable for this account.");
    expect(view.text()).not.toContain("Manage source");
  });
});

describe("SourceSkillsPage exact source query", () => {
  test("an exact match opens the existing update form and consumes the query", async () => {
    const calls: string[] = [];
    sourceTransport(sourceIndex([ALPHA]), calls);
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    expect(view.text()).toContain("Edit alpha");
    expect(view.text()).toContain("Review changes");
    expect(calls).toEqual(["/source-skills/alpha"]);
    expect(view.container.querySelector('[data-testid="location"]')?.textContent).toBe("");
  });

  test("a missing source name stays on the list and opens no editor", async () => {
    const calls: string[] = [];
    sourceTransport(sourceIndex([BETA]), calls);
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    expect(view.text()).toContain('No exact source skill named "alpha"');
    expect(view.text()).not.toContain("Review changes");
    expect(calls).toEqual([]);
  });

  test("a changed pinned revision stays on the list and opens no editor", async () => {
    const calls: string[] = [];
    sourceTransport(sourceIndex([ALPHA]), calls);
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${OTHER_SHA}`));
    await settle();

    expect(view.text()).toContain("Source main changed since this skill was opened. Refresh source and compare again.");
    expect(view.text()).not.toContain("Review changes");
    expect(calls).toEqual([]);
  });

  test("an unsupported namespace stays on the list and opens no editor", async () => {
    const calls: string[] = [];
    sourceTransport(sourceIndex([ALPHA]), calls);
    const view = mount(sourceTree(`?skill=mattpocock%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    expect(view.text()).toContain("Source editing supports egawilldoit skills only");
    expect(view.text()).not.toContain("Review changes");
    expect(calls).toEqual([]);
  });

  test("a non-owner sees the existing refusal and the source index is never requested", async () => {
    boundary.role = "viewer";
    const calls: string[] = [];
    sourceTransport(sourceIndex([ALPHA]), calls);
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    expect(view.text()).toContain("Source management is available to workspace owners with editor access.");
    expect(boundary.get).not.toHaveBeenCalled();
  });
});
