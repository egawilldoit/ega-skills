import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { ProjectSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource, type ResourceState } from "../api/useApiResource";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection } from "../components/StatePanel";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * `/projects` — the projects the caller's own session may read.
 *
 * ## What the list is
 *
 * The rows are whatever `project_member_read` returned: every project in every
 * workspace where the viewer holds an **active** membership, and nothing else.
 * The console does not filter that further and does not widen it client-side —
 * `private.is_active_member` is the only authority on who sees a row.
 *
 * ## What "no projects" means here
 *
 * `projects` and `project_contexts` have **no writer anywhere in this
 * repository**, so an empty list is the normal state of every real deployment.
 * That is emphatically not the same claim as "this workspace has no projects",
 * and the empty state below says so in those words. The list is never rendered as
 * a metric, and a count of zero is never dressed up as a measurement.
 */

/**
 * Empty-state title.
 *
 * "Recorded", not "no projects": the table holds nothing *because nothing has
 * written to it*, which is a statement about this deployment and not about the
 * viewer's workspace.
 */
export const PROJECTS_EMPTY_TITLE = "No project rows recorded";

/**
 * Empty-state reason.
 *
 * Names all three reasons the list can be empty — no writer, no row for this
 * session, and RLS exclusion — because a reader cannot otherwise tell them apart,
 * and only one of them is a fact about the workspace.
 */
export const PROJECTS_EMPTY_REASON =
  "The control plane returned no project rows for this session. This checkout contains no writer for the " +
  "projects table, so an empty list is the expected state of a deployment rather than a measurement of " +
  "zero projects. Row-level security also means a project belonging to a workspace you are not an active " +
  "member of is excluded here rather than reported as absent.";

const COLUMNS: readonly Column<ProjectSummary>[] = [
  {
    key: "name",
    label: "Project",
    render: (row) => <Link to={`/projects/${encodeURIComponent(row.project_id)}`}>{row.name}</Link>,
  },
  { key: "project_id", label: "Project id", mono: true, render: (row) => row.project_id },
  {
    key: "active_context_count",
    label: "Contexts recorded",
    numeric: true,
    render: (row) => row.active_context_count,
  },
  {
    key: "created_at",
    label: "Created",
    render: (row) => <time dateTime={row.created_at}>{row.created_at}</time>,
  },
];

/**
 * The whole `/projects` view, as a function of one resource state.
 *
 * Split out of the component so every required state — loading, loaded, empty,
 * unauthorized, unavailable, and error — is reachable directly. The component
 * below is the two lines that turn a `useApiResource` into one of these, and a
 * test renders each state here rather than trying to observe a fetch lifecycle.
 */
export function renderProjects(
  state: ResourceState<readonly ProjectSummary[]>,
  reload: () => void,
  stateLabel: string,
): ReactNode {
  return (
    <>
      <p className="page__lede">{stateLabel}</p>
      <ResourceSection
        state={state}
        reload={reload}
        loadingLabel="Loading projects…"
        empty={(data) =>
          data.length === 0 ? (
            <EmptyState title={PROJECTS_EMPTY_TITLE} reason={PROJECTS_EMPTY_REASON} />
          ) : null
        }
      >
        {(data) => (
          <>
            <DataTable
              caption="Projects visible to your session"
              columns={COLUMNS}
              rows={data}
              rowKey={(row) => row.project_id}
            />
            <p className="page__lede">
              <span className="mono">Contexts recorded</span> counts published contexts whose{" "}
              <span className="mono">revoked_at</span> is null, read for exactly the projects on this
              page. A{" "}
              {data.length === 0 ? "blank" : "zero"} in that column is a completed read that found
              none — it is not a count of contexts a policy hid from you. A context pins one exact
              release digest; open a project to see it.
            </p>
          </>
        )}
      </ResourceSection>
    </>
  );
}

/**
 * `/projects` — projects in the selected workspace.
 *
 * `workspace_id` is sent only when the shell has resolved a selection, and it is
 * a **filter, not a grant** (CONTRACT-F §1): it narrows rows the caller may
 * already read. With no resolved selection the request carries no filter at all
 * and the answer is RLS's own scope, which is why the console never has to ask
 * the database whether the caller may have a workspace.
 */
export function ProjectsPage(): ReactNode {
  const client = useApiClient();
  const { workspaceId, stateLabel } = useWorkspace();

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<readonly ProjectSummary[]>(API_ENDPOINTS.projects, {
        signal,
        timeoutMs: 15_000,
        // filter, not a grant: workspace_id narrows the read and grants no access
        query: workspaceId === null ? {} : { workspace_id: workspaceId },
      }),
    [client, workspaceId],
  );
  const resource = useApiResource(load, [client, workspaceId]);

  return renderProjects(resource.state, resource.reload, stateLabel);
}