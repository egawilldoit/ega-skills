// SPEC-005 §5.1.5–§5.1.6, §5.1.8 ProjectConfigV1 parse + normalize (EGA-583).
//
// The project config module owns the V1 config schema: parsing a `.egaskills.yaml`
// text into the normalized `ProjectConfigV1` object exactly as SPEC-005 defines it.
//
// - §5.1.5: only `routing.mode = suggest` is accepted in V1. `routing.max_skills`
//   must be an integer 1–3, `routing.max_tokens` an integer 1–1,000,000. Invalid
//   config fails with the frozen `E_PROJECT_CONFIG_INVALID` code. No profiles, no
//   inheritance, no team policy — unknown top-level keys are rejected.
// - §5.1.6: `namespaces.allow`/`namespaces.deny` hold namespace strings ONLY:
//   trim ASCII outer whitespace, validate against the SPEC-001 namespace regex
//   (^[a-z0-9][a-z0-9._-]{0,63}$), and NEVER silently lowercase or repair
//   invalid input. `skills.prefer`/`skills.deny` hold canonical skill IDs ONLY
//   (<namespace>/<portable-name>, both components validated); aliases and bare
//   portable names are NOT accepted. All four lists are order-insensitive for
//   config semantics: deduplicated and sorted ascending by UTF-16 code units in
//   the normalized config. Syntactically valid policy entries MAY reference
//   namespaces/skills that are not currently installed — that is never a config
//   error (policy validation never depends on the current installation).
// - §5.1.8: an omitted optional field and an explicitly written default produce
//   the SAME normalized object; the normalized object uses EXACTLY the snake_case
//   keys shown in the spec (`schema_version`, `max_skills`, `max_tokens`,
//   `namespaces.allow`, ...). Duplicate YAML keys are invalid (the yaml parser
//   rejects them with DUPLICATE_KEY before normalization).
//
// Parsing is pure and deterministic: same YAML text, same frozen normalized
// object. Installation state is NEVER consulted.

import { parse as parseYaml } from "yaml";

/** Frozen error code for any invalid project config (SPEC-005 §5.1.5 rule 4). */
export const E_PROJECT_CONFIG_INVALID = "E_PROJECT_CONFIG_INVALID";

export type ProjectConfigErrorCode = typeof E_PROJECT_CONFIG_INVALID;

/** Error thrown by the config module; `code` is always the frozen E_PROJECT_CONFIG_INVALID. */
export class ProjectConfigError extends Error {
  readonly code: ProjectConfigErrorCode;

  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
    this.code = E_PROJECT_CONFIG_INVALID;
  }
}

/** V1 routing mode: exactly `suggest` (SPEC-005 §5.1.5 rule 1). */
export type RoutingModeV1 = "suggest";

export interface ProjectRoutingV1 {
  readonly mode: RoutingModeV1;
  /** Integer 1–3 (SPEC-005 §5.1.5 rule 4). */
  readonly max_skills: 1 | 2 | 3;
  /** Integer 1–1,000,000 (SPEC-005 §5.1.5 rule 4). */
  readonly max_tokens: number;
}

/** `namespaces.allow` / `namespaces.deny`: namespace strings only (§5.1.6 rule 1). */
export interface ProjectNamespacePolicyV1 {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/** `skills.prefer` / `skills.deny`: canonical `<namespace>/<portable-name>` IDs only (§5.1.6 rule 2). */
export interface ProjectSkillPolicyV1 {
  readonly prefer: readonly string[];
  readonly deny: readonly string[];
}

export interface ProjectLockingV1 {
  readonly required: boolean;
}

/**
 * Fully materialized normalized project config (SPEC-005 §5.1.8): defaults
 * populated, policy lists validated/deduplicated/sorted, canonical skill IDs
 * only. Keys are EXACTLY the spec's snake_case keys; the object is frozen.
 */
export interface ProjectConfigV1 {
  readonly schema_version: 1;
  readonly routing: ProjectRoutingV1;
  readonly namespaces: ProjectNamespacePolicyV1;
  readonly skills: ProjectSkillPolicyV1;
  readonly locking: ProjectLockingV1;
}

/**
 * Built-in defaults applied when NO config file is selected (SPEC-005 §5.1.5
 * rule 2): unlocked mode using current local versions. Deep-frozen.
 */
export const PROJECT_CONFIG_V1_DEFAULTS: ProjectConfigV1 = Object.freeze({
  schema_version: 1,
  routing: Object.freeze({
    mode: "suggest",
    max_skills: 3,
    max_tokens: 5000,
  }),
  namespaces: Object.freeze({
    allow: Object.freeze([]),
    deny: Object.freeze([]),
  }),
  skills: Object.freeze({
    prefer: Object.freeze([]),
    deny: Object.freeze([]),
  }),
  locking: Object.freeze({
    required: false,
  }),
});

// SPEC-001 §5.1.4 namespace + portable-name syntax, frozen verbatim:
//   namespace:    ^[a-z0-9][a-z0-9._-]{0,63}$   (1–64 chars, lowercase alnum start)
//   portable name:^[a-z0-9]+(?:-[a-z0-9]+)*$    (1–64 chars, lowercase alnum, `-` separated)
const NAMESPACE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PORTABLE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PORTABLE_NAME_LENGTH = 64;

/** ASCII outer whitespace trim (SPACE TAB LF CR FF VT), never Unicode-aware. */
const ASCII_TRIM_RE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

const SCHEMA_VERSION = 1 as const;
const MODE_SUGGEST = "suggest" as const;
const MAX_SKILLS_DEFAULT = 3 as const;
const MAX_TOKENS_DEFAULT = 5000 as const;

const TOP_LEVEL_KEYS = new Set(["schema_version", "routing", "namespaces", "skills", "locking"]);
const ROUTING_KEYS = new Set(["mode", "max_skills", "max_tokens"]);
const NAMESPACE_POLICY_KEYS = new Set(["allow", "deny"]);
const SKILL_POLICY_KEYS = new Set(["prefer", "deny"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ProjectConfigError(`Invalid project config: ${message}`);
}

/** Rejects unexpected keys: the V1 schema is frozen and never silently ignores input. */
function assertOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      invalid(`${field} contains unsupported key ${JSON.stringify(key)}`);
    }
  }
}

