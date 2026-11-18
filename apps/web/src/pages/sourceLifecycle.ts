/**
 * A source PR is a proposed change, not a publication.
 *
 * These labels keep three different facts apart in the management console:
 *   - Proposed source change: a PR exists but has not been merged.
 *   - Accepted source change: the PR was merged into the source repository.
 *   - Published active skill: the skill id is in the readable release catalog.
 *
 * Nothing here queries GitHub or publishes a release. The inputs are the values
 * the existing source-status and published-link reads already provide.
 */

export type SourceLifecycleStage = "proposed" | "accepted" | "published" | "unpublished";

export interface SourceProposalState {
  readonly state: string;
  readonly mergeSha: string | null;
}

export interface SourceLifecycle {
  readonly stage: SourceLifecycleStage;
  readonly label: string;
}

/** Whether a released row exists for this source skill in the current catalog. */
export function sourceItemLifecycle(published: boolean): SourceLifecycle {
  return published
    ? { stage: "published", label: "Published active skill" }
    : { stage: "unpublished", label: "Source change not published" };
}

/** The stage of a source proposal, independent of any publication. */
export function sourceProposalLifecycle(proposal: SourceProposalState | null): SourceLifecycle | null {
  if (proposal === null) return null;
  if (proposal.state === "merged") {
    return {
      stage: "accepted",
      label: proposal.mergeSha === null
        ? "Accepted source change · merge commit not observed"
        : "Accepted source change",
    };
  }
  return { stage: "proposed", label: "Proposed source change" };
}
