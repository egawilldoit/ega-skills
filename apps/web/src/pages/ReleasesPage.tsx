import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { ReleaseSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, type Column } from "../components/DataTable";
import { ReleaseStatusBadge, shortDigest } from "../components/ReleaseStatus";
import { EmptyState, ResourceSection } from "../components/StatePanel";

const COLUMNS: readonly Column<ReleaseSummary>[] = [
  {
    key: "release_digest",
    label: "Release",
    mono: true,
    render: (row) => (
      <Link to={`/releases/${encodeURIComponent(row.release.release_digest)}`}>
        <span title={row.release.release_digest}>
          {shortDigest(row.release.release_digest)}
        </span>
      </Link>
    ),
  },
  {
    key: "status",
    label: "Integrity",
    render: (row) => <ReleaseStatusBadge status={row.release.status} />,
  },
  {
    key: "skill_count",
    label: "Skills",
    numeric: true,
    render: (row) => row.release.skill_count,
  },
  {
    key: "snapshot_rows",
    label: "Snapshot rows",
    numeric: true,
    render: (row) => row.release.snapshot_rows,
  },
  {
    key: "published_at",
    label: "Published",
    render: (row) => <time dateTime={row.published_at}>{row.published_at}</time>,
  },
  {
    key: "is_stable",
    label: "Stable pointer",
    render: (row) => (row.is_stable ? "Points here" : "—"),
  },
];

/**
 * `/releases` — published releases and the current stable pointer.
 *
 * A release whose integrity is not `stable` is listed with its status badge and
 * links to a detail page that refuses to present its contents. The list is not
 * filtered on status: hiding a bad release would be the opposite of what an
 * operator needs to see.
 */
export function ReleasesPage(): ReactNode {
  const client = useApiClient();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<readonly ReleaseSummary[]>(API_ENDPOINTS.releases, {
        signal,
        timeoutMs: 15_000,
      }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  return (
    <>
      <p className="page__lede">
        <Link to="/releases/compare">Compare two releases</Link>
      </p>
      <ResourceSection
        state={resource.state}
        reload={resource.reload}
        loadingLabel="Loading releases…"
        empty={(data) =>
          data.length === 0 ? (
            <EmptyState
              title="No releases recorded"
              reason="The control plane reports no published releases for any hub this session can read."
            />
          ) : null
        }
      >
        {(data) => (
          <DataTable
            caption="Published releases"
            columns={COLUMNS}
            rows={data}
            rowKey={(row) => `${row.release.hub_id}:${row.release.release_digest}`}
          />
        )}
      </ResourceSection>
    </>
  );
}