function trimAscii(value: string): string {
  return value.replace(ASCII_TRIM_RE, "");
}

/** §5.1.6 rule 1: namespace strings only, validated AFTER ASCII trim, never lowercased/repaired. */
function validateNamespaceEntry(ns: string): void {
  if (!NAMESPACE_RE.test(ns)) {
    invalid(
      `namespace ${JSON.stringify(ns)} must match ^[a-z0-9][a-z0-9._-]{0,63}$ (1–64 chars, lowercase alphanumeric start; namespaces are never lowercased or repaired)`,
    );
  }
}

/** §5.1.6 rule 2: canonical skill IDs only; aliases and bare portable names are NOT accepted. */
function validateSkillEntry(id: string): void {
  const first = id.indexOf("/");
  const last = id.lastIndexOf("/");
  if (first <= 0 || first !== last || first === id.length - 1) {
    invalid(
      `skill policy entry ${JSON.stringify(id)} must be a canonical <namespace>/<portable-name> skill ID (aliases and bare portable names are not accepted)`,
    );
  }
  const ns = id.slice(0, first);
  const name = id.slice(first + 1);
  if (!NAMESPACE_RE.test(ns)) {
    invalid(
      `skill policy entry ${JSON.stringify(id)}: namespace component must match ^[a-z0-9][a-z0-9._-]{0,63}$ (1–64 chars, lowercase alphanumeric start; never lowercased or repaired)`,
    );
  }
  if (name.length < 1 || name.length > MAX_PORTABLE_NAME_LENGTH || !PORTABLE_NAME_RE.test(name)) {
    invalid(
      `skill policy entry ${JSON.stringify(id)}: portable-name component must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (1–64 chars, lowercase alphanumeric segments separated by single hyphens)`,
    );
  }
}

/**
 * Validates a policy list (strings only), trims ASCII outer whitespace, rejects
 * non-canonical entries via `validateOne`, then deduplicates and sorts ascending
 * by UTF-16 code units (§5.1.6 rule 3). Returns a frozen array.
 */
function normalizeStringList(
  value: unknown,
  field: string,
  validateOne: (entry: string) => void,
): readonly string[] {
  // Omitted field == explicit default (SPEC-005 §5.1.8 rule 2): absent lists
  // are the empty list. An explicitly non-sequence value is still invalid.
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    invalid(`"${field}" must be a YAML sequence of strings`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      invalid(`"${field}" entries must be strings (got ${typeof raw})`);
    }
    const entry = trimAscii(raw);
    validateOne(entry);
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  out.sort(); // default comparator = ascending UTF-16 code-unit order (§5.1.6 rule 3)
  return Object.freeze(out);
}

/**
 * Normalizes a raw parsed YAML value into the frozen, fully materialized
 * `ProjectConfigV1` (SPEC-005 §5.1.5–§5.1.6, §5.1.8). Throws
 * `ProjectConfigError` with code `E_PROJECT_CONFIG_INVALID` on any invalid input.
 */
