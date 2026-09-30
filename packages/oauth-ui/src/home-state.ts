export type OAuthGrantErrorState = "disabled" | "error";

interface OAuthGrantErrorLike {
  readonly code?: unknown;
  readonly error_code?: unknown;
  readonly message?: unknown;
  readonly status?: unknown;
}

export function classifyOAuthGrantError(error: unknown): OAuthGrantErrorState {
  if (error === null || typeof error !== "object") return "error";
  const candidate = error as OAuthGrantErrorLike;
  const code = candidate.code ?? candidate.error_code;
  if (code === "feature_disabled") return "disabled";
  if (
    candidate.status === 404 &&
    typeof candidate.message === "string" &&
    /oauth server is disabled/i.test(candidate.message)
  ) {
    return "disabled";
  }
  return "error";
}
