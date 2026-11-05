/**
 * Executed jsdom evidence for EGA-822 source navigation.
 *
 * The production SkillDetailPage and SourceSkillsPage render unchanged. Only the
 * BFF client boundary and the workspace role are replaced, so the explicit
 * source check, exact-match rule, pinned revision check, stale-request guard,
 * existing update form and existing role gate are the real implementations.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, act, cloneElement, useState, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
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
const HOSTED_STATUS = {
  state: "unknown",
  console_release_digest: RELEASE.release_digest,
  hosted_release_digest: null,
  observed_at: null,
  checked_at: "2026-11-04T00:00:00.000Z",
  reason: "not checked in this component test",
  endpoint: "https://ega-skills-mcp.vercel.app/readyz",
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

type RequestCall = { readonly path: string; readonly signal?: AbortSignal };

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
  const render = (): void => {
    act(() => root!.render(<StrictMode>{cloneElement(element)}</StrictMode>));
  };
  render();
  return {
    container,
    text: () => container.textContent ?? "",
    render,
    click: (label: string) => {
      const button = [...container.querySelectorAll("button")].find(node => node.textContent === label);
      if (!button) throw new Error(`button missing: ${label}`);
      act(() => dom!.click(button));
    },
    unmount: () => {
      act(() => root!.unmount());
      root = null;
    },
  };
}

async function settle(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function DetailNav() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/skills/${encodeURIComponent("egawilldoit/beta")}`)}>open beta</button>;
}

function detailTree(skillId: string) {
  return (
    <MemoryRouter initialEntries={[`/skills/${encodeURIComponent(skillId)}`]}>
      <DetailNav />
      <Routes>
        <Route path="/skills/:skillId" element={<SkillDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function detailTransport(source: unknown | (() => Promise<unknown>)): RequestCall[] {
  const calls: RequestCall[] = [];
  boundary.get.mockImplementation((path: string, options?: { signal?: AbortSignal }) => {
    calls.push({ path, ...(options?.signal ? { signal: options.signal } : {}) });
    if (path.startsWith("/skills/")) {
      const decoded = decodeURIComponent(path.slice("/skills/".length));
      return Promise.resolve(skillDetail(decoded, decoded.split("/")[1] ?? "skill"));
    }
    if (path === "/source-skills") return typeof source === "function" ? source() : Promise.resolve(source);
    if (path === "/hosted-release-status") return Promise.resolve(HOSTED_STATUS);
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
  return calls;
}

function SourceNav() {
  const navigate = useNavigate();
  const open = (name: string): void => {
    navigate(`/source-skills?skill=${encodeURIComponent(`egawilldoit/${name}`)}&sha=${SOURCE_SHA}`);
  };
  return (
    <>
      <button onClick={() => open("alpha")}>open alpha</button>
      <button onClick={() => open("beta")}>open beta</button>
      <button onClick={() => navigate(`/source-skills?skill=${encodeURIComponent("egawilldoit/beta")}`)}>open beta without sha</button>
    </>
  );
}

function VersionedSourcePage({ version }: { readonly version: number }) {
  return (
    <>
      <output data-testid="source-version">{version}</output>
      <SourceSkillsPage />
    </>
  );
}

function RoleHarness() {
  const [version, setVersion] = useState(0);
  return (
    <>
      <button
        onClick={() => {
          boundary.role = "viewer";
          setVersion(value => value + 1);
        }}
      >
        become viewer
      </button>
      <LocationProbe />
      <SourceNav />
      <Routes>
        <Route path="/source-skills" element={<VersionedSourcePage version={version} />} />
      </Routes>
    </>
  );
}

function sourceTree(search: string) {
  return (
    <MemoryRouter initialEntries={[`/source-skills${search}`]}>
      <RoleHarness />
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

type DetailResponder = (path: string, options: { signal?: AbortSignal }) => Promise<unknown>;

function sourceTransport(index: unknown, detail: DetailResponder, calls: RequestCall[] = []): RequestCall[] {
  boundary.get.mockImplementation((path: string, options?: { signal?: AbortSignal }) => {
    if (path === "/source-skills") return Promise.resolve(index);
    if (path === "/skills") return Promise.resolve(CATALOG);
    if (path.startsWith("/source-skills/")) {
      calls.push({ path, ...(options?.signal ? { signal: options.signal } : {}) });
      return detail(path, options ?? {});
    }
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
  return calls;
}

function immediateDetail(path: string): Promise<unknown> {
  return Promise.resolve(sourceDetail(path.slice("/source-skills/".length)));
}

describe("SkillDetailPage explicit source check", () => {
  test("opening a released detail makes no source request until the owner asks", async () => {
    const calls = detailTransport(sourceIndex([ALPHA]));
    const view = mount(detailTree("egawilldoit/alpha"));
    await settle();

    expect(view.text()).toContain("Check source availability");
    expect(calls.filter(call => call.path === "/source-skills")).toHaveLength(0);

    view.click("Check source availability");
    await settle();

    expect(calls.filter(call => call.path === "/source-skills")).toHaveLength(1);
    expect(view.text()).toContain("Editing source creates a pull request proposal. It does not publish a release.");
    const link = [...view.container.querySelectorAll("a")].find(node => node.textContent === "Manage source");
    expect(link?.getAttribute("href")).toBe(`/source-skills?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`);
  });

  test("a missing source name shows unavailable and never links to a similar item", async () => {
    detailTransport(sourceIndex([BETA]));
    const view = mount(detailTree("egawilldoit/alpha"));
    await settle();
    view.click("Check source availability");
    await settle();

    expect(view.text()).toContain('No exact source skill named "alpha"');
    expect(view.text()).not.toContain("Manage source");
    expect(view.container.querySelector('a[href*="beta"]')).toBeNull();
  });

  test("an unsupported namespace is rejected without any source request", async () => {
    const calls = detailTransport(sourceIndex([ALPHA]));
    const view = mount(detailTree("mattpocock/alpha"));
    await settle();

    expect(view.text()).toContain("Source editing supports egawilldoit skills only");
    expect(view.text()).not.toContain("Check source availability");
    expect(calls.filter(call => call.path === "/source-skills")).toHaveLength(0);
  });

  test("a forbidden source index shows the account refusal and offers no editor link", async () => {
    detailTransport(() => Promise.reject({
      kind: "forbidden",
      message: "This account cannot manage source skills.",
      code: "E_SOURCE_FORBIDDEN",
      status: 403,
      retryable: false,
    }));
    const view = mount(detailTree("egawilldoit/alpha"));
    await settle();
    view.click("Check source availability");
    await settle();

    expect(view.text()).toContain("Source editing is unavailable for this account.");
    expect(view.text()).not.toContain("Manage source");
  });

  test("a non-owner sees the access message and triggers no source request", async () => {
    boundary.role = "viewer";
    const calls = detailTransport(sourceIndex([ALPHA]));
    const view = mount(detailTree("egawilldoit/alpha"));
    await settle();

    expect(view.text()).toContain("Source editing is available to workspace owners with editor access.");
    expect(view.text()).not.toContain("Check source availability");
    expect(calls.filter(call => call.path === "/source-skills")).toHaveLength(0);
  });

  test("navigation discards an obsolete source check and exposes no stale link", async () => {
    let resolveSource!: (value: unknown) => void;
    const sourcePromise = new Promise<unknown>(resolve => {
      resolveSource = resolve;
    });
    const calls = detailTransport(() => sourcePromise);
    const view = mount(detailTree("egawilldoit/alpha"));
    await settle();
    view.click("Check source availability");
    await settle();

    const sourceCall = calls.find(call => call.path === "/source-skills");
    expect(sourceCall?.signal?.aborted).toBe(false);

    view.click("open beta");
    await settle();
    expect(sourceCall?.signal?.aborted).toBe(true);

    resolveSource(sourceIndex([ALPHA]));
    await settle();

    expect(view.text()).not.toContain("Manage source");
    expect(view.text()).toContain("egawilldoit/beta");
  });
});

describe("SourceSkillsPage exact source query", () => {
  test("an exact match opens the existing update form and consumes the query", async () => {
    const calls = sourceTransport(sourceIndex([ALPHA]), immediateDetail);
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    expect(view.text()).toContain("Edit alpha");
    expect(view.text()).toContain("Review changes");
    expect(calls.map(call => call.path)).toEqual(["/source-skills/alpha"]);
    expect(view.container.querySelector('[data-testid="location"]')?.textContent).toBe("");
  });

  test("a missing pinned SHA is refused without requesting source detail", async () => {
    const calls = sourceTransport(sourceIndex([ALPHA]), immediateDetail);
    const view = mount(sourceTree("?skill=egawilldoit%2Falpha"));
    await settle();

    expect(view.text()).toContain("A pinned source revision is required");
    expect(view.text()).not.toContain("Review changes");
    expect(calls).toEqual([]);
  });

  test("an invalid pinned SHA is refused without requesting source detail", async () => {
    const calls = sourceTransport(sourceIndex([ALPHA]), immediateDetail);
    const view = mount(sourceTree("?skill=egawilldoit%2Falpha&sha=not-a-sha"));
    await settle();

    expect(view.text()).toContain("The source revision in this link is invalid");
    expect(view.text()).not.toContain("Review changes");
    expect(calls).toEqual([]);
  });

  test("a missing source name stays on the list and opens no editor", async () => {
    const calls = sourceTransport(sourceIndex([BETA]), immediateDetail);
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    expect(view.text()).toContain('No exact source skill named "alpha"');
    expect(view.text()).not.toContain("Review changes");
    expect(calls).toEqual([]);
  });

  test("a changed pinned revision stays on the list and opens no editor", async () => {
    const calls = sourceTransport(sourceIndex([ALPHA]), immediateDetail);
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${OTHER_SHA}`));
    await settle();

    expect(view.text()).toContain("Source main changed since this skill was opened. Refresh source and compare again.");
    expect(view.text()).not.toContain("Review changes");
    expect(calls).toEqual([]);
  });

  test("an unsupported namespace stays on the list and opens no editor", async () => {
    const calls = sourceTransport(sourceIndex([ALPHA]), immediateDetail);
    const view = mount(sourceTree(`?skill=mattpocock%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    expect(view.text()).toContain("Source editing supports egawilldoit skills only");
    expect(view.text()).not.toContain("Review changes");
    expect(calls).toEqual([]);
  });

  test("a non-owner sees the existing refusal and the source index is never requested", async () => {
    boundary.role = "viewer";
    const calls = sourceTransport(sourceIndex([ALPHA]), immediateDetail);
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    expect(view.text()).toContain("Source management is available to workspace owners with editor access.");
    expect(boundary.get).not.toHaveBeenCalled();
  });

  test("a newer requested skill survives an older response that resolves last", async () => {
    const pending = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (cause: unknown) => void; signal?: AbortSignal }>();
    sourceTransport(sourceIndex([ALPHA, BETA]), (path, options) => {
      const request = deferred();
      pending.set(path, { ...request, signal: options.signal });
      return request.promise;
    });
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    expect(pending.has("/source-skills/alpha")).toBe(true);
    view.click("open beta");
    await settle();
    expect(pending.has("/source-skills/beta")).toBe(true);

    pending.get("/source-skills/beta")!.resolve(sourceDetail("beta"));
    await settle();
    expect(view.text()).toContain("Edit beta");

    pending.get("/source-skills/alpha")!.resolve(sourceDetail("alpha"));
    await settle();
    expect(view.text()).toContain("Edit beta");
    expect(view.text()).not.toContain("Edit alpha");
  });

  test("a late older failure does not replace the newer editor or its state", async () => {
    const pending = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (cause: unknown) => void; signal?: AbortSignal }>();
    sourceTransport(sourceIndex([ALPHA, BETA]), (path, options) => {
      const request = deferred();
      pending.set(path, { ...request, signal: options.signal });
      return request.promise;
    });
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();
    view.click("open beta");
    await settle();

    pending.get("/source-skills/beta")!.resolve(sourceDetail("beta"));
    await settle();
    expect(view.text()).toContain("Edit beta");

    pending.get("/source-skills/alpha")!.reject(new Error("older source request failed"));
    await settle();
    expect(view.text()).toContain("Edit beta");
    expect(view.text()).not.toContain("older source request failed");
  });

  test("unmount aborts a pending editor request", async () => {
    const pending = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (cause: unknown) => void; signal?: AbortSignal }>();
    sourceTransport(sourceIndex([ALPHA]), (path, options) => {
      const request = deferred();
      pending.set(path, { ...request, signal: options.signal });
      return request.promise;
    });
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    const request = pending.get("/source-skills/alpha");
    expect(request).toBeDefined();
    view.unmount();
    expect(request?.signal?.aborted).toBe(true);
    request?.resolve(sourceDetail("alpha"));
  });

  test("an owner-to-viewer transition aborts the pending editor request", async () => {
    const pending = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (cause: unknown) => void; signal?: AbortSignal }>();
    sourceTransport(sourceIndex([ALPHA]), (path, options) => {
      const request = deferred();
      pending.set(path, { ...request, signal: options.signal });
      return request.promise;
    });
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    view.click("become viewer");
    await settle();
    expect(view.text()).toContain("Source management is available to workspace owners with editor access.");

    pending.get("/source-skills/alpha")!.resolve(sourceDetail("alpha"));
    await settle();
    expect(view.text()).toContain("Source management is available to workspace owners with editor access.");
    expect(view.text()).not.toContain("Edit alpha");
  });

  test("an invalid newer query aborts the older pending editor request", async () => {
    const pending = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (cause: unknown) => void; signal?: AbortSignal }>();
    sourceTransport(sourceIndex([ALPHA, BETA]), (path, options) => {
      const request = deferred();
      pending.set(path, { ...request, signal: options.signal });
      return request.promise;
    });
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    const alphaRequest = pending.get("/source-skills/alpha");
    expect(alphaRequest).toBeDefined();
    view.click("open beta without sha");
    await settle();
    expect(alphaRequest?.signal?.aborted).toBe(true);
    expect(view.text()).toContain("A pinned source revision is required");

    alphaRequest!.resolve(sourceDetail("alpha"));
    await settle();
    expect(view.text()).toContain("A pinned source revision is required");
    expect(view.text()).not.toContain("Edit alpha");
  });

  test("StrictMode keeps the initial query edit request alive", async () => {
    const pending = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (cause: unknown) => void; signal?: AbortSignal }>();
    sourceTransport(sourceIndex([ALPHA]), (path, options) => {
      const request = deferred();
      pending.set(path, { ...request, signal: options.signal });
      return request.promise;
    });
    const view = mount(sourceTree(`?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`));
    await settle();

    const request = pending.get("/source-skills/alpha");
    expect(request).toBeDefined();
    expect(request?.signal?.aborted).toBe(false);
    request!.resolve(sourceDetail("alpha"));
    await settle();
    expect(view.text()).toContain("Edit alpha");
  });

  test("the existing manual Edit skill action still opens the editor", async () => {
    const calls = sourceTransport(sourceIndex([ALPHA, BETA]), immediateDetail);
    const view = mount(sourceTree(""));
    await settle();

    view.click("Edit skill");
    await settle();

    expect(view.text()).toContain("Edit alpha");
    expect(view.text()).toContain("Review changes");
    expect(calls.map(call => call.path)).toEqual(["/source-skills/alpha"]);
  });
});
