/**
 * Release identity — the single fail-closed fact the console renders.
 *
 * ## Why this module is the highest-risk part of the console
 *
 * Everything the console shows about a release is only trustworthy if the
 * artifact bytes on disk are the release the workspace actually points at.
 * There is exactly one existing implementation of that verification —
 * `loadHostedReleaseSnapshot` (`packages/mcp/src/hosted.ts:92`) — and this
 * module calls it. It does **not** reimplement, weaken, or shortcut any part of
 * it. That loader already recomputes the `HubRelease` envelope digest, matches
 * `sqlite_artifact_digest` against the SQLite bytes, runs SQLite
 * `integrity_check`, matches the FTS row count to `snapshot_rows`, runs the
 * full `verifyReleaseProjection` (catalog, manifests, aliases, BOTH FTS
 * tables, token artifacts, file identities) and reads every manifest blob
 * through the hash-verified cache reader. Any of those failing means no
 * identity is produced at all — there is no degraded identity mode.
 *
 * ## The binding
 *
 * ```
 * expected_release_digest   EGA_WEB_EXPECTED_RELEASE_DIGEST, else the retained
 *                           manifest's default_release_digest, else absent
 *            |
 *            v
 * verified artifact          loadHostedReleaseSnapshot(...).release.digest,
 *                            cross-checked against release-package.json
 *            |
 *            v
 * actual_release_digest
 * ```
 *
 * `status` is decided by comparing those two, and only those two:
 *
 * - `stable`   — an authoritative expected digest exists AND equals the
 *                verified digest.
 * - `unpinned` — the artifact is fully verified but nothing authoritative
 *                says which release it should be. This is a real, honest
 *                outcome, not an error and **not** stable. The console must
 *                say so; calling this `stable` would be a lie, because
 *                nothing has established that these bytes are the release the
 *                workspace serves.
 * - `mismatch` — FAIL CLOSED. `assertCatalogServable()` throws, so no route can
 *                serve catalog data under a mismatched identity.
 *
 * The contracts.ts invariant is maintained structurally: `mismatch_reason` is
 * built by exactly two call sites, both of which also set
 * `status: "mismatch"`, and both non-mismatch statuses pass `null`.
 *
 * ## Injection
 *
 * Nothing here reads `process.env` except `getReleaseIdentity()` with no
 * argument. Every evaluation takes an explicit `ServerConfig` (plus optional
 * dependency overrides), so a test builds an isolated scenario by copying the
 * committed artifact to a temp dir and calling `parseServerConfig` on a literal
 * record. There is no module-level mutable state besides a memo keyed on the
 * config object itself, which `resetReleaseIdentityCache()` clears.
 *
 * No expected digest can arrive from a browser request: the evaluation
 * functions accept a server-owned config and nothing else. There is no request
 * parameter to pass one through.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  HostedRuntimeError,
  loadHostedReleaseSnapshot,
  loadRetainedReleaseSet,
  type HostedReleaseSnapshot,
  type RetainedReleaseSet,
} from "@ega-skills/mcp";

import type { ReleaseIdentity } from "../src/api/contracts.ts";

import { loadServerConfig, type ServerConfig } from "./env.ts";

/** Where an authoritative expected digest came from. */
export type ExpectedDigestSource = "env" | "retained-manifest";

/**
 * The evaluated binding. A superset of the shared `ReleaseIdentity` DTO: it
 * carries the two digests and their provenance so an operator can see *why*
 * the console believes what it believes, and so Builder 2b can render the
 * identity without re-deriving either side.
 */
