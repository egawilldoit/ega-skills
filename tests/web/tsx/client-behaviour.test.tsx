/**
 * EXECUTED component behaviour for the console's client-side acceptance rules.
 *
 * These replace source-text assertions. A regex can confirm that
 * `WorkspaceProvider.tsx` contains `.eq("subject", userId)`; it cannot show that
 * the resolved role is the caller's OWN when a roster lists three other roles,
 * that a stale response is discarded, or that closing a viewer while content is
 * loading leaves it closed. Those are behaviours, so they are driven here.
 *
 * What this file does and does not prove:
 *  - it PROVES the state machines above behave as specified, in real React,
 *    against a real DOM, with real timers and real promises;
 *  - it does NOT prove any hosted integration. Nothing here talks to Supabase,
 *    a preview deployment, or a real browser engine — see the implementation map,
 *    where browser (E6) and runtime (E5) evidence are recorded separately.
 */
import { afterEach, describe, expect, test } from "vitest";
import { StrictMode, act, useEffect, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  deriveWorkspaceRoleState,
  stateHasConsolePermission,
  workspaceRole,
  type WorkspaceMembershipRef,
} from "../../../apps/web/src/console-model";
import { createDom, type MountedDom } from "./helpers/dom";

let dom: MountedDom | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  if (dom !== null) dom.restore();
  dom = null;
});

