import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { WorkspaceQuotaView } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, Field, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection, UnavailableState } from "../components/StatePanel";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * `/workspace/quotas` — recorded quota policy and recorded usage windows.
 *
 * ## Two truths this page must not get wrong
 *
 * **1. These numbers are displayed, not enforced.**
 *
 * `quota_policies` holds three integers. Nothing in this repository enforces
 * them: outside the migrations and the tests, the only references to
 * `quota_policies` are this console's own allow-list entry in `supabase-read.ts`
 * and the DTO in `contracts.ts`. The hosted runtime's actual bounds come from
 * process-level environment values it reads once at startup —
 * `EGA_HOSTED_MAX_BODY_BYTES`, `EGA_HOSTED_MAX_RESPONSE_BYTES`,
 * `EGA_HOSTED_MAX_CONCURRENT_REQUESTS`, `EGA_HOSTED_REQUEST_TIMEOUT_MS`
 * (`packages/mcp/src/hosted-runtime.ts:39-42`). There is no
 * requests-per-minute enforcement anywhere in this codebase.
 *
 * A table of three limits with no such statement would imply a mechanism that
 * does not exist, and an operator would reasonably conclude that editing the row
 * changes what the runtime serves. It does not. So the note is rendered *above*
 * the numbers, not as a footnote, and it is deliberately the most prominent
 * element on the page.
 *
 * For the same reason there is **no utilisation bar** anywhere on this page.
 * Utilisation would be `usage / policy` rendered as a fraction of enforcement,
 * and `quota_usage` has no writer — so the denominator would be a real number and
 * the numerator a fabrication.
 *
 * **2. An empty table is an absence, not a measurement.**
 *
 * `quota_usage` has no production writer anywhere in this repository; the only
 * inserts for it are in `tests/rls/seed.sql` and
 * `tests/web/cross-workspace-isolation.test.mjs`. An empty series is therefore
 * the expected state of a real deployment. It is never rendered as `0 requests`,
 * a `0` bandwidth, or an empty table body, because that would state a
 * measurement that was never taken.
 *
 * The same applies to a missing policy row: "no policy recorded" must not read
 * as "no limit applies".
 *
 * ## Why the copy is duplicated from the server
 *
 * `POLICY_ENFORCEMENT_NOTE` in `apps/web/server/governance.ts` carries the same
 * claim, because the server response is where the fact belongs. The page cannot
 * import it: `governance.ts` pulls in `./env.ts`, which imports
 * `@ega-skills/mcp` and `process.env`, and `tests/web/project-boundary.test.mjs`
 * exists precisely to stop server code reaching the browser bundle. The page
 * also must not import a server module at all. So the sentence is written out
 * here and `tests/web/governance-pages.test.mjs` asserts both copies make the
 * same claim, which turns the duplication into a checked invariant instead of
 * silent drift.
 */

/**
 * The enforcement disclaimer, above the numbers.
 *
 * Duplicated from `POLICY_ENFORCEMENT_NOTE` in
 * `apps/web/server/governance.ts`; see the note above on why.
 */
export const QUOTA_POLICY_ENFORCEMENT_NOTE =
  "These three numbers are recorded policy rows in public.quota_policies. Nothing in this " +
  "deployment enforces them: the hosted runtime does not read quota_policies. The limits the " +
  "runtime actually applies come from process-level environment values — " +
  "EGA_HOSTED_MAX_BODY_BYTES, EGA_HOSTED_MAX_RESPONSE_BYTES, " +
  "EGA_HOSTED_MAX_CONCURRENT_REQUESTS and EGA_HOSTED_REQUEST_TIMEOUT_MS — read once at " +
  "startup. There is no requests-per-minute enforcement anywhere in this codebase. Editing a " +
  "row here would not change a single served request.";

/**
 * Fallback used only if the server ever sent a loaded view with no reason for an
 * empty usage series. Written to deny the zero reading just as firmly as the
 * server's own copy, because the "never render an absence as a zero" rule cannot
 * depend on which string happened to arrive.
 */
const USAGE_FALLBACK_REASON =
  "No quota usage has been recorded. This deployment writes no rows to public.quota_usage, " +
  "so an empty series is the expected state here — it is not a measurement of zero requests.";

/** Fallback for a missing policy row. Denies the "no limit applies" reading. */
const POLICY_FALLBACK_REASON =
  "No quota_policies row is readable for this workspace. Either no policy has been recorded " +
  "for it, or row-level security does not admit this caller to one — the two are " +
  "indistinguishable from the console. Neither means the runtime applies no limit.";

