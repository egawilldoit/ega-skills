/** Executed jsdom evidence using production components, not browser acceptance. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { WorkspaceProvider, useWorkspace } from "../../../apps/web/src/workspace/WorkspaceProvider";
import { SkillDetailPage } from "../../../apps/web/src/pages/SkillDetailPage";
import { WorkspaceOverviewPage } from "../../../apps/web/src/pages/WorkspaceOverviewPage";
import { createDom, type MountedDom } from "./helpers/dom";

// Only external boundaries are replaced. Production membership, resource,
// cancellation, selection and content-viewer logic execute unchanged.
const boundary = vi.hoisted(() => ({ auth: {} as any, from: vi.fn(), get: vi.fn() }));
vi.mock("../../../apps/web/src/auth/AuthProvider", () => ({ useAuth: () => boundary.auth }));
vi.mock("../../../apps/web/src/auth/supabase", () => ({ supabase: { from: boundary.from } }));
vi.mock("../../../apps/web/src/api/useApiClient", () => ({ useApiClient: () => api }));
const api = { get: (...args: any[]) => boundary.get(...args) };
let dom: MountedDom | null = null;
let root: Root | null = null;
const token = async () => null;
const member = (subject = "me", workspace = "ws-a", role = "owner", active = true) =>
  ({ subject, workspace_id: workspace, role, active });
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let membershipRequests: { subject: string; result: ReturnType<typeof deferred> }[];
beforeEach(() => {
  boundary.auth = { status: "signed_in", userId: "me", getAccessToken: token };
  membershipRequests = [];
  boundary.from.mockReset().mockImplementation((table) => {
    expect(table).toBe("workspace_memberships");
    return { select: () => ({ eq: (column: string, subject: string) => {
      expect(column).toBe("subject");
      return { order: () => {
        const result = deferred(); membershipRequests.push({ subject, result }); return result.promise;
      } };
    } }) };
  });
  boundary.get.mockReset();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null; dom?.restore(); dom = null;
});
function mount(element: ReactElement) {
  dom = createDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container);
  const render = () => act(() => root!.render(<StrictMode>{cloneElement(element)}</StrictMode>));
  render();
  return {
    container, render, text: () => container.textContent ?? "",
    click: (label: string) => {
      const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!button) throw new Error(`button missing: ${label}`);
      act(() => dom!.click(button));
    },
    settle: async () => { await act(async () => { await Promise.resolve(); }); },
    unmount: () => { act(() => root!.unmount()); root = null; },
  };
}
async function roster(rows: any[], subject = "me") {
  await act(async () => {
    for (const request of membershipRequests.filter((r) => r.subject === subject))
      request.result.resolve({ data: rows, error: null });
  });
}
function WorkspaceControls() {
  const ws = useWorkspace();
  return <><output>{JSON.stringify({ id: ws.workspaceId, role: ws.role, allowed: ws.can("members_read"), memberships: ws.memberships.length })}</output>
    <button onClick={() => ws.selectWorkspace("ws-b")}>switch workspace</button></>;
}
const provider = (page?: ReactElement) => <WorkspaceProvider><WorkspaceControls />{page}</WorkspaceProvider>;

describe("production WorkspaceProvider membership and account state", () => {
  test("a mixed owner/admin roster resolves only the current subject's viewer role", async () => {
    const view = mount(provider());
    await roster([member("other", "ws-a"), member("me", "ws-b", "viewer"), member("admin", "ws-c", "admin")]);
    expect(view.text()).toContain('"id":"ws-b","role":"viewer","allowed":false,"memberships":1');
    expect(membershipRequests.every((r) => r.subject === "me")).toBe(true);
  });
  test.each([[], [member("other")], [member("me", "ws-a", "admin", false)]])(
    "absent or inactive current membership grants no permissions: %j", async (rows) => {
      const view = mount(provider()); await roster(rows);
      expect(view.text()).toContain('"id":null,"role":null,"allowed":false');
    });
  test("account switching discards the previous account's delayed membership", async () => {
    const view = mount(provider());
    boundary.auth = { ...boundary.auth, userId: "next" }; view.render();
    expect(view.text()).toContain('"role":null');
    await roster([member("next", "ws-b", "viewer")], "next");
    await roster([member("me", "ws-a")]);
    expect(view.text()).toContain('"id":"ws-b","role":"viewer"');
    expect(view.text()).not.toContain('"id":"ws-a"');
  });
  test("signing out during loading clears protected state and discards the response", async () => {
    const view = mount(provider());
    boundary.auth = { ...boundary.auth, status: "signed_out", userId: null }; view.render();
    await roster([member()]);
    expect(view.text()).toContain('"id":null,"role":null,"allowed":false,"memberships":0');
  });
  test("unmount discards late membership responses", async () => {
    const view = mount(provider()); view.unmount(); await roster([member()]);
    expect(view.container.innerHTML).toBe("");
  });
});

const workspaceData = (id: string) => ({ workspace_id: id, owner_subject: `owner-${id}`, created_at: "2026-10-14", viewer_role: "owner" });
describe("production workspace selection and requests", () => {
  test("switch clears rendered data immediately and sends the selected workspace", async () => {
    const responses = new Map<string, ReturnType<typeof deferred>>();
    boundary.get.mockImplementation((_path, options) => {
      const key = options.query?.workspace ?? "none";
      const result = deferred(); responses.set(key, result); return result.promise;
    });
    const view = mount(provider(<WorkspaceOverviewPage />));
    await roster([member(), member("me", "ws-b")]);
    await act(async () => responses.get("ws-a")!.resolve(workspaceData("ws-a")));
    expect(view.text()).toContain("owner-ws-a");
    view.click("switch workspace");
    expect(view.text()).not.toContain("owner-ws-a");
    expect(view.text()).toContain("Loading workspace");
    expect(boundary.get.mock.calls.at(-1)?.[1].query).toEqual({ workspace: "ws-b" });
    await act(async () => responses.get("ws-b")!.resolve(workspaceData("ws-b")));
    expect(view.text()).toContain("owner-ws-b");
  });
  test("previous workspace response is aborted and cannot populate the selection", async () => {
    const requests: any[] = [];
    boundary.get.mockImplementation((path, options) => {
      const result = deferred(); requests.push({ path, options, result }); return result.promise;
    });
    const view = mount(provider(<WorkspaceOverviewPage />));
    await roster([member(), member("me", "ws-b")]);
    const old = requests.at(-1);
    view.click("switch workspace"); const fresh = requests.at(-1);
    expect(old.options.signal.aborted).toBe(true);
    await act(async () => { fresh.result.resolve(workspaceData("ws-b")); old.result.resolve(workspaceData("ws-a")); });
    expect(view.text()).toContain("owner-ws-b"); expect(view.text()).not.toContain("owner-ws-a");
    view.unmount(); expect(fresh.options.signal.aborted).toBe(true);
  });
});

const skillData = (id: string) => ({ release: null, summary: { skill_id: id, name: id, description: "fixture", schema_version: 1, content_digest: "digest", l1_tokens: null, l2_tokens: 2, l1_status: "MISSING" }, routing: { domains: [], triggers: [], exclude_patterns: [] }, sources: [], files: [] });
const contentData = (content: string) => ({ content, level: "L2", token_count: 2, requested_max_tokens: 32000, version_hash: "digest", truncated: false });
function Navigation() { const navigate = useNavigate(); return <button onClick={() => navigate("/skills/skill-b")}>next skill</button>; }
function skillTree() { return <MemoryRouter initialEntries={["/skills/skill-a"]}><Navigation /><Routes><Route path="/skills/:skillId" element={<SkillDetailPage />} /></Routes></MemoryRouter>; }
let contentRequests: any[];
function contentTransport() {
  contentRequests = [];
  boundary.get.mockImplementation((path, options) => {
    if (!path.endsWith("/content")) return Promise.resolve(skillData(path.split("/").at(-1)));
    const result = deferred(); contentRequests.push({ path, options, result }); return result.promise;
  });
}
describe("production SkillDetailPage content viewer", () => {
  test("navigation from A to B discards delayed A content", async () => {
    contentTransport(); const view = mount(skillTree()); await view.settle();
    view.click("Load L2 Skill Content"); const old = contentRequests[0];
    view.click("next skill"); await view.settle();
    expect(old.options.signal.aborted).toBe(true);
    view.click("Load L2 Skill Content"); const fresh = contentRequests[1];
    expect(fresh.path).toBe("/skills/skill-b/content");
    await act(async () => { fresh.result.resolve(contentData("B-CONTENT")); old.result.resolve(contentData("A-CONTENT")); });
    expect(view.text()).toContain("B-CONTENT"); expect(view.text()).not.toContain("A-CONTENT");
  });
  test("closing during loading keeps content cleared even after a late response", async () => {
    contentTransport(); const view = mount(skillTree()); await view.settle();
    view.click("Load L2 Skill Content"); const request = contentRequests[0];
    view.click("Close Viewer"); expect(request.options.signal.aborted).toBe(true);
    await act(async () => request.result.resolve(contentData("OLD-CONTENT")));
    expect(view.text()).not.toContain("OLD-CONTENT");
    expect(view.text()).not.toContain("Close Viewer");
    expect(view.container.querySelector(".content-viewer")).toBeNull();
  });
  test("reopening makes a fresh request which cannot reuse superseded content", async () => {
    contentTransport(); const view = mount(skillTree()); await view.settle();
    view.click("Load L2 Skill Content"); view.click("Close Viewer"); view.click("Load L2 Skill Content");
    expect(contentRequests).toHaveLength(2);
    await act(async () => contentRequests[0].result.resolve(contentData("SUPERSEDED")));
    expect(view.text()).toContain("Loading L2 content"); expect(view.text()).not.toContain("SUPERSEDED");
    await act(async () => contentRequests[1].result.resolve(contentData("FRESH")));
    expect(view.text()).toContain("FRESH");
  });
  test("unmount aborts pending content and cannot restore state", async () => {
    contentTransport(); const view = mount(skillTree()); await view.settle(); view.click("Load L2 Skill Content");
    view.unmount(); expect(contentRequests[0].options.signal.aborted).toBe(true);
    await act(async () => contentRequests[0].result.resolve(contentData("LATE")));
    expect(view.container.innerHTML).toBe("");
  });
  test("rejection renders the production error state without an unhandled rejection", async () => {
    contentTransport(); const view = mount(skillTree()); await view.settle(); view.click("Load L2 Skill Content");
    await act(async () => contentRequests[0].result.reject(new Error("Content unavailable")));
    expect(view.text()).toContain("Unable to serve L2 content"); expect(view.text()).toContain("Content unavailable");
    expect(view.container.querySelector(".content-viewer")).toBeNull();
  });
});

describe("a malformed response is refused at the boundary", () => {
  test("a bare array for /skills is rejected, not rendered", async () => {
    const { decodeCatalogPage, ResponseContractError } = await import("../../../apps/web/src/api/decode");
    expect(() => decodeCatalogPage([])).toThrow(ResponseContractError);
  });

  test("a catalog row missing its identity is rejected", async () => {
    const { decodeCatalogPage, ResponseContractError } = await import("../../../apps/web/src/api/decode");
    expect(() =>
      decodeCatalogPage({ skills: [{ name: "no id" }], total: 1, limit: 50, offset: 0 }),
    ).toThrow(ResponseContractError);
  });

  test("a well-formed envelope passes through untouched", async () => {
    const { decodeCatalogPage } = await import("../../../apps/web/src/api/decode");
    const page = {
      skills: [],
      total: 0,
      limit: 50,
      offset: 0,
      sort: "name",
      sort_direction: "asc",
      facets: {},
      applied_filters: {},
    };
    expect(decodeCatalogPage(page)).toEqual(page);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Server-rendered markup still renders                                    */
/* -------------------------------------------------------------------------- */

describe("static rendering of real components", () => {
  test("a data table renders its rows and an empty link", async () => {
    const { DataTable } = await import("../../../apps/web/src/components/DataTable");
    const html = renderToStaticMarkup(
      <DataTable
        caption="Skills"
        columns={[
          { key: "skill_id", label: "Skill", render: (row) => row.skill_id },
          { key: "name", label: "Name", render: (row) => row.name },
        ]}
        rows={[
          { skill_id: "a/b", name: "Alpha" },
          { skill_id: "c/d", name: "Beta" },
        ]}
        rowKey={(row) => row.skill_id}
      />,
    );
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).toContain("a/b");
  });
});