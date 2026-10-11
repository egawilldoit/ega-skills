import type { ReactNode } from "react";

import type { ReleaseIdentity, ReleaseIntegrityStatus } from "../api/contracts";
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
