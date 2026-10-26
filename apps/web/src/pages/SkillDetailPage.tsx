import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { API_ENDPOINTS } from "../api/client";
import type { SkillContentLevel, SkillContentView, SkillDetail, SkillSourceRef } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { DataTable, Field, type Column } from "../components/DataTable";
import { ReleaseIntegrityNotice, ReleaseStatusBadge, shortDigest } from "../components/ReleaseStatus";
import { EmptyState, ErrorState, ResourceSection } from "../components/StatePanel";

type ContentState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly level: SkillContentLevel; readonly filePath?: string }
  | { readonly status: "loaded"; readonly data: SkillContentView }
  | { readonly status: "error"; readonly message: string; readonly level: SkillContentLevel; readonly filePath?: string };

const SOURCE_COLUMNS: readonly Column<SkillSourceRef>[] = [
  { key: "source_id", label: "Source id", mono: true, render: (row) => row.source_id },
  { key: "revision", label: "Revision", mono: true, render: (row) => row.revision },
  { key: "path", label: "Path", mono: true, render: (row) => row.path },
];

function isInspectableCompanionFile(row: SkillDetail["files"][number]): boolean {
  if (row.path === "SKILL.md" || row.path === "SKILL.core.md") return false;
  if (row.role && ["skill-body", "core", "script", "asset", "ega-metadata"].includes(row.role)) {
    return false;
  }
  if (row.content_kind && row.content_kind !== "TEXT") {
    return false;
  }
  const lower = row.path.toLowerCase();
  const binaryExts = [".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".zip", ".tar", ".gz", ".bin", ".exe", ".pdf", ".wasm"];
  if (binaryExts.some((ext) => lower.endsWith(ext))) return false;
  return true;
}

/**
 * `/skills/:skillId` — one skill as released.
 *
 * The skill id is echoed exactly as it came from the route parameter. If the
 * BFF reports that the id is unknown the page says the skill is not present in
 * the readable release; it never guesses a nearest match.
 */
export function SkillDetailPage(): ReactNode {
  const client = useApiClient();
  const params = useParams<{ readonly skillId: string | undefined }>();
  const skillId = params.skillId ?? null;

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<SkillDetail>(API_ENDPOINTS.skill(skillId ?? ""), {
        signal,
        timeoutMs: 15_000,
      }),
    [client, skillId],
  );
  const resource = useApiResource(load, [client, skillId]);

  const [contentState, setContentState] = useState<ContentState>({ status: "idle" });

  const activeRequestRef = useRef<{
    seq: number;
    controller: AbortController;
  } | null>(null);
  const reqSeqRef = useRef<number>(0);

  // Synchronously abort in-flight requests and reset content state when skillId changes or unmounts
  useEffect(() => {
    if (activeRequestRef.current) {
      activeRequestRef.current.controller.abort();
      activeRequestRef.current = null;
    }
    setContentState({ status: "idle" });
    return () => {
      if (activeRequestRef.current) {
        activeRequestRef.current.controller.abort();
        activeRequestRef.current = null;
      }
    };
  }, [skillId]);

  const closeContent = useCallback(() => {
    if (activeRequestRef.current) {
      activeRequestRef.current.controller.abort();
      activeRequestRef.current = null;
    }
    setContentState({ status: "idle" });
  }, []);

  const fetchContent = useCallback(
    async (level: SkillContentLevel, filePath?: string) => {
      if (skillId === null) return;
      if (activeRequestRef.current) {
        activeRequestRef.current.controller.abort();
      }
      const controller = new AbortController();
      const seq = ++reqSeqRef.current;
      activeRequestRef.current = { seq, controller };

      setContentState({ status: "loading", level, ...(filePath ? { filePath } : {}) });
      try {
        const query: Record<string, string> = { level };
        if (filePath) query.file_path = filePath;
        const res = await client.get<SkillContentView>(API_ENDPOINTS.skillContent(skillId), {
          query,
          signal: controller.signal,
          timeoutMs: 15_000,
        });

        // Discard late or superseded responses, or if user closed the viewer
        if (controller.signal.aborted || activeRequestRef.current?.seq !== seq) {
          return;
        }
        activeRequestRef.current = null;
        setContentState({ status: "loaded", data: res });
      } catch (err: unknown) {
        if (
          controller.signal.aborted ||
          activeRequestRef.current?.seq !== seq ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        activeRequestRef.current = null;
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : "Failed to retrieve skill content";
        setContentState({
          status: "error",
          message: msg,
          level,
          ...(filePath ? { filePath } : {}),
        });
      }
    },
    [client, skillId],
  );

  const fileColumns: readonly Column<SkillDetail["files"][number]>[] = [
    { key: "path", label: "Path", mono: true, render: (row) => row.path },
    { key: "byte_length", label: "Bytes", numeric: true, render: (row) => row.byte_length.toLocaleString() },
    { key: "content_digest", label: "Content digest", mono: true, render: (row) => row.content_digest },
    {
      key: "actions",
      label: "Inspection",
      render: (row) => {
        if (!isInspectableCompanionFile(row)) {
          return (
            <span className="muted">
              {row.path === "SKILL.md" || row.path === "SKILL.core.md"
                ? "Use level buttons above"
                : "Not inspectable as text"}
            </span>
          );
        }
        return (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void fetchContent("L2", row.path)}
            disabled={contentState.status === "loading"}
          >
            View content
          </button>
        );
      },
    },
  ];

  if (skillId === null) {
    return (
      <ErrorState
        title="Missing skill id"
        detail="The route did not supply a skill id, so there is nothing to look up."
      />
    );
  }

  return (
    <ResourceSection
      state={resource.state}
      reload={resource.reload}
      loadingLabel={`Loading ${skillId}…`}
    >
      {(data) => (
        <>
          <div className="backlink">
            <Link to="/skills">← All skills</Link>
          </div>
          {data.release === null ? (
            <EmptyState
              title="Release not identified"
              reason="The API returned this skill without a release identity, so it cannot be attributed to a verified release."
            />
          ) : (
            <section className="panel" aria-labelledby="skill-release">
              <h2 id="skill-release">
                Released in <ReleaseStatusBadge status={data.release.status} />
              </h2>
              <ReleaseIntegrityNotice release={data.release} />
              <Field label="Digest" mono>
                {shortDigest(data.release.release_digest)}
              </Field>
            </section>
          )}

          <h2>Identity</h2>
          <dl className="fields">
            <Field label="Skill id" mono>
              {data.summary.skill_id}
            </Field>
            <Field label="Name">{data.summary.name}</Field>
            <Field label="Description">{data.summary.description}</Field>
            <Field label="Schema version" mono>
              {data.summary.schema_version}
            </Field>
            <Field label="Release-pinned version hash" mono>
              <span title={data.summary.version_hash}>{shortDigest(data.summary.version_hash)}</span>
            </Field>
            <Field label="Content digest" mono>
              {data.summary.content_digest}
            </Field>
          </dl>

          <h2>Token Budgets & Content Availability</h2>
          <dl className="fields">
            <Field label="L1 Content Status" mono>
              {data.summary.l1_status === "AUTHORED"
                ? "Authored (SKILL.core.md is present in release)"
                : "Missing (SKILL.core.md was not authored in this release)"}
            </Field>
            <Field label="L1 Token Budget" mono>
              {data.summary.l1_tokens !== null
                ? `${data.summary.l1_tokens.toLocaleString()} tokens`
                : "Unavailable (SKILL.core.md not authored in this release)"}
            </Field>
            <Field label="L2 Content Status" mono>
              {data.content?.l2_available === false
                ? "Unavailable"
                : "Available (Servable on demand)"}
            </Field>
            <Field label="L2 Token Budget" mono>
              {data.summary.l2_tokens.toLocaleString()} tokens (Request ceiling: 32,768 max tokens, default 32,000)
            </Field>
          </dl>

          <h2>Trust & Provenance</h2>
          <dl className="fields">
            <Field label="Trust level" mono>
              {data.trust_level ?? "UNKNOWN"}
            </Field>
            <Field label="Provenance status" mono>
              {data.summary.provenance_status}
            </Field>
            <Field label="Source type">
              {data.summary.source_type ?? "None declared"}
            </Field>
            <Field label="Observed revision" mono>
              {data.observed_source_revision ?? data.source_commit_sha ?? "Not recorded"}
            </Field>
            <Field label="Version history">
              {data.history
                ? `${data.history.state === "retained" ? "Retained historical versions" : "Not retained"} (${data.history.reason ?? "Single release pin"})`
                : "Current release only"}
            </Field>
          </dl>

          <h2>Skill Content & Inspection</h2>
          <div className="content-viewer__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => void fetchContent("L2")}
              disabled={contentState.status === "loading"}
            >
              Load L2 Skill Content
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void fetchContent("L1")}
              disabled={contentState.status === "loading"}
            >
              Request L1 Content
            </button>
            {contentState.status !== "idle" && (
              <button type="button" className="button button--ghost" onClick={closeContent}>
                Close Viewer
              </button>
            )}
          </div>

          {contentState.status === "loading" && (
            <div className="state state--loading">
              <span className="spinner" aria-hidden="true" />
              Loading {contentState.level} content{contentState.filePath ? ` (${contentState.filePath})` : ""}…
            </div>
          )}

          {contentState.status === "error" && (
            <div className="state state--empty">
              <h3>Unable to serve {contentState.level} content{contentState.filePath ? ` (${contentState.filePath})` : ""}</h3>
              <p>{contentState.message}</p>
            </div>
          )}

          {contentState.status === "loaded" && (
            <section className="panel content-viewer" aria-labelledby="content-viewer-title">
              <div className="content-viewer__header">
                <h3 id="content-viewer-title">
                  {contentState.data.file_path ?? "SKILL.md"} ({contentState.data.level})
                </h3>
                <button type="button" className="button button--secondary" onClick={closeContent}>
                  Close
                </button>
              </div>
              <div className="content-viewer__meta">
                <span>
                  Token count: <strong>{contentState.data.token_count.toLocaleString()}</strong> / {contentState.data.requested_max_tokens.toLocaleString()} requested max tokens
                </span>
                <span>
                  Version: <code>{shortDigest(contentState.data.version_hash)}</code>
                </span>
                <span>
                  Complete: <strong>{contentState.data.truncated ? "No (Truncated)" : "Yes (Verified exact bytes)"}</strong>
                </span>
              </div>
              <pre className="content-viewer__code"><code>{contentState.data.content}</code></pre>
            </section>
          )}

          <h2>Routing</h2>
          <dl className="fields">
            <Field label="Domains" mono>
              {data.routing.domains.length === 0 ? "None declared" : data.routing.domains.join(", ")}
            </Field>
            <Field label="Triggers" mono>
              {data.routing.triggers.length === 0 ? "None declared" : data.routing.triggers.join(", ")}
            </Field>
            <Field label="Exclude patterns" mono>
              {data.routing.exclude_patterns.length === 0
                ? "None declared"
                : data.routing.exclude_patterns.join(", ")}
            </Field>
            <Field label="Priority" mono>
              {data.routing.priority ?? "Not pinned"}
            </Field>
          </dl>

          <h2>Sources</h2>
          {data.sources.length === 0 ? (
            <EmptyState
              title="No adopted sources"
              reason={data.sources_unavailable_reason ?? "No external repository sources are adopted for this skill."}
            />
          ) : (
            <DataTable<SkillDetail["sources"][number]>
              caption={`Adopted sources for ${data.summary.skill_id}`}
              columns={SOURCE_COLUMNS}
              rows={data.sources}
              rowKey={(row) => `${row.source_id}@${row.revision}:${row.path}`}
            />
          )}

          <h2>Files (Companion Files)</h2>
          <DataTable<SkillDetail["files"][number]>
            caption={`Files released for ${data.summary.skill_id}`}
            columns={fileColumns}
            rows={data.files}
            rowKey={(row) => row.path}
            minWidth="820px"
          />
        </>
      )}
    </ResourceSection>
  );
}
