export type RouterErrorCode =
  | "E_RESOLVE_REQUEST_INVALID"
  | "E_SKILL_NOT_FOUND"
  | "E_SKILL_REFERENCE_AMBIGUOUS";

export class RouterError extends Error {
  readonly code: RouterErrorCode;

  constructor(code: RouterErrorCode, message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
  }
}
