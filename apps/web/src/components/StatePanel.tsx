import type { ReactNode } from "react";
import { useId } from "react";

import { describeApiError, isUnavailableError, type ApiError } from "../api/contracts";
import type { ResourceState } from "../api/useApiResource";
import { Icon, type IconName } from "./Icon";

/**
 * Honest state surfaces.
 *
 * Every asynchronous region of the console renders exactly one of these before
 * any data. There is no component in this app that substitutes a placeholder
 * metric, a zero, or a sample row for a value the BFF has not returned.
 *
 * Each message state is a single card: an icon that distinguishes the reason at
 * a glance, a heading that names it, one sentence of real explanation, and at
 * most one recovery action. The icon never carries meaning on its own — it is
 * `aria-hidden` and every state's heading says the same thing in words.
 */

function StateCard({
  kind,
  icon,
  title,
  detail,
  action,
  alert = false,
}: {
  readonly kind: "empty" | "forbidden" | "unavailable" | "error" | "muted";
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
  readonly alert?: boolean;
}): ReactNode {
  // `useId` rather than a fixed string: a page can legitimately render two
  // states of the same kind, and duplicate heading ids would break the
  // accessible name of both.
  const headingId = useId();
  return (
    <section
      className={`card state state-card state--${kind}`}
      role={alert ? "alert" : undefined}
      aria-labelledby={headingId}
    >
      <span className="tile">
        <Icon name={icon} />
      </span>
      <h3 id={headingId}>{title}</h3>
      <p>{detail}</p>
      {action === undefined ? null : <div className="actions">{action}</div>}
    </section>
  );
}

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
  action,
}: {
  readonly title: string;
  readonly reason: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <StateCard
      kind="unavailable"
      icon="warn"
      title={title}
      detail={reason}
      {...(action === undefined ? {} : { action })}
    />
  );
}

export function ForbiddenState({ reason }: { readonly reason: string }): ReactNode {
  return (
    <StateCard
      kind="forbidden"
      icon="lock"
      title="Not permitted for your workspace role"
      detail={reason}
      alert
    />
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
    <StateCard
      kind="error"
      icon="warn"
      title={title}
      detail={detail}
      alert
      {...(onRetry === undefined
        ? {}
        : {
            action: (
              <button type="button" className="button" onClick={onRetry}>
                Retry
              </button>
            ),
          })}
    />
  );
}

export function EmptyState({
  title,
  reason,
  action,
}: {
  readonly title: string;
  readonly reason: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <StateCard
      kind="empty"
      icon="empty"
      title={title}
      detail={reason}
      {...(action === undefined ? {} : { action })}
    />
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
