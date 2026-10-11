/**
 * Runtime validation for BFF responses.
 *
 * TypeScript's `readonly SkillSummary[]` is a *compile-time* claim about a
 * payload that crosses a network boundary. It is erased at runtime, so
 * `client.get<T>()` used to hand the SPA a bare assertion: the parsed JSON was
 * cast to `T` and whatever arrived was rendered. When the BFF answered `/skills`
 * with the real catalog envelope — `{ skills, total, limit, offset, sort,
 * applied_filters, facets }` — the page read `.length` and `.map` off an object
 * and threw during render, taking the whole route down with it.
 *
 * Every decoder here turns "the payload is not what the contract says" into a
 * thrown {@link ResponseContractError}, which `useApiResource` turns into a
 * controlled error panel. A malformed response is a bug to report, not a crash
 * to propagate into React.
 *
 * These are deliberately hand-written and structural rather than generated: they
 * check the fields the pages actually read, in the shape the server actually
 * returns, so a contract drift is caught at the boundary that caused it. A
 * validator that merely re-stated the TypeScript type would pass everything the
 * type permits and stop being useful.
 */

/** Thrown when a response does not match its declared contract. */
export class ResponseContractError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = "ResponseContractError";
    this.detail = detail;
  }
}

function fail(what: string, detail: string): never {
  throw new ResponseContractError(`The server response did not match the ${what} contract.`, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(value: unknown, what: string, detail: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(what, `${detail}: expected an array, received ${describe(value)}`);
  return value;
}

function requireString(value: unknown, what: string, detail: string): string {
  if (typeof value !== "string") fail(what, `${detail}: expected a string, received ${describe(value)}`);
  return value;
}

function requireFiniteNumber(value: unknown, what: string, detail: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(what, `${detail}: expected a finite number, received ${describe(value)}`);
  }
  return value;
}

function requireBoolean(value: unknown, what: string, detail: string): boolean {
  if (typeof value !== "boolean") fail(what, `${detail}: expected a boolean, received ${describe(value)}`);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, what: string, detail: string): boolean {
  return value === undefined ? fallback : requireBoolean(value, what, detail);
}

/**
 * A short, safe description of an unexpected value.
 *
 * Only the JSON type and, for arrays, the length are reported. The payload is
 * untrusted server output and may carry content or user data, so it is never
 * interpolated into an error message that gets rendered or logged verbatim.
 */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  const type = typeof value;
  if (type === "object") return "an object";
  if (type === "string") return "a string";
  return `a ${type}`;
}

/* -------------------------------------------------------------------------- */
/* Skill rows                                                                  */
/* -------------------------------------------------------------------------- */

function requireStringArray(value: unknown, what: string, detail: string): readonly string[] {
  const items = requireArray(value, what, detail);
  return items.map((item, index) => requireString(item, what, `${detail}[${index}]`));
}

/**
 * Validate one skill row.
 *
 * `triggers` is optional on the wire: the server's catalog row carries routing
 * facets, and a skill with no recorded trigger list is an honest empty state
 * rather than a reason to reject the whole page. Everything the table renders
 * directly is required.
 */
function decodeSkillSummary(value: unknown, what: string, detail: string): Record<string, unknown> {
  if (!isRecord(value)) fail(what, `${detail}: expected an object, received ${describe(value)}`);
  requireString(value.skill_id, what, `${detail}.skill_id`);
  requireString(value.name, what, `${detail}.name`);
  requireString(value.description, what, `${detail}.description`);
  requireString(value.content_digest, what, `${detail}.content_digest`);
  requireString(value.version_hash, what, `${detail}.version_hash`);
  requireStringArray(value.frameworks ?? [], what, `${detail}.frameworks`);
  requireStringArray(value.platforms ?? [], what, `${detail}.platforms`);
  if (value.l1_status !== "AUTHORED" && value.l1_status !== "MISSING") {
    fail(what, `${detail}.l1_status: expected AUTHORED or MISSING, received ${describe(value.l1_status)}`);
  }
  if (value.l1_tokens !== null && typeof value.l1_tokens !== "number") {
    fail(what, `${detail}.l1_tokens: expected a number or null, received ${describe(value.l1_tokens)}`);
  }
  requireFiniteNumber(value.l2_tokens, what, `${detail}.l2_tokens`);
  return value;
}