export function normalizeProjectConfigV1(value: unknown): ProjectConfigV1 {
  if (!isRecord(value)) {
    invalid("top level must be a YAML mapping");
  }
  assertOnlyKeys(value, TOP_LEVEL_KEYS, "top level");

  // schema_version: exactly 1 (absent == default 1, §5.1.8 rule 2).
  const schemaVersion = value.schema_version === undefined ? SCHEMA_VERSION : value.schema_version;
  if (schemaVersion !== SCHEMA_VERSION) {
    invalid(`schema_version must be 1 (got ${JSON.stringify(value.schema_version)})`);
  }

  // routing: mode/max_skills/max_tokens with field-level defaults.
  const routingRaw = value.routing === undefined ? {} : value.routing;
  if (!isRecord(routingRaw)) {
    invalid('"routing" must be a YAML mapping');
  }
  assertOnlyKeys(routingRaw, ROUTING_KEYS, '"routing"');

  const mode = routingRaw.mode === undefined ? MODE_SUGGEST : routingRaw.mode;
  if (mode !== MODE_SUGGEST) {
    invalid(`routing.mode must be "suggest" in V1 (got ${JSON.stringify(mode)})`);
  }

  const maxSkillsRaw = routingRaw.max_skills === undefined ? MAX_SKILLS_DEFAULT : routingRaw.max_skills;
  if (typeof maxSkillsRaw !== "number" || !Number.isInteger(maxSkillsRaw) || maxSkillsRaw < 1 || maxSkillsRaw > 3) {
    invalid(`routing.max_skills must be an integer 1–3 (got ${JSON.stringify(maxSkillsRaw)})`);
  }

  const maxTokensRaw = routingRaw.max_tokens === undefined ? MAX_TOKENS_DEFAULT : routingRaw.max_tokens;
  if (
    typeof maxTokensRaw !== "number" ||
    !Number.isInteger(maxTokensRaw) ||
    maxTokensRaw < 1 ||
    maxTokensRaw > 1_000_000
  ) {
    invalid(`routing.max_tokens must be an integer 1–1,000,000 (got ${JSON.stringify(maxTokensRaw)})`);
  }

  // namespaces / skills policy lists (default empty).
  const namespacesRaw = value.namespaces === undefined ? {} : value.namespaces;
  if (!isRecord(namespacesRaw)) {
    invalid('"namespaces" must be a YAML mapping');
  }
  assertOnlyKeys(namespacesRaw, NAMESPACE_POLICY_KEYS, '"namespaces"');
  const namespaceAllow = normalizeStringList(namespacesRaw.allow, "namespaces.allow", validateNamespaceEntry);
  const namespaceDeny = normalizeStringList(namespacesRaw.deny, "namespaces.deny", validateNamespaceEntry);

  const skillsRaw = value.skills === undefined ? {} : value.skills;
  if (!isRecord(skillsRaw)) {
    invalid('"skills" must be a YAML mapping');
  }
  assertOnlyKeys(skillsRaw, SKILL_POLICY_KEYS, '"skills"');
  const skillPrefer = normalizeStringList(skillsRaw.prefer, "skills.prefer", validateSkillEntry);
  const skillDeny = normalizeStringList(skillsRaw.deny, "skills.deny", validateSkillEntry);

  // locking.required (default false = unlocked mode, §5.1.5 rule 2).
  const lockingRaw = value.locking === undefined ? {} : value.locking;
  if (!isRecord(lockingRaw)) {
    invalid('"locking" must be a YAML mapping');
  }
  assertOnlyKeys(lockingRaw, new Set(["required"]), '"locking"');
  const lockingRequired = lockingRaw.required === undefined ? false : lockingRaw.required;
  if (typeof lockingRequired !== "boolean") {
    invalid(`locking.required must be a boolean (got ${JSON.stringify(lockingRequired)})`);
  }

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    routing: Object.freeze({
      mode: MODE_SUGGEST,
      max_skills: maxSkillsRaw as 1 | 2 | 3, // range validated above
      max_tokens: maxTokensRaw,
    }),
    namespaces: Object.freeze({
      allow: namespaceAllow,
      deny: namespaceDeny,
    }),
    skills: Object.freeze({
      prefer: skillPrefer,
      deny: skillDeny,
    }),
    locking: Object.freeze({
      required: lockingRequired,
    }),
  });
}

/**
 * Parses `.egaskills.yaml` text (or any YAML `schema_version: 1` config document)
 * into the normalized `ProjectConfigV1`. Malformed YAML and duplicate YAML keys
 * fail with `E_PROJECT_CONFIG_INVALID` (the yaml parser rejects duplicates with
 * DUPLICATE_KEY before any normalization happens).
 */
export function parseProjectConfig(source: string): ProjectConfigV1 {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    invalid(`YAML parse error: ${detail}`);
  }
  return normalizeProjectConfigV1(parsed);
}