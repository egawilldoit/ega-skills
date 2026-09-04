// SPEC-005 §5.1.8–§5.1.11, §5.1.14 config hash + lockfile validation (EGA-584).
//
// Three responsibilities, independently testable:
//
// 1. hashNormalizedConfig(normalizedConfig): the §5.1.8 config identity
//    `config_hash = SHA256(RFC8785_JCS(normalized ProjectConfigV1))`,
//    formatted `sha256:<64 lowercase hex>`. The input is the FULLY
//    MATERIALIZED normalized object (defaults populated, policy lists
//    validated/deduplicated/sorted, canonical skill IDs only), so an omitted
//    optional field and an explicitly written default hash identically
//    (§5.1.8 rule 2), policy list order is irrelevant (§5.1.6 rule 3), and
//    YAML comments/key order/formatting never enter the hash (JCS sorts
//    object keys lexicographically; the normalized object uses EXACTLY the
//    spec's snake_case keys — TypeScript camelCase names are never
//    serialized, §5.1.8 rule 3). Uses canonicalize@4.0.0 + SHA-256 via
//    @ega-skills/hashing (SPEC-002 primitives, §5.1.8 rule 4).
//
// 2. validateLockfile(parsed, expectedConfigHash): maps the RAW parsed YAML
//    value of a `.egaskills.lock` to the frozen normalized `ProjectLockV1`.
//    V1 lock schema (§5.1.9): `lockfile_version: 1`, `token_estimator` MUST
//    be `ega-o200k-v1`, `generated_from.config_hash` MUST equal the
//    expected hash (passed as a parameter), and `skills` maps canonical
//    skill IDs (sorted ascending — deterministic serialization, §5.1.9
//    rule 5) to `{ name, version_hash }` entries where `name` MUST equal the
//    portable-name component of the key and `version_hash` MUST match
//    `sha256:<64 lowercase hex>`. NO unknown semantic keys exist in V1
//    (unknown keys at any level are rejected, §5.1.14 rule 3; §5.1.9 rule 4).
//    `skills: {}` is a VALID active lock (§5.1.9 rule 6). Failure codes are
//    frozen (§5.2):
//      - E_PROJECT_LOCK_INVALID       lockfile_version ≠ 1, bad shapes,
//                                     unknown semantic keys, unsorted skill
//                                     keys, NUL or non-text (U+FFFD) markers
//                                     in any string; parse-level text problems
//                                     (NUL byte, invalid UTF-8) also map here
//                                     (§5.1.14 rule 5).
//      - E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED  token_estimator ≠ ega-o200k-v1
//                                     (§5.1.9 rule 2, §5.1.11).
//      - E_LOCK_CONFIG_MISMATCH       generated_from.config_hash ≠ expected
//                                     (§5.1.9 rule 3) — enforced even when
//                                     locking.required=false (§5.1.12 rule 1).
//    Validation never consults installation state and never repairs input.
//
// 3. readConfigAndLock(discovery): the control-file gate (§5.1.14). Discovery
//    is presence-based by design (EGA-582); this layer judges KIND and TEXT.
//    - No selected config (configPath null) → { config: null, lock: null }:
//      no config, no lock in force (§5.1.2 rule 5, §5.1.12 rule 2).
//    - Config present without an adjacent lock (lockPath null) →
//      { config, lock: null }; whether locking.required=true demands a lock
//      (E_LOCK_REQUIRED) is resolver-integration territory (EGA-587), NOT
//      enforced here.
//    - A config or lock path that is a symlink/junction is REJECTED rather
//      than followed (§5.1.14 rule 4): config → E_PROJECT_CONFIG_INVALID,
//      lock → E_PROJECT_LOCK_INVALID (§5.1.14 rule 5). Non-regular kinds and
//      non-text content (invalid UTF-8, NUL byte) map to the same codes.
//    - A path discovery reported as present that cannot be read (ENOENT
//      TOCTOU race) is FAIL-CLOSED: the corresponding INVALID error is
//      thrown — a vanished control file is an invalid state, never silently
//      treated as absent.
//    - Duplicate YAML mapping keys are INVALID (§5.1.14 rule 2): the yaml
//      parser rejects them (DUPLICATE_KEY) before any normalization.
//    - The active lock is validated against hashNormalizedConfig of the
//      effective normalized config, so E_LOCK_CONFIG_MISMATCH is raised here
//      exactly when the lock is stale relative to the active config.
//
// Generation slash refresh (EGA-585), optional-lock semantics (EGA-586), and
// resolver wiring (EGA-587) are out of scope for this module.

