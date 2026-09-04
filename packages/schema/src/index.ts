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
  | "E_SKILL_REFERENCE_AMBIGUOUS";

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
