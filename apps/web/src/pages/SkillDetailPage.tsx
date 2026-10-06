import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { SkillDetail } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, Field, type Column } from "../components/DataTable";
import { ReleaseIntegrityNotice, ReleaseStatusBadge, shortDigest } from "../components/ReleaseStatus";
import { EmptyState, ResourceSection } from "../components/StatePanel";
import { ErrorState } from "../components/StatePanel";

/**
 * `/skills/:skillId` — one skill as released.
 *
 * The skill id is echoed exactly as it came from the route parameter. If the
 * BFF reports that the id is unknown the page says the skill is not present in
 * the readable release; it never guesses a nearest match.
 */
export function SkillDetailPage(): ReactNode {
  const client = useApiClient();
  const params = useParams<{ readonly skillId: string | undefined }>();
  const skillId = params.skillId ?? null;

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<SkillDetail>(API_ENDPOINTS.skill(skillId ?? ""), {
        signal,
        timeoutMs: 15_000,
      }),
    [client, skillId],
  );
  const resource = useApiResource(load, [client, skillId]);

  if (skillId === null) {
    return (
      <ErrorState
        title="Missing skill id"
        detail="The route did not supply a skill id, so there is nothing to look up."
      />
    );
  }

  return (
    <ResourceSection
      state={resource.state}
      reload={resource.reload}
      loadingLabel={`Loading ${skillId}…`}
    >
      {(data) => (
        <>
          <p className="page__lede">
            <Link to="/skills">All skills</Link>
          </p>
          {data.release === null ? (
            <EmptyState
              title="Release not identified"
              reason="The API returned this skill without a release identity, so it cannot be attributed to a verified release."
            />
          ) : (
            <section className="panel" aria-labelledby="skill-release">
              <h2 id="skill-release">
                Released in <ReleaseStatusBadge status={data.release.status} />
              </h2>
              <ReleaseIntegrityNotice release={data.release} />
              <Field label="Digest" mono>
                {shortDigest(data.release.release_digest)}
              </Field>
            </section>
          )}

          <h2>Identity</h2>
          <dl className="fields">
            <Field label="Skill id" mono>
              {data.summary.skill_id}
            </Field>
            <Field label="Name">{data.summary.name}</Field>
            <Field label="Description">{data.summary.description}</Field>
            <Field label="Schema version" mono>
              {data.summary.schema_version}
            </Field>
            <Field label="Content digest" mono>
              {data.summary.content_digest}
            </Field>
          </dl>

          <h2>Routing</h2>
          <dl className="fields">
            <Field label="Domains" mono>
              {data.routing.domains.length === 0 ? "None declared" : data.routing.domains.join(", ")}
            </Field>
            <Field label="Triggers" mono>
              {data.routing.triggers.length === 0 ? "None declared" : data.routing.triggers.join(", ")}
            </Field>
            <Field label="Exclude patterns" mono>
              {data.routing.exclude_patterns.length === 0
                ? "None declared"
                : data.routing.exclude_patterns.join(", ")}
            </Field>
            <Field label="Priority" mono>
              {data.routing.priority ?? "Not pinned"}
            </Field>
          </dl>

          <h2>Sources</h2>
          <DataTable<SkillDetail["sources"][number]>
            caption={`Adopted sources for ${data.summary.skill_id}`}
            columns={SOURCE_COLUMNS}
            rows={data.sources}
            rowKey={(row) => `${row.source_id}@${row.revision}:${row.path}`}
          />

          <h2>Files</h2>
          <DataTable<SkillDetail["files"][number]>
            caption={`Files released for ${data.summary.skill_id}`}
            columns={FILE_COLUMNS}
            rows={data.files}
            rowKey={(row) => row.path}
          />
        </>
      )}
    </ResourceSection>
  );
}

const SOURCE_COLUMNS: readonly Column<SkillDetail["sources"][number]>[] = [
  { key: "source_id", label: "Source", mono: true, render: (row) => row.source_id },
  { key: "revision", label: "Revision", mono: true, render: (row) => row.revision },
  { key: "path", label: "Path", mono: true, render: (row) => row.path },
];

const FILE_COLUMNS: readonly Column<SkillDetail["files"][number]>[] = [
  { key: "path", label: "Path", mono: true, render: (row) => row.path },
  { key: "byte_length", label: "Bytes", numeric: true, render: (row) => row.byte_length },
  { key: "content_digest", label: "Content digest", mono: true, render: (row) => row.content_digest },
];