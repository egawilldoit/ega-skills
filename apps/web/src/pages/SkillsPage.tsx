import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { SkillSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, type Column } from "../components/DataTable";
import { shortDigest } from "../components/ReleaseStatus";
import { EmptyState, ResourceSection } from "../components/StatePanel";

const COLUMNS: readonly Column<SkillSummary>[] = [
  {
    key: "skill_id",
    label: "Skill",
    mono: true,
    render: (row) => (
      <Link to={`/skills/${encodeURIComponent(row.skill_id)}`}>{row.skill_id}</Link>
    ),
  },
  { key: "name", label: "Name", render: (row) => row.name },
  { key: "description", label: "Description", render: (row) => row.description },
  {
    key: "domains",
    label: "Domains",
    render: (row) => (row.domains.length === 0 ? "—" : row.domains.join(", ")),
  },
  {
    key: "content_digest",
    label: "Content digest",
    mono: true,
    render: (row) => <span title={row.content_digest}>{shortDigest(row.content_digest)}</span>,
  },
];

/**
 * `/skills` — the skills published in the currently readable release.
 *
 * When the deployment holds no verified release the BFF answers with an error
 * and the shared error panel renders an explicit unavailable state. The console
 * does not fall back to a cached or previous release's contents.
 */
export function SkillsPage(): ReactNode {
  const client = useApiClient();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<readonly SkillSummary[]>(API_ENDPOINTS.skills, { signal, timeoutMs: 15_000 }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  return (
    <ResourceSection
      state={resource.state}
      reload={resource.reload}
      loadingLabel="Loading skills…"
      empty={(data) =>
        data.length === 0 ? (
          <EmptyState
            title="No skills in the readable release"
            reason="The verified release snapshot for this deployment contains zero skills."
          />
        ) : null
      }
    >
      {(data) => (
        <>
          <p className="page__lede">
            {data.length} {data.length === 1 ? "skill" : "skills"} in the readable release.
          </p>
          <DataTable
            caption="Skills in the readable Hub release"
            columns={COLUMNS}
            rows={data}
            rowKey={(row) => row.skill_id}
          />
        </>
      )}
    </ResourceSection>
  );
}