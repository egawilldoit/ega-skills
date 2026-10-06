import { useMemo } from "react";

import { useAuth } from "../auth/AuthProvider";
import { createApiClient, type ApiClient } from "./client";

/**
 * The console's single BFF client.
 *
 * `getAccessToken` is a stable `useCallback` in `AuthProvider`, so the client is
 * created once per session rather than once per render. The only credential it
 * can attach is the first-party Supabase user access token, and only ever to a
 * same-origin URL.
 */
export function useApiClient(): ApiClient {
  const { getAccessToken } = useAuth();
  return useMemo(() => createApiClient({ getAccessToken }), [getAccessToken]);
}