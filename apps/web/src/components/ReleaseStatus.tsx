import type { ReactNode } from "react";

import type { ReleaseIdentity, ReleaseIntegrityStatus } from "../api/contracts";

/**
 * Status wording for a release integrity state.
 *
 * The three states are not interchangeable, but they are not the same kind of
 * difference either, and flattening them was the original bug here:
 *
 *  - `stable` — verified, and named by an authoritative pointer.
 *  - `unpinned` — **verified**, but no pointer names it. Contents are served and
 *    are trustworthy; only the claim "this is the current release" is
 *    unsupported. Labelling it as untrustworthy misreports proven bytes.
 *  - `mismatch` — verified as *wrong*: the artifact disagrees with what the
 *    deployment is configured to serve. This is the only state that fails
 *    closed, and the BFF refuses it before any response is built.
 *
 * So `unpinned` must be visibly flagged — an operator needs to know currency is
 * unproven — but it must never be described as unverifiable content.
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
      // `unpinned` means no authoritative pointer says which release this
      // deployment should serve. It is NOT a statement about integrity: the
      // bytes were fully verified (envelope digest, SQLite digest, integrity
      // check, blob presence) and ARE served. Saying the contents "cannot be
      // served or trusted" was wrong on both counts and contradicted
      // `server/release-identity.ts`, which fails closed only on `mismatch`.
      return "This deployment has no authoritative pointer naming the expected release. The artifact below is fully verified; what is unproven is that it is the intended current release.";
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