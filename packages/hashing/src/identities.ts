// SPEC-002 §5.1.1 + §5.1.3 + §5.1.14 RFC 8785 JCS + SHA-256 identities (EGA-562).
//
// Normative: canonicalize@4.0.0 for JCS; SHA-256 exclusively; lowercase
// sha256:<64 hex>. Pure and deterministic once canonical input exists.
// No custom almost-JCS serializer. No signatures.
//
// Error mapping (distinct, deterministic):
// - E_HASH_IJSON: value is not I-JSON-compatible (undefined, function, symbol,
//   BigInt, NaN, +/-Infinity) found anywhere in the value graph.
// - E_HASH_CANONICAL_JSON: canonical serialization itself fails (circular
//   structure, unsupported shape) or the serializer output is not valid JSON.

import canonicalize from "canonicalize";
import { createHash } from "node:crypto";

export type HashIdentityErrorCode = "E_HASH_CANONICAL_JSON" | "E_HASH_IJSON";

export class HashIdentityError extends Error {
  readonly code: HashIdentityErrorCode;

  constructor(code: HashIdentityErrorCode, message: string) {
    super(message);
    this.name = "HashIdentityError";
    this.code = code;
  }
}

const HASH_IDENTITY_PREFIX = "sha256:";
const HEX_64_RE = /^[0-9a-f]{64}$/;
const utf8Encoder = new TextEncoder();

function isIJsonReject(value: unknown): boolean {
  return (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    (typeof value === "number" && !Number.isFinite(value))
  );
}

function assertIJsonCompatible(value: unknown): void {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (isIJsonReject(current)) {
      throw new HashIdentityError(
        "E_HASH_IJSON",
        "Value is not I-JSON-compatible for JCS canonicalization.",
      );
    }
    if (current !== null && typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (seen.has(record)) {
        throw new HashIdentityError(
          "E_HASH_CANONICAL_JSON",
          "Value cannot be canonicalized: circular structure.",
        );
      }
      seen.add(record);
      if (Array.isArray(record)) {
        for (const entry of record) {
          stack.push(entry);
        }
      } else {
        for (const key of Object.keys(record)) {
          stack.push((record as Record<string, unknown>)[key]);
        }
      }
    }
  }
}

function canonicalJsonFailure(message: string): HashIdentityError {
  return new HashIdentityError("E_HASH_CANONICAL_JSON", message);
}

export function canonicalizeJson(value: unknown): Uint8Array {
  assertIJsonCompatible(value);
  let serialized: unknown;
  try {
    serialized = (canonicalize as (input: unknown) => unknown)(value);
  } catch {
    throw canonicalJsonFailure("Value cannot be canonicalized to JCS JSON.");
  }
  if (typeof serialized !== "string") {
    throw canonicalJsonFailure("JCS canonicalization did not produce JSON text.");
  }
  try {
    JSON.parse(serialized);
  } catch {
    throw canonicalJsonFailure("JCS canonicalization produced invalid JSON.");
  }
  return utf8Encoder.encode(serialized);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function formatHashIdentity(hex: string): string {
  if (!HEX_64_RE.test(hex)) {
    throw new HashIdentityError(
      "E_HASH_CANONICAL_JSON",
      "Hash identity requires 64 lowercase hex characters.",
    );
  }
  return `${HASH_IDENTITY_PREFIX}${hex}`;
}

export function hashBytes(bytes: Uint8Array): string {
  return formatHashIdentity(sha256Hex(bytes));
}

// Blob identity: caller passes canonical bytes (TEXT: SPEC-002 canonical
// bytes; BINARY: exact bytes). This function hashes the given bytes as-is.
export function hashBlobBytes(canonicalOrExactBytes: Uint8Array): string {
  return hashBytes(canonicalOrExactBytes);
}

// SkillVersion identity: SHA256(JCS-UTF-8(canonical manifest)).
export function hashCanonicalManifest(manifest: unknown): string {
  return hashBytes(canonicalizeJson(manifest));
}
