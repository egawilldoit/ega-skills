import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

import { API_ENDPOINTS } from "../api/client";
import type { AuditRow } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState, ResourceSection } from "../components/StatePanel";

/**
 * `/audit` — control-plane audit events, with real client-side filters.
 *
 * ## This is control and security history, not usage analytics
 *
 * Every column here answers a security question: who attempted which operation
 * against which identity, what the identity was before and after, which request
 * carried it, and whether it was allowed or denied. None of that is traffic
 * volume. Request counts and bandwidth belong to the quota surfaces, and the
 * banner below states it so nobody reads this page as a usage report — the two
 * invite opposite conclusions from identical-looking tables.
 *
 * The filter bar deliberately contains **no** request-count or bandwidth control.
 * A charting affordance here would be an analytics surface by another name.
 *
 * ## Why the filters are client-side, and what that costs
 *
 * The adapter's allow-list (`apps/web/server/supabase-read.ts:415-420`) declares
 * exactly four filterable columns on `audit_events`: `workspace_id`,
 * `actor_subject`, `operation`, `result`. There is **no** allow-listed filter on
 * `target_identity`, and no time-range filter exists at all — the adapter builds a
 * PostgREST URL with no ordering and no range operator. Time-window and target
 * filtering therefore has to happen here, over the rows the bounded read
 * returned, which is exactly what the brief asks for.
 *
 * The cost of that is stated on the page rather than hidden: filtering applies to
 * **the page that was read**, not to the whole log. The server's `limit` is
 * explicit and an oversized `limit` is refused rather than truncated, so the
 * count line below the filters reports how many rows were read as well as how
 * many matched. An operator needs both numbers to know whether a narrow filter
 * means "nothing happened" or "nothing on this page happened".
 *
 * ## Never a credential
 *
 * `audit_events` has no credential column, the server projects exactly the ten
 * allow-listed columns, and it joins nothing. There is no path from this table to
 * `source_credentials` (which is not allow-listed at all) or to any secret
 * reference. The rendered columns are the security-relevant identities and
 * nothing else.
 */

/** One client-side filter set. All fields are independent and AND-combined. */
export interface AuditFilters {
  /** Inclusive lower bound on `occurred_at`, as a UTC calendar date (`YYYY-MM-DD`). */
  readonly from: string;
  /** Inclusive upper bound on `occurred_at`, as a UTC calendar date (`YYYY-MM-DD`). */
  readonly to: string;
  /** Free-text match against `actor_subject`, case-insensitive substring. */
  readonly actor: string;
  /** Free-text match against `operation`, case-insensitive substring. */
  readonly operation: string;
  /** Free-text match against `target_identity`, case-insensitive substring. */
  readonly target: string;
  /**
   * `all` | `allowed` | `denied` | `other`.
   *
   * `other` exists because `audit_events.result` is plain `text not null` with
   * **no** `check` constraint in any migration, while `AuditRow.result` is typed
   * `"allowed" | "denied"`. A value outside those two is representable on the
   * wire. Rather than coercing it — which would invent a security judgement — the
   * server passes it through and this page renders it as an unclassified badge.
   * `other` is how an operator isolates those rows instead of losing them inside
   * "all".
   */
  readonly result: "all" | "allowed" | "denied" | "other";
}

/** The neutral filter set: nothing narrowed. */
export const NO_AUDIT_FILTERS: AuditFilters = Object.freeze({
  from: "",
  to: "",
  actor: "",
  operation: "",
  target: "",
  result: "all",
});

/** True when any filter would narrow the result set. */
export function hasActiveAuditFilters(filters: AuditFilters): boolean {
  return (
    filters.from !== "" ||
    filters.to !== "" ||
    filters.actor !== "" ||
    filters.operation !== "" ||
    filters.target !== "" ||
    filters.result !== "all"
  );
}

/** Normalise a `YYYY-MM-DD` date input. Anything else is dropped, not coerced. */
function auditDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

/**
 * Case-insensitive substring match.
 *
 * `null` targets count as **absent, not empty**: a row with no
 * `target_identity` does not match a search for the empty string, and does not
 * match a search for text either. Matching on `null` would let a search for `a`
 * return every identity-less row, which would misrepresent the log.
 */
