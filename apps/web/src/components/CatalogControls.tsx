import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";

import type { CatalogAppliedFilters, CatalogFacets, CatalogFacetValue } from "../api/contracts";

/**
 * The catalog's query state, as the SPA holds it.
 *
 * Kept separate from `CatalogPage` because it is the *request*, not the
 * response: nothing here is invented, and every field maps one-to-one onto a
 * parameter `catalogOptions()` reads. `limit` is the page size, `offset` the
 * window into the filtered set.
 */
export interface CatalogQuery {
  readonly q: string;
  readonly namespace: string;
  readonly domain: string;
  readonly framework: string;
  readonly source: string;
  readonly l1: string;
  /**
   * A `CATALOG_SORT_KEYS` key, optionally `-`-prefixed for descending.
   *
   * The `-` prefix is the server's own notation, so it is stored verbatim rather
   * than split into two fields. Splitting it here would mean the page had to
   * re-assemble it on every request and could disagree with the server about
   * what it sent.
   */
  readonly sort: string;
  readonly limit: number;
  readonly offset: number;
}

/** An empty query: no filters, default ordering, first page. */
export function emptyCatalogQuery(): CatalogQuery {
  return {
    q: "",
    namespace: "",
    domain: "",
    framework: "",
    source: "",
    l1: "",
    sort: "name",
    limit: 50,
    offset: 0,
  };
}

/** The subset that is sent as query parameters. Blank values are omitted. */
export function catalogQueryParams(query: CatalogQuery): Record<string, string | number> {
  const params: Record<string, string | number> = {
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  };
  if (query.q.trim() !== "") params["q"] = query.q.trim();
  if (query.namespace !== "") params["namespace"] = query.namespace;
  if (query.domain !== "") params["domain"] = query.domain;
  if (query.framework !== "") params["framework"] = query.framework;
  if (query.source !== "") params["source"] = query.source;
  if (query.l1 !== "") params["l1"] = query.l1;
  return params;
}

/** True when anything narrows the result beyond ordering and paging. */
export function hasActiveFilters(query: CatalogQuery): boolean {
  return (
    query.q.trim() !== "" ||
    query.namespace !== "" ||
    query.domain !== "" ||
    query.framework !== "" ||
    query.source !== "" ||
    query.l1 !== ""
  );
}

/**
 * A field the server echoed back, so the UI can show what was *actually*
 * applied rather than what the form currently holds. This matters because the
 * server trims and validates: a filter the user typed but the server rejected is
 * not the same as a filter that is in force.
 */
export interface AppliedFilterView {
  readonly label: string;
  readonly field: keyof CatalogAppliedFilters;
}

const APPLIED_FILTER_FIELDS: readonly AppliedFilterView[] = [
  { label: "Search", field: "q" },
  { label: "Namespace", field: "namespace" },
  { label: "Domain", field: "domain" },
  { label: "Framework", field: "framework" },
  { label: "Source", field: "source" },
  { label: "L1", field: "l1" },
];

/**
 * Search, filter, sort and page controls for the catalog.
 *
 * Every control is driven by the values the server returned: the filter options
 * are the real facet values with their real counts, and the sort keys are the
 * ones `CATALOG_SORT_KEYS` accepts. No option is hard-coded, so the UI cannot
 * offer a filter the catalog cannot satisfy, and a facet that exists in the
 * data but not in this list simply is not offered.
 *
 * Changing any filter resets the offset to the first page. Keeping the old
 * offset after narrowing would land the operator on an empty page and read as
 * "no results" when matches exist.
 */
