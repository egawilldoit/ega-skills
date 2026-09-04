export {
  EGA_O200K_V1_ESTIMATOR_ID,
  TokenEstimatorError,
  assertTokenEstimatorCompatibility,
  assertTokenEstimatorId,
  tokenEstimator,
} from "./token-estimator.js";
export type {
  TokenEstimator,
  TokenEstimatorErrorCode,
  TokenEstimatorInput,
  TokenEstimatorReferenceVector,
} from "./token-estimator.js";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type SchemaErrorCode =
  | "E_CONTROL_FILE_ENCODING"
  | "E_SKILL_FILE_MISSING"
  | "E_SKILL_FRONTMATTER_INVALID"
  | "E_SKILL_NAME_REQUIRED"
  | "E_SKILL_NAME_INVALID"
  | "E_SKILL_DIRECTORY_NAME_MISMATCH"
  | "E_SKILL_DESCRIPTION_REQUIRED"
  | "E_SKILL_DESCRIPTION_TOO_LARGE"
  | "E_NAMESPACE_INVALID"
  | "E_SKILL_NOT_FOUND"
  | "E_SKILL_REFERENCE_AMBIGUOUS"
  | "E_EGA_METADATA_INVALID"
  | "E_ALIAS_CONFLICT"
  | "E_L1_TOO_LARGE";

export interface SchemaErrorContext {
  readonly path?: string;
  readonly field?: string;
}

export class SchemaValidationError extends Error {
  readonly code: SchemaErrorCode;
  readonly path?: string;
  readonly field?: string;

  constructor(
    code: SchemaErrorCode,
    message: string,
    context: SchemaErrorContext = {},
  ) {
    super(message);
    this.name = "SchemaValidationError";
    this.code = code;
    if (context.path !== undefined) {
      this.path = context.path;
    }
    if (context.field !== undefined) {
      this.field = context.field;
    }
  }
}

export interface PortableSkill {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
}

export interface ParsePortableSkillInput {
  readonly directoryName: string;
  readonly skillMd?: Uint8Array;
  readonly skillCoreMd?: Uint8Array;
  readonly egaYaml?: Uint8Array;
}

const PORTABLE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PORTABLE_NAME_LENGTH = 64;
const MAX_DESCRIPTION_CODE_POINTS = 1024;

const portableFrontmatterSchema = z
  .object({
    name: z.unknown().optional(),
    description: z.unknown().optional(),
    license: z.string().optional(),
    compatibility: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().optional(),
  })
  .strict();

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function isPortableSkillName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= MAX_PORTABLE_NAME_LENGTH &&
    PORTABLE_NAME_RE.test(value)
  );
}

export function validatePortableSkillName(
  value: unknown,
  context: SchemaErrorContext = { field: "name" },
): string {
  if (typeof value !== "string" || !isPortableSkillName(value)) {
    throw new SchemaValidationError(
      "E_SKILL_NAME_INVALID",
      "Skill name must be 1–64 lowercase ASCII alphanumeric characters with single internal hyphen separators.",
      context,
    );
  }
  return value;
}

