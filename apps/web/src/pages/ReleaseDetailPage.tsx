import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";

import { API_ENDPOINTS, isReleaseDigest } from "../api/client";
import type { ReleaseDetail } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, Field, type Column } from "../components/DataTable";
import {
  ReleaseIntegrityNotice,
  ReleaseStatusBadge,
  explainReleaseStatus,
  shortDigest,
} from "../components/ReleaseStatus";
import { ErrorState, ResourceSection } from "../components/StatePanel";

/**
 * `/releases/:releaseDigest` — one release.
 *
 * When integrity is not `stable` the page renders identity plus the reason and
 * stops: artifact rows are withheld because their contents are not verified.
 * That is the fail-closed path the contract requires.
 */
export function ReleaseDetailPage(): ReactNode {
  const client = useApiClient();
  const params = useParams<{ readonly releaseDigest: string | undefined }>();
  const raw = params.releaseDigest ?? null;
  const digest = raw === null ? null : decodeURIComponent(raw);

  const valid = digest !== null && isReleaseDigest(digest);
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<ReleaseDetail>(API_ENDPOINTS.release(digest ?? ""), {
        signal,
        timeoutMs: 15_000,
      }),
    [client, digest],
  );
  const resource = useApiResource(load, [client, digest]);

  if (digest === null) {
    return (
      <ErrorState
        title="Missing release digest"
        detail="The route did not supply a release digest, so there is nothing to look up."
      />
    );
  }
  if (!valid) {
    return (
      <ErrorState
        title="Not a release digest"
        detail={`${digest} is not in the canonical sha256:<64 hex> form the control plane enforces, so no lookup was attempted.`}
      />
    );
  }

  return (
    <ResourceSection
      state={resource.state}
      reload={resource.reload}
      loadingLabel={`Loading ${shortDigest(digest)}…`}
    >
      {(data) => (
        <>
          <p className="page__lede">
            <Link to="/releases">All releases</Link>
          </p>

          <section className="panel" aria-labelledby="release-identity">
            <h2 id="release-identity">
              Release identity <ReleaseStatusBadge status={data.release.status} />
            </h2>
            <ReleaseIntegrityNotice release={data.release} />
            <p className="page__lede">{explainReleaseStatus(data.release.status)}</p>
            <dl className="fields">
              <Field label="Digest" mono>
                {data.release.release_digest}
              </Field>
              <Field label="Hub" mono>
                {data.release.hub_id}
              </Field>
              <Field label="SQLite artifact digest" mono>
                {data.release.sqlite_artifact_digest}
              </Field>
              <Field label="Skills" mono>
                {data.release.skill_count}
              </Field>
              <Field label="Snapshot rows" mono>
                {data.release.snapshot_rows}
              </Field>
              <Field label="Published" mono>
                {data.published_at ? (
                  <time dateTime={data.published_at}>{data.published_at}</time>
                ) : (
                  // The release identity carries no timestamp by design, so
                  // "unknown" is the honest rendering. Never substitute a date.
                  <span title="The release identity contains no timestamp by design">
                    Not recorded
                  </span>
                )}
              </Field>
              <Field label="Stable pointer" mono>
                {data.is_stable ? "This digest" : "Another digest"}
              </Field>
              <Field label="Stable pointer updated" mono>
                {data.stable_pointer_updated_at ?? "No stable pointer recorded"}
              </Field>
              <Field label="Publication revision" mono>
                {data.release.publication_revision ?? "Not recorded by this deployment"}
              </Field>
            </dl>
          </section>

          {data.release.status === "stable" ? (
            <>
              <h2>Immutable artifacts</h2>
              <DataTable<ReleaseDetail["artifacts"][number]>
                caption={`Immutable objects backing ${shortDigest(data.release.release_digest)}`}
                columns={ARTIFACT_COLUMNS}
                rows={data.artifacts}
                rowKey={(row) => `${row.artifact_kind}:${row.object_digest}`}
              />
            </>
          ) : (
            <ErrorState
              title="Artifact contents withheld"
              detail="Artifacts for a release that is not integrity-stable are not listed, because this deployment cannot verify what they contain."
            />
          )}
        </>
      )}
    </ResourceSection>
  );
}

const ARTIFACT_COLUMNS: readonly Column<ReleaseDetail["artifacts"][number]>[] = [
  { key: "artifact_kind", label: "Kind", render: (row) => row.artifact_kind },
  { key: "object_digest", label: "Object digest", render: (row) => row.object_digest },
  { key: "byte_length", label: "Bytes", numeric: true, render: (row) => row.byte_length },
  {
    key: "created_at",
    label: "Stored at",
    render: (row) => <time dateTime={row.created_at}>{row.created_at}</time>,
  },
];