import type { ReactNode } from "react";

import { describeApiError, isUnavailableError, type ApiError } from "../api/contracts";
import type { ResourceState } from "../api/useApiResource";

/**
 * Honest state surfaces.
 *
 * Every asynchronous region of the console renders exactly one of these before
 * any data. There is no component in this app that substitutes a placeholder
 * metric, a zero, or a sample row for a value the BFF has not returned.
 */

export function LoadingState({ label }: { readonly label: string }): ReactNode {
  return (
    <p className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function UnavailableState({
  title,
  reason,
}: {
  readonly title: string;
  readonly reason: string;
}): ReactNode {
  return (
    <section className="state state--unavailable" aria-labelledby="unavailable-heading">
      <h3 id="unavailable-heading">{title}</h3>
      <p>{reason}</p>
    </section>
  );
}

export function ForbiddenState({ reason }: { readonly reason: string }): ReactNode {
  return (
    <section className="state state--forbidden" aria-labelledby="forbidden-heading">
      <h3 id="forbidden-heading">Not permitted for your workspace role</h3>
      <p>{reason}</p>
    </section>
  );
}

export function ErrorState({
  title,
  detail,
  onRetry,
}: {
  readonly title: string;
  readonly detail: string;
  readonly onRetry?: () => void;
}): ReactNode {
  return (
    <section className="state state--error" role="alert" aria-labelledby="error-heading">
      <h3 id="error-heading">{title}</h3>
      <p>{detail}</p>
      {onRetry === undefined ? null : (
        <button type="button" className="button button--secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </section>
  );
}

export function EmptyState({
  title,
  reason,
}: {
  readonly title: string;
  readonly reason: string;
}): ReactNode {
  return (
    <section className="state state--empty" aria-labelledby="empty-heading">
      <h3 id="empty-heading">{title}</h3>
      <p>{reason}</p>
    </section>
  );
}

/** Map a normalized error onto the right honest surface. */
export function ErrorPanel({
  error,
  onRetry,
}: {
  readonly error: ApiError;
  readonly onRetry?: () => void;
}): ReactNode {
  if (error.kind === "aborted") {
    return (
      <p className="state state--muted" role="status">
        Request cancelled.
      </p>
    );
  }
  if (isUnavailableError(error)) {
    return <UnavailableState title="Not available" reason={describeApiError(error)} />;
  }
  if (error.kind === "forbidden") {
    return <ForbiddenState reason={describeApiError(error)} />;
  }
  if (error.kind === "unauthorized") {
    return (
      <UnavailableState
        title="Session not accepted by the API"
        reason={`${describeApiError(error)} Sign in again, or confirm that this deployment still trusts the Supabase project named by VITE_SUPABASE_URL.`}
      />
    );
  }
  return (
    <ErrorState
      title="Could not load this view"
      detail={describeApiError(error)}
      {...(error.retryable && onRetry !== undefined ? { onRetry } : {})}
    />
  );
}

export interface ResourceSectionProps<T> {
  readonly state: ResourceState<T>;
  readonly reload: () => void;
  readonly loadingLabel: string;
  readonly children: (data: T) => ReactNode;
  /**
   * Optional emptiness check. Returning `null` means "not empty"; returning a
   * node replaces the rendered body with an explicit empty state, so a caller
   * can never accidentally render an empty table.
   */
  readonly empty?: (data: T) => ReactNode | null;
}

/**
 * Render one asynchronous region: loading, error, emptiness, then content.
 * Centralizing the switch keeps the four states present on every page instead
 * of depending on each page author remembering them.
 */
export function ResourceSection<T>({
  state,
  reload,
  loadingLabel,
  children,
  empty,
}: ResourceSectionProps<T>): ReactNode {
  if (state.status === "loading") return <LoadingState label={loadingLabel} />;
  if (state.status === "error") return <ErrorPanel error={state.error} onRetry={reload} />;
  const emptyNode = empty?.(state.data) ?? null;
  if (emptyNode !== null) return emptyNode;
  return children(state.data);
}