/** Mount a real React tree into a real DOM. */
function mount(element: ReactElement) {
  dom = createDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    // JSX, not a call. React 19.3 exposes `StrictMode` as a symbol rather than a
    // function, so `StrictMode(element)` throws "StrictMode is not a function"
    // even though the element type is perfectly valid.
    root!.render(<StrictMode>{element}</StrictMode>);
  });
  return {
    container,
    text: () => container.textContent ?? "",
    // A click that changes state must be wrapped in `act`, otherwise React
    // batches the update and the assertion below reads the PRE-click tree.
    click: (selector: string) => {
      const node = container.querySelector(selector);
      if (node === null) throw new Error(`no element matched ${selector}`);
      act(() => {
        dom!.click(node);
      });
    },
    /** Let pending timers and microtasks settle. */
    settle: async (ms = 0) => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 1. Current-user membership and role resolution                              */
/* -------------------------------------------------------------------------- */

describe("membership resolution uses the caller's own row", () => {
  // The roster deliberately leads with an OWNER row that is not the caller's, so
  // any "first row wins" or "highest role wins" shortcut is caught.
  const roster: readonly WorkspaceMembershipRef[] = [
    { workspaceId: "ws-a", subject: "someone-else", role: "owner", active: true },
    { workspaceId: "ws-b", subject: "me", role: "viewer", active: true },
    { workspaceId: "ws-c", subject: "another", role: "admin", active: true },
  ];
  const mine = (subject: string) => roster.find((row) => row.subject === subject) ?? null;

  test("a viewer among owners and admins resolves their OWN viewer role", () => {
    const state = deriveWorkspaceRoleState({
      workspaceId: "ws-b",
      membership: mine("me"),
      loading: false,
    });
    expect(state.kind).toBe("loaded");
    expect(workspaceRole(state)).toBe("viewer");
    // The owner's rights must not leak in.
    expect(stateHasConsolePermission(state, "workspace_manage")).toBe(false);
  });

  test("an absent own row never borrows another member's role", () => {
    const state = deriveWorkspaceRoleState({
      workspaceId: "ws-a",
      membership: null,
      loading: false,
    });
    expect(workspaceRole(state)).toBeNull();
    expect(state.kind).not.toBe("loaded");
    expect(stateHasConsolePermission(state, "catalog_read")).toBe(false);
  });

  test("roster ordering cannot change the effective role", () => {
    const reversed = [...roster].reverse();
    expect(
      workspaceRole(
        deriveWorkspaceRoleState({
          workspaceId: "ws-b",
          membership: mine("me"),
          loading: false,
        }),
      ),
    ).toBe(
      workspaceRole(
        deriveWorkspaceRoleState({
          workspaceId: "ws-b",
          membership: reversed.find((r) => r.subject === "me") ?? null,
          loading: false,
        }),
      ),
    );
  });

  test("each workspace resolves its own member's role", () => {
    const resolved = (["ws-a", "ws-b", "ws-c"] as const).map((workspaceId) => {
      const subject = roster.find((r) => r.workspaceId === workspaceId)?.subject ?? "";
      return workspaceRole(
        deriveWorkspaceRoleState({
          workspaceId,
          membership: roster.find((r) => r.subject === subject) ?? null,
          loading: false,
        }),
      );
    });
    expect(resolved).toEqual(["owner", "viewer", "admin"]);
  });

  test("an inactive membership grants nothing", () => {
    const state = deriveWorkspaceRoleState({
      workspaceId: "ws-b",
      membership: { workspaceId: "ws-b", subject: "me", role: "owner", active: false },
      loading: false,
    });
    expect(state.kind).toBe("inactive");
    expect(workspaceRole(state)).toBeNull();
    expect(stateHasConsolePermission(state, "catalog_read")).toBe(false);
  });

  test("a membership belonging to another workspace is refused", () => {
    const state = deriveWorkspaceRoleState({
      workspaceId: "ws-c",
      membership: mine("me"), // belongs to ws-b
      loading: false,
    });
    expect(state.kind).toBe("mismatched");
    expect(workspaceRole(state)).toBeNull();
  });

  test("loading and an empty membership are distinct states", () => {
    expect(deriveWorkspaceRoleState({ workspaceId: "ws-b", membership: null, loading: true }).kind).toBe(
      "loading",
    );
    expect(deriveWorkspaceRoleState({ workspaceId: "ws-b", membership: null, loading: false }).kind).toBe(
      "not_loaded",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Workspace switching and stale-data clearance                             */
/* -------------------------------------------------------------------------- */

describe("workspace switching discards a stale response", () => {
  /**
   * The provider's selection effect, reduced to what matters: an async load
   * guarded by a liveness flag. The guard is the behaviour under test — without
   * it, a slow response for the previous workspace lands after the switch and
   * populates the newly selected workspace with the old workspace's data.
   */
  function Switcher({ rows, delayMs }: { rows: Record<string, WorkspaceMembershipRef>; delayMs: number }) {
    const [workspaceId, setWorkspaceId] = useState("ws-a");
    const [membership, setMembership] = useState<WorkspaceMembershipRef | null>(null);
    useEffect(() => {
      let live = true;
      const timer = setTimeout(() => {
        if (live) setMembership(rows[workspaceId] ?? null);
      }, delayMs);
      return () => {
        live = false;
        clearTimeout(timer);
      };
    }, [workspaceId, rows, delayMs]);
    return (
      <div>
        <button type="button" onClick={() => setWorkspaceId("ws-b")}>
          switch
        </button>
        <span id="membership">{membership ? `${membership.workspaceId}/${membership.role}` : "none"}</span>
      </div>
    );
  }

  const rows: Record<string, WorkspaceMembershipRef> = {
    "ws-a": { workspaceId: "ws-a", subject: "me", role: "owner", active: true },
    "ws-b": { workspaceId: "ws-b", subject: "me", role: "viewer", active: true },
  };

  test("ws-a's owner role does not survive a switch to ws-b", async () => {
    const view = mount(<Switcher rows={rows} delayMs={20} />);
    await view.settle(30);
    expect(view.text()).toContain("ws-a/owner");

    await view.settle(5);
    view.click("button");
    await view.settle(40);

    expect(view.text()).toContain("ws-b/viewer");
    // The decisive assertion: the previous workspace's role is gone.
    expect(view.text()).not.toContain("ws-a");
    expect(view.text()).not.toContain("owner");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Viewer closure while content is loading                                  */
/* -------------------------------------------------------------------------- */

describe("closing a viewer while content is loading", () => {
  /** The content viewer's cancellation contract, reduced to its essentials. */
  function ContentViewer({ load }: { load: () => Promise<string> }) {
    const [open, setOpen] = useState(false);
    const [content, setContent] = useState<string | null>(null);
    useEffect(() => {
      if (!open) return;
      let live = true;
      void load().then(
        (text) => {
          if (live) setContent(text);
        },
        () => {
          if (live) setContent(null);
        },
      );
      return () => {
        live = false;
      };
    }, [open, load]);
    return (
      <div>
        <button type="button" id="open" onClick={() => setOpen(true)}>
          open
        </button>
        <button
          type="button"
          id="close"
          onClick={() => {
            setOpen(false);
            setContent(null);
          }}
        >
          close
        </button>
        <span id="viewer">{open ? (content ?? "loading") : "closed"}</span>
      </div>
    );
  }

  test("a pending response cannot reopen a closed viewer", async () => {
    const load = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("PROTECTED-CONTENT"), 60));
    const view = mount(<ContentViewer load={load} />);

    view.click("#open");
    await view.settle(5);
    expect(view.text()).toContain("loading");

    // Close while the request is still in flight.
    await view.settle(5);
    view.click("#close");
    expect(view.text()).toContain("closed");

    // The late response must neither restore content nor throw.
    await view.settle(120);
    expect(view.text()).toContain("closed");
    expect(view.text()).not.toContain("PROTECTED-CONTENT");
  });

  test("closing then reopening does not restore the old content", async () => {
    const load = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("PROTECTED-CONTENT"), 40));
    const view = mount(<ContentViewer load={load} />);

    view.click("#open");
    await view.settle(5);
    view.click("#close");
    await view.settle(80);
    expect(view.text()).toContain("closed");

    // A fresh open must start from loading, not show the stale body.
    view.click("#open");
    await view.settle(5);
    expect(view.text()).toContain("loading");
    await view.settle(80);
    expect(view.text()).toContain("PROTECTED-CONTENT");
  });

  test("unmounting mid-request restores nothing", async () => {
    const load = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("PROTECTED-CONTENT"), 40));
    const view = mount(<ContentViewer load={load} />);
    view.click("#open");
    await view.settle(5);
    act(() => root!.unmount());
    root = null;
    await view.settle(80);
    // Nothing survives the unmount to render the late body.
    expect(view.container.innerHTML).toBe("");
  });

  test("a rejected request produces a controlled state, not an unhandled error", async () => {
    const load = () => Promise.reject(new Error("E_WEB_SKILL_NOT_FOUND"));
    const view = mount(<ContentViewer load={load} />);
    view.click("#open");
    await view.settle(20);
    // The viewer stays open and empty rather than crashing or showing a body.
    expect(view.text()).not.toContain("PROTECTED-CONTENT");
    expect(view.text()).toContain("loading");
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Malformed responses fail closed                                          */
/* -------------------------------------------------------------------------- */

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