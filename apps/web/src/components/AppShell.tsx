import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { useAuth } from "../auth/AuthProvider";
import { navSectionForPath, visibleNavSections, type NavItem } from "../console-model";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { Icon, type IconName } from "./Icon";

/**
 * Console shell: skip link, permission-aware sidebar, sticky top bar, account
 * panel, and the main region.
 *
 * Navigation is derived, never hand-listed per page: `visibleNavSections`
 * filters the tree against the resolved workspace role, so a role that has not
 * been loaded sees no gated destination at all. The filter is presentation only
 * — every read is still authorized by the BFF and by RLS.
 *
 * Icons are presentation, so they live here rather than in `console-model`:
 * a nav destination's identity is its path, its label, and its permission, and
 * adding a decorative field to that model would put this file's visual choices
 * in the way of the model's own tests.
 */
const SECTION_ICONS: Readonly<Record<string, IconName>> = {
  catalog: "layers",
  projects: "folder",
  workspace: "grid",
  observability: "usage",
};

const ITEM_ICONS: Readonly<Record<string, IconName>> = {
  "/": "layers",
  "/skills": "box",
  "/releases": "pulse",
  "/releases/compare": "compare",
  "/projects": "folder",
  "/workspace": "grid",
  "/workspace/members": "users",
  "/workspace/quotas": "quota",
  "/workspace/security": "shield",
  "/analytics": "usage",
  "/audit": "audit",
  "/settings": "cog",
};

/**
 * Singular page heading for a record route.
 *
 * A detail URL is owned by its collection, so the collection is what the
 * navigation highlights; the heading names the record type instead of repeating
 * the collection name. The record's own identity is on the page, next to the
 * values that identify it.
 */
const DETAIL_TITLES: Readonly<Record<string, string>> = {
  "/skills": "Skill",
  "/releases": "Release",
  "/projects": "Project",
};

/**
 * Routes that exist but are not navigation destinations.
 *
 * `/discovery` is a deep-linked inspection view, deliberately absent from the
 * sidebar. It still needs a truthful heading and breadcrumb rather than falling
 * back to "Console".
 */
const UNLISTED_ROUTES: Readonly<Record<string, { readonly section: string; readonly item: string }>> = {
  "/discovery": { section: "Catalog", item: "Discovery" },
};

/**
 * The nav destination that owns a path.
 *
 * Exact match first, then the longest nav path that is a prefix of the path, so
 * `/skills/anthropic/frontend-design` is owned by `/skills` and the top bar can
 * name the section the record belongs to instead of falling back to "Console".
 */
function ownerItem(pathname: string, sections: readonly { readonly items: readonly NavItem[] }[]): NavItem | undefined {
  let best: NavItem | undefined;
  for (const section of sections) {
    for (const item of section.items) {
      if (item.path === pathname) return item;
      const matches = item.path === "/" ? pathname === "/" : pathname.startsWith(`${item.path}/`);
      if (matches && (best === undefined || item.path.length > best.path.length)) best = item;
    }
  }
  return best;
}