/** Shown when the console has no workspace selection to scope the read to. */
const NO_WORKSPACE_SCOPE_REASON =
  "No workspace is selected, so this read has no scope. The quota view reports one workspace " +
  "at a time and row-level security does not tell the console which workspace a row belongs " +
  "to — so the console is not going to guess one.";

/**
 * `/workspace/quotas` — quota policy plus recorded usage windows.
 *
 * Owner/admin only, per `quota_policy_admin_read` and `quota_usage_admin_read`
 * (`202609090004_contract_f_rls.sql:262,278`). Both policies call
 * `private.has_workspace_role(workspace_id, array['owner','admin'])`, so an
 * ordinary member, maintainer or viewer reads zero rows here — which is the
 * correct, policy-faithful outcome and is rendered through the same honest
 * empty states as a genuinely unrecorded workspace, never as a zero and never as
 * a broken table.
 */
export function QuotasPage(): ReactNode {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();

  /**
   * `null` when there is no workspace selection. Resolved immediately and
   * without a request so the page can say why instead of spinning forever or
   * issuing a read whose scope it would have to invent.
   */
  const load = useCallback(
    async (signal: AbortSignal): Promise<WorkspaceQuotaView | null> => {
      if (workspaceId === null) return null;
      return await client.get<WorkspaceQuotaView>(API_ENDPOINTS.workspaceQuotas(), {
        signal,
        timeoutMs: 15_000,
        query: { workspace: workspaceId, workspace_id: workspaceId },
      });
    },
    [client, workspaceId],
  );
  const resource = useApiResource(load, [client, workspaceId]);

  return (
    <>
      <p className="page__lede">
        Read-only. Owner and admin only. The three policy numbers below are recorded rows, not
        limits this deployment applies.
      </p>
      <ResourceSection
        state={resource.state}
        reload={resource.reload}
        loadingLabel="Loading quotas…"
      >
        {(data) =>
          data === null ? (
            <UnavailableState title="No workspace scope" reason={NO_WORKSPACE_SCOPE_REASON} />
          ) : (
            <>
              <section className="state state--warning" aria-labelledby="quota-enforcement-heading">
                <h3 id="quota-enforcement-heading">
                  Recorded policy is not what the runtime enforces
                </h3>
                <p>{QUOTA_POLICY_ENFORCEMENT_NOTE}</p>
              </section>

              <h2>Policy</h2>
              {data.policy === null ? (
                <UnavailableState
                  title="No quota policy recorded"
                  reason={data.policy_unavailable_reason ?? POLICY_FALLBACK_REASON}
                />
              ) : (
                <>
                  <dl className="fields">
                    <Field label="Requests per minute" mono>
                      {data.policy.requests_per_minute}
                    </Field>
                    <Field label="Concurrent requests" mono>
                      {data.policy.concurrent_requests}
                    </Field>
                    <Field label="Bandwidth bytes" mono>
                      {data.policy.bandwidth_bytes}
                    </Field>
                  </dl>
                  <p className="field__hint">
                    Recorded for workspace{" "}
                    <span className="mono">{data.workspace_id}</span>. These are the values in the
                    row; the effective limits are the <code>EGA_HOSTED_MAX_*</code> environment
                    values named above.
                  </p>
                </>
              )}

              <h2>Usage windows</h2>
              {data.usage.length === 0 ? (
                <EmptyState
                  title="No quota usage has been recorded"
                  reason={data.usage_unavailable_reason ?? USAGE_FALLBACK_REASON}
                />
              ) : (
                <DataTable
                  caption="Quota usage windows recorded for this workspace"
                  columns={USAGE_COLUMNS}
                  rows={data.usage}
                  rowKey={(row) => `${row.workspace_id}:${row.window_started}`}
                />
              )}
            </>
          )
        }
      </ResourceSection>
    </>
  );
}

const USAGE_COLUMNS: readonly Column<WorkspaceQuotaView["usage"][number]>[] = [
  {
    key: "window_started",
    label: "Window started",
    render: (row) => <time dateTime={row.window_started}>{row.window_started}</time>,
  },
  {
    key: "request_count",
    label: "Requests",
    numeric: true,
    render: (row) => row.request_count,
  },
  {
    key: "bandwidth_bytes",
    label: "Bandwidth (bytes)",
    numeric: true,
    render: (row) => row.bandwidth_bytes,
  },
];