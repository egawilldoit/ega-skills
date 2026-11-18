import { API_ENDPOINTS, type ApiClient } from "../api/client";
import type { CatalogPage } from "../api/contracts";

/**
 * Read-only reconciliation of saved skill preferences against the published catalog.
 *
 * Favorites and defaults are private rows in `skill_preferences`; a catalog reset
 * can leave an id there that is no longer in the verified release. This module
 * does NOT filter, rewrite or delete those stored values — they are preserved
 * exactly as the API returned them. It only classifies them so the UI can tell
 * an operator what is still active without ever building a broken skill link or
 * presenting a stale default as a live selection.
 */

export interface SavedSkillPreferences {
  readonly revision: number;
  readonly favorite_skill_ids: readonly string[];
  readonly default_skill_ids: readonly string[];
  readonly updated_at: string | null;
}

export interface ReconciledPreference<T extends string> {
  readonly skillId: T;
  /** True when the id is in the readable release and can be linked/selected. */
  readonly active: boolean;
}

export interface ReconciledPreferences {
  readonly favorites: readonly ReconciledPreference<"favorite">[];
  readonly defaults: readonly ReconciledPreference<"default">[];
  readonly staleFavorites: readonly string[];
  readonly staleDefaults: readonly string[];
  readonly available: boolean;
}

const ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** Validate the GET body at the SPA boundary; never trust an unshaped payload. */
export function decodePreferences(value: unknown): SavedSkillPreferences | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["revision"] !== "number" ||
    !Number.isSafeInteger(v["revision"]) ||
    v["revision"] < 0 ||
    !Array.isArray(v["favorite_skill_ids"]) ||
    !Array.isArray(v["default_skill_ids"]) ||
    (v["updated_at"] !== null && typeof v["updated_at"] !== "string")
  ) {
    return null;
  }
  const ids = (raw: unknown[]): string[] | null => {
    const result: string[] = [];
    for (const id of raw) {
      if (typeof id !== "string" || !ID.test(id)) return null;
      if (!result.includes(id)) result.push(id);
    }
    return result;
  };
  const favorites = ids(v["favorite_skill_ids"] as unknown[]);
  const defaults = ids(v["default_skill_ids"] as unknown[]);
  if (favorites === null || defaults === null) return null;
  return Object.freeze({
    revision: v["revision"],
    favorite_skill_ids: Object.freeze(favorites),
    default_skill_ids: Object.freeze(defaults),
    updated_at: v["updated_at"] as string | null,
  });
}

/**
 * Classify saved ids against the published skill ids.
 *
 * `publishedIds` is the set compiled from the same catalog read that drives the
 * skills list, so a stale id can never appear as an active selection. Order and
 * duplicates are preserved for display; membership comes only from the catalog.
 */
export function reconcilePreferences(
  preferences: SavedSkillPreferences,
  publishedIds: ReadonlySet<string>,
): ReconciledPreferences {
  const classify = <T extends string>(ids: readonly string[], kind: T) =>
    ids.map((skillId) => ({ skillId, active: publishedIds.has(skillId) } as ReconciledPreference<T>));
  const favorites = classify(preferences.favorite_skill_ids, "favorite");
  const defaults = classify(preferences.default_skill_ids, "default");
  return {
    favorites,
    defaults,
    staleFavorites: favorites.filter((entry) => !entry.active).map((entry) => entry.skillId),
    staleDefaults: defaults.filter((entry) => !entry.active).map((entry) => entry.skillId),
    available: true,
  };
}

/** An empty reconciliation used while the preferences read is unavailable. */
export function unavailablePreferences(): ReconciledPreferences {
  return {
    favorites: [],
    defaults: [],
    staleFavorites: [],
    staleDefaults: [],
    available: false,
  };
}

/** Compile one catalog page's rows into published ids. */
export function publishedIdsFromPage(page: CatalogPage): ReadonlySet<string> {
  return new Set(page.skills.map((skill) => skill.skill_id));
}

/**
 * Read every published skill id from the same verified release the list uses.
 *
 * A favorite can sit on a later page of the catalog, so the current page is not
 * a sound basis for calling an id stale. Paging the catalog's own read keeps the
 * classification honest with no second registry and no new endpoint. A release
 * that changes mid-read is an error, not a partly reconciled snapshot.
 */
export async function loadPublishedSkillIds(
  client: Pick<ApiClient, "get">,
  signal: AbortSignal,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  let offset = 0;
  let expectedTotal: number | undefined;
  let digest: string | undefined;
  do {
    const page: CatalogPage = await client.get<CatalogPage>(API_ENDPOINTS.skills, {
      signal,
      timeoutMs: 15_000,
      query: { sort: "skill_id", limit: 200, offset },
    });
    if (
      !page.release ||
      page.offset !== offset ||
      page.total > 10_000 ||
      (expectedTotal !== undefined && (page.total !== expectedTotal || page.release.release_digest !== digest)) ||
      (page.skills.length === 0 && offset < page.total)
    ) {
      throw new Error("The published catalog changed while saved skills were checked.");
    }
    expectedTotal = page.total;
    digest = page.release.release_digest;
    for (const skill of page.skills) ids.add(skill.skill_id);
    offset += page.skills.length;
    if (offset > expectedTotal) throw new Error("The published catalog page is invalid.");
  } while (offset < expectedTotal!);
  return ids;
}
