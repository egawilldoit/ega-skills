import type { ReactNode } from "react";
import { useCallback } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { SecurityDenyRow } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection } from "../components/StatePanel";

/**
 * `/workspace/security` — the recorded control-plane deny rows.
 *
 * ## What these rows are, and what they are not
 *
 * `security_denies` is a record of denies written to the database. It is **not**
 * the enforced policy, and the difference matters more here than on any other
 * page, because the table's name invites the opposite assumption.
 *
 * The hosted runtime authorizes requests from a **separate, process-level
 * authorization policy** (the hosted authz JSON, read at
 * `packages/mcp/src/hosted-runtime.ts:166`), configured by the operator and read
 * once at startup. Nothing in this
 * repository writes `security_denies` — the only inserts for it in the whole
 * tree are in `tests/rls/seed.sql` and `tests/web/cross-workspace-isolation.test.mjs`.
 * So in a real deployment this table is empty, and its being empty says nothing
 * about whether an identity is refused.
 *
 * The page therefore states, above the table, that these are the *recorded*
 * control-plane denies and that a separate runtime policy is enforced on top.
 * An operator who read an empty table as "nothing is denied" would be wrong, and
 * the page must not be the reason they believe it.
 *
 * `private.is_denied` (`202609090004_contract_f_rls.sql:39`) does consult these
 * rows on the catalog path, so where a row exists it has real effect. That is
 * why the note says the runtime policy is enforced *in addition to* these rows,
 * not instead of them.
 *
 * ## The empty state cannot distinguish two causes, and says so
 *
 * `SecurityDenyRow[]` is a flat array with no wrapper and no reason field, so an
 * empty array is genuinely indistinguishable between "no deny has been written"
 * and "row-level security withheld every row from this caller". The server
 * cannot tell them apart either. Rather than pick one, the empty state names both
 * — which is the honest answer and also the useful one, since a viewer who sees
 * nothing learns that their role is the likely reason.
 */
const COLUMNS: readonly Column<SecurityDenyRow>[] = [
  { key: "kind", label: "Kind", mono: true, render: (row) => row.kind },
  { key: "identity", label: "Identity", mono: true, render: (row) => row.identity },
  { key: "reason", label: "Reason", render: (row) => row.reason },
  {
    key: "created_at",
    label: "Recorded",
    render: (row) => <time dateTime={row.created_at}>{row.created_at}</time>,
  },
];

/**
 * The scoping note. Rendered above the table, not in a tooltip or a footer,
 * because a reader who sees the table without it will draw the wrong conclusion
 * from it.
 *
 * The environment variable that configures that policy is deliberately **not**
 * named here. `tests/web/project-boundary.test.mjs` bans any SPA source that
 * references a server-only env var, because doing so signals an intent to read a
 * server secret in the browser — and no other page in this SPA names an `EGA_`
 * variable either. That is the right outcome on the merits as well: the reader of
 * this page is a workspace admin, who cannot read or change that variable, so the
 * name would be a knob they do not have. The deployer-facing name lives in
 * `apps/web/server/governance.ts`, and
 * `tests/web/governance-pages.test.mjs` asserts it there.
 */
export const SECURITY_DENY_SCOPE_NOTE =
  "These are the recorded control-plane denies held in public.security_denies — the denies " +
  "written to the database. They are not the whole enforced policy. The hosted runtime " +
  "additionally enforces a separate, process-level authorization policy that this table does " +
  "not describe and that this console cannot display, and an identity refused by that policy " +
  "never appears here. An empty table therefore does not mean that nothing is denied.";

/**
 * Empty-state reason for `security_denies`.
 *
 * Deliberately does not claim "nothing is denied", does not render a count of
 * zero, and names both indistinguishable causes. Duplicated from
 * `EMPTY_DENY_REASON` in `apps/web/server/governance.ts`; see `QuotasPage.tsx`
 * for why the server and page cannot share one constant, and
 * `tests/web/governance-pages.test.mjs` for the assertion that keeps the two
 * copies in step.
 */
export const SECURITY_EMPTY_REASON =
  "No deny rows are recorded for the workspaces this caller may read. Either none has " +
  "been written, or your role does not admit you to any. This table is not the whole " +
  "enforced policy: the hosted runtime additionally enforces a separate, process-level " +
  "authorization policy that these rows do not describe, so an empty table is not a " +
  "statement that nothing is denied.";

/**
 * `/workspace/security` — recorded deny rows for the caller's workspaces.
 *
 * Owner/admin only, per `security_deny_admin_read`
 * (`202609090004_contract_f_rls.sql:235`), which calls
 * `private.has_workspace_role(workspace_id, array['owner','admin'])`. A viewer,
 * maintainer or member reads zero rows, and that is the correct policy-faithful
 * outcome rather than a failure.
 *
 * Read-only by design. `authenticated` holds `SELECT` only and no write policy
 * exists on this table, so removing a deny is impossible by privilege as well as
 * by omission — and the console offers no control that would imply otherwise.
 */
export function SecurityPage(): ReactNode {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<readonly SecurityDenyRow[]>(API_ENDPOINTS.securityDenies, {
        signal,
        timeoutMs: 15_000,
        ...(workspaceId ? { query: { workspace: workspaceId, workspace_id: workspaceId } } : {}),
      }),
    [client, workspaceId],
  );
  const resource = useApiResource(load, [client, workspaceId]);

  return (
    <>
      <p className="page__lede">
        Read-only. Removing a deny is a control-plane change and is not performed from this
        console.
      </p>
      <ResourceSection
        state={resource.state}
        reload={resource.reload}
        loadingLabel="Loading security denies…"
        empty={(data) =>
          data.length === 0 ? (
            <EmptyState title="No recorded deny rows" reason={SECURITY_EMPTY_REASON} />
          ) : null
        }
      >
        {(data) => (
          <>
            <section className="state state--warning" aria-labelledby="deny-scope-heading">
              <h3 id="deny-scope-heading">Recorded denies, not the whole enforced policy</h3>
              <p>{SECURITY_DENY_SCOPE_NOTE}</p>
            </section>
            <DataTable
              caption="Recorded control-plane deny rows readable by this caller"
              columns={COLUMNS}
              rows={data}
              rowKey={(row) => row.id}
            />
          </>
        )}
      </ResourceSection>
    </>
  );
}