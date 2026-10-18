import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useAuth } from "../auth/AuthProvider";
import type { ConsolePermission } from "../console-model";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { UnavailableState } from "../components/StatePanel";

/**
 * Gate for every protected route.
 *
 * Three distinct outcomes, never collapsed:
 *  - Supabase is not configured at build time → an actionable configuration
 *    state, because no sign-in can possibly succeed.
 *  - The session is still being resolved → a status line, not a redirect. A
 *    redirect here would bounce a signed-in operator to `/login` on every hard
 *    refresh.
 *  - Signed out → `/login` with the attempted path preserved in `?next=`, and
 *    validated as a same-site relative path before it is ever used.
 */
export function RequireSession({ children }: { readonly children: ReactNode }): ReactNode {
  const { status, configurationIssue } = useAuth();
  const location = useLocation();

  if (status === "unconfigured") {
    return (
      <UnavailableState
        title="Supabase is not configured"
        reason={
          configurationIssue ??
          "The browser-visible Supabase variables are missing, so this console cannot authenticate anyone."
        }
      />
    );
  }

  if (status === "loading") {
    return (
      <p className="state state--loading" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        Resolving your session…
      </p>
    );
  }

  if (status === "signed_out") {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return children;
}

/**
 * Gate for routes that additionally require a resolved workspace role.
 *
 * The navigation filter already withholds these links, and the BFF re-checks
 * the same policy server-side, so this is presentation only. It still matters:
 * a bookmarked URL must not render a page the operator's role cannot read.
 */
export function RequirePermission({
  children,
  permission,
}: {
  readonly children: ReactNode;
  readonly permission: ConsolePermission;
}): ReactNode {
  const { can, stateLabel } = useWorkspace();
  if (can(permission)) return children;
  return <UnavailableState title="Not available for your workspace role" reason={stateLabel} />;
}