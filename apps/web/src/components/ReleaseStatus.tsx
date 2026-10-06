import type { ReactNode } from "react";

import type { ReleaseIdentity, ReleaseIntegrityStatus } from "../api/contracts";

/**
 * Status wording for a release integrity state.
 *
 * The three states are not interchangeable and the console must not smooth them
 * over: `unpinned` and `mismatch` both mean "contents are not trustworthy", so
 * neither may be presented as a normal, browsable release.
 */
export function describeReleaseStatus(status: ReleaseIntegrityStatus): string {
  switch (status) {
    case "stable":
      return "Stable";
    case "unpinned":
      return "Unpinned";
    case "mismatch":
      return "Mismatch";
  }
}

/** One-line consequence of a status, shown next to the badge. */
export function explainReleaseStatus(status: ReleaseIntegrityStatus): string {
  switch (status) {
    case "stable":
      return "The release digest matches the verified snapshot this deployment holds.";
    case "unpinned":
      return "This deployment has no retained manifest entry for the digest, so its contents cannot be served or trusted.";
    case "mismatch":
      return "The retained manifest authorizes this digest but the artifact disagrees with it. Contents are withheld.";
  }
}

export function ReleaseStatusBadge({ status }: { readonly status: ReleaseIntegrityStatus }): ReactNode {
  return (
    <span className={`badge badge--${status}`}>
      <span className="visually-hidden">Release integrity: </span>
      {describeReleaseStatus(status)}
    </span>
  );
}

/**
 * Fail-closed banner for a release whose contents must not be presented.
 * Renders nothing for `stable`, so a caller can include it unconditionally.
 */
export function ReleaseIntegrityNotice({ release }: { readonly release: ReleaseIdentity }): ReactNode {
  if (release.status === "stable") return null;
  const reason =
    release.mismatch_reason ?? explainReleaseStatus(release.status);
  return (
    <section className="state state--warning" aria-labelledby="release-integrity-heading">
      <h3 id="release-integrity-heading">
        Release {release.status === "mismatch" ? "mismatch" : "not pinned"} — contents withheld
      </h3>
      <p>{reason}</p>
      {release.publication_revision === undefined ? null : (
        <p className="mono">Publication revision: {release.publication_revision}</p>
      )}
    </section>
  );
}

/** Truncate a digest for display without hiding that it was truncated. */
export function shortDigest(digest: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (match === null) return digest;
  return `sha256:${match[1]?.slice(0, 12)}…`;
}