import { readFileSync, lstatSync } from "node:fs";
import { TextDecoder } from "node:util";
import { parse as parseYaml } from "yaml";

import { canonicalizeJson, hashBytes } from "@ega-skills/hashing";

import { parseProjectConfig, ProjectConfigError, E_PROJECT_CONFIG_INVALID } from "./config.js";
import type { ProjectConfigV1 } from "./config.js";
import type { ProjectDiscovery } from "./discovery.js";

/** Frozen error codes owned by the project lock module (SPEC-005 §5.2). */
export const E_PROJECT_LOCK_INVALID = "E_PROJECT_LOCK_INVALID";
export const E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED = "E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED";
export const E_LOCK_CONFIG_MISMATCH = "E_LOCK_CONFIG_MISMATCH";
export const E_LOCKED_VERSION_MISSING = "E_LOCKED_VERSION_MISSING";
/** `locking.required=true` with no adjacent lock (§5.1.12; thrown by resolveLockMode). */
export const E_LOCK_REQUIRED = "E_LOCK_REQUIRED";

export type ProjectLockErrorCode =
  | typeof E_PROJECT_LOCK_INVALID
  | typeof E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED
  | typeof E_LOCK_CONFIG_MISMATCH
  | typeof E_LOCKED_VERSION_MISSING
  | typeof E_LOCK_REQUIRED;

/** Error thrown by the lock module; `code` is always one of the frozen codes above. */
export class ProjectLockError extends Error {
  readonly code: ProjectLockErrorCode;

  constructor(code: ProjectLockErrorCode, message: string) {
    super(message);
    this.name = "ProjectLockError";
    this.code = code;
  }
}

/** V1 token estimator — the ONLY estimator a V1 lock may carry (§5.1.9 rule 2). */
export const TOKEN_ESTIMATOR_EGA_O200K_V1 = "ega-o200k-v1" as const;

/** A single locked-skill entry: name + exact immutable version hash (§5.1.9 rule 4). */
export interface ProjectLockEntryV1 {
  /** Portable-name component of the skill key; MUST equal it exactly. */
  readonly name: string;
  /** Immutable version identity, `sha256:<64 lowercase hex>`. */
  readonly version_hash: string;
}

export interface ProjectGeneratedFromV1 {
  /** §5.1.8 config hash of the active normalized config, `sha256:<64 lowercase hex>`. */
  readonly config_hash: string;
}

/**
 * Frozen normalized V1 lockfile (SPEC-005 §5.1.9): deterministic shape with
 * `skills` keys sorted ascending. Deep-frozen by validation.
 */
export interface ProjectLockV1 {
  readonly lockfile_version: 1;
  readonly token_estimator: typeof TOKEN_ESTIMATOR_EGA_O200K_V1;
  readonly generated_from: ProjectGeneratedFromV1;
  readonly skills: Readonly<Record<string, ProjectLockEntryV1>>;
}

/** Result of the §5.1.14 control-file gate. */
export interface ReadConfigAndLockResult {
  /** Effective normalized project config, or null when no config is selected. */
  readonly config: ProjectConfigV1 | null;
  /** Validated active lock adjacent to the config, or null when none exists. */
  readonly lock: ProjectLockV1 | null;
}

// SPEC-001 §5.1.4 namespace + portable-name syntax, frozen verbatim (mirrors
// config.ts; kept local so lock validation is self-contained).
const NAMESPACE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PORTABLE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PORTABLE_NAME_LENGTH = 64;

const LOCKFILE_VERSION = 1 as const;
const VERSION_HASH_RE = /^sha256:[0-9a-f]{64}$/;

const TOP_LEVEL_KEYS = new Set(["lockfile_version", "token_estimator", "generated_from", "skills"]);
const GENERATED_FROM_KEYS = new Set(["config_hash"]);
const ENTRY_KEYS = new Set(["name", "version_hash"]);

