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
 *  2. `WorkspaceProvider` — owns the workspace selection and the viewer's own
 *     resolved role. It is mounted with `membership: null`, so the console
 *     stays in the `not_loaded` state and withholds every permission-gated
 *     destination until Builder 5 supplies a real membership row. No role is
 *     ever assumed.
 */
export function App(): ReactNode {
  return (
    <AuthProvider>
      <WorkspaceProvider membership={null} workspaceId={null}>
        <AppRoutes />
      </WorkspaceProvider>
    </AuthProvider>
  );
}