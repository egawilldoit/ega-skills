import type { ReactNode } from "react";
import { useCallback, useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { API_ENDPOINTS, isReleaseDigest } from "../api/client";
import type { ReleaseDiffView } from "../api/contracts";
import { useApiClient } from "../api/useApiClient";
import { useApiResource } from "../api/useApiResource";
import { Field } from "../components/DataTable";
import { ReleaseIntegrityNotice, ReleaseStatusBadge, shortDigest } from "../components/ReleaseStatus";
import { ErrorState, ResourceSection, UnavailableState } from "../components/StatePanel";

/**
 * `/releases/compare` — diff two release digests.
 *
 * Declared before `/releases/:releaseDigest` so the literal path is never
 * swallowed by the digest parameter.
 *
 * Digests are validated against the canonical `sha256:<64 hex>` form in the
 * browser before any request is made. No request is sent until the operator
 * submits both fields, so the console never probes the BFF with guesses.
 */
export function ReleaseComparePage(): ReactNode {
  const client = useApiClient();
  const baseId = useId();
  const headId = useId();
  const [baseDraft, setBaseDraft] = useState("");
  const [headDraft, setHeadDraft] = useState("");
  const [query, setQuery] = useState<{ base: string; head: string } | null>(null);

  const load = useCallback(
    (signal: AbortSignal) =>
      client.get<ReleaseDiffView>(API_ENDPOINTS.releaseCompare(), {
        signal,
        timeoutMs: 30_000,
        query: query === null ? {} : { base: query.base, head: query.head },
      }),
    [client, query],
  );
  const resource = useApiResource(load, [client, query?.base, query?.head]);

  const baseValid = isReleaseDigest(baseDraft);
  const headValid = isReleaseDigest(headDraft);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!baseValid || !headValid) return;
    setQuery({ base: baseDraft, head: headDraft });
  };

  return (
    <>
      <p className="page__lede">
        <Link to="/releases">All releases</Link>
      </p>

      <form className="compare-form" onSubmit={onSubmit}>
        <div className="field">
          <label className="field__label" htmlFor={baseId}>
            Base release digest
          </label>
          <input
            className="field__input mono"
            id={baseId}
            name="base"
            value={baseDraft}
            placeholder="sha256:…"
            spellCheck={false}
            onChange={(event) => setBaseDraft(event.target.value)}
            aria-describedby={`${baseId}-hint`}
          />
          <p className="field__hint" id={`${baseId}-hint`}>
            {baseDraft === ""
              ? "Canonical sha256:<64 hex> digest of the older release."
              : baseValid
                ? "Valid digest form."
                : "Not in the canonical sha256:<64 hex> form. No request will be sent."}
          </p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={headId}>
            Head release digest
          </label>
          <input
            className="field__input mono"
            id={headId}
            name="head"
            value={headDraft}
            placeholder="sha256:…"
            spellCheck={false}
            onChange={(event) => setHeadDraft(event.target.value)}
            aria-describedby={`${headId}-hint`}
          />
          <p className="field__hint" id={`${headId}-hint`}>
            {headDraft === ""
              ? "Canonical sha256:<64 hex> digest of the newer release."
              : headValid
                ? "Valid digest form."
                : "Not in the canonical sha256:<64 hex> form. No request will be sent."}
          </p>
        </div>

        <button
          type="submit"
          className="button button--primary"
          disabled={!baseValid || !headValid}
        >
          Compare
        </button>
      </form>

      {query === null ? (
        <UnavailableState
          title="No comparison requested"
          reason="Enter two release digests above. Nothing is fetched until you submit, so this console does not probe the API with guessed digests."
        />
      ) : (
        <ResourceSection
          state={resource.state}
          reload={resource.reload}
          loadingLabel="Computing release diff…"
        >
          {(data) => <DiffView data={data} />}
        </ResourceSection>
      )}
    </>
  );
}

function Side({ label, value, reason }: {
  readonly label: string;
  readonly value: ReleaseDiffView["base"];
  readonly reason: string | null;
}): ReactNode {
  if (value === null) {
    return (
      <section className="panel" aria-labelledby={`${label}-heading`}>
        <h2 id={`${label}-heading`}>{label}</h2>
        <UnavailableState
          title={`${label} release unavailable`}
          reason={reason ?? "The API did not return an identity for this side of the comparison."}
        />
      </section>
    );
  }
  return (
    <section className="panel" aria-labelledby={`${label}-heading`}>
      <h2 id={`${label}-heading`}>
        {label} <ReleaseStatusBadge status={value.status} />
      </h2>
      <ReleaseIntegrityNotice release={value} />
      <dl className="fields">
        <Field label="Digest" mono>
          <Link to={`/releases/${encodeURIComponent(value.release_digest)}`}>
            {shortDigest(value.release_digest)}
          </Link>
        </Field>
        <Field label="Skills" mono>
          {value.skill_count}
        </Field>
        <Field label="Snapshot rows" mono>
          {value.snapshot_rows}
        </Field>
      </dl>
    </section>
  );
}

function DiffView({ data }: { readonly data: ReleaseDiffView }): ReactNode {
  const lists = [
    { key: "added", title: "Added in head", ids: data.added_skill_ids },
    { key: "removed", title: "Removed in head", ids: data.removed_skill_ids },
    { key: "changed", title: "Changed", ids: data.changed_skill_ids },
    { key: "unchanged", title: "Unchanged", ids: data.unchanged_skill_ids },
  ] as const;

  return (
    <>
      <div className="compare-grid">
        <Side label="Base" value={data.base} reason={data.base_unavailable_reason} />
        <Side label="Head" value={data.head} reason={data.head_unavailable_reason} />
      </div>

      {data.base?.status !== "stable" || data.head?.status !== "stable" ? (
        <ErrorState
          title="Comparison is not trustworthy"
          detail="A release must be integrity-stable on both sides before a diff means anything. The lists below are shown for reference only."
        />
      ) : null}

      <h2>Differences</h2>
      <div className="compare-lists">
        {lists.map((list) => (
          <section key={list.key} className="panel" aria-labelledby={`list-${list.key}`}>
            <h3 id={`list-${list.key}`}>
              {list.title} <span className="count">{list.ids.length}</span>
            </h3>
            {list.ids.length === 0 ? (
              <p className="page__lede">None reported by this comparison.</p>
            ) : (
              <ul className="id-list">
                {list.ids.map((id) => (
                  <li key={id}>
                    <Link to={`/skills/${encodeURIComponent(id)}`}>{id}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </>
  );
}