const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ProjectLockError(E_PROJECT_LOCK_INVALID, `Invalid project lock: ${message}`);
}

function estimatorUnsupported(estimator: string): never {
  throw new ProjectLockError(
    E_LOCK_TOKEN_ESTIMATOR_UNSUPPORTED,
    `Lock token estimator ${JSON.stringify(estimator)} is not supported: only "${TOKEN_ESTIMATOR_EGA_O200K_V1}" is accepted in V1`,
  );
}

/** Rejects unexpected keys: the V1 schema is frozen and never silently ignores input (§5.1.14 rule 3). */
function assertOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      invalid(`${field} contains unsupported key ${JSON.stringify(key)}`);
    }
  }
}

/** §5.1.14 rule 1: control-file text is UTF-8 text with no NUL byte. NUL or a U+FFFD replacement marker is rejected. */
function assertPlainText(value: string, field: string): void {
  if (value.includes("\u0000")) {
    invalid(`${field} contains a NUL byte (control files must be plain UTF-8 text)`);
  }
  if (value.includes("\uFFFD")) {
    invalid(`${field} contains non-text content (U+FFFD replacement character; control files must be valid UTF-8 text)`);
  }
}

/** §5.1.9 rule 4: the lock key MUST be a valid canonical skill ID; aliases and bare portable names are not accepted. */
function validateSkillKey(key: string): void {
  const first = key.indexOf("/");
  const last = key.lastIndexOf("/");
  if (first <= 0 || first !== last || first === key.length - 1) {
    invalid(
      `skill key ${JSON.stringify(key)} must be a canonical <namespace>/<portable-name> skill ID (aliases and bare portable names are not accepted)`,
    );
  }
  const ns = key.slice(0, first);
  const name = key.slice(first + 1);
  if (!NAMESPACE_RE.test(ns)) {
    invalid(
      `skill key ${JSON.stringify(key)}: namespace component must match ^[a-z0-9][a-z0-9._-]{0,63}$ (1–64 chars, lowercase alphanumeric start)`,
    );
  }
  if (name.length < 1 || name.length > MAX_PORTABLE_NAME_LENGTH || !PORTABLE_NAME_RE.test(name)) {
    invalid(
      `skill key ${JSON.stringify(key)}: portable-name component must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (1–64 chars, lowercase alphanumeric segments separated by single hyphens)`,
    );
  }
}

/**
 * §5.1.8 config identity: `sha256:<64 lowercase hex>` of the RFC 8785 JCS of
 * the fully materialized normalized `ProjectConfigV1`. The input is
 * post-normalization, so omitted defaults and explicit defaults hash
 * identically and policy lists are already sorted (order-insensitive hash).
 */
export function hashNormalizedConfig(normalizedConfig: ProjectConfigV1): string {
  return hashBytes(canonicalizeJson(normalizedConfig));
}

/**
 * Validates a raw parsed `.egaskills.lock` value into the frozen normalized
 * `ProjectLockV1` (SPEC-005 §5.1.9–§5.1.11). Throws `ProjectLockError` with a
 * frozen code on any invalid input; `expectedConfigHash` is the §5.1.8 hash
 * of the active normalized config and is enforced even when
 * `locking.required=false` (§5.1.12 rule 1). Never consults installation
 * state and never repairs input.
 */