/* -------------------------------------------------------------------------- */
/* Catalog page                                                                */
/* -------------------------------------------------------------------------- */

function decodeFacets(value: unknown, what: string, detail: string): Record<string, unknown> {
  if (!isRecord(value)) fail(what, `${detail}: expected an object, received ${describe(value)}`);
  return value;
}

/**
 * The real `/catalog` and `/skills` envelope.
 *
 * `/skills` is served by the same `handleCatalog`, so it answers with this shape
 * too — that identity is deliberate (one enumeration, two names), and it is why
 * the page must read `.skills` rather than treating the body as an array.
 */
export function decodeCatalogPage(value: unknown): Record<string, unknown> {
  const what = "catalog page";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  const skills = requireArray(value.skills, what, "skills");
  for (const [index, row] of skills.entries()) {
    decodeSkillSummary(row, what, `skills[${index}]`);
  }
  const total = requireFiniteNumber(value.total, what, "total");
  const limit = requireFiniteNumber(value.limit, what, "limit");
  const offset = requireFiniteNumber(value.offset, what, "offset");
  if (total < 0 || limit < 0 || offset < 0) {
    fail(what, "total, limit and offset must be non-negative counts");
  }
  requireString(value.sort, what, "sort");
  requireString(value.sort_direction, what, "sort_direction");
  decodeFacets(value.facets, what, "facets");
  return value;
}

/* -------------------------------------------------------------------------- */
/* Releases                                                                    */
/* -------------------------------------------------------------------------- */

function decodeReleaseSummary(value: unknown, what: string, detail: string): Record<string, unknown> {
  if (!isRecord(value)) fail(what, `${detail}: expected an object, received ${describe(value)}`);
  const release = value.release;
  if (!isRecord(release)) fail(what, `${detail}.release: expected an object, received ${describe(release)}`);
  requireString(release.release_digest, what, `${detail}.release.release_digest`);
  requireString(release.hub_id, what, `${detail}.release.hub_id`);
  // `status` drives the fail-closed decision, so an unrecognized value must not
  // be coerced: it would silently change what the UI is allowed to claim.
  if (release.status !== "stable" && release.status !== "unpinned" && release.status !== "mismatch") {
    fail(
      what,
      `${detail}.release.status: expected stable, unpinned or mismatch, received ${describe(release.status)}`,
    );
  }
  optionalBoolean(value.is_stable, false, what, `${detail}.is_stable`);
  return value;
}

/** The real `/releases` envelope: `{ releases: [...] }`, never a bare array. */
export function decodeReleasesPage(value: unknown): Record<string, unknown> {
  const what = "releases page";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  const releases = requireArray(value.releases, what, "releases");
  for (const [index, row] of releases.entries()) {
    decodeReleaseSummary(row, what, `releases[${index}]`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Release comparison                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `/releases/compare` answers with the diff DTO.
 *
 * The server requires **both** `base` and `candidate` and refuses anything else
 * with a 400. A response that reached this decoder therefore describes two real
 * digests, and the page must send both.
 */
export function decodeReleaseComparison(value: unknown): Record<string, unknown> {
  const what = "release comparison";
  if (!isRecord(value)) fail(what, `expected an object, received ${describe(value)}`);
  requireString(value.base, what, "base");
  requireString(value.candidate, what, "candidate");
  return value;
}

/* -------------------------------------------------------------------------- */
/* Endpoint map                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The decoder each endpoint must use.
 *
 * Keyed by the path the client requests, so a page cannot accidentally pair one
 * endpoint with another's decoder: `client.get` looks the path up here and falls
 * back to no validation only for a path that is genuinely not yet described.
 */
export const RESPONSE_DECODERS: Readonly<Record<string, (value: unknown) => unknown>> = Object.freeze({
  "/catalog": decodeCatalogPage,
  "/skills": decodeCatalogPage,
  "/releases": decodeReleasesPage,
  "/releases/compare": decodeReleaseComparison,
});

/** Whether a path has a declared decoder. */
export function hasResponseDecoder(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(RESPONSE_DECODERS, path);
}