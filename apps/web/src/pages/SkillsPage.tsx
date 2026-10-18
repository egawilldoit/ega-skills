import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { CatalogPage, SkillSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { categoryAxes, CategoryBrowse, type CategoryAxisKey } from "../components/CategoryBrowse";
import {
  catalogQueryParams,
  CatalogControls,
  CatalogPagination,
  emptyCatalogQuery,
  type CatalogQuery,
} from "../components/CatalogControls";
import { DataTable, type Column } from "../components/DataTable";
import { shortDigest } from "../components/ReleaseStatus";
import { EmptyState, ResourceSection } from "../components/StatePanel";

/**
 * Sort keys the catalog accepts.
 *
 * Mirrors `CATALOG_SORT_KEYS` in `apps/web/server/catalog.ts`. The server is
 * the authority — an unknown key is rejected with a 400 — so this list is
 * duplicated deliberately rather than discovered: the SPA cannot import from the
 * server module, and offering a key the server refuses would turn every sort
 * click into an error. `catalog.test.mjs` asserts the two lists agree.
 */
const SORT_KEYS = [
  "skill_id",
  "name",
  "namespace",
  "domain",
  "framework",
  "l1_status",
  "l1_tokens",
  "l2_tokens",
  "source_type",
  "trust_level",
] as const;

const COLUMNS: readonly Column<SkillSummary>[] = [
  {
    key: "skill_id",
    label: "Skill",
    mono: true,
    // Wide enough that a long `namespace/name` id wraps at its separator rather
    // than at an arbitrary character in the description beside it.
    width: "230px",
    render: (row) => (
      <Link to={`/skills/${encodeURIComponent(row.skill_id)}`}>{row.skill_id}</Link>
    ),
  },
  { key: "name", label: "Name", width: "160px", render: (row) => row.name },
  { key: "description", label: "Description", render: (row) => row.description },
  {
    key: "domains",
    label: "Domains",
    width: "120px",
    render: (row) => (row.domains.length === 0 ? "—" : row.domains.join(", ")),
  },
  {
    key: "content_digest",
    label: "Content digest",
    mono: true,
    width: "150px",
    render: (row) => <span title={row.content_digest}>{shortDigest(row.content_digest)}</span>,
  },
];

/**
 * `/skills` — the skills published in the currently readable release.
 *
 * `/skills` is served by the same `handleCatalog` as `/catalog`, so it answers
 * with the catalog envelope — `{ skills, total, limit, offset, sort,
 * applied_filters, facets }` — and not a bare array. The page read the body as
 * `SkillSummary[]` and called `.map` on an object, throwing during render.
 *
 * Search, filters, sort and paging are all performed by the server: the catalog
 * is 116 skills against a default page ceiling of 50, so a client-side slice
 * would both hide most of the catalog and disagree with the server's own
 * totals. `total` counts every match; `skills.length` counts this page.
 *
 * When the deployment holds no verified release the BFF answers with an error
 * and the shared error panel renders an explicit unavailable state. The console
 * does not fall back to a cached or previous release's contents.
 */
export function SkillsPage(): ReactNode {
  const client = useApiClient();
  const [query, setQuery] = useState<CatalogQuery>(emptyCatalogQuery);

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<CatalogPage>(API_ENDPOINTS.skills, {
        signal,
        timeoutMs: 15_000,
        query: catalogQueryParams(query),
      }),
    [client, query],
  );
  // The query is part of the dependency list, so changing a filter re-reads.
  const resource = useApiResource(load, [client, query]);

  /**
   * Choosing a category selects the catalog's own filter for that axis.
   *
   * The value becomes the matching query parameter and the same server-side
   * catalog answers, so a category can never become a second enumeration path.
   * `""` is the catalog's own "no filter" encoding. Choosing the active category
   * again clears it, so the panel is also the way back to the whole catalog.
   */
  const selectCategory = useCallback((key: CategoryAxisKey, value: string) => {
    setQuery((previous) => ({
      ...previous,
      [key]: previous[key] === value ? "" : value,
      offset: 0,
    }));
  }, []);

  const clearCategory = useCallback(() => {
    setQuery((previous) => ({
      ...previous,
      namespace: "",
      domain: "",
      framework: "",
      group: "",
      offset: 0,
    }));
  }, []);

  return (
    <>
      <ResourceSection
        state={resource.state}
        reload={resource.reload}
        loadingLabel="Loading skills…"
      >
        {(data) => {
          const axes = categoryAxes(data.facets);
          const selected = {
            namespace: query.namespace,
            domain: query.domain,
            framework: query.framework,
            group: query.group,
          };
          const active = axes.flatMap((axis) =>
            selected[axis.key] === "" ? [] : [{ label: axis.label, value: selected[axis.key] }],
          );
          const releaseDigest = data.release === null ? null : data.release.release_digest;

          return (
            <>
              {/*
                The category panel and the controls stay mounted when nothing
                matches, so a filter the server refuses to satisfy — including one
                typed into the URL by hand — is always recoverable in place. The
                list below reports the honest zero.
              */}
              <CategoryBrowse
                axes={axes}
                selected={selected}
                onSelect={selectCategory}
                onClear={clearCategory}
              />

              {active.length > 0 ? (
                <p className="category-browse__active">
                  Category {active.map((entry) => `${entry.label}: ${entry.value}`).join(" · ")} —{" "}
                  {data.total} {data.total === 1 ? "skill" : "skills"} from the readable release
                  {releaseDigest === null ? "" : ` (${shortDigest(releaseDigest)})`}.
                </p>
              ) : null}

              <CatalogControls
                query={query}
                facets={data.facets}
                applied={data.applied_filters}
                sortKeys={SORT_KEYS}
                onChange={setQuery}
              />

              {/*
                `total` is every match in the release; `skills.length` is this
                page. Showing both keeps the page from implying it lists
                everything.
              */}
              <p className="page__lede">
                {data.total} {data.total === 1 ? "skill matches" : "skills match"} in the readable
                release.
              </p>

              {data.total === 0 ? (
                <EmptyState
                  title="No skills match"
                  reason="The verified release snapshot for this deployment contains no skills matching these filters."
                />
              ) : (
                <>
                  <DataTable
                    caption="Skills in the readable Hub release"
                    columns={COLUMNS}
                    rows={data.skills as readonly SkillSummary[]}
                    rowKey={(row) => row.skill_id}
                  />
                  <CatalogPagination
                    total={data.total}
                    offset={data.offset}
                    limit={data.limit}
                    onOffset={(offset) => setQuery((previous) => ({ ...previous, offset }))}
                  />
                </>
              )}
            </>
          );
        }}
      </ResourceSection>
    </>
  );
}