export function AppShell({ children }: { readonly children: ReactNode }): ReactNode {
  const { email, status, signOut, lastFailure } = useAuth();
  const { workspaceId, role, roleLabel, stateLabel, memberships, selectWorkspace } = useWorkspace();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const location = useLocation();
  const scrim = useRef<HTMLDivElement>(null);
  const drawerToggle = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);

  // The sidebar is a drawer only below the breakpoint. Tracking the query keeps
  // `inert` (and therefore the tab order) correct when the window is resized
  // rather than only on first paint.
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const sync = (): void => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Any navigation closes the drawer: leaving it open over the new page is a
  // known mobile trap.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setDrawerOpen(false);
      drawerToggle.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const sections = visibleNavSections(role);
  const section = navSectionForPath(location.pathname);
  const item = ownerItem(location.pathname, sections);
  const unlisted = UNLISTED_ROUTES[location.pathname];
  const sectionLabel = unlisted?.section ?? section?.label;
  const itemLabel = unlisted?.item ?? item?.label;
  // A section label that is already part of the item label ("Catalog overview"
  // inside "Catalog") is not repeated as a breadcrumb prefix.
  const prefix =
    sectionLabel !== undefined &&
    itemLabel !== undefined &&
    itemLabel !== sectionLabel &&
    !itemLabel.toLowerCase().startsWith(sectionLabel.toLowerCase());
  const isRecord = item !== undefined && item.path !== location.pathname;
  const pageTitle =
    unlisted?.item ??
    (item === undefined
      ? (section?.label ?? "Console")
      : isRecord
        ? (DETAIL_TITLES[item.path] ?? item.label)
        : item.label);

  return (
    <div className="shell">
      <a className="skip-link" href="#console-main">
        Skip to main content
      </a>

      <nav
        id="console-navigation"
        className={drawerOpen ? "side is-open" : "side"}
        aria-label="Console sections"
        inert={narrow && !drawerOpen}
      >
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            E
          </span>
          <span>
            <span className="brand__name">EGA Skills</span>
            <span className="brand__sub">CONSOLE</span>
          </span>
        </div>

        {sections.length === 0 ? (
          <p className="side__empty">{stateLabel}</p>
        ) : (
          sections.map((visibleSection) => (
            <div key={visibleSection.id}>
              <h2 className="nav-group__title">{visibleSection.label}</h2>
              <ul className="nav-group__list">
                {visibleSection.items.map((navItem) => {
                  // Active state follows the same ownership rule as the
                  // breadcrumb: a detail URL keeps its collection highlighted,
                  // and `/releases/compare` never lights up `/releases` as well.
                  const active = item?.path === navItem.path;
                  return (
                    <li key={navItem.path}>
                      {/*
                        A plain `Link`, not `NavLink`: this nav's active state is
                        the same ownership rule the breadcrumb uses, and
                        `NavLink` additionally marks every prefix match active
                        (`/workspace` for `/workspace/members`) via its own
                        `aria-current`, which would highlight two destinations at
                        once.
                      */}
                      <Link
                        to={navItem.path}
                        className={active ? "nav-link nav-link--active" : "nav-link"}
                        aria-current={active ? "page" : undefined}
                      >
                        <Icon name={ITEM_ICONS[navItem.path] ?? SECTION_ICONS[visibleSection.id] ?? "box"} />
                        {navItem.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </nav>

      <div
        ref={scrim}
        className={drawerOpen ? "scrim is-open" : "scrim"}
        aria-hidden="true"
        onClick={() => setDrawerOpen(false)}
      />

      <div className="main">
        <header className="top">
          <button
            ref={drawerToggle}
            type="button"
            className="button button--ghost shell__drawer-toggle"
            aria-expanded={drawerOpen}
            aria-controls="console-navigation"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <Icon name="menu" />
            <span className="visually-hidden">
              {drawerOpen ? "Hide navigation" : "Show navigation"}
            </span>
          </button>

          <div className="where">
            {sectionLabel === undefined ? (
              <b>{pageTitle}</b>
            ) : (
              <>
                {prefix ? (
                  <>
                    <span>{sectionLabel}</span>
                    <span aria-hidden="true">/</span>
                  </>
                ) : null}
                <b>{itemLabel ?? sectionLabel}</b>
              </>
            )}
          </div>

          <span className="sp" />

          <span className="tag">Read-only</span>

          <AccountPanel
            email={email}
            status={status}
            roleLabel={roleLabel}
            stateLabel={stateLabel}
            workspaceId={workspaceId}
            memberships={memberships}
            onSelectWorkspace={selectWorkspace}
            onSignOut={() => void signOut()}
          />
        </header>

        {lastFailure === null ? null : (
          <p className="shell__alert" role="alert">
            {lastFailure.message}
          </p>
        )}

        <main id="console-main" className="content" tabIndex={-1}>
          <h1 className="shell__title">{pageTitle}</h1>
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Account and workspace panel.
 *
 * Everything the previous banner showed about the session is still here: the
 * signed-in subject, the resolved role, the selected workspace id, the
 * multi-workspace selector (when the subject really has more than one
 * membership), and sign-out. Only its shape changed — the workspace id is now a
 * copyable monospace value, and the panel closes on outside click, on `Escape`,
 * and when focus leaves it.
 */
function AccountPanel({
  email,
  status,
  roleLabel,
  stateLabel,
  workspaceId,
  memberships,
  onSelectWorkspace,
  onSignOut,
}: {
  readonly email: string | null;
  readonly status: string;
  readonly roleLabel: string;
  readonly stateLabel: string;
  readonly workspaceId: string | null;
  readonly memberships: readonly { readonly workspaceId: string; readonly role: string }[];
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onSignOut: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const initials = email === null ? "?" : email.slice(0, 2).toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      className="idwrap"
      ref={wrap}
      onBlur={(event) => {
        if (open && event.relatedTarget !== null && !wrap.current?.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="button av"
        aria-label="Account and workspace"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((previous) => !previous)}
      >
        {initials}
      </button>

      {open ? (
        <div className="pop" id={panelId}>
          <div className="pop__who">
            <b>{email === null ? status : email}</b>
            <span title={stateLabel}>{roleLabel}</span>
          </div>

          <div className="pop__section">
            <span className="field__label" id={`${panelId}-ws`}>
              Workspace ID
            </span>
            <div className="code-field">
              <code aria-labelledby={`${panelId}-ws`}>
                {workspaceId ?? "No workspace selected"}
              </code>
            </div>
          </div>

          {memberships.length > 1 ? (
            <div className="pop__section">
              <label className="field__label" htmlFor={`${panelId}-select`}>
                Workspace
              </label>
              <select
                className="select"
                id={`${panelId}-select`}
                value={workspaceId ?? ""}
                onChange={(event) => onSelectWorkspace(event.target.value)}
              >
                {memberships.map((membership) => (
                  <option key={membership.workspaceId} value={membership.workspaceId}>
                    {membership.workspaceId} ({membership.role})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="pop__out">
            <button type="button" className="button" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
