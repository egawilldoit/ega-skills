import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { WorkspaceSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { Field } from "../components/DataTable";
import { ResourceSection } from "../components/StatePanel";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * `/workspace` — workspace identity and the viewer's own membership role.
 *
 * ## Who can load this at all, and why that is most roles not being a bug
 *
 * `personal_workspace_owner_read`
 * (`supabase/migrations/202609090004_contract_f_rls.sql:218`) is
 * `owner_subject = auth.jwt() ->> 'sub'`. The workspace record — its
 * `owner_subject` and its `created_at` — is readable **only by the owner**, and
 * `WorkspaceSummary` declares both as required. So this endpoint answers `200`
 * for the owner and a typed `403` for every other role.
 *
 * The alternative would have been to widen the read, which is exactly what the
 * console must never do: a privileged read would make the permission-aware
 * navigation a lie. Instead the refusal names the policy, and the console's own
 * resolved role is shown next to it so the operator can see *why* the read was
 * refused rather than guessing.
 *
 * The two role answers are shown independently and never reconciled into a single
 * winner. When they disagree the console is about to gate navigation on a stale
 * membership, so it says so.
 */
export function WorkspaceOverviewPage(): ReactNode {
  const client = useApiClient();
  const { role, roleLabel, stateLabel, workspaceId } = useWorkspace();

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<WorkspaceSummary>(API_ENDPOINTS.workspace, {
        signal,
        timeoutMs: 15_000,
        ...(workspaceId ? { query: { workspace: workspaceId } } : {}),
      }),
    [client, workspaceId],
  );
  const resource = useApiResource(load, [client, workspaceId]);

  return (
    <>
      <p className="page__lede">{stateLabel}</p>
      <ResourceSection
        state={resource.state}
        reload={resource.reload}
        loadingLabel="Loading workspace…"
      >
        {(data) => {
          const agrees = role === null || role === data.viewer_role;
          return (
            <>
              <section className="panel" aria-labelledby="workspace-identity">
                <h2 id="workspace-identity">Workspace</h2>
                <dl className="fields">
                  <Field label="Workspace id" mono>
                    {data.workspace_id}
                  </Field>
                  <Field label="Owner subject" mono>
                    {data.owner_subject}
                  </Field>
                  <Field label="Created" mono>
                    <time dateTime={data.created_at}>{data.created_at}</time>
                  </Field>
                  <Field label="Your role (console)" mono>
                    {role === null ? "Not resolved" : `${role} — ${roleLabel}`}
                  </Field>
                  <Field label="Your role (API)" mono>
                    {data.viewer_role}
                  </Field>
                </dl>
                {agrees ? null : (
                  <p className="state state--warning" role="alert">
                    The console resolved role {role ?? "none"} while the API reports{" "}
                    {data.viewer_role}. Navigation may be gated on a stale membership; reload the
                    console once the workspace selection is wired.
                  </p>
                )}
              </section>

              <h2>Membership read path</h2>
              <p className="page__lede">
                Your role is read from your own row in{" "}
                <span className="mono">workspace_memberships</span>, which the{" "}
                <span className="mono">membership_self_or_admin_read</span> policy admits for any
                subject. A non-admin therefore sees their own row and nothing else in that table.
              </p>
              <p className="state state--muted" role="status">
                These identity fields come from <span className="mono">personal_workspaces</span>,
                whose <span className="mono">personal_workspace_owner_read</span> policy admits only
                the row whose owner is your own subject. This view is therefore available to the
                workspace owner; for any other role the API refuses with that policy named rather
                than substituting a value it cannot read.
              </p>
            </>
          );
        }}
      </ResourceSection>
    </>
  );
}