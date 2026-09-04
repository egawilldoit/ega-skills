import { parseDocument } from "yaml";
import { z } from "zod";

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
const ASCII_OUTER_WHITESPACE_START = /^[\t\n\v\f\r ]+/;
const ASCII_OUTER_WHITESPACE_END = /[\t\n\v\f\r ]+$/;

const egaMetadataV1Schema = z
  .object({
    schema_version: z.literal(1),
    domains: z.array(z.string()).optional(),
    platforms: z.array(z.string()).optional(),
    frameworks: z.array(z.string()).optional(),
    aliases: z.array(z.string()).optional(),
    triggers: z.array(z.string()).optional(),
    anti_triggers: z.array(z.string()).optional(),
  })
  .strict();

type EgaMetadataV1 = z.infer<typeof egaMetadataV1Schema>;

export interface NormalizedEgaRoutingMetadata {
  readonly domains: readonly string[];
  readonly platforms: readonly string[];
  readonly frameworks: readonly string[];
  readonly aliases: readonly string[];
  readonly triggers: readonly string[];
  readonly antiTriggers: readonly string[];
}

export interface ParseEgaMetadataOptions {
  readonly path?: string;
}

const EMPTY_STRING_LIST: readonly string[] = Object.freeze([]);

export const EMPTY_EGA_ROUTING_METADATA: NormalizedEgaRoutingMetadata = Object.freeze({
  domains: EMPTY_STRING_LIST,
  platforms: EMPTY_STRING_LIST,
  frameworks: EMPTY_STRING_LIST,
  aliases: EMPTY_STRING_LIST,
  triggers: EMPTY_STRING_LIST,
  antiTriggers: EMPTY_STRING_LIST,
});

export class EgaMetadataValidationError extends Error {
  readonly code = "E_EGA_METADATA_INVALID" as const;
  readonly path: string;
  readonly field: string | undefined;

  constructor(message: string, path: string, field?: string) {
    super(message);
    this.name = "EgaMetadataValidationError";
    this.path = path;
    this.field = field;
  }
}

function metadataError(path: string, field?: string): EgaMetadataValidationError {
  const detail = field === undefined ? "" : ` field \"${field}\"`;
  return new EgaMetadataValidationError(`Invalid ega.yaml metadata${detail}.`, path, field);
}

function yamlError(path: string): EgaMetadataValidationError {
  return new EgaMetadataValidationError("Invalid ega.yaml YAML syntax.", path);
}

function firstZodField(error: z.ZodError): string | undefined {
  const issue = error.issues[0];
  if (issue === undefined) return undefined;

  const [firstPathSegment] = issue.path;
  if (typeof firstPathSegment === "string") return firstPathSegment;
  if (typeof firstPathSegment === "number") return String(firstPathSegment);

  if (issue.code === "unrecognized_keys") return issue.keys[0];
  return undefined;
}

function trimAsciiOuterWhitespace(value: string): string {
  return value
    .replace(ASCII_OUTER_WHITESPACE_START, "")
    .replace(ASCII_OUTER_WHITESPACE_END, "");
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20),
  );
}

function compareUtf16Ascending(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function dedupeAndSort(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf16Ascending);
}

function normalizeIdentifierSet(
  values: readonly string[] | undefined,
  field: "domains" | "platforms" | "frameworks" | "aliases",
  path: string,
): string[] {
  if (values === undefined) return [];

  const normalized = values.map((value) =>
    asciiLowercase(trimAsciiOuterWhitespace(value)),
  );

  for (const value of normalized) {
    if (!IDENTIFIER_PATTERN.test(value)) throw metadataError(path, field);
  }

  return dedupeAndSort(normalized);
}

function normalizeNaturalLanguageSet(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];

  return dedupeAndSort(
    values.map((value) => value.replace(/\r\n?/g, "\n").trim()),
  );
}

function normalizeParsedMetadata(
  metadata: EgaMetadataV1,
  path: string,
): NormalizedEgaRoutingMetadata {
  return {
    domains: normalizeIdentifierSet(metadata.domains, "domains", path),
    platforms: normalizeIdentifierSet(metadata.platforms, "platforms", path),
    frameworks: normalizeIdentifierSet(metadata.frameworks, "frameworks", path),
    aliases: normalizeIdentifierSet(metadata.aliases, "aliases", path),
    triggers: normalizeNaturalLanguageSet(metadata.triggers),
    antiTriggers: normalizeNaturalLanguageSet(metadata.anti_triggers),
  };
}

export function parseEgaMetadata(
  source: string | undefined,
  options: ParseEgaMetadataOptions = {},
): NormalizedEgaRoutingMetadata {
  if (source === undefined) return EMPTY_EGA_ROUTING_METADATA;

  const path = options.path ?? "ega.yaml";
  let yamlValue: unknown;

  try {
    const document = parseDocument(source, {
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    });

    if (document.errors.length > 0) throw yamlError(path);
    yamlValue = document.toJS();
  } catch (error) {
    if (error instanceof EgaMetadataValidationError) throw error;
    throw yamlError(path);
  }

  const result = egaMetadataV1Schema.safeParse(yamlValue);
  if (!result.success) throw metadataError(path, firstZodField(result.error));

  return normalizeParsedMetadata(result.data, path);
}
