// 1.1[A] canonical artifact envelope (EGA-623). Home: the proven V1 hashing
// package (SPEC-002), since an envelope digest IS a JCS/SHA-256 identity.
//
// Implements post-V1 spec section 2 + Contracts A/B/C envelope rules over the
// proven V1 JCS/SHA-256 primitive (@ega-skills/hashing, SPEC-002 EGA-562):
//
//   digest = SHA-256(RFC8785-JCS({ object_type, schema_version, payload }))
//
// rendered `sha256:<64 lowercase hex>`. The digest is excluded from its own
// preimage. Unknown envelope fields are rejected; missing and null differ at
// the contract layer (this module treats explicit null like any I-JSON value
// for hashing, and contracts reject it before calling here).
//
// Pure and deterministic. No I/O, no network, no registry access.

import { canonicalizeJson, sha256Hex } from "./identities.js";

export type ArtifactErrorCode = "E_ARTIFACT_SCHEMA" | "E_ARTIFACT_DIGEST";

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
  }
}

export interface ArtifactEnvelope {
  readonly object_type: string;
  readonly schema_version: number;
  readonly payload: unknown;
  readonly digest: string;
}

export interface ArtifactPreimage {
  readonly object_type: string;
  readonly schema_version: number;
  readonly payload: unknown;
}

export type VerifyOk = { readonly ok: true; readonly digest: string };
export type VerifyFail = {
  readonly ok: false;
  readonly code: ArtifactErrorCode;
  readonly message: string;
};
export type VerifyResult = VerifyOk | VerifyFail;

const HEX_64_RE = /^[0-9a-f]{64}$/;
const ENVELOPE_KEYS = ["digest", "object_type", "payload", "schema_version"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Canonical digest of an envelope preimage (digest excluded by construction). */
export function digestArtifactPreimage(preimage: ArtifactPreimage): string {
  let bytes: Uint8Array;
  try {
    bytes = canonicalizeJson({
      object_type: preimage.object_type,
      payload: preimage.payload,
      schema_version: preimage.schema_version,
    });
  } catch {
    throw new ArtifactError("E_ARTIFACT_SCHEMA", "Preimage is not I-JSON canonicalizable.");
  }
  return `sha256:${sha256Hex(bytes)}`;
}

/** Build a signed envelope for a preimage. Throws ArtifactError on bad input. */
export function createEnvelope(preimage: ArtifactPreimage): ArtifactEnvelope {
  if (!isPlainObject(preimage)) {
    throw new ArtifactError("E_ARTIFACT_SCHEMA", "Preimage must be an object.");
  }
  if (typeof preimage.object_type !== "string" || preimage.object_type.length === 0) {
    throw new ArtifactError("E_ARTIFACT_SCHEMA", "object_type must be a non-empty string.");
  }
  if (!Number.isInteger(preimage.schema_version) || preimage.schema_version < 1) {
    throw new ArtifactError("E_ARTIFACT_SCHEMA", "schema_version must be a positive integer.");
  }
  return {
    digest: digestArtifactPreimage(preimage),
    object_type: preimage.object_type,
    payload: preimage.payload,
    schema_version: preimage.schema_version,
  };
}

/** Fail-closed envelope verification. Never throws on malformed input. */
export function verifyEnvelope(doc: unknown): VerifyResult {
  try {
    return verifyEnvelopeInner(doc);
  } catch {
    return { code: "E_ARTIFACT_SCHEMA", message: "Envelope is not readable.", ok: false };
  }
}

function verifyEnvelopeInner(doc: unknown): VerifyResult {
  if (!isPlainObject(doc)) {
    return { code: "E_ARTIFACT_SCHEMA", message: "Envelope must be an object.", ok: false };
  }
  const keys = Object.keys(doc).sort();
  if (JSON.stringify(keys) !== JSON.stringify(ENVELOPE_KEYS)) {
    return { code: "E_ARTIFACT_SCHEMA", message: "Envelope must hold exactly object_type/schema_version/payload/digest.", ok: false };
  }
  if (typeof doc["object_type"] !== "string" || doc["object_type"].length === 0) {
    return { code: "E_ARTIFACT_SCHEMA", message: "object_type must be a non-empty string.", ok: false };
  }
  if (!Number.isInteger(doc["schema_version"]) || (doc["schema_version"] as number) < 1) {
    return { code: "E_ARTIFACT_SCHEMA", message: "schema_version must be a positive integer.", ok: false };
  }
  if (typeof doc["digest"] !== "string" || !/^sha256:/.test(doc["digest"] as string)) {
    return { code: "E_ARTIFACT_SCHEMA", message: "digest must match sha256:<hex>.", ok: false };
  }
  const hex = (doc["digest"] as string).slice("sha256:".length);
  if (!HEX_64_RE.test(hex)) {
    return { code: "E_ARTIFACT_SCHEMA", message: "digest must match sha256:<64 lowercase hex>.", ok: false };
  }
  let recomputed: string;
  try {
    recomputed = digestArtifactPreimage({
      object_type: doc["object_type"] as string,
      payload: doc["payload"],
      schema_version: doc["schema_version"] as number,
    });
  } catch {
    return { code: "E_ARTIFACT_SCHEMA", message: "Payload is not I-JSON canonicalizable.", ok: false };
  }
  if (recomputed !== doc["digest"]) {
    return { code: "E_ARTIFACT_DIGEST", message: `Digest mismatch (want ${recomputed}).`, ok: false };
  }
  return { digest: recomputed, ok: true };
}
