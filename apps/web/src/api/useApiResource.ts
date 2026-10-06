import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ApiError } from "./contracts";
import { normalizeThrownError } from "./client";

/**
 * Result of one BFF read.
 *
 * `loading` includes the refetch triggered by `reload`, so pages never have to
 * model a separate "refreshing" flag and never show stale rows next to a
 * spinner without saying so.
 */
export type ResourceState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly error: ApiError };

export interface ApiResource<T> {
  readonly state: ResourceState<T>;
  /** Re-run the loader. Any in-flight request is aborted first. */
  readonly reload: () => void;
}

/**
 * Run a cancellable BFF read and expose its honest state.
 *
 * Guarantees:
 *  - The previous value is cleared on reload, so the UI cannot display stale
 *    data as if it were fresh.
 *  - An unmount aborts the in-flight request.
 *  - Any thrown value becomes an `ApiError`; nothing rejects unhandled.
 *  - A late response from a superseded request is discarded.
 */
export function useApiResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): ApiResource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const data = await loadRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setState({ status: "ready", data });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setState({ status: "error", error: normalizeThrownError(cause) });
      }
    })();
    return () => {
      controller.abort();
    };
    // The caller owns the dependency list; `load` is read through a ref so an
    // inline arrow function does not retrigger on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  const reload = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  return useMemo(() => ({ state, reload }), [state, reload]);
}