export interface ReleaseIdentityBinding {
  /**
   * Exactly the DTO `apps/web/src/api/contracts.ts` declares, or `null` when no
   * release could be verified at all. A null identity is never a degraded
   * identity: it means nothing is servable, and `unavailable_reason` says why.
   */
  readonly identity: ReleaseIdentity | null;
  /** The verified artifact digest, or `null` when no artifact was loadable. */
  readonly actual_release_digest: string | null;
  /** The authoritative expectation, or `null` when none is configured. */
  readonly expected_release_digest: string | null;
  /** Where `expected_release_digest` came from; `null` when there is none. */
  readonly expected_digest_source: ExpectedDigestSource | null;
  /** True when `status === "stable"`. Convenience for route guards. */
  readonly is_stable: boolean;
  /** The verified snapshot, or `null` when verification refused. */
  readonly snapshot: HostedReleaseSnapshot | null;
  /** The verified retained set, or `null` when none is configured. */
  readonly retained: RetainedReleaseSet | null;
  /**
   * Why no identity could be produced at all (artifact absent, envelope digest
   * wrong, SQLite integrity failure, FTS row-count mismatch, missing blob).
   * Non-null exactly when `identity` is `null`. Never downgraded to `unpinned`.
   */
  readonly unavailable_reason: string | null;
}

/**
 * Typed failure from the identity core.
 *
 * `code` is stable and maps to an HTTP status. The message names digests and
 * rules only; `ServerConfigError`-style secrets never appear here because
 * nothing in this module can read one.
 */
export class ReleaseIdentityError extends Error {
  readonly code: string;
  readonly status: number;
  /** The binding that produced the refusal, when one was evaluated. */
  readonly binding: ReleaseIdentityBinding | null;

  constructor(
    code: string,
    message: string,
    binding: ReleaseIdentityBinding | null = null,
    status = 503,
  ) {
    super(message);
    this.name = "ReleaseIdentityError";
    this.code = code;
    this.status = status;
    this.binding = binding;
  }
}