export function validateLockfile(parsed: unknown, expectedConfigHash: string): ProjectLockV1 {
  if (!isRecord(parsed)) {
    invalid("top level must be a YAML mapping");
  }
  assertOnlyKeys(parsed, TOP_LEVEL_KEYS, "top level");

  // lockfile_version: exactly 1 (§5.1.9 rule 1). No field-level defaults:
  // every V1 lock field is mandatory.
  if (parsed.lockfile_version !== LOCKFILE_VERSION) {
    invalid(`lockfile_version must be 1 (got ${JSON.stringify(parsed.lockfile_version)})`);
  }

  // token_estimator: a non-string is a shape error; any string other than
  // ega-o200k-v1 is the frozen unsupported-estimator failure (§5.1.9 rule 2).
  if (typeof parsed.token_estimator !== "string") {
    invalid(`"token_estimator" must be a string (got ${typeof parsed.token_estimator})`);
  }
  if (parsed.token_estimator !== TOKEN_ESTIMATOR_EGA_O200K_V1) {
    estimatorUnsupported(parsed.token_estimator);
  }

  // generated_from.config_hash: shape, then equality with the expected hash
  // (§5.1.9 rule 3). An active lock is authoritative — the mismatch fires
  // regardless of locking.required (§5.1.12 rule 1).
  const generatedFromRaw = parsed.generated_from;
  if (!isRecord(generatedFromRaw)) {
    invalid('"generated_from" must be a YAML mapping');
  }
  assertOnlyKeys(generatedFromRaw, GENERATED_FROM_KEYS, '"generated_from"');
  const configHashRaw = generatedFromRaw.config_hash;
  if (typeof configHashRaw !== "string") {
    invalid(`"generated_from.config_hash" must be a string (got ${typeof configHashRaw})`);
  }
  assertPlainText(configHashRaw, '"generated_from.config_hash"');
  if (!VERSION_HASH_RE.test(configHashRaw)) {
    invalid(`"generated_from.config_hash" must be sha256:<64 lowercase hex> (got ${JSON.stringify(configHashRaw)})`);
  }
  if (configHashRaw !== expectedConfigHash) {
    throw new ProjectLockError(
      E_LOCK_CONFIG_MISMATCH,
      `Lock was generated from a different config: lock has ${configHashRaw}, active config has ${expectedConfigHash}`,
    );
  }

  // skills: a mapping; empty is a VALID active lock (§5.1.9 rule 6).
  const skillsRaw = parsed.skills;
  if (!isRecord(skillsRaw)) {
    invalid('"skills" must be a YAML mapping');
  }
  const skillKeys = Object.keys(skillsRaw);

  // Deterministic serialization: skill keys MUST be sorted ascending
  // (§5.1.9 rule 5). Lock keys are all-lowercase ASCII canonical IDs, so the
  // default UTF-16 code-unit comparison is exact.
  for (let i = 1; i < skillKeys.length; i++) {
    const prev = skillKeys[i - 1] as string;
    const current = skillKeys[i] as string;
    if (prev > current) {
      invalid(
        `"skills" keys must be sorted ascending (deterministic lock serialization); found ${JSON.stringify(prev)} before ${JSON.stringify(current)}`,
      );
    }
  }

  const skills: Record<string, ProjectLockEntryV1> = {};
  for (const key of skillKeys) {
    assertPlainText(key, `"skills" key`);
    validateSkillKey(key);
    const entryRaw = skillsRaw[key];
    if (!isRecord(entryRaw)) {
      invalid(`"skills.${key}" must be a YAML mapping`);
    }
    assertOnlyKeys(entryRaw, ENTRY_KEYS, `"skills.${key}"`);

    const nameRaw = entryRaw.name;
    if (typeof nameRaw !== "string") {
      invalid(`"skills.${key}".name must be a string (got ${typeof nameRaw})`);
    }
    const versionHashRaw = entryRaw.version_hash;
    if (typeof versionHashRaw !== "string") {
      invalid(`"skills.${key}".version_hash must be a string (got ${typeof versionHashRaw})`);
    }
    assertPlainText(nameRaw, `"skills.${key}".name`);
    assertPlainText(versionHashRaw, `"skills.${key}".version_hash`);
    if (!VERSION_HASH_RE.test(versionHashRaw)) {
      invalid(
        `"skills.${key}".version_hash must be sha256:<64 lowercase hex> (got ${JSON.stringify(versionHashRaw)})`,
      );
    }

    // §5.1.9 rule 4: name MUST equal the portable-name component of the key.
    const portableName = key.slice(key.indexOf("/") + 1);
    if (nameRaw !== portableName) {
      invalid(
        `"skills.${key}".name must equal the portable-name component ${JSON.stringify(portableName)} (got ${JSON.stringify(nameRaw)})`,
      );
    }

    skills[key] = Object.freeze({ name: nameRaw, version_hash: versionHashRaw });
  }

  return Object.freeze({
    lockfile_version: LOCKFILE_VERSION,
    token_estimator: TOKEN_ESTIMATOR_EGA_O200K_V1,
    generated_from: Object.freeze({ config_hash: configHashRaw }),
    skills: Object.freeze(skills),
  });
}