export function parsePortableSkill(input: ParsePortableSkillInput): PortableSkill {
  const skillPath = controlPath(input.directoryName, "SKILL.md");

  if (input.skillMd === undefined) {
    throw new SchemaValidationError(
      "E_SKILL_FILE_MISSING",
      "SKILL.md is required in every skill root.",
      { path: skillPath },
    );
  }

  // SPEC-001 §5.1.2 requires every present control file to pass encoding checks
  // before any name/description/frontmatter semantic validation.
  const skillText = decodeControlFile(input.skillMd, skillPath);
  if (input.skillCoreMd !== undefined) {
    decodeControlFile(
      input.skillCoreMd,
      controlPath(input.directoryName, "SKILL.core.md"),
    );
  }
  if (input.egaYaml !== undefined) {
    decodeControlFile(
      input.egaYaml,
      controlPath(input.directoryName, "ega.yaml"),
    );
  }

  const frontmatter = parsePortableFrontmatter(skillText, skillPath);

  if (frontmatter.name === undefined || frontmatter.name === null || frontmatter.name === "") {
    throw new SchemaValidationError(
      "E_SKILL_NAME_REQUIRED",
      "SKILL.md frontmatter requires a non-empty name.",
      { path: skillPath, field: "name" },
    );
  }

  const name = validatePortableSkillName(frontmatter.name, {
    path: skillPath,
    field: "name",
  });

  if (name !== input.directoryName) {
    throw new SchemaValidationError(
      "E_SKILL_DIRECTORY_NAME_MISMATCH",
      `Skill name ${JSON.stringify(name)} must exactly match directory ${JSON.stringify(input.directoryName)}.`,
      { path: skillPath, field: "name" },
    );
  }

  if (
    frontmatter.description === undefined ||
    frontmatter.description === null ||
    frontmatter.description === ""
  ) {
    throw new SchemaValidationError(
      "E_SKILL_DESCRIPTION_REQUIRED",
      "SKILL.md frontmatter requires a non-empty description.",
      { path: skillPath, field: "description" },
    );
  }

  if (typeof frontmatter.description !== "string") {
    throw new SchemaValidationError(
      "E_SKILL_FRONTMATTER_INVALID",
      "SKILL.md description must be a string.",
      { path: skillPath, field: "description" },
    );
  }

  if (frontmatter.description.trim().length === 0) {
    throw new SchemaValidationError(
      "E_SKILL_DESCRIPTION_REQUIRED",
      "SKILL.md frontmatter requires a non-empty description after outer-whitespace trimming.",
      { path: skillPath, field: "description" },
    );
  }

  if ([...frontmatter.description].length > MAX_DESCRIPTION_CODE_POINTS) {
    throw new SchemaValidationError(
      "E_SKILL_DESCRIPTION_TOO_LARGE",
      "SKILL.md description must contain at most 1024 Unicode code points.",
      { path: skillPath, field: "description" },
    );
  }

  const result: {
    name: string;
    description: string;
    license?: string;
    compatibility?: string;
    metadata?: Readonly<Record<string, string>>;
    allowedTools?: string;
  } = {
    name,
    description: frontmatter.description,
  };

  if (frontmatter.license !== undefined) {
    result.license = frontmatter.license;
  }
  if (frontmatter.compatibility !== undefined) {
    result.compatibility = frontmatter.compatibility;
  }
  if (frontmatter.metadata !== undefined) {
    result.metadata = { ...frontmatter.metadata };
  }
  if (frontmatter["allowed-tools"] !== undefined) {
    result.allowedTools = frontmatter["allowed-tools"];
  }

  return result;
}

function controlPath(directoryName: string, fileName: string): string {
  return `${directoryName}/${fileName}`;
}

function decodeControlFile(bytes: Uint8Array, path: string): string {
  for (const byte of bytes) {
    if (byte === 0) {
      throw new SchemaValidationError(
        "E_CONTROL_FILE_ENCODING",
        `${path} must be UTF-8 text without NUL bytes.`,
        { path },
      );
    }
  }

  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new SchemaValidationError(
      "E_CONTROL_FILE_ENCODING",
      `${path} must be valid UTF-8 text without NUL bytes.`,
      { path },
    );
  }
}

function parsePortableFrontmatter(text: string, path: string): z.infer<typeof portableFrontmatterSchema> {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw frontmatterError(path, "SKILL.md must begin with YAML frontmatter delimited by --- lines.");
  }

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      end = index;
      break;
    }
  }

  if (end < 0) {
    throw frontmatterError(path, "SKILL.md YAML frontmatter is missing its closing --- delimiter.");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join("\n"));
  } catch {
    throw frontmatterError(path, "SKILL.md YAML frontmatter could not be parsed.");
  }

  const checked = portableFrontmatterSchema.safeParse(parsed);
  if (!checked.success) {
    throw frontmatterError(path, "SKILL.md frontmatter contains unsupported fields or invalid portable metadata types.");
  }

  return checked.data;
}

