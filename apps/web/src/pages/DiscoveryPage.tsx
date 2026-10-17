import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { PinnedIntentInspectionReport } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, Field } from "../components/DataTable";
import { EmptyState, ResourceSection } from "../components/StatePanel";

/**
 * `/discovery` — one pinned synthetic intent inspection (EGA-728).
 *
 * Read-only view over the committed evaluation report. The BFF refuses the
 * report when its evaluated digest does not match the served release, so this
 * page never renders a mismatched result. Only the synthetic corpus task is
 * shown; no production user prompt or telemetry is ever fetched.
 */
export function DiscoveryPage(): ReactNode {
  const client = useApiClient();

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<PinnedIntentInspectionReport>(API_ENDPOINTS.discovery, {
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
      loadingLabel="Loading pinned intent inspection…"
      empty={(data) => {
        const report = data as PinnedIntentInspectionReport;
        const caseItem = report.case;
        if (caseItem === undefined) {
          return (
            <EmptyState
              title="No inspection case"
              reason="The pinned report did not contain a synthetic intent case."
            />
          );
        }
        return null;
      }}
    >
      {(data) => {
        const report = data as PinnedIntentInspectionReport;
        const caseItem = report.case ?? {};
        const intentId = caseItem.intent_id ?? caseItem.id ?? "unknown";
        const task = caseItem.task ?? "Synthetic intent not recorded.";
        const expected =
          caseItem.expected_skill_id ??
          caseItem.expected_skill ??
          caseItem.expected_primary ??
          "—";
        const selectedRaw = caseItem.selected_skill_id ?? caseItem.selected_skill ?? caseItem.selected?.[0];
        const selected = selectedRaw ?? "—";
        const reason =
          caseItem.reason ??
          caseItem.failure_reason ??
          "No failure reason recorded.";
        const releaseDigest =
          report.release_digest ??
          report.evaluated_release_digest ??
          report.evaluated_catalog_digest ??
          report.served_release_digest ??
          "—";
        const confidence = caseItem.confidence ?? "—";
        const wrong = caseItem.wrong_automatic_selections ?? [];
        const ranking = caseItem.ranking ?? [];
        const candidates = caseItem.candidates ?? [];

        return (
          <>
            <p className="page__lede">
              Read-only inspection of one pinned synthetic intent. The report is
              digest-bound to the served release and contains no production user
              prompts or live telemetry.
            </p>

            <section className="panel" aria-labelledby="inspection-release">
              <h2 id="inspection-release">Release identity</h2>
              <Field label="Evaluated release digest" mono>
                {releaseDigest}
              </Field>
              <Field label="Report kind" mono>
                {report.report_kind ?? "pinned-synthetic-intent-inspection"}
              </Field>
              <Field label="Sanitized" mono>
                {report.sanitized === true ? "Yes" : "Unknown"}
              </Field>
            </section>

            <h2>Synthetic intent (pinned)</h2>
            <dl className="fields">
              <Field label="Intent id" mono>
                {intentId}
              </Field>
              <Field label="Task">
                {task}
              </Field>
            </dl>

            <h2>Inspection result</h2>
            <dl className="fields">
              <Field label="Expected skill" mono>
                {expected}
              </Field>
              <Field label="Selected skill" mono>
                {selected}
              </Field>
              <Field label="Confidence" mono>
                {confidence}
              </Field>
              <Field label="Reason">
                {reason}
              </Field>
            </dl>

            {wrong.length > 0 ? (
              <>
                <h2>Wrong automatic selections</h2>
                <ul>
                  {wrong.map((id) => (
                    <li key={id}>
                      <code>{id}</code>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {ranking.length > 0 ? (
              <>
                <h2>Discovery ranking (window)</h2>
                <DataTable
                  caption="Resolver window for this intent"
                  columns={[
                    {
                      key: "rank",
                      label: "Rank",
                      numeric: true,
                      render: (row: { readonly rank: number; readonly skill: string }) => row.rank,
                    },
                    {
                      key: "skill",
                      label: "Skill",
                      mono: true,
                      render: (row: { readonly rank: number; readonly skill: string }) => row.skill,
                    },
                  ]}
                  rows={ranking.map((skill, index) => ({ rank: index + 1, skill }))}
                  rowKey={(row) => `${row.rank}-${row.skill}`}
                />
              </>
            ) : null}

            {candidates.length > 0 ? (
              <>
                <h2>Candidates</h2>
                <ul>
                  {candidates.map((id) => (
                    <li key={id}>
                      <code>{id}</code>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        );
      }}
    </ResourceSection>
  );
}
