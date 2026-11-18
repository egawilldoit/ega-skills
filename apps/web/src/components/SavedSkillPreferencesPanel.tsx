import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { ApiError } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import {
  decodePreferences,
  loadPublishedSkillIds,
  reconcilePreferences,
  type ReconciledPreferences,
  type SavedSkillPreferences,
} from "../pages/savedSkillPreferences";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Saved favorites and defaults, reconciled against the current release.
 *
 * Read-only by design. This panel never writes preferences: a catalog reset can
 * leave an old id stored, and the right response is to show it truthfully —
 * saved, but not active — while leaving the stored row intact for the owner to
 * change through the existing preference API. A stale id is never rendered as a
 * link and never given an "active default" marker, so a broken detail route and
 * a misleading selection are both impossible.
 */
export function SavedSkillPreferencesPanel({
  workspaceId,
}: {
  readonly workspaceId: string;
}): ReactNode {
  const client = useApiClient();
  const enabled = UUID.test(workspaceId);

  const load = useCallback(
    async (signal: AbortSignal): Promise<ReconciledPreferences> => {
      const [preferences, publishedIds] = await Promise.all([
        client.get<SavedSkillPreferences>(API_ENDPOINTS.skillPreferences, {
          signal,
          timeoutMs: 15_000,
          query: { workspace_id: workspaceId },
          decode: (value) => {
            const decoded = decodePreferences(value);
            if (decoded === null) throw new Error("Saved skill preferences are invalid.");
            return decoded;
          },
        }),
        loadPublishedSkillIds(client, signal),
      ]);
      return reconcilePreferences(preferences, publishedIds);
    },
    [client, workspaceId],
  );
  const resource = useApiResource(load, [client, workspaceId], { enabled });

  // No workspace context (for example an unscoped release preview) means there
  // are no per-owner preferences to show. The GET route also requires a real
  // workspace UUID; do not send a request it would reject.
  if (!enabled) return null;
  // Non-owners receive 403 from the existing owner-scoped read. That is expected;
  // it is not a console failure and must not surface as an error card here.
  if (resource.state.status === "error" && isQuietError(resource.state.error)) return null;

  return (
    <section className="panel" aria-labelledby="saved-skill-preferences">
      <h2 id="saved-skill-preferences">Your saved skills</h2>
      {resource.state.status === "loading" ? (
        <p className="state state--muted" role="status">
          Loading saved skills…
        </p>
      ) : resource.state.status === "error" ? (
        <p className="state state--muted">Saved skills could not be loaded. Browsing is unaffected.</p>
      ) : (
        <SavedList data={resource.state.data} />
      )}
      <p className="foot">
        Saved only for this workspace. A skill that is not in the current catalog is shown as saved
        but unavailable; it is not a live favorite or default and no link is offered.
      </p>
    </section>
  );
}

function isQuietError(error: ApiError): boolean {
  return error.kind === "forbidden" || error.kind === "unauthorized" || error.kind === "unavailable";
}

function SavedList({ data }: { readonly data: ReconciledPreferences }): ReactNode {
  const { favorites, defaults } = data;
  if (favorites.length === 0 && defaults.length === 0) {
    return <p className="muted">No saved favorites or defaults for this workspace.</p>;
  }
  return (
    <dl className="fields">
      <div>
        <dt>Defaults</dt>
        <dd>
          {defaults.length === 0 ? (
            <span className="muted">None</span>
          ) : (
            <ul className="saved-skill-list">
              {defaults.map((entry) => (
                <li key={entry.skillId}>{savedSkill(entry.skillId, entry.active, "default")}</li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <div>
        <dt>Favorites</dt>
        <dd>
          {favorites.length === 0 ? (
            <span className="muted">None</span>
          ) : (
            <ul className="saved-skill-list">
              {favorites.map((entry) => (
                <li key={entry.skillId}>{savedSkill(entry.skillId, entry.active, "favorite")}</li>
              ))}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}

function savedSkill(skillId: string, active: boolean, kind: "default" | "favorite"): ReactNode {
  return (
    <>
      {active ? (
        <Link to={`/skills/${encodeURIComponent(skillId)}`}>
          <code>{skillId}</code>
        </Link>
      ) : (
        <code>{skillId}</code>
      )}{" "}
      {active ? (
        <span className="badge badge--stable">Active {kind}</span>
      ) : (
        <span className="badge badge--unpinned">Saved {kind} · not in current catalog</span>
      )}
    </>
  );
}
