import type { ReactNode } from "react";

import type { ReleaseIdentity, ReleaseIntegrityStatus } from "../api/contracts";
import { Field } from "./DataTable";
import { describeReleaseStatus, explainReleaseStatus } from "./release-status";

export { describeReleaseStatus, explainReleaseStatus, shortDigest } from "./release-status";

export function ReleaseStatusBadge({ status }: { readonly status: ReleaseIntegrityStatus }): ReactNode {
  return (
    <span className={`badge badge--${status}`}>
      <span className="visually-hidden">Release integrity: </span>
      {describeReleaseStatus(status)}
    </span>
  );
}

/**
 * Fail-closed banner for a release whose contents must not be presented,
 * or honest warning banner for an unpinned release whose currency is unproven.
 * Renders nothing for `stable`, so a caller can include it unconditionally.
 */
export function ReleaseIntegrityNotice({ release }: { readonly release: ReleaseIdentity }): ReactNode {
  if (release.status === "stable") return null;
  const reason =
    release.mismatch_reason ?? explainReleaseStatus(release.status);
  return (
    <section className="state state--warning" aria-labelledby="release-integrity-heading">
      <h3 id="release-integrity-heading">
        {release.status === "mismatch" ? "Release mismatch — contents withheld" : "Release not pinned"}
      </h3>
      <p>{reason}</p>
      {release.publication_revision === undefined ? null : (
        <p className="mono">Publication revision: {release.publication_revision}</p>
      )}
    </section>
  );
}

/**
 * The verified release this Console can read.
 *
 * This is deliberately separate from the hosted MCP observation below it. A
 * readable artifact is not proof of publication, so the two identities are
 * rendered as two facts and never collapsed into one "current release" claim.
 */
export function ConsoleReleaseIdentity({
  release,
  unavailableReason,
}: {
  readonly release: ReleaseIdentity | null;
  readonly unavailableReason: string | null;
}): ReactNode {
  return (
    <section className="panel" aria-labelledby="console-release-heading">
      <h2 id="console-release-heading">
        Console release{" "}
        {release === null ? null : <ReleaseStatusBadge status={release.status} />}
      </h2>
      {release === null ? (
        <p className="page__lede">
          {unavailableReason ?? "The Console has no verified release identity to display."}
        </p>
      ) : (
        <>
          <ReleaseIntegrityNotice release={release} />
          <p className="page__lede">
            This is the immutable release this Console can read. It is not proof that the
            canonical hosted MCP is serving the same release.
          </p>
          <dl className="fields">
            <Field label="Release digest" mono>
              {release.release_digest}
            </Field>
            <Field label="SQLite artifact digest" mono>
              {release.sqlite_artifact_digest}
            </Field>
            <Field label="Hub" mono>
              {release.hub_id}
            </Field>
            <Field label="Skills in release" mono>
              {release.skill_count}
            </Field>
            <Field label="Snapshot rows" mono>
              {release.snapshot_rows}
            </Field>
          </dl>
        </>
      )}
    </section>
  );
}
