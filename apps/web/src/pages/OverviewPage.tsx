import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { CatalogSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { Field } from "../components/DataTable";
import { ReleaseIntegrityNotice, ReleaseStatusBadge, shortDigest } from "../components/ReleaseStatus";
import { EmptyState, ResourceSection } from "../components/StatePanel";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * `/` — release identity and catalog totals for the selected workspace.
 *
 * Nothing here is computed locally. Every number comes from the BFF's
 * `CatalogSummary`, which is derived from the verified release snapshot; when
 * the snapshot cannot be read the page says so instead of showing zeroes.
 */
export function OverviewPage(): ReactNode {
  const client = useApiClient();
  const { workspaceId, stateLabel } = useWorkspace();

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<CatalogSummary>(API_ENDPOINTS.catalog, {
        signal,
        timeoutMs: 15_000,
        query: workspaceId === null ? {} : { workspace: workspaceId },
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
        loadingLabel="Loading catalog summary…"
        empty={(data) =>
          data.release === null ? (
            <EmptyState
              title="No readable release"
              reason={
                data.release_unavailable_reason ??
                "This deployment holds no verified release for the selected workspace."
              }
            />
          ) : null
        }
      >
        {(data) => (
          <>
            <ReleasePanel data={data} />
            <h2>Totals</h2>
            <dl className="fields">
              <Field label="Skills" mono>
                {data.skill_total}
              </Field>
              <Field label="Domains" mono>
                {data.domain_total}
              </Field>
              <Field label="Snapshot taken at" mono>
                <time dateTime={data.generated_at}>{data.generated_at}</time>
              </Field>
            </dl>
          </>
        )}
      </ResourceSection>
    </>
  );
}

function ReleasePanel({ data }: { readonly data: CatalogSummary }): ReactNode {
  if (data.release === null) {
    return (
      <EmptyState
        title="No readable release"
        reason={
          data.release_unavailable_reason ??
          "This deployment holds no verified release for the selected workspace."
        }
      />
    );
  }
  const release = data.release;
  return (
    <section className="panel" aria-labelledby="overview-release">
      <h2 id="overview-release">
        Release <ReleaseStatusBadge status={release.status} />
      </h2>
      <ReleaseIntegrityNotice release={release} />
      <dl className="fields">
        <Field label="Digest" mono>
          <span title={release.release_digest}>{shortDigest(release.release_digest)}</span>{" "}
          <Link to={`/releases/${encodeURIComponent(release.release_digest)}`}>Detail</Link>
        </Field>
        <Field label="Hub" mono>
          {release.hub_id}
        </Field>
        <Field label="SQLite artifact" mono>
          <span title={release.sqlite_artifact_digest}>
            {shortDigest(release.sqlite_artifact_digest)}
          </span>
        </Field>
        <Field label="Snapshot rows" mono>
          {release.snapshot_rows}
        </Field>
        <Field label="Publication revision" mono>
          {release.publication_revision ?? "Not recorded by this deployment"}
        </Field>
      </dl>
    </section>
  );
}