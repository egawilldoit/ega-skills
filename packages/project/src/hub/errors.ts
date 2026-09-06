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
  | "E_AUTO_ADOPT";

export class HubError extends Error {
  readonly code: HubErrorCode;

  constructor(code: HubErrorCode, message: string) {
    super(message);
    this.name = "HubError";
    this.code = code;
  }
}
