import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import { describeApiError, type HostedReleaseState, type HostedReleaseStatusView } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { Field } from "./DataTable";
import { describeHostedReleaseState } from "./release-status";

const BADGE_CLASS: Readonly<Record<HostedReleaseState, string>> = {
  matches: "badge--hosted-matches",
  different: "badge--hosted-different",
  unknown: "badge--hosted-unknown",
};

function HostedBadge({ state }: { readonly state: HostedReleaseState }): ReactNode {
  return (
    <span className={`badge ${BADGE_CLASS[state]}`}>
      <span className="visually-hidden">Hosted MCP comparison: </span>
      {describeHostedReleaseState(state)}
    </span>
  );
}

/** Shared note for every state: equality is not a permission claim. */
function ComparisonNote(): ReactNode {
  return (
    <p className="hosted-release__note">
      A matching digest identifies the same release artifact. It does not prove that every
      caller can read every skill, and it grants no access.
    </p>
  );
}

/**
 * The Console's observation of the fixed canonical hosted MCP release.
 *
 * The URL is chosen by the server. This component sends no URL and cannot turn
 * the endpoint into a proxy. Transport failure is shown as unknown, never as a
 * match or a difference.
 */
export function HostedReleaseStatusPanel(): ReactNode {
  const client = useApiClient();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<HostedReleaseStatusView>(API_ENDPOINTS.hostedReleaseStatus, {
        signal,
        timeoutMs: 8_000,
      }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  if (resource.state.status === "loading") {
    return (
      <p className="state state--loading" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        Checking the canonical hosted MCP release…
      </p>
    );
  }

  if (resource.state.status === "error") {
    return (
      <section className="panel hosted-release" aria-labelledby="hosted-release-heading">
        <h2 id="hosted-release-heading">
          Hosted MCP <HostedBadge state="unknown" />
        </h2>
        <p className="page__lede">{describeApiError(resource.state.error)}</p>
        <ComparisonNote />
        <button type="button" className="button button--secondary" onClick={resource.reload}>
          Refresh status
        </button>
      </section>
    );
  }

  const status = resource.state.data;

  return (
    <section className="panel hosted-release" aria-labelledby="hosted-release-heading">
      <h2 id="hosted-release-heading">
        Hosted MCP <HostedBadge state={status.state} />
      </h2>
      <p className="page__lede">
        The Console compares its verified release with an observation of the fixed canonical
        hosted MCP readiness endpoint.
      </p>
      <dl className="fields">
        <Field label="Console release digest" mono>
          {status.console_release_digest ?? "No verified Console release identity"}
        </Field>
        <Field label="Hosted MCP release digest" mono>
          {status.hosted_release_digest ?? "No successful observation"}
        </Field>
        <Field label="MCP observation time">
          {status.observed_at === null ? (
            "No successful observation"
          ) : (
            <time dateTime={status.observed_at}>{status.observed_at}</time>
          )}
        </Field>
        <Field label="Console status request time">
          <time dateTime={status.checked_at}>{status.checked_at}</time>
        </Field>
        <Field label="Endpoint" mono>
          {status.endpoint}
        </Field>
      </dl>
      {status.reason === null ? null : (
        <p className="hosted-release__reason">{status.reason}</p>
      )}
      <p className="hosted-release__note">
        Observations can be reused for up to 15 seconds. Refresh status asks the Console for
        the current result; it may reuse a cached observation without contacting the MCP again.
      </p>
      <ComparisonNote />
      <button type="button" className="button button--secondary" onClick={resource.reload}>
        Refresh status
      </button>
    </section>
  );
}
