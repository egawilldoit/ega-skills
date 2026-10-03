import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { useAuth } from "../auth/AuthProvider";
import { navItemForPath, navSectionForPath, visibleNavSections } from "../console-model";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * Console shell: skip link, banner, permission-aware navigation, main region.
 *
 * Navigation is derived, never hand-listed per page: `visibleNavSections`
 * filters the tree against the resolved workspace role, so a role that has not
 * been loaded sees no gated destination at all. The filter is presentation only
 * — every read is still authorized by the BFF and by RLS.
 */
export function AppShell({ children }: { readonly children: ReactNode }): ReactNode {
  const { email, status, signOut, lastFailure } = useAuth();
  const { workspaceId, role, roleLabel, stateLabel } = useWorkspace();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const firstRender = useRef(true);

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
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const sections = visibleNavSections(role);
  const currentItem = navItemForPath(location.pathname);
  const currentSection = navSectionForPath(location.pathname);
  const pageTitle = currentItem?.label ?? (currentSection?.label ?? "Console");

  return (
    <div className={`shell${drawerOpen ? " shell--drawer-open" : ""}`}>
      <a className="skip-link" href="#console-main">
        Skip to main content
      </a>

      <header className="shell__banner">
        <div className="shell__brand">
          <button
            type="button"
            className="button button--ghost shell__drawer-toggle"
            aria-expanded={drawerOpen}
            aria-controls="console-navigation"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
            <span className="visually-hidden">
              {drawerOpen ? "Hide navigation" : "Show navigation"}
            </span>
          </button>
          <span className="shell__product">EGA Skills Console</span>
          <span className="shell__badge">Read-only</span>
        </div>

        <div className="shell__identity">
          <span className="shell__workspace">
            {workspaceId === null ? "No workspace selected" : workspaceId}
          </span>
          <span className="shell__role" title={stateLabel}>
            {roleLabel}
          </span>
          <span className="shell__subject">
            {email === null ? status : email}
          </span>
          {status === "signed_in" ? (
            <button type="button" className="button button--secondary" onClick={() => void signOut()}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      {lastFailure === null ? null : (
        <p className="shell__alert" role="alert">
          {lastFailure.message}
        </p>
      )}

      <div className="shell__body">
        <nav id="console-navigation" className="shell__nav" aria-label="Console sections">
          {sections.length === 0 ? (
            <p className="shell__nav-empty">{stateLabel}</p>
          ) : (
            sections.map((section) => (
              <div key={section.id} className="nav-group">
                <h2 className="nav-group__title">{section.label}</h2>
                <ul className="nav-group__list">
                  {section.items.map((item) => (
                    <li key={item.path}>
                      <NavLink
                        to={item.path}
                        end={item.path === "/"}
                        className={({ isActive }) =>
                          isActive ? "nav-link nav-link--active" : "nav-link"
                        }
                      >
                        {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </nav>

        <main id="console-main" className="shell__main" tabIndex={-1}>
          <h1 className="shell__title">{pageTitle}</h1>
          {children}
        </main>
      </div>
    </div>
  );
}