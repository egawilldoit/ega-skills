// 1.1[B] Hub error catalog — Contract A section 9 (EGA-624).

export type HubErrorCode =
  | "E_HUB_SCHEMA"
  | "E_SOURCE_SCHEMA"
  | "E_SOURCE_SELECTION"
  | "E_LOCK_MISMATCH"
  | "E_LOCK_DIGEST"
  | "E_LOCK_COMMIT"
  | "E_TREE_DIGEST"
  | "E_PROVENANCE"
  | "E_EXTRACTION_POLICY"
  | "E_AUTO_ADOPT"
  | "E_PLAN_SCHEMA"
  | "E_PLAN_DIGEST"
  | "E_PLAN_COMMIT"
  | "E_PLAN_REFETCH"
  | "E_PLAN_STALE"
  | "E_PLAN_NOOP"
  | "E_JOURNAL_SCHEMA"
  | "E_JOURNAL_STATE"
  | "E_RECOVERY_REQUIRED"
  | "E_PLAN_RESOLVE"
  | "E_PLAN_FETCH"
  | "E_HUB_LOCKED"
  | "E_BUILD_ATTESTATION"
  | "E_ALIAS_SCOPE"
  | "E_TOKEN_ARTIFACT"
  | "E_SEARCH_INPUT"
  | "E_SEARCH_ISOLATION"
  | "E_RELEASE_SCHEMA"
  | "E_RELEASE_DIGEST"
  | "E_PACKAGE_BINDING"
  | "E_STABLE";

export class HubError extends Error {
  readonly code: HubErrorCode;

  constructor(code: HubErrorCode, message: string) {
    super(message);
    this.name = "HubError";
    this.code = code;
  }
}
