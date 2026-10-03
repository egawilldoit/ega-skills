import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { ProjectDetail } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, Field, type Column } from "../components/DataTable";
import { ErrorState, EmptyState, ResourceSection } from "../components/StatePanel";

/**
 * `/projects/:projectId` — project identity and every published context.
 *
 * Revoked contexts are listed with their revocation reason and actor. The rows
 * are never filtered out: an operator needs to see that a context was revoked
 * and when.
 */
export function ProjectDetailPage(): ReactNode {
  const client = useApiClient();
  const params = useParams<{ readonly projectId: string | undefined }>();
  const projectId = params.projectId ?? null;

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<ProjectDetail>(API_ENDPOINTS.project(projectId ?? ""), {
        signal,
        timeoutMs: 15_000,
      }),
    [client, projectId],
  );
  const resource = useApiResource(load, [client, projectId]);

  if (projectId === null) {
    return (
      <ErrorState
        title="Missing project id"
        detail="The route did not supply a project id, so there is nothing to look up."
      />
    );
  }

  return (
    <ResourceSection
      state={resource.state}
      reload={resource.reload}
      loadingLabel={`Loading project ${projectId}…`}
    >
      {(data) => (
        <>
          <p className="page__lede">
            <Link to="/projects">All projects</Link>
          </p>

          <section className="panel" aria-labelledby="project-identity">
            <h2 id="project-identity">Project</h2>
            <dl className="fields">
              <Field label="Name">{data.project.name}</Field>
              <Field label="Project id" mono>
                {data.project.project_id}
              </Field>
              <Field label="Workspace" mono>
                {data.project.workspace_id}
              </Field>
              <Field label="Created" mono>
                <time dateTime={data.project.created_at}>{data.project.created_at}</time>
              </Field>
              <Field label="Active contexts" mono>
                {data.project.active_context_count}
              </Field>
            </dl>
          </section>

          <h2>Published contexts</h2>
          {data.contexts.length === 0 ? (
            <EmptyState
              title="No published contexts"
              reason="This project has no published context. Publishing happens outside this console, which is read-only."
            />
          ) : (
            <DataTable
              caption={`Contexts published for ${data.project.name}`}
              columns={CONTEXT_COLUMNS}
              rows={data.contexts}
              rowKey={(row) => row.context_id}
            />
          )}
        </>
      )}
    </ResourceSection>
  );
}

const CONTEXT_COLUMNS: readonly Column<ProjectDetail["contexts"][number]>[] = [
  {
    key: "context_digest",
    label: "Context digest",
    mono: true,
    render: (row) => (
      <Link to={`/releases/${encodeURIComponent(row.release_digest)}`}>{row.context_digest}</Link>
    ),
  },
  {
    key: "release_digest",
    label: "Release",
    mono: true,
    render: (row) => row.release_digest,
  },
  {
    key: "published_at",
    label: "Published",
    render: (row) => <time dateTime={row.published_at}>{row.published_at}</time>,
  },
  {
    key: "revoked_at",
    label: "Revoked",
    render: (row) =>
      row.revoked_at === null ? (
        "Active"
      ) : (
        <time dateTime={row.revoked_at}>{row.revoked_at}</time>
      ),
  },
  {
    key: "revocation_reason",
    label: "Revocation reason",
    render: (row) => row.revocation_reason ?? "—",
  },
];