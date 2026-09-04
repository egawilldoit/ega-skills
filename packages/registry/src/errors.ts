export const REGISTRY_ERROR_CODES = [
  "E_REGISTRY_HOME",
  "E_REGISTRY_DB_OPEN",
  "E_REGISTRY_MIGRATION",
  "E_REGISTRY_FTS5_UNAVAILABLE",
  "E_REGISTRY_SCHEMA_NEWER",
  "E_ALIAS_CONFLICT",
  "E_CACHE_WRITE",
  "E_CACHE_HASH_MISMATCH",
] as const;

export type RegistryErrorCode = (typeof REGISTRY_ERROR_CODES)[number];

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError;
}
