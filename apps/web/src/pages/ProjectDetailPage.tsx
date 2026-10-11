import { useWorkspace } from "../workspace/WorkspaceProvider";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { ProjectContextSummary, ProjectDetail, ProjectSummary } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource, type ResourceState } from "../api/useApiResource";
import { DataTable, Field, type Column } from "../components/DataTable";
import {
  EmptyState,
  ErrorState,
  ResourceSection,
  UnavailableState,
} from "../components/StatePanel";

/**
 * `/projects/:projectId` — project identity, every readable context, and the
 * release each one is **pinned to**.
 *
 * ## The one question this page answers
 *
 * *Which exact release is this context pinned to?* The answer is the context's own
 * `release_digest`, and it is the largest thing on the page: the first field of
 * its own panel, in monospace, as selectable text so it can be copied straight
 * into a ticket or a diff.
 *
 * ## Three rules this page is built around
 *
 * 1. **A pin is never replaced.** Nothing here resolves "the current release" in
 *    order to stand in for a pin. The release this deployment serves is reported
 *    once, on its own line, explicitly labelled as *not* the pin, because an
 *    operator comparing the two needs both — and a pin that has been quietly
 *    swapped for the served release is worse than no pin at all.
 * 2. **A revoked context is distinct, and its pin still matters.** A revoked row
 *    renders with a danger badge, a warning surface, and its pinned digest
 *    unchanged: the pin of a revoked context is precisely what an operator needs.
 * 3. **What cannot be read is named, not faked.** `private.can_read_context`
 *    excludes a revoked context from *every* role, including its own workspace's
 *    owner, so this console cannot list it and cannot quote its pin. That is a
 *    policy fact rather than missing data, and the page states it explicitly
 *    instead of leaving a reader to infer "no contexts" from an empty table. No
 *    revocation record is invented to fill the gap.
 */

/* -------------------------------------------------------------------------- */
/* Response shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The `/projects/:projectId` payload as this page reads it.
 *
 * Structurally the shared {@link ProjectDetail} with three additive fields and a
 * widened context row; the canonical declarations live in
 * `apps/web/server/projects.ts`, which is the single source of truth for the wire
 * shape. They are repeated here rather than imported because a browser module must
 * not import the server directory, so the two declarations are kept in step by
 * `tests/web/project-pages.test.mjs`, which renders the real route's real response.
 */

/** Whether a context's pinned release is one this deployment can resolve. */
export type PinnedReleaseResolution = "resolvable" | "not-resolvable" | "unknown";

/** One context, plus what can honestly be said about its pin. */
export interface ProjectContextRow extends ProjectContextSummary {
  readonly release_resolution: PinnedReleaseResolution;
  readonly release_resolution_reason: string;
}

/** One readable `context_revocations` row. */
export interface ContextRevocationView {
  readonly context_id: string;
  readonly revoked_at: string;
  readonly revoked_by: string;
  readonly reason: string;
}