export function CatalogControls({
  query,
  facets,
  applied,
  onChange,
  sortKeys,
}: {
  readonly query: CatalogQuery;
  readonly facets: CatalogFacets;
  readonly applied: CatalogAppliedFilters;
  readonly onChange: (next: CatalogQuery) => void;
  readonly sortKeys: readonly string[];
}): ReactNode {
  const searchId = useId();
  const [searchDraft, setSearchDraft] = useState(query.q);

  // Keep the draft in step when the query is reset from outside (for example by
  // "Clear filters"), without clobbering what the user is mid-way through typing.
  useEffect(() => {
    setSearchDraft(query.q);
  }, [query.q]);

  const set = (patch: Partial<CatalogQuery>): void => {
    onChange({
      ...query,
      ...patch,
      // Any narrowing invalidates the current window.
      offset: patch.offset ?? 0,
    });
  };

  return (
    <form
      className="catalog-controls"
      onSubmit={(event) => {
        event.preventDefault();
        set({ q: searchDraft });
      }}
      role="search"
    >
      <div className="field">
        <label className="field__label" htmlFor={searchId}>
          Search skills
        </label>
        <input
          className="field__input"
          id={searchId}
          name="q"
          type="search"
          value={searchDraft}
          placeholder="name, description, id…"
          onChange={(event) => setSearchDraft(event.target.value)}
        />
        <button type="submit" className="button">
          Search
        </button>
      </div>

      <div className="catalog-controls__filters">
        <FacetSelect
          label="Namespace"
          value={query.namespace}
          options={facets.namespaces}
          onChange={(value) => set({ namespace: value })}
        />
        <FacetSelect
          label="Domain"
          value={query.domain}
          options={facets.domains}
          onChange={(value) => set({ domain: value })}
        />
        <FacetSelect
          label="Framework"
          value={query.framework}
          options={facets.frameworks}
          onChange={(value) => set({ framework: value })}
        />
        <FacetSelect
          label="Source"
          value={query.source}
          options={facets.sources}
          onChange={(value) => set({ source: value })}
        />
        <FacetSelect
          label="L1 availability"
          value={query.l1}
          options={facets.l1_statuses}
          onChange={(value) => set({ l1: value })}
        />
        <div className="field">
          <label className="field__label" htmlFor={`${searchId}-sort`}>
            Sort
          </label>
          <select
            className="field__input"
            id={`${searchId}-sort`}
            name="sort"
            value={query.sort}
            onChange={(event) => set({ sort: event.target.value })}
          >
            {sortKeys.map((key) => (
              <option key={`asc:${key}`} value={key}>
                {key} ascending
              </option>
            ))}
            {sortKeys.map((key) => (
              <option key={`desc:${key}`} value={`-${key}`}>
                {key} descending
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${searchId}-limit`}>
            Per page
          </label>
          <select
            className="field__input"
            id={`${searchId}-limit`}
            name="limit"
            value={query.limit}
            onChange={(event) => set({ limit: Number(event.target.value) })}
          >
            {[25, 50, 100, 200].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
        {hasActiveFilters(query) ? (
          <button
            type="button"
            className="button"
            onClick={() => onChange({ ...emptyCatalogQuery(), limit: query.limit })}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <AppliedFilters applied={applied} />
    </form>
  );
}

/** A `<select>` whose options are the server's facet values and real counts. */
function FacetSelect({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly CatalogFacetValue[];
  readonly onChange: (value: string) => void;
}): ReactNode {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        className="field__input"
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.value} ({option.skill_count})
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The filters the server says it applied.
 *
 * Rendered from the echoed `applied_filters` rather than from local state, so
 * this can never claim a filter is active when the server ignored or rejected
 * it.
 */
function AppliedFilters({ applied }: { readonly applied: CatalogAppliedFilters }): ReactNode {
  const active = APPLIED_FILTER_FIELDS.filter((entry) => applied[entry.field] !== null).map(
    (entry) => ({ label: entry.label, value: String(applied[entry.field]) }),
  );
  if (active.length === 0) return null;
  return (
    <p className="catalog-controls__applied">
      Applied:{" "}
      {active.map((entry) => (
        <span key={entry.label} className="chip">
          {entry.label}: {entry.value}
        </span>
      ))}
    </p>
  );
}

/**
 * Paging controls.
 *
 * `total` is the match count across the whole filtered set; `shown` is the rows
 * on this page. The two are reported separately because conflating them either
 * hides the rest of the catalog or overstates what is on screen.
 */
export function CatalogPagination({
  total,
  offset,
  limit,
  onOffset,
}: {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly onOffset: (offset: number) => void;
}): ReactNode {
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);
  const canPrevious = offset > 0;
  const canNext = offset + limit < total;

  return (
    <nav className="catalog-pagination" aria-label="Catalog pages">
      <p className="catalog-pagination__status" aria-live="polite">
        Showing {first}–{last} of {total} matching{" "}
        {total === 1 ? "skill" : "skills"}
      </p>
      <div className="catalog-pagination__buttons">
        <button
          type="button"
          className="button"
          disabled={!canPrevious}
          onClick={() => onOffset(Math.max(0, offset - limit))}
        >
          Previous
        </button>
        <button
          type="button"
          className="button"
          disabled={!canNext}
          onClick={() => onOffset(offset + limit)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}