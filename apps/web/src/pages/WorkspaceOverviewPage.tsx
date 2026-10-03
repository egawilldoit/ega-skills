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
 * The role shown here is the one the shell already resolved; the row below is
 * the API's independent view. When the two disagree the page says so instead
 * of picking a winner, because a mismatch means the console is about to gate
 * navigation on a stale answer.
 */
export function WorkspaceOverviewPage(): ReactNode {
  const client = useApiClient();
  const { role, stateLabel } = useWorkspace();

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<WorkspaceSummary>(API_ENDPOINTS.workspace, { signal, timeoutMs: 15_000 }),
    [client],
  );
  const resource = useApiResource(load, [client]);

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
                    {role ?? "Not resolved"}
                  </Field>
                  <Field label="Your role (API)" mono>
                    {data.viewer_role}
                  </Field>
                </dl>
                {agrees ? null : (
                  <p className="state state--warning" role="alert">
                    The console resolved role {role ?? "none"} while the API reports{" "}
                    {data.viewer_role}. Navigation may be gated on a stale membership; reload
                    the console once the workspace selection is wired.
                  </p>
                )}
              </section>

              <h2>Membership read path</h2>
              <p className="page__lede">
                Your role is read from your own row in <span className="mono">workspace_memberships</span>,
                which the <span className="mono">membership_self_or_admin_read</span> policy
                allows for any subject. A non-admin therefore sees their own row and nothing
                else in that table.
              </p>
            </>
          );
        }}
      </ResourceSection>
    </>
  );
}