/** The detail payload. Every {@link ProjectDetail} field is present unchanged. */
export interface ProjectDetailView extends Omit<ProjectDetail, "contexts"> {
  readonly contexts: readonly ProjectContextRow[];
  readonly revocations: readonly ContextRevocationView[];
  readonly contexts_unavailable_reason: string | null;
  readonly revocations_unavailable_reason: string | null;
  readonly served_release_digest: string | null;
  readonly served_release_unavailable_reason: string | null;
  readonly context_policy_note: string;
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                         */
/* -------------------------------------------------------------------------- */

/** Title of the panel that exists to make the pin impossible to miss. */
export const PIN_PANEL_TITLE = "Pinned release";

/** The sentence above each pin, naming the question the digest answers. */
export const PIN_LEAD =
  "This context is pinned to exactly this release digest. The value is the whole answer: copy it as " +
  "it stands, and do not read any other digest on this page as a substitute for it.";

/**
 * The pin-versus-served-release contrast.
 *
 * Always rendered, including when the two digests happen to be equal — a reader
 * must never have to wonder whether the page substituted one for the other.
 */
export function pinContrastNote(
  servedReleaseDigest: string | null,
  servedReleaseUnavailableReason: string | null,
): string {
  if (servedReleaseDigest === null) {
    return (
      "This deployment does not resolve a single served release, so there is no current release to " +
      `contrast these pins against. ${servedReleaseUnavailableReason ?? ""}`.trim()
    );
  }
  return (
    `This deployment currently serves ${servedReleaseDigest}, which is a fact about the deployment and ` +
    "not about these contexts. A context pins the release the runtime resolves against, which is " +
    "frequently not the release this console serves. No pin on this page has been replaced by it."
  );
}

/** Human label for one {@link PinnedReleaseResolution}. */
export function resolutionLabel(resolution: PinnedReleaseResolution): string {
  switch (resolution) {
    case "resolvable":
      return "This deployment can serve this pin";
    case "not-resolvable":
      return "This deployment does not ship this pin";
    case "unknown":
      return "This deployment cannot say";
  }
}

/** Badge modifier matching a resolution verdict. */
function resolutionBadge(resolution: PinnedReleaseResolution): string {
  switch (resolution) {
    case "resolvable":
      return "badge--stable";
    case "not-resolvable":
      return "badge--mismatch";
    case "unknown":
      return "badge--unpinned";
  }
}

/* -------------------------------------------------------------------------- */
/* Panels                                                                       */
/* -------------------------------------------------------------------------- */

function ResolutionBadge({ context }: { readonly context: ProjectContextRow }): ReactNode {
  return <span className={`badge ${resolutionBadge(context.release_resolution)}`}>{resolutionLabel(context.release_resolution)}</span>;
}

/**
 * One context, led by its pin.
 *
 * The pin is the first field, in its own `<code>` element so it selects and copies
 * as one string, and it is preceded by {@link PIN_LEAD} so a reader knows what the
 * number is before they read it.
 */
function ContextPanel({ context }: { readonly context: ProjectContextRow }): ReactNode {
  const revoked = context.revoked_at !== null;
  return (
    <section
      className="panel"
      aria-labelledby={`context-${context.context_id}`}
      data-revoked={revoked ? "true" : "false"}
    >
      <h3 id={`context-${context.context_id}`}>
        Context <span className="mono">{context.context_digest}</span>{" "}
        {revoked ? (
          <span className="badge badge--mismatch">Revoked</span>
        ) : (
          <span className="badge badge--stable">Active</span>
        )}
      </h3>

      {revoked ? (
        <p className="state state--warning" role="note">
          This context is revoked. Its pinned release digest is shown unchanged, because the pin of a
          revoked context is exactly what you need in order to tell what stopped being resolved.
        </p>
      ) : (
        <p className="page__lede">{PIN_LEAD}</p>
      )}

      <dl className="fields">
        <Field label={`${PIN_PANEL_TITLE} — the digest this context resolves against`} mono>
          <code>{context.release_digest}</code>
        </Field>
        <Field label="Can this deployment serve that pin?" mono>
          <ResolutionBadge context={context} />
        </Field>
        <Field label="Why">{context.release_resolution_reason}</Field>
        <Field label="Context id" mono>
          {context.context_id}
        </Field>
        <Field label="Project id" mono>
          {context.project_id}
        </Field>
        <Field label="Published">
          <time dateTime={context.published_at}>{context.published_at}</time>
        </Field>
        <Field label="Revoked" mono>
          {context.revoked_at === null ? (
            "Not revoked"
          ) : (
            <time dateTime={context.revoked_at}>{context.revoked_at}</time>
          )}
        </Field>
        <Field label="Revocation reason">
          {context.revocation_reason ?? "No revocation record readable for this context"}
        </Field>
        <Field label="Revoked by" mono>
          {context.revoked_by ?? "No revocation record readable for this context"}
        </Field>
      </dl>
    </section>
  );
}

const REVOCATION_COLUMNS: readonly Column<ContextRevocationView>[] = [
  { key: "context_id", label: "Context id", mono: true, render: (row) => row.context_id },
  {
    key: "revoked_at",
    label: "Revoked",
    render: (row) => <time dateTime={row.revoked_at}>{row.revoked_at}</time>,
  },
  { key: "revoked_by", label: "Revoked by", mono: true, render: (row) => row.revoked_by },
  { key: "reason", label: "Reason", render: (row) => row.reason },
];

/* -------------------------------------------------------------------------- */
/* View                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The whole `/projects/:projectId` view, as a function of one resource state.
 *
 * Split out of the component for the same reason as `renderProjects`: every
 * required state is then directly renderable, and the component stays the two
 * lines that turn a `useApiResource` into one of these.
 */
export function renderProjectDetail(
  state: ResourceState<ProjectDetailView>,
  reload: () => void,
): ReactNode {
  return (
    <ResourceSection state={state} reload={reload} loadingLabel="Loading project…">
      {(data) => (
        <>
          <p className="page__lede">
            <Link to="/projects">All projects</Link>
          </p>

          <section className="panel" aria-labelledby="project-identity">
            <h2 id="project-identity">Project</h2>
            <dl className="fields">
              <Field label="Name">{data.project.name}</Field>
              <Field label="Project id" mono>
                {data.project.project_id}
              </Field>
              <Field label="Workspace" mono>
                {data.project.workspace_id}
              </Field>
              <Field label="Created" mono>
                <time dateTime={data.project.created_at}>{data.project.created_at}</time>
              </Field>
              <Field label="Contexts recorded" mono>
                {data.project.active_context_count}
              </Field>
            </dl>
          </section>

          <h2>{PIN_PANEL_TITLE} per context</h2>
          <p className="page__lede">{pinContrastNote(data.served_release_digest, data.served_release_unavailable_reason)}</p>

          {data.contexts.length === 0 ? (
            <EmptyState
              title="No readable context to pin a release to"
              reason={
                data.contexts_unavailable_reason ??
                "The control plane returned no context for this project."
              }
            />
          ) : (
            data.contexts.map((context) => <ContextPanel key={context.context_id} context={context} />)
          )}

          <h2>Revocation records</h2>
          {data.revocations.length === 0 ? (
            <EmptyState
              title="No readable revocation record"
              reason={
                data.revocations_unavailable_reason ??
                "The control plane returned no context_revocations row for the contexts above."
              }
            />
          ) : (
            <DataTable
              caption="Context revocation records readable by your session"
              columns={REVOCATION_COLUMNS}
              rows={data.revocations}
              rowKey={(row) => row.context_id}
            />
          )}

          <UnavailableState
            title="Revoked contexts are excluded from this view by policy"
            reason={data.context_policy_note}
          />
        </>
      )}
    </ResourceSection>
  );
}

/**
 * `/projects/:projectId` — project identity and every readable context.
 *
 * Revoked contexts are rendered distinctly and keep their pinned digest. One is
 * not filterable client-side out of existence: an operator needs to see that a
 * context was revoked, when, and to what release it had been pinned.
 */
export function ProjectDetailPage(): ReactNode {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const params = useParams<{ readonly projectId: string | undefined }>();
  const projectId = params.projectId ?? null;

  const load = useCallback(
    (signal: AbortSignal) =>
      projectId === null
        ? Promise.reject(new Error("The route supplied no project id."))
        : client.get<ProjectDetailView>(API_ENDPOINTS.project(projectId), {
            signal,
            timeoutMs: 15_000,
            ...(workspaceId ? { query: { workspace: workspaceId, workspace_id: workspaceId } } : {}),
          }),
    [client, projectId, workspaceId],
  );
  const resource = useApiResource(load, [client, projectId, workspaceId]);

  if (projectId === null) {
    return (
      <ErrorState
        title="Missing project id"
        detail="The route did not supply a project id, so there is nothing to look up."
      />
    );
  }

  return renderProjectDetail(resource.state, resource.reload);
}

/** Re-exported so a test can build a fixture response without a second shape. */
export type { ProjectSummary };