function matchesText(haystack: string | null, needle: string): boolean {
  if (needle === "") return true;
  if (haystack === null) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Apply the filter set to one row.
 *
 * Dates compare as the **UTC calendar date** prefix of `occurred_at`, which is
 * what `<input type="date">` yields. That is a deliberate simplification rather
 * than a timezone bug: the alternative is a local-timezone boundary that silently
 * shifts events across midnight, and a filter that misplaces an event is worse
 * than one that reports a UTC window. The inputs are labelled UTC for that
 * reason.
 */
export function auditRowMatches(row: AuditRow, filters: AuditFilters): boolean {
  const from = auditDate(filters.from);
  const to = auditDate(filters.to);
  if (from !== "" || to !== "") {
    const day = row.occurred_at.slice(0, 10);
    if (from !== "" && day < from) return false;
    if (to !== "" && day > to) return false;
  }
  if (!matchesText(row.actor_subject, filters.actor)) return false;
  if (!matchesText(row.operation, filters.operation)) return false;
  if (!matchesText(row.target_identity, filters.target)) return false;
  switch (filters.result) {
    case "allowed":
      return row.result === "allowed";
    case "denied":
      return row.result === "denied";
    case "other":
      return row.result !== "allowed" && row.result !== "denied";
    case "all":
      return true;
  }
}

/**
 * Order newest first, tie-broken by the `bigint` primary key descending.
 *
 * The server sends no `order` parameter, so arrival order is whatever PostgREST
 * returned and is not stable. A time filter over an unordered page would put
 * matching rows in an arbitrary sequence, which reads as a broken log.
 *
 * `id` is compared through `BigInt` rather than numerically because it crosses
 * the wire as a decimal string (`audit_events.id` is
 * `bigint generated always as identity`, and `JSON.stringify` throws on a
 * `BigInt`, so `governance.ts` stringifies it). Comparing those strings
 * lexically would order `10` before `9`. Unparseable ids fall back to lexical
 * order rather than throwing in a render path.
 */
export function sortAuditRows(rows: readonly AuditRow[]): readonly AuditRow[] {
  return [...rows].sort((left, right) => {
    if (left.occurred_at !== right.occurred_at) {
      return left.occurred_at < right.occurred_at ? 1 : -1;
    }
    try {
      const a = BigInt(left.id);
      const b = BigInt(right.id);
      if (a !== b) return a < b ? 1 : -1;
    } catch {
      if (left.id !== right.id) return left.id < right.id ? 1 : -1;
    }
    return 0;
  });
}

const COLUMNS: readonly Column<AuditRow>[] = [
  {
    key: "occurred_at",
    label: "Occurred",
    render: (row) => <time dateTime={row.occurred_at}>{row.occurred_at}</time>,
  },
  { key: "actor_subject", label: "Actor", mono: true, render: (row) => row.actor_subject },
  { key: "operation", label: "Operation", mono: true, render: (row) => row.operation },
  {
    key: "target_identity",
    label: "Target",
    mono: true,
    render: (row) => row.target_identity ?? "—",
  },
  {
    key: "old_identity",
    label: "Old identity",
    mono: true,
    render: (row) => row.old_identity ?? "—",
  },
  {
    key: "new_identity",
    label: "New identity",
    mono: true,
    render: (row) => row.new_identity ?? "—",
  },
  {
    key: "request_id",
    label: "Request ID",
    mono: true,
    render: (row) => row.request_id ?? "—",
  },
  { key: "result", label: "Result", render: (row) => <ResultBadge result={row.result} /> },
];

/**
 * The result badge.
 *
 * `allowed` and `denied` get the two semantic treatments. **Anything else gets a
 * neutral badge with the raw value**, never one of the two colours: `result` has
 * no database `check` constraint, so an unrecognised value is real and colouring
 * it as `allowed` or `denied` would be the console asserting a security outcome it
 * has no basis for.
 */
function ResultBadge({ result }: { readonly result: string }): ReactNode {
  if (result === "allowed") return <span className="badge badge--stable">allowed</span>;
  if (result === "denied") return <span className="badge badge--mismatch">denied</span>;
  return (
    <span className="badge badge--muted" title="An audit result this console does not classify">
      {result}
    </span>
  );
}

/**
 * Not-analytics banner.
 *
 * Duplicated from `AUDIT_NOT_ANALYTICS_NOTE` in
 * `apps/web/server/governance.ts`; see `QuotasPage.tsx` for why the server and
 * page cannot share one constant.
 */
export const AUDIT_NOT_ANALYTICS_NOTE =
  "Control and security history: who attempted which operation against which identity, " +
  "and whether it was allowed or denied. This is not usage analytics — request volume and " +
  "bandwidth belong to the quota surfaces, and no credential, token, or secret value is " +
  "recorded in or reachable from these rows.";

/**
 * Empty-state reason for `audit_events`.
 *
 * Names both indistinguishable causes, because a viewer legitimately sees none
 * and must not be told they are looking at a zero. Duplicated from
 * `EMPTY_AUDIT_REASON` in `apps/web/server/governance.ts`.
 */
export const AUDIT_EMPTY_REASON =
  "No audit events have been recorded for the workspaces this caller may read. " +
  "Either no control-plane writer has produced an event yet, or your workspace role " +
  "does not admit you to any event — audit rows are scoped to owner and admin, and a " +
  "viewer, maintainer or member correctly sees none. This is an absence of records, not a count of zero events.";

/** Shown when the filters exclude every row that was read. */
function filteredEmptyReason(read: number): string {
  return (
    `No audit event on this page matches the filters. ${read} ` +
    `${read === 1 ? "event was" : "events were"} read, so this is a statement about the ` +
    "rows the bounded read returned — not about the whole audit log. Widen the date range, " +
    "or clear the filters to see them."
  );
}

/**
 * `/audit` — control-plane audit events, owner/admin only.
 *
 * Owner/admin only, per `audit_admin_read`
 * (`202609090004_contract_f_rls.sql:239`), which requires both a non-null
 * `workspace_id` and `private.has_workspace_role(workspace_id, {owner, admin})`.
 * A viewer, maintainer or member therefore reads zero rows — the correct,
 * policy-faithful outcome, rendered through a stated reason rather than as a
 * broken table or a count of zero.
 *
 * Ordering is the page's own, over the page it read: see {@link sortAuditRows}.
 * The read-only guarantee is `authenticated` holds `SELECT` and no write policy
 * exists, so there is no mutation control here to imply otherwise — the only
 * button is a client-side filter reset.
 */
export function AuditPage(): ReactNode {
  const client = useApiClient();
  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<readonly AuditRow[]>(API_ENDPOINTS.auditEvents, {
        signal,
        timeoutMs: 20_000,
        // The bounded page is what the filters apply to, so ask for the largest
        // page the adapter permits rather than the 50-row default: an operator
        // filtering a window should not be silently capped below it.
        query: { limit: 200 },
      }),
    [client],
  );
  const resource = useApiResource(load, [client]);

  /**
   * Merge a partial filter set.
   *
   * Takes a patch rather than a `(key, value)` pair with a generic, because a
   * generic arrow function in a `.tsx` file is parsed as JSX by some toolchains.
   * A patch object is unambiguous and needs no cast at the call sites that pass a
   * plain `event.target.value`.
   */
  const set = useCallback((patch: Partial<AuditFilters>) => {
    setFilters((previous) => ({ ...previous, ...patch }));
  }, []);

  const matching = useMemo(() => {
    if (resource.state.status !== "ready") return [];
    return sortAuditRows(resource.state.data.filter((row) => auditRowMatches(row, filters)));
  }, [resource.state, filters]);

  const narrowed = hasActiveAuditFilters(filters);

  return (
    <>
      <p className="page__lede">
        Read-only. Owner and admin only. Filters apply to the page read below, not to the whole
        log.
      </p>
      <ResourceSection
        state={resource.state}
        reload={resource.reload}
        loadingLabel="Loading audit events…"
        empty={(data) =>
          data.length === 0 ? (
            <EmptyState title="No audit events have been recorded" reason={AUDIT_EMPTY_REASON} />
          ) : null
        }
      >
        {(data) => (
          <>
            <section className="state state--warning" aria-labelledby="audit-scope-heading">
              <h3 id="audit-scope-heading">Control and security history, not usage analytics</h3>
              <p>{AUDIT_NOT_ANALYTICS_NOTE}</p>
            </section>

            <div className="compare-form">
              <div className="field">
                <label className="field__label" htmlFor="audit-from">
                  From (UTC)
                </label>
                <input
                  id="audit-from"
                  className="field__input"
                  type="date"
                  value={filters.from}
                  onChange={(event) => set({ from: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="audit-to">
                  To (UTC)
                </label>
                <input
                  id="audit-to"
                  className="field__input"
                  type="date"
                  value={filters.to}
                  onChange={(event) => set({ to: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="audit-actor">
                  Actor contains
                </label>
                <input
                  id="audit-actor"
                  className="field__input"
                  type="search"
                  value={filters.actor}
                  onChange={(event) => set({ actor: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="audit-operation">
                  Operation contains
                </label>
                <input
                  id="audit-operation"
                  className="field__input"
                  type="search"
                  value={filters.operation}
                  onChange={(event) => set({ operation: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="audit-target">
                  Target contains
                </label>
                <input
                  id="audit-target"
                  className="field__input"
                  type="search"
                  value={filters.target}
                  onChange={(event) => set({ target: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="audit-result">
                  Result
                </label>
                <select
                  id="audit-result"
                  className="field__input"
                  value={filters.result}
                  onChange={(event) => set({ result: event.target.value as AuditFilters["result"] })}
                >
                  <option value="all">All results</option>
                  <option value="allowed">Allowed</option>
                  <option value="denied">Denied</option>
                  <option value="other">Other (not classified by this console)</option>
                </select>
              </div>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setFilters(NO_AUDIT_FILTERS)}
                disabled={!narrowed}
              >
                Clear filters
              </button>
              <p className="field__hint">
                <span className="count">{matching.length}</span> matching
                {narrowed ? " of " : " "}
                {narrowed ? `${data.length} ` : ""}
                {data.length === 1 ? "event" : "events"} read
                {narrowed ? " on this page." : ". No filters applied."}
              </p>
            </div>

            {matching.length === 0 ? (
              <EmptyState title="No audit event matches these filters" reason={filteredEmptyReason(data.length)} />
            ) : (
              <DataTable
                caption="Control-plane audit events readable by this caller"
                columns={COLUMNS}
                rows={matching}
                rowKey={(row) => row.id}
              />
            )}
          </>
        )}
      </ResourceSection>
    </>
  );
}