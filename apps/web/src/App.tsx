import type { ReactNode } from "react";

import { AuthProvider } from "./auth/AuthProvider";
import { AppRoutes } from "./pages/routes";
import { WorkspaceProvider } from "./workspace/WorkspaceProvider";

/**
 * Application root.
 *
 * Provider order is deliberate:
 *  1. `AuthProvider` — owns the first-party Supabase user session and supplies
 *     the access token the API client attaches.
 *  2. `WorkspaceProvider` — dynamically resolves workspace memberships from the
 *     authenticated session, auto-selects if one is active, allows switching
 *     if multiple exist, and derives the viewer's role honestly.
 */
export function App(): ReactNode {
  return (
    <AuthProvider>
      <WorkspaceProvider>
        <AppRoutes />
      </WorkspaceProvider>
    </AuthProvider>
  );
}