/**
 * Locked-version lookup (§5.1.11): returns the exact immutable version hash
 * for a locked skill. Throws `E_LOCKED_VERSION_MISSING` when the skill is
 * absent from the lock — the resolver NEVER falls forward to current/latest.
 */
export function lockedVersionFor(lock: ProjectLockV1, skillId: string): string {
  const entry = lock.skills[skillId];
  if (entry === undefined) {
    throw new ProjectLockError(
      E_LOCKED_VERSION_MISSING,
      `Skill ${JSON.stringify(skillId)} is not locked: no locked version exists for it (never fall forward to current/latest)`,
    );
  }
  return entry.version_hash;
}

/** Rejects symlink/junction and non-regular control files; also validates UTF-8 text + no NUL (§5.1.14 rules 1, 4, 5). */
function readControlFileText(path: string, kind: "config" | "lock"): string {
  // Config failures map to E_PROJECT_CONFIG_INVALID, lock failures to
  // E_PROJECT_LOCK_INVALID (§5.1.14 rule 5) — the only two codes this gate emits.
  const failFor = (message: string): ProjectConfigError | ProjectLockError =>
    kind === "config"
      ? new ProjectConfigError(message)
      : new ProjectLockError(E_PROJECT_LOCK_INVALID, message);

  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(path);
  } catch {
    // Converted to null: handled by the guard below.
  }
  if (stat === null) {
    // Discovery reported this path as present; a vanished file is an invalid
    // state (TOCTOU), never silently treated as absent — fail closed.
    throw failFor(`${kind} file ${path} was discovered but is missing at read time (fail-closed: never silently absent)`);
  }
  if (stat.isSymbolicLink()) {
    throw failFor(`${kind} file ${path} is a symlink/junction and is REJECTED rather than followed (SPEC-005 §5.1.14 rule 4)`);
  }
  if (!stat.isFile()) {
    throw failFor(`${kind} file ${path} is not a regular file; .egaskills control files must be regular UTF-8 text (SPEC-005 §5.1.14 rule 1)`);
  }

  let text: string | null = null;
  try {
    // fatal:true turns invalid UTF-8 into a RangeError instead of silent
    // U+FFFD substitution — invalid bytes are rejected, never repaired.
    text = utf8StrictDecoder.decode(readFileSync(path));
  } catch {
    // Converted to null: handled by the guard below.
  }
  if (text === null) {
    throw failFor(`${kind} file ${path} is not valid UTF-8 text (SPEC-005 §5.1.14 rule 1)`);
  }
  if (text.includes("\u0000")) {
    throw failFor(`${kind} file ${path} contains a NUL byte (SPEC-005 §5.1.14 rule 1)`);
  }
  return text;
}

/**
 * Control-file gate (SPEC-005 §5.1.14): reads, decodes, parses, and validates
 * the config and adjacent lock reported by discovery. Config failures map to
 * `E_PROJECT_CONFIG_INVALID`, lock failures to `E_PROJECT_LOCK_INVALID`
 * (§5.1.14 rule 5). The lock is validated against the hash of the effective
 * normalized config. Missing-file handling and no-config behavior are
 * documented on the module header.
 */
export function readConfigAndLock(discovery: ProjectDiscovery): ReadConfigAndLockResult {
  if (discovery.configPath === null) {
    // No selected config ⇒ no config and no lock in force (§5.1.2 rule 5,
    // §5.1.12 rule 2: UNLOCKED behavior using current local versions).
    return { config: null, lock: null };
  }
  const configText = readControlFileText(discovery.configPath, "config");
  const config = parseProjectConfig(configText);
  if (discovery.lockPath === null) {
    // Config without an adjacent lock: unlocked unless the resolver enforces
    // locking.required (E_LOCK_REQUIRED is EGA-587 wiring, not this gate).
    return { config, lock: null };
  }
  const lockText = readControlFileText(discovery.lockPath, "lock");
  let parsedLock: unknown;
  try {
    parsedLock = parseYaml(lockText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    invalid(`YAML parse error: ${detail}`);
  }
  const lock = validateLockfile(parsedLock, hashNormalizedConfig(config));
  return { config, lock };
}

// Re-exported for convenience so lock consumers can build compound messages
// without importing config.js separately.
export { E_PROJECT_CONFIG_INVALID };