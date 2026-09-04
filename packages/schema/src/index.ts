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
  | "E_SKILL_DESCRIPTION_TOO_LARGE";

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