function frontmatterError(path: string, message: string): SchemaValidationError {
  return new SchemaValidationError("E_SKILL_FRONTMATTER_INVALID", message, { path });
}

// SPEC-001 §5.1.4 Namespace and canonical skill ID (EGA-553).
// Namespace syntax: ^[a-z0-9][a-z0-9._-]{0,63}$ (1–64 chars).
// Namespaces are NOT lowercased silently: invalid input is rejected.

const NAMESPACE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isNamespace(value: string): boolean {
  return typeof value === "string" && NAMESPACE_RE.test(value);
}

export function validateNamespace(
  value: unknown,
  context: SchemaErrorContext = { field: "namespace" },
): string {
  if (typeof value !== "string" || !isNamespace(value)) {
    throw new SchemaValidationError(
      "E_NAMESPACE_INVALID",
      "Namespace must match ^[a-z0-9][a-z0-9._-]{0,63}$ (1–64 chars; lowercase alphanumeric start, then lowercase alphanumeric plus . _ -).",
      context,
    );
  }
  return value;
}

export function buildCanonicalSkillId(
  namespace: string,
  portableName: string,
): string {
  const ns = validateNamespace(namespace, { field: "namespace" });
  const name = validatePortableSkillName(portableName, { field: "name" });
  return `${ns}/${name}`;
}

export interface CanonicalSkillIdParts {
  readonly namespace: string;
  readonly name: string;
}

export function parseCanonicalSkillId(id: string): CanonicalSkillIdParts {
  if (typeof id !== "string") {
    throw new SchemaValidationError(
      "E_NAMESPACE_INVALID",
      "Canonical skill ID must be <namespace>/<portable-name> with exactly one / separator.",
      { field: "reference" },
    );
  }
  const first = id.indexOf("/");
  const last = id.lastIndexOf("/");
  if (first <= 0 || first !== last || first === id.length - 1) {
    throw new SchemaValidationError(
      "E_NAMESPACE_INVALID",
      "Canonical skill ID must be <namespace>/<portable-name> with exactly one / separator.",
      { field: "reference" },
    );
  }
  const namespace = id.slice(0, first);
  const name = id.slice(first + 1);
  validateNamespace(namespace, { field: "namespace" });
  validatePortableSkillName(name, { field: "name" });
  return { namespace, name };
}

// SPEC-001 §5.1.12 Skill-reference resolution order (EGA-553).
// Pure, deterministic, reusable by registry/router. No persistence, no routing.

export interface VisibleSkillEntry {
  readonly canonicalId: string;
  readonly aliases?: readonly string[];
}

