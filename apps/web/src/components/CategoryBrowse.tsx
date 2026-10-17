import type { ReactNode } from "react";

import type { CatalogFacets, CatalogFacetValue } from "../api/contracts";

/**
 * Presentation categories for the governed catalog (EGA-724).
 *
 * ## What a category is here, and what it is deliberately not
 *
 * A category is one of the catalog's **own** grouping values, exactly as the
 * server already reports them in `CatalogFacets`. The panel renders the values
 * the current response carries and nothing else:
 *
 * - It holds no skill registry, no skill id, and no label the server did not
 *   send, so it cannot invent a category or a member skill.
 * - Every category maps onto a filter `/skills` already accepts (`namespace`,
 *   `domain`, `framework`), so choosing one re-reads the list from the same
 *   authoritative catalog module. There is no second enumeration path and no
 *   second authority; this module is presentation only.
 * - Counts are the server's real per-category counts over the filtered set, so a
 *   category that covers one skill reads as one skill. The shipped release is
 *   genuinely sparse (only 7 of 114 skills carry a domain), and this panel shows
 *   that sparseness rather than hiding it behind fabricated groupings.
 *
 * The human-intent grouping authored in PR #138's `catalog/presentation.yaml`
 * is not present on this branch's base, so it is not projected here. When it
 * lands, it belongs behind this same seam: an extra axis whose values are
 * validated against the release's `skill_versions` and resolved to catalog rows
 * by the existing catalog reader. It must never become a second catalog.
 */

/** The catalog filter each presentation axis is served by. */
export type CategoryAxisKey = "namespace" | "domain" | "framework";

/** One presentation axis and the server's own values for it. */
export interface CategoryAxis {
  readonly key: CategoryAxisKey;
  readonly label: string;
  readonly values: readonly CatalogFacetValue[];
}

/**
 * The axes, in presentation order, and the facet list each one reads.
 *
 * The mapping is total: every axis names a filter `apps/web/server/catalog.ts`
 * implements and a facet both `catalog.ts` and `CatalogFacets` declare, so the
 * panel cannot offer a selection the server would reject.
 */
const AXES: readonly {
  readonly key: CategoryAxisKey;
  readonly label: string;
  readonly facet: keyof CatalogFacets;
}[] = [
  { key: "namespace", label: "Publisher", facet: "namespaces" },
  { key: "domain", label: "Domain", facet: "domains" },
  { key: "framework", label: "Framework", facet: "frameworks" },
];

/**
 * The axes that have at least one value in this response.
 *
 * An axis with no values is dropped rather than rendered empty: a heading with
 * nothing under it reads as "there are no skills like this", which is a claim
 * about the release this component cannot make.
 */
export function categoryAxes(facets: Readonly<CatalogFacets>): readonly CategoryAxis[] {
  return AXES.map((axis) => ({
    key: axis.key,
    label: axis.label,
    values: facets[axis.facet],
  })).filter((axis) => axis.values.length > 0);
}

/**
 * The category the operator has chosen, one value per axis.
 *
 * `""` is "no category on this axis", which is the catalog's own encoding for an
 * absent filter — not a category named the empty string.
 */
export type CategorySelection = Readonly<Record<CategoryAxisKey, string>>;

/**
 * The "Browse by category" panel.
 *
 * Every button is `aria-pressed`, so the active category is announced rather
 * than only coloured. Choosing the active category again clears it, so the panel
 * is also the way back to the whole catalog.
 */
export function CategoryBrowse({
  axes,
  selected,
  onSelect,
  onClear,
}: {
  readonly axes: readonly CategoryAxis[];
  readonly selected: CategorySelection;
  readonly onSelect: (key: CategoryAxisKey, value: string) => void;
  readonly onClear: () => void;
}): ReactNode {
  if (axes.length === 0) return null;
  const hasSelection = axes.some((axis) => selected[axis.key] !== "");
  return (
    <section className="category-browse panel" aria-labelledby="category-browse-title">
      <h2 id="category-browse-title">Browse by category</h2>
      <p className="category-browse__hint">
        Categories are the readable release&apos;s own catalog values. Choosing one filters the list
        below; it never adds, renames or reorders a skill.
      </p>
      {axes.map((axis) => (
        <div className="category-browse__axis" key={axis.key}>
          <h3 className="category-browse__axis-title">{axis.label}</h3>
          <ul className="category-browse__values">
            {axis.values.map((facet) => {
              const pressed = selected[axis.key] === facet.value;
              return (
                <li key={`${axis.key}:${facet.value}`}>
                  <button
                    type="button"
                    className={pressed ? "button button--primary" : "button button--secondary"}
                    aria-pressed={pressed}
                    onClick={() => onSelect(axis.key, facet.value)}
                  >
                    {facet.value} ({facet.skill_count})
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {hasSelection ? (
        <button type="button" className="button" onClick={onClear}>
          Clear category
        </button>
      ) : null}
    </section>
  );
}
