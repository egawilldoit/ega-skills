import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { CatalogPage, CatalogSummary, ReleaseIdentity } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { CodeField, DigestText } from "../components/CopyButton";
import { Field } from "../components/DataTable";
import { Disclosure } from "../components/Disclosure";
import { Icon } from "../components/Icon";
import { ReleaseIntegrityNotice, ReleaseStatusBadge, shortDigest } from "../components/ReleaseStatus";
import { EmptyState, ResourceSection } from "../components/StatePanel";
import { StatCard } from "../components/StatCard";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * `/` — release identity and catalog totals for the selected workspace.
 *
 * Nothing here is computed locally. Every number comes from the BFF's
 * `CatalogSummary`, which is derived from the verified release snapshot; when
 * the snapshot cannot be read the page says so instead of showing zeroes.
 *
 * The objectives are the two measured totals and the identity of the release
 * they were measured against. The page deliberately draws no chart, no trend,
 * and no per-domain breakdown: the BFF does not return one, and inventing a
 * series here would present a shape the data does not have.
 */
export function OverviewPage(): ReactNode {
  const client = useApiClient();
  const { workspaceId, stateLabel } = useWorkspace();

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<CatalogPage>(API_ENDPOINTS.catalog, {
        signal,
        timeoutMs: 15_000,
        // The catalog route reads `workspace_id`; it has no `workspace`
        // parameter, so the previous name was silently dropped and the request
        // ran unscoped whatever workspace was selected.
        query: workspaceId === null ? {} : { workspace_id: workspaceId },
      }),
    [client, workspaceId],
  );
  const resource = useApiResource(load, [client, workspaceId]);

  const ready = resource.state.status === "ready" ? resource.state.data : null;
  const release = ready?.release ?? null;

  return (
    <>
      <p className="page__lede">{stateLabel}</p>

      {/*
        Navigation affordances are disabled rather than hidden while the release
        identity is unknown: there is no release to view and no readable
        catalog to browse, and offering a live link to either would be a claim
        the console cannot support. `aria-disabled` plus `tabIndex={-1}` keeps
        them out of the keyboard path while leaving them announced.
      */}
      <div className="actions">
        <ActionLink
          to={release === null ? "/releases" : `/releases/${encodeURIComponent(release.release_digest)}`}
          disabled={release === null}
        >
          View release
        </ActionLink>
        <ActionLink to="/skills" disabled={release === null} primary>
          Browse skills
        </ActionLink>
      </div>

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
              action={
                <Link className="button" to="/releases">
                  View releases
                </Link>
              }
            />
          ) : null
        }
      >
        {(data) => (
          <>
            <div className="stats">
              <StatCard
                label="Skills"
                value={data.skill_total}
                snapshotAt={data.generated_at}
                icon="box"
                accent
                href="/skills"
              />
              <StatCard
                label="Domains"
                value={data.domain_total}
                snapshotAt={data.generated_at}
                icon="grid"
              />
            </div>

            <ReleasePanel data={data} />

            <p className="foot">
              The badge names what this deployment can prove about the release: “Stable” means the
              release digest matches the verified snapshot, and nothing else. It is not a statement
              about production readiness or about your access rights.
            </p>
          </>
        )}
      </ResourceSection>
    </>
  );
}

function ActionLink({
  to,
  disabled,
  primary = false,
  children,
}: {
  readonly to: string;
  readonly disabled: boolean;
  readonly primary?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Link
      to={to}
      className={primary ? "button button--primary" : "button"}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined}
      onClick={(event) => {
        if (disabled) event.preventDefault();
      }}
    >
      {children}
    </Link>
  );
}

/**
 * The release identity card.
 *
 * The header carries the integrity badge, because that badge is the one fact
 * that changes how every value below it should be read. The digest is shown
 * abbreviated in the summary row and in full behind the disclosure, where it is
 * grouped into checkable chunks and stays copyable.
 */
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
  const release: ReleaseIdentity = data.release;
  return (
    <section className="panel" aria-labelledby="overview-release">
      <h2 id="overview-release">
        <span className="tile">
          <Icon name="pulse" />
        </span>
        Current release
        <ReleaseStatusBadge status={release.status} />
      </h2>

      <ReleaseIntegrityNotice release={release} />

      <dl className="fields">
        <Field label="Hub" mono>
          {release.hub_id}
        </Field>
        <Field label="Release digest" mono>
          <div className="field__actions">
            <CodeField
              value={release.release_digest}
              display={shortDigest(release.release_digest)}
              label="release digest"
            />
            <Link to={`/releases/${encodeURIComponent(release.release_digest)}`}>Detail</Link>
          </div>
        </Field>
        <Field label="Snapshot rows" mono>
          {release.snapshot_rows.toLocaleString("en-US")}
        </Field>
      </dl>

      <Disclosure label="Technical details">
        <dl className="fields">
          <Field label="Release digest (full)" mono>
            <CodeField
              chunked
              copy={false}
              value={release.release_digest}
              display={<DigestText digest={release.release_digest} />}
              label="release digest"
            />
          </Field>
          <Field label="SQLite digest" mono>
            <CodeField
              chunked
              value={release.sqlite_artifact_digest}
              display={<DigestText digest={release.sqlite_artifact_digest} />}
              label="SQLite digest"
            />
          </Field>
          <Field label="Publication revision" mono>
            {release.publication_revision === undefined ? (
              <span className="muted">Not recorded by this deployment</span>
            ) : (
              <CodeField value={release.publication_revision} label="publication revision" />
            )}
          </Field>
          <Field label="Snapshot taken at" mono>
            <time dateTime={data.generated_at}>{data.generated_at}</time>
          </Field>
        </dl>
      </Disclosure>
    </section>
  );
}