/** Overridable collaborators. Defaults are the real implementations. */
export interface ReleaseIdentityDependencies {
  /** Defaults to `loadHostedReleaseSnapshot` from `@ega-skills/mcp`. */
  readonly loadSnapshot?: (artifactDir: string) => HostedReleaseSnapshot;
  /** Defaults to `loadRetainedReleaseSet` from `@ega-skills/mcp`. */
  readonly loadRetained?: (manifestPath: string) => RetainedReleaseSet;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Read `release-package.json` and return the two fields identity depends on.
 *
 * `loadHostedReleaseSnapshot` already validates this file's shape and its
 * agreement with the release envelope. Re-reading it here is not a second
 * opinion about integrity — it is the cross-check the binding diagram calls
 * for: `actual_release_digest` must equal the `hub_release_digest` the package
 * declares, and `snapshot_rows` must come from the same file the loader
 * verified. A disagreement here means the bytes changed between verification
 * and this read, so it fails closed rather than trusting either side.
 */
function readReleasePackage(
  artifactDir: string,
): { hubReleaseDigest: string; sqliteArtifactDigest: string; snapshotRows: number } {
  const raw = readFileSync(join(artifactDir, "release-package.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReleaseIdentityError(
      "E_WEB_PACKAGE_INVALID",
      "release-package.json is not an object",
    );
  }
  const record = parsed as Record<string, unknown>;
  const { hub_release_digest: hubReleaseDigest, sqlite_artifact_digest: sqliteDigest, snapshot_rows: rows } = record;
  if (
    typeof hubReleaseDigest !== "string" ||
    !DIGEST_RE.test(hubReleaseDigest) ||
    typeof sqliteDigest !== "string" ||
    !DIGEST_RE.test(sqliteDigest) ||
    !Number.isSafeInteger(rows) ||
    (rows as number) < 0
  ) {
    throw new ReleaseIdentityError(
      "E_WEB_PACKAGE_INVALID",
      "release-package.json identity fields are malformed",
    );
  }
  return {
    hubReleaseDigest,
    sqliteArtifactDigest: sqliteDigest,
    snapshotRows: rows as number,
  };
}

/** Sanitized one-line description of an upstream verification failure. */
function describeLoadFailure(error: unknown): string {
  if (error instanceof HostedRuntimeError || error instanceof ReleaseIdentityError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Build the `ReleaseIdentity` for a verified snapshot.
 *
 * `expectedReleaseDigest` and its source drive the status. The cross-check
 * against `release-package.json` runs first: if the package disagrees with the
 * verified envelope, that is a `mismatch` regardless of any expectation,
 * because the two records of "what release is this" no longer agree.
 */
function buildIdentity(
  snapshot: HostedReleaseSnapshot,
  expectedReleaseDigest: string | null,
  expectedDigestSource: ExpectedDigestSource | null,
  publicationRevision: string | null,
): ReleaseIdentity {
  const pkg = readReleasePackage(snapshot.artifactDir);
  const actual = snapshot.release.digest;
  const skillCount = Object.keys(snapshot.release.payload.skill_versions).length;

  // Bind on the SEMANTIC release digest, never on sqlite_artifact_digest.
  // `packages/project/src/hub/release.ts:3-6` states the semantic envelope is
  // deliberately separate from its transport artifact, so a semantically
  // identical rebuild changes the byte digest while the release digest is
  // unchanged. Keying on bytes would report false staleness on every rebuild.
  const mismatchReason = ((): string | null => {
    if (pkg.hubReleaseDigest !== actual) {
      return `The verified artifact digest ${actual} does not match the hub_release_digest ${pkg.hubReleaseDigest} declared by release-package.json. The two records of this release disagree, so no expected digest is consulted.`;
    }
    if (expectedReleaseDigest === null) return null;
    if (expectedReleaseDigest === actual) return null;
    const where =
      expectedDigestSource === "retained-manifest"
        ? "the retained release manifest's default_release_digest"
        : "EGA_WEB_EXPECTED_RELEASE_DIGEST";
    return `The configured expected release digest ${expectedReleaseDigest} (from ${where}) does not match the verified web artifact digest ${actual}.`;
  })();

  const status = mismatchReason === null
    ? expectedReleaseDigest === null ? "unpinned" : "stable"
    : "mismatch";

  // `publication_revision` is optional under `exactOptionalPropertyTypes`, so
  // it is present only when the deployment genuinely records one. The only
  // source is the retained manifest's CAS version; a deployment with no
  // retained manifest has no publication revision and says so by omission
  // rather than inventing a value.
  return Object.freeze({
    release_digest: actual,
    hub_id: snapshot.release.payload.hub_id,
    status,
    skill_count: skillCount,
    snapshot_rows: pkg.snapshotRows,
    sqlite_artifact_digest: pkg.sqliteArtifactDigest,
    ...(publicationRevision === null ? {} : { publication_revision: publicationRevision }),
    mismatch_reason: mismatchReason,
  });
}

/** A binding that produced no identity because verification refused. */
function unavailableBinding(reason: string): ReleaseIdentityBinding {
  return Object.freeze({
    identity: null,
    actual_release_digest: null,
    expected_release_digest: null,
    expected_digest_source: null,
    is_stable: false,
    snapshot: null,
    retained: null,
    unavailable_reason: reason,
  });
}

/**
 * Evaluate the release identity for one server config.
 *
 * Order of operations, and why:
 *
 * 1. **Load the retained manifest first, when configured.** `loadRetainedReleaseSet`
 *    re-verifies the manifest envelope, every candidate, every package digest,
 *    the hub identity and each release digest, and guarantees the default
 *    release is a member of the retained set. Its `default_release_digest` is
 *    then an *authoritative* expectation, not an operator guess.
 * 2. **Load the artifact through `loadHostedReleaseSnapshot`.** All integrity
 *    verification happens there. No weaker check is performed anywhere.
 * 3. **Disagreement is a mismatch, never a choice.** If an env expectation and
 *    a retained manifest both exist and disagree, or if the artifact directory
 *    and the retained default name different releases, that is a `mismatch`.
 *    There is no code path that picks the convenient one.
 *
 * Never throws for an absent or tampered artifact: it returns a binding whose
 * `identity` is `null` and whose `unavailable_reason` explains the refusal.
 * Callers that need to fail closed call `assertCatalogServable`, which throws.
 */
export function evaluateReleaseIdentity(
  config: Readonly<ServerConfig>,
  dependencies: ReleaseIdentityDependencies = {},
): ReleaseIdentityBinding {
  const loadSnapshot = dependencies.loadSnapshot ?? loadHostedReleaseSnapshot;
  const loadRetained = dependencies.loadRetained ?? loadRetainedReleaseSet;

  if (!config.hasReleaseSource) {
    return unavailableBinding(
      "No release source is configured: neither an artifact directory nor a retained manifest was supplied.",
    );
  }

  // 1. Authoritative expectation from the retained manifest, if configured.
  let retained: RetainedReleaseSet | null = null;
  let retainedDefault: string | null = null;
  if (config.retainedManifestPath !== null) {
    try {
      retained = loadRetained(config.retainedManifestPath);
      retainedDefault = retained.manifest.payload.default_release_digest;
    } catch (error) {
      return unavailableBinding(
        `The configured retained release manifest failed verification: ${describeLoadFailure(error)}`,
      );
    }
  }

  // 2. Verified artifact. The retained set's default snapshot is itself the
  //    verified artifact when no artifact directory is configured; loading it
  //    a second time from the same bytes would only repeat the verification.
  const snapshotPath = config.artifactDir ?? retained?.defaultSnapshot.artifactDir ?? null;
  if (snapshotPath === null) {
    return unavailableBinding(
      "No verified artifact directory is available to read.",
    );
  }
  let snapshot: HostedReleaseSnapshot;
  try {
    snapshot = retained !== null && config.artifactDir === null
      ? retained.defaultSnapshot
      : loadSnapshot(snapshotPath);
  } catch (error) {
    return unavailableBinding(
      `The web release artifact failed verification: ${describeLoadFailure(error)}`,
    );
  }

  const actual = snapshot.release.digest;

  // The only real publication revision available to a read-only console is the
  // retained manifest's CAS version. Absent a retained manifest there is no
  // revision to report, and the DTO field is omitted rather than faked.
  const publicationRevision =
    retained === null ? null : String(retained.manifest.payload.publication_revision);

  // 3. Two configured sources that disagree is a mismatch. Naming the
  //    expectation a "source of truth" would just be picking the convenient one.
  const expected = config.expectedReleaseDigest ?? retainedDefault;
  const expectedSource: ExpectedDigestSource | null =
    config.expectedReleaseDigest !== null
      ? "env"
      : retainedDefault !== null
        ? "retained-manifest"
        : null;

  if (
    config.expectedReleaseDigest !== null &&
    retainedDefault !== null &&
    config.expectedReleaseDigest !== retainedDefault
  ) {
    return Object.freeze({
      identity: Object.freeze({
        ...buildIdentity(snapshot, config.expectedReleaseDigest, "env", publicationRevision),
        status: "mismatch" as const,
        mismatch_reason:
          `EGA_WEB_EXPECTED_RELEASE_DIGEST (${config.expectedReleaseDigest}) and the retained ` +
          `release manifest's default_release_digest (${retainedDefault}) disagree, so the ` +
          `deployment does not name one authoritative release. The verified web artifact ` +
          `digest is ${actual}.`,
      }),
      actual_release_digest: actual,
      expected_release_digest: config.expectedReleaseDigest,
      expected_digest_source: "env",
      is_stable: false,
      snapshot,
      retained,
      unavailable_reason: null,
    });
  }

  if (retained !== null && retainedDefault !== actual) {
    return Object.freeze({
      identity: Object.freeze({
        ...buildIdentity(snapshot, retainedDefault, "retained-manifest", publicationRevision),
        status: "mismatch" as const,
        mismatch_reason:
          `The retained release manifest's default_release_digest (${retainedDefault}) does not ` +
          `match the verified web artifact digest (${actual}). The artifact directory and the ` +
          `retained set name different releases.`,
      }),
      actual_release_digest: actual,
      expected_release_digest: retainedDefault,
      expected_digest_source: "retained-manifest",
      is_stable: false,
      snapshot,
      retained,
      unavailable_reason: null,
    });
  }

  const identity = buildIdentity(snapshot, expected, expectedSource, publicationRevision);
  return Object.freeze({
    identity,
    actual_release_digest: actual,
    expected_release_digest: expected,
    expected_digest_source: expectedSource,
    is_stable: identity.status === "stable",
    snapshot,
    retained,
    unavailable_reason: null,
  });
}

/**
 * Memo cache keyed on the config object identity.
 *
 * A `WeakMap` on the (frozen) config object means evaluation happens once per
 * distinct configuration and a cache entry cannot outlive the config that
 * produced it. Two structurally identical configs built from different temp
 * directories are distinct keys, which is exactly what tests rely on.
 */
let memo = new WeakMap<object, ReleaseIdentityBinding>();

/**
 * Memoized {@link evaluateReleaseIdentity}.
 *
 * Call it with no argument in production (that is the only path that reads
 * `process.env`); pass an explicit config in tests to get a fresh evaluation.
 */
export function getReleaseIdentityBinding(
  config?: Readonly<ServerConfig>,
  dependencies?: ReleaseIdentityDependencies,
): ReleaseIdentityBinding {
  const resolved = config ?? loadServerConfig();
  const cached = memo.get(resolved);
  if (cached !== undefined && dependencies === undefined) return cached;
  const binding = evaluateReleaseIdentity(resolved, dependencies);
  if (dependencies === undefined) memo.set(resolved, binding);
  return binding;
}

/**
 * The {@link ReleaseIdentity} for this deployment, or `null` when no release
 * could be verified. Matches the shared DTO exactly — no fields added, no
 * fields redefined.
 */
export function getReleaseIdentity(
  config?: Readonly<ServerConfig>,
  dependencies?: ReleaseIdentityDependencies,
): ReleaseIdentity | null {
  return getReleaseIdentityBinding(config, dependencies).identity;
}

/**
 * Fail closed. Returns the verified identity when the catalog may be served,
 * throws {@link ReleaseIdentityError} otherwise.
 *
 * Three things throw here, and none of them is downgraded to a warning:
 *
 * - `identity === null` — no artifact verified (absent, truncated, tampered,
 *   SQLite corrupt, blob missing). No identity exists, so nothing is servable.
 * - `status === "mismatch"` — a release *was* verified but it is not the
 *   release the deployment says it should be. Serving catalog rows under a
 *   mismatched identity is exactly the stale-catalog-as-current failure the
 *   architecture prohibits, so this throws rather than rendering.
 * - a thrown `ServerConfigError` from loading `process.env` — malformed
 *   configuration is a startup failure, not a runtime state.
 *
 * `unpinned` deliberately does **not** throw. It is an honest, servable state:
 * the bytes are fully verified; nobody has claimed which release they should
 * be. The UI shows the identity and the `unpinned` status.
 */
export function assertCatalogServable(
  config?: Readonly<ServerConfig>,
  dependencies?: ReleaseIdentityDependencies,
): ReleaseIdentity {
  // A `ServerConfigError` from `loadServerConfig()` (malformed digest, missing
  // path) propagates unchanged: bad configuration is a startup failure, not a
  // runtime state the UI should render.
  const binding = getReleaseIdentityBinding(config, dependencies);

  if (binding.identity === null) {
    throw new ReleaseIdentityError(
      "E_WEB_RELEASE_UNVERIFIED",
      `The console cannot serve release contents: ${binding.unavailable_reason ?? "no verified release identity."}`,
      binding,
    );
  }
  if (binding.identity.status === "mismatch") {
    throw new ReleaseIdentityError(
      "E_WEB_RELEASE_MISMATCH",
      `Catalog unavailable: the web artifact does not match the workspace stable release. ${binding.identity.mismatch_reason ?? ""}`.trim(),
      binding,
    );
  }
  return binding.identity;
}

/**
 * Drop every memoized binding. Only tests need this; production evaluates once
 * per config and the config objects are module-owned singletons.
 */
export function resetReleaseIdentityCache(): void {
  // A WeakMap has no clear(), so the cache is replaced wholesale. Entries are
  // weakly held either way, so this cannot leak.
  memo = new WeakMap<object, ReleaseIdentityBinding>();
}

/**
 * The verified snapshot for this deployment, or `null`.
 *
 * Builder 2b should prefer {@link assertCatalogServable} and read
 * `getReleaseIdentityBinding(...).snapshot`, so the identity check and the
 * snapshot a route serves can never come from different evaluations.
 */
export function getVerifiedSnapshot(
  config?: Readonly<ServerConfig>,
  dependencies?: ReleaseIdentityDependencies,
): HostedReleaseSnapshot | null {
  return getReleaseIdentityBinding(config, dependencies).snapshot;
}