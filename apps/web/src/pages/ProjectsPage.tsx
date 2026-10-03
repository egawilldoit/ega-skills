import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { ProjectSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection } from "../components/StatePanel";

const COLUMNS: readonly Column<ProjectSummary>[] = [
  {
    key: "name",
    label: "Project",
    render: (row) => <Link to={`/projects/${encodeURIComponent(row.project_id)}`}>{row.name}</Link>,
  },
  { key: "project_id", label: "Project id", mono: true, render: (row) => row.project_id },
  {
    key: "active_context_count",
    label: "Active contexts",
    numeric: true,
    render: (row) => row.active_context_count,
  },
  {
    key: "created_at",
    label: "Created",
    render: (row) => <time dateTime={row.created_at}>{row.created_at}</time>,
  },
];

/** `/projects` — projects in the selected workspace. */
export function ProjectsPage(): ReactNode {
  const client = useApiClient();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<readonly ProjectSummary[]>(API_ENDPOINTS.projects, {
        signal,
        timeoutMs: 15_000,
      }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  return (
    <ResourceSection
      state={resource.state}
      reload={resource.reload}
      loadingLabel="Loading projects…"
      empty={(data) =>
        data.length === 0 ? (
          <EmptyState
            title="No projects"
            reason="The control plane reports no projects for this workspace."
          />
        ) : null
      }
    >
      {(data) => (
        <DataTable
          caption="Projects in this workspace"
          columns={COLUMNS}
          rows={data}
          rowKey={(row) => row.project_id}
        />
      )}
    </ResourceSection>
  );
}