function compareUtf16(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function portableNameOf(canonicalId: string): string | null {
  const first = canonicalId.indexOf("/");
  const last = canonicalId.lastIndexOf("/");
  if (first <= 0 || first !== last || first === canonicalId.length - 1) {
    return null;
  }
  return canonicalId.slice(first + 1);
}

export function resolveSkillReference(
  ref: string,
  visibleCatalog: readonly VisibleSkillEntry[],
): string {
  // 1. Exact canonical ID.
  for (const entry of visibleCatalog) {
    if (entry.canonicalId === ref) {
      return entry.canonicalId;
    }
  }

  // 2. Exact global alias (deterministic: sorted catalog order).
  const byCanonical = [...visibleCatalog].sort((a, b) =>
    compareUtf16(a.canonicalId, b.canonicalId),
  );
  for (const entry of byCanonical) {
    for (const alias of entry.aliases ?? []) {
      if (alias === ref) {
        return entry.canonicalId;
      }
    }
  }

  // 3. Bare portable name, ONLY if exactly one visible canonical skill matches.
  const matches = byCanonical.filter(
    (entry) => portableNameOf(entry.canonicalId) === ref,
  );
  if (matches.length === 1) {
    const only = matches[0];
    if (only !== undefined) {
      return only.canonicalId;
    }
  }
  if (matches.length > 1) {
    const ordered = matches.map((entry) => entry.canonicalId);
    throw new SchemaValidationError(
      "E_SKILL_REFERENCE_AMBIGUOUS",
      `Bare skill reference ${JSON.stringify(ref)} is ambiguous: ${ordered.map((candidate) => JSON.stringify(candidate)).join(", ")}.`,
      { field: "reference" },
    );
  }

  throw new SchemaValidationError(
    "E_SKILL_NOT_FOUND",
    `Skill reference ${JSON.stringify(ref)} did not match any visible canonical skill.`,
    { field: "reference" },
  );
}

// SPEC-001 §5.1.8–§5.1.10 ega.yaml routing metadata (EGA-554).
// Canonical storage forms are distinct from derived search text (SPEC-003 FTS).

export interface EgaRoutingMetadata {
  readonly domains: readonly string[];
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly aliases: readonly string[];
  readonly triggers: readonly string[];
  readonly antiTriggers: readonly string[];
}

export const EMPTY_EGA_ROUTING_METADATA: EgaRoutingMetadata = Object.freeze({
  domains: Object.freeze([]) as readonly string[],
  platforms: Object.freeze([]) as readonly string[],
  frameworks: Object.freeze([]) as readonly string[],
  aliases: Object.freeze([]) as readonly string[],
  triggers: Object.freeze([]) as readonly string[],
  antiTriggers: Object.freeze([]) as readonly string[],
});

const ROUTING_IDENTIFIER_RE = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

const EGA_YAML_KEYS = new Set([
  "schema_version",
  "domains",
  "platforms",
  "frameworks",
  "aliases",
  "triggers",
  "anti_triggers",
]);

function trimAsciiWhitespace(value: string): string {
  return value.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

function sortUtf16(values: string[]): string[] {
  return values.sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

function metadataError(
  message: string,
  path: string,
  field?: string,
): SchemaValidationError {
  return new SchemaValidationError(
    "E_EGA_METADATA_INVALID",
    message,
    field === undefined ? { path } : { path, field },
  );
}

function normalizeIdentifierSet(
  value: unknown,
  field: string,
  path: string,
): string[] {
  if (!Array.isArray(value)) {
    throw metadataError(
      `ega.yaml ${field} must be an array of identifier strings.`,
      path,
      field,
    );
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw metadataError(
        `ega.yaml ${field} entries must be strings.`,
        path,
        field,
      );
    }
    const canonical = asciiLowercase(trimAsciiWhitespace(entry));
    if (!ROUTING_IDENTIFIER_RE.test(canonical)) {
      throw metadataError(
        `ega.yaml ${field} entry ${JSON.stringify(entry)} is not a valid routing identifier.`,
        path,
        field,
      );
    }
    normalized.push(canonical);
  }
  return sortUtf16([...new Set(normalized)]);
}

function normalizeTriggerText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function normalizeTriggerSet(
  value: unknown,
  field: string,
  path: string,
): string[] {
  if (!Array.isArray(value)) {
    throw metadataError(
      `ega.yaml ${field} must be an array of strings.`,
      path,
      field,
    );
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw metadataError(
        `ega.yaml ${field} entries must be strings.`,
        path,
        field,
      );
    }
    normalized.push(normalizeTriggerText(entry));
  }
  return sortUtf16([...new Set(normalized)]);
}

export interface ParseEgaMetadataOptions {
  readonly path?: string;
}

export function parseEgaMetadata(
  bytes: Uint8Array | undefined,
  options: ParseEgaMetadataOptions = {},
): EgaRoutingMetadata {
  if (bytes === undefined) {
    return {
      domains: [],
      platforms: [],
      frameworks: [],
      aliases: [],
      triggers: [],
      antiTriggers: [],
    };
  }
  const path = options.path ?? "ega.yaml";
  // SPEC-001 §5.1.2 ordering: encoding errors surface as E_CONTROL_FILE_ENCODING.
  const text = decodeControlFile(bytes, path);

  let parsed: unknown;
  try {
    parsed = parseYaml(text, { uniqueKeys: true });
  } catch {
    throw metadataError("ega.yaml could not be parsed as a YAML mapping.", path);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw metadataError("ega.yaml must declare schema_version: 1.", path, "schema_version");
  }
  const record = parsed as Record<string, unknown>;
  if (record["schema_version"] !== 1) {
    throw metadataError("ega.yaml must declare schema_version: 1.", path, "schema_version");
  }
  for (const key of Object.keys(record)) {
    if (!EGA_YAML_KEYS.has(key)) {
      throw metadataError(
        `ega.yaml key ${JSON.stringify(key)} is not supported in V1.`,
        path,
        key,
      );
    }
  }

  return {
    domains:
      record["domains"] === undefined
        ? []
        : normalizeIdentifierSet(record["domains"], "domains", path),
    platforms:
      record["platforms"] === undefined
        ? []
        : normalizeIdentifierSet(record["platforms"], "platforms", path),
    frameworks:
      record["frameworks"] === undefined
        ? []
        : normalizeIdentifierSet(record["frameworks"], "frameworks", path),
    aliases:
      record["aliases"] === undefined
        ? []
        : normalizeIdentifierSet(record["aliases"], "aliases", path),
    triggers:
      record["triggers"] === undefined
        ? []
        : normalizeTriggerSet(record["triggers"], "triggers", path),
    antiTriggers:
      record["anti_triggers"] === undefined
        ? []
        : normalizeTriggerSet(record["anti_triggers"], "anti_triggers", path),
  };
}

// SPEC-001 §5.1.11 alias collision contract (EGA-555).
// Pure and side-effect-free: the registry passes the existing alias owner
// map in; this helper never persists anything. Existing-owner keys MUST be
// canonical (already-normalized) aliases mapping to canonical skill IDs.

export function assertAliasClaimsAvailable(
  claims: readonly string[],
  canonicalId: string,
  existingOwners: ReadonlyMap<string, string>,
): string[] {
  parseCanonicalSkillId(canonicalId);
  if (!Array.isArray(claims)) {
    throw metadataError("ega.yaml aliases must be an array of identifier strings.", "ega.yaml", "aliases");
  }
  const normalized: string[] = [];
  for (const entry of claims) {
    if (typeof entry !== "string") {
      throw metadataError("ega.yaml aliases entries must be strings.", "ega.yaml", "aliases");
    }
    const canonical = asciiLowercase(trimAsciiWhitespace(entry));
    if (!ROUTING_IDENTIFIER_RE.test(canonical)) {
      throw metadataError(
        `ega.yaml aliases entry ${JSON.stringify(entry)} is not a valid routing identifier.`,
        "ega.yaml",
        "aliases",
      );
    }
    normalized.push(canonical);
  }
  const ordered = sortUtf16([...new Set(normalized)]);
  for (const alias of ordered) {
    const owner = existingOwners.get(alias);
    if (owner !== undefined && owner !== canonicalId) {
      throw new SchemaValidationError(
        "E_ALIAS_CONFLICT",
        `Alias ${JSON.stringify(alias)} is already owned by ${JSON.stringify(owner)} and cannot map to ${JSON.stringify(canonicalId)}.`,
        { field: "aliases" },
      );
    }
  }
  return ordered;
}

// SPEC-001 §5.1.7, §5.1.13–§5.1.14 content levels and package content (EGA-556).
// Progressive disclosure is modeled, never generated: no L1 synthesis, no
// reference loading, no script execution. Size classification is derived
// metadata and never affects content identity.

export const L0_TARGET_MAX_TOKENS = 250;
export const L1_TARGET_MIN_TOKENS = 500;
export const L1_TARGET_MAX_TOKENS = 2000;
export const L1_HARD_MAX_TOKENS = 4000;
export const L2_NORMAL_MAX_TOKENS = 5000;
export const L2_LARGE_MAX_TOKENS = 12000;

export type L1Status = "AUTHORED" | "MISSING";
export type L2SizeClass = "NORMAL" | "LARGE" | "OVERSIZED";

export function resolveL1Status(
  skillCoreMd: Uint8Array | undefined,
  options: ParseEgaMetadataOptions = {},
): L1Status {
  if (skillCoreMd === undefined) {
    return "MISSING";
  }
  // Present core text must still pass control-file encoding; content itself
  // is the exact canonical L1 text (no transform, no generation).
  decodeControlFile(skillCoreMd, options.path ?? "SKILL.core.md");
  return "AUTHORED";
}

export function assertL1TokenBudget(l1Tokens: number): void {
  if (l1Tokens > L1_HARD_MAX_TOKENS) {
    throw new SchemaValidationError(
      "E_L1_TOO_LARGE",
      `Authored L1 of ${l1Tokens} ega-o200k-v1 tokens exceeds the 4000-token hard maximum; import with l1Status MISSING while a valid L2 remains.`,
      { field: "SKILL.core.md" },
    );
  }
}

export function classifyL2SizeClass(l2Tokens: number): L2SizeClass {
  if (l2Tokens <= L2_NORMAL_MAX_TOKENS) {
    return "NORMAL";
  }
  if (l2Tokens <= L2_LARGE_MAX_TOKENS) {
    return "LARGE";
  }
  return "OVERSIZED";
}

export interface PackageContentSummary {
  readonly referenceCount: number;
  readonly hasScripts: boolean;
  readonly hasAssets: boolean;
}

function normalizePackagePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function summarizePackageContent(
  paths: readonly string[],
): PackageContentSummary {
  let referenceCount = 0;
  let hasScripts = false;
  let hasAssets = false;
  for (const raw of paths) {
    const path = normalizePackagePath(raw);
    if (path.startsWith("references/") && path.length > "references/".length) {
      referenceCount += 1;
    } else if (path.startsWith("scripts/") && path.length > "scripts/".length) {
      hasScripts = true;
    } else if (path.startsWith("assets/") && path.length > "assets/".length) {
      hasAssets = true;
    }
  }
  return { referenceCount, hasScripts, hasAssets };
}

export interface L0DiscoveryMetadata {
  readonly canonicalId: string;
  readonly l1Status: L1Status;
  readonly l1Tokens: number | null;
  readonly l2Tokens: number | null;
  readonly sizeClass: L2SizeClass;
  readonly domains: readonly string[];
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly aliases: readonly string[];
  readonly triggers: readonly string[];
  readonly antiTriggers: readonly string[];
  readonly referenceCount: number;
  readonly hasScripts: boolean;
  readonly hasAssets: boolean;
}

export interface BuildL0MetadataInput {
  readonly canonicalId: string;
  readonly l1Status: L1Status;
  readonly l1Tokens: number | null;
  readonly l2Tokens: number | null;
  readonly sizeClass: L2SizeClass;
  readonly routing: EgaRoutingMetadata;
  readonly referenceCount: number;
  readonly hasScripts: boolean;
  readonly hasAssets: boolean;
}

export function buildL0Metadata(input: BuildL0MetadataInput): L0DiscoveryMetadata {
  return Object.freeze({
    canonicalId: input.canonicalId,
    l1Status: input.l1Status,
    l1Tokens: input.l1Tokens,
    l2Tokens: input.l2Tokens,
    sizeClass: input.sizeClass,
    domains: Object.freeze([...input.routing.domains]),
    platforms: Object.freeze([...input.routing.platforms]),
    frameworks: Object.freeze([...input.routing.frameworks]),
    aliases: Object.freeze([...input.routing.aliases]),
    triggers: Object.freeze([...input.routing.triggers]),
    antiTriggers: Object.freeze([...input.routing.antiTriggers]),
    referenceCount: input.referenceCount,
    hasScripts: input.hasScripts,
    hasAssets: input.hasAssets,
  });
}
