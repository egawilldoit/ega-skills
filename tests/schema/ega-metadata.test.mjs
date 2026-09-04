import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_EGA_ROUTING_METADATA,
  SchemaValidationError,
  parseEgaMetadata,
} from "../../packages/schema/dist/index.js";

const encoder = new TextEncoder();

const EMPTY = {
  domains: [],
  platforms: [],
  frameworks: [],
  aliases: [],
  triggers: [],
  antiTriggers: [],
};

function encode(text) {
  return encoder.encode(text);
}

function parse(source, path = "ega.yaml") {
  return parseEgaMetadata(encode(source), { path });
}

function captureInvalid(source, path = "ega.yaml") {
  try {
    parse(source, path);
    assert.fail("expected ega.yaml validation to fail");
  } catch (error) {
    return error;
  }
}

function expectMetadataError(error, { path = "ega.yaml", field } = {}) {
  assert.ok(error instanceof SchemaValidationError);
  assert.equal(error.code, "E_EGA_METADATA_INVALID");
  assert.equal(typeof error.message, "string");
  assert.ok(error.message.length > 0);
  assert.equal(error.path, path);
  if (field !== undefined) assert.equal(error.field, field);
}

test("SPEC-001: schema exposes the pure ega.yaml normalization API", () => {
  assert.equal(typeof parseEgaMetadata, "function");
  assert.deepEqual(EMPTY_EGA_ROUTING_METADATA, EMPTY);
});

test("SPEC-001: missing ega.yaml is valid and returns frozen empty routing metadata", () => {
  assert.deepEqual(parseEgaMetadata(undefined), EMPTY);
});

test("SPEC-001: schema_version 1 is valid", () => {
  assert.deepEqual(parse("schema_version: 1\n"), EMPTY);
});

test("SPEC-001: missing, non-numeric, and unsupported schema versions are rejected", () => {
  for (const source of [
    "domains: [web]\n",
    'schema_version: "1"\n',
    "schema_version: 2\n",
  ]) {
    expectMetadataError(captureInvalid(source), { field: "schema_version" });
  }
});

test("SPEC-001: unknown semantic keys are rejected", () => {
  const error = captureInvalid("schema_version: 1\nfuture_field: true\n");
  expectMetadataError(error, { field: "future_field" });
});

test("SPEC-001: malformed and duplicate-key YAML map to E_EGA_METADATA_INVALID", () => {
  for (const source of [
    "schema_version: 1\ndomains: [web\n",
    "schema_version: 1\nschema_version: 1\n",
  ]) {
    const error = captureInvalid(source, "skills/demo/ega.yaml");
    expectMetadataError(error, { path: "skills/demo/ega.yaml" });
    assert.notEqual(error.name, "YAMLParseError");
  }
});

test("SPEC-001: control-file encoding errors remain the parent E_CONTROL_FILE_ENCODING contract", () => {
  assert.throws(
    () => parseEgaMetadata(Uint8Array.of(0xff), { path: "skills/demo/ega.yaml" }),
    (error) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.code, "E_CONTROL_FILE_ENCODING");
      assert.equal(error.path, "skills/demo/ega.yaml");
      return true;
    },
  );
});

test("SPEC-001: identifier fields must be arrays of strings", () => {
  for (const [field, value] of [
    ["domains", "web"],
    ["platforms", "42"],
    ["frameworks", "{ angular: true }"],
    ["aliases", "null"],
  ]) {
    const error = captureInvalid(`schema_version: 1\n${field}: ${value}\n`);
    expectMetadataError(error, { field });
  }
});

test("SPEC-001: Web/web/WEB deduplicate to canonical web", () => {
  assert.deepEqual(
    parse("schema_version: 1\ndomains: [Web, web, WEB]\n").domains,
    ["web"],
  );
});

test("SPEC-001: identifier sets trim ASCII outer whitespace and ASCII-lowercase", () => {
  const normalized = parse([
    "schema_version: 1",
    "domains:",
    '  - "  Web\\t"',
    "platforms:",
    '  - "\\r Windows \\n"',
    "frameworks:",
    '  - " Angular  "',
    "aliases:",
    '  - "  MY.ALIAS  "',
    "",
  ].join("\n"));

  assert.deepEqual(normalized.domains, ["web"]);
  assert.deepEqual(normalized.platforms, ["windows"]);
  assert.deepEqual(normalized.frameworks, ["angular"]);
  assert.deepEqual(normalized.aliases, ["my.alias"]);
});

test("SPEC-001: valid identifier punctuation is preserved", () => {
  const normalized = parse([
    "schema_version: 1",
    "frameworks: [C++, c+, my.company, personal_v1, node-js]",
    "",
  ].join("\n"));

  assert.deepEqual(normalized.frameworks, [
    "c+",
    "c++",
    "my.company",
    "node-js",
    "personal_v1",
  ]);
});

test("SPEC-001: invalid identifier punctuation is rejected rather than stripped", () => {
  for (const value of ["c#", "+cpp", ".web", "_web", "-web", "web/path", "wéB"]) {
    const error = captureInvalid(`schema_version: 1\nframeworks: ["${value}"]\n`);
    expectMetadataError(error, { field: "frameworks" });
  }
});

test("SPEC-001: identifier trimming is ASCII-only", () => {
  const error = captureInvalid('schema_version: 1\ndomains: ["\\u00a0web\\u00a0"]\n');
  expectMetadataError(error, { field: "domains" });
});

test("SPEC-001: identifier boundary accepts 64 characters and rejects 65", () => {
  const valid = `a${"b".repeat(63)}`;
  const invalid = `a${"b".repeat(64)}`;

  assert.deepEqual(parse(`schema_version: 1\naliases: [${valid}]\n`).aliases, [valid]);
  expectMetadataError(captureInvalid(`schema_version: 1\naliases: [${invalid}]\n`), {
    field: "aliases",
  });
});

test("SPEC-001: domains normalize deterministically in UTF-16 code-unit order", () => {
  assert.deepEqual(
    parse("schema_version: 1\ndomains: [zeta, a_beta, a.beta, a-beta, a+beta]\n").domains,
    ["a+beta", "a-beta", "a.beta", "a_beta", "zeta"],
  );
});

test("SPEC-001: platforms normalize deterministically", () => {
  assert.deepEqual(
    parse("schema_version: 1\nplatforms: [Windows, linux, WINDOWS, android]\n").platforms,
    ["android", "linux", "windows"],
  );
});

test("SPEC-001: frameworks normalize deterministically", () => {
  assert.deepEqual(
    parse("schema_version: 1\nframeworks: [React, angular, REACT, vue.js]\n").frameworks,
    ["angular", "react", "vue.js"],
  );
});

test("SPEC-001: aliases normalize deterministically", () => {
  assert.deepEqual(
    parse("schema_version: 1\naliases: [Zed, alpha, ALPHA, my.alias]\n").aliases,
    ["alpha", "my.alias", "zed"],
  );
});

test("SPEC-001: triggers preserve Unicode and do not normalize NFC/NFD", () => {
  const composed = "Café";
  const decomposed = "Cafe\u0301";
  const normalized = parse([
    "schema_version: 1",
    "triggers:",
    `  - "${composed}"`,
    `  - "${decomposed}"`,
    '  - "日本語 Δ"',
    "",
  ].join("\n"));

  assert.equal(normalized.triggers.includes(composed), true);
  assert.equal(normalized.triggers.includes(decomposed), true);
  assert.equal(normalized.triggers.includes("日本語 Δ"), true);
  assert.equal(normalized.triggers.length, 3);
});

test("SPEC-001: trigger case is preserved and case-distinct strings stay distinct", () => {
  const normalized = parse(
    'schema_version: 1\ntriggers: ["Web API", "web api", "Web API"]\n',
  );
  assert.deepEqual(normalized.triggers, ["Web API", "web api"]);
});

test("SPEC-001: trigger CRLF and lone CR normalize to LF", () => {
  const normalized = parse([
    "schema_version: 1",
    "triggers:",
    '  - "Line1\\r\\nLine2\\rLine3"',
    "",
  ].join("\n"));

  assert.deepEqual(normalized.triggers, ["Line1\nLine2\nLine3"]);
});

test("SPEC-001: trigger outer whitespace trims without collapsing internal whitespace", () => {
  const normalized = parse([
    "schema_version: 1",
    "triggers:",
    '  - "  Keep   Internal\\tSpacing  "',
    "",
  ].join("\n"));

  assert.deepEqual(normalized.triggers, ["Keep   Internal\tSpacing"]);
});

test("SPEC-001: duplicate canonical triggers are removed", () => {
  const normalized = parse([
    "schema_version: 1",
    "triggers:",
    '  - "  Alpha\\r\\nBeta  "',
    '  - "Alpha\\nBeta"',
    '  - "Alpha\\rBeta"',
    "",
  ].join("\n"));

  assert.deepEqual(normalized.triggers, ["Alpha\nBeta"]);
});

test("SPEC-001: anti_triggers use the same Unicode/case/line-ending/trim/dedupe/sort rules", () => {
  const normalized = parse([
    "schema_version: 1",
    "anti_triggers:",
    '  - "  Do NOT use\\r\\nhere  "',
    '  - "Do NOT use\\nhere"',
    '  - "do not use"',
    '  - "Éviter"',
    "",
  ].join("\n"));

  assert.deepEqual(normalized.antiTriggers, ["Do NOT use\nhere", "do not use", "Éviter"]);
});

test("SPEC-001: triggers and anti_triggers must be arrays of strings", () => {
  for (const [field, value] of [
    ["triggers", "deploy"],
    ["anti_triggers", "[valid, 42]"],
  ]) {
    const error = captureInvalid(`schema_version: 1\n${field}: ${value}\n`);
    expectMetadataError(error, { field });
  }
});

test("SPEC-001: order-insensitive inputs produce identical normalized routing metadata", () => {
  const a = parse([
    "schema_version: 1",
    "domains: [Web, API]",
    "platforms: [Windows, linux]",
    "frameworks: [React, C++]",
    "aliases: [Zed, alpha]",
    'triggers: ["Build API", "Deploy App"]',
    'anti_triggers: ["Legacy only", "No deploy"]',
    "",
  ].join("\n"));

  const b = parse([
    'anti_triggers: ["No deploy", "Legacy only"]',
    'triggers: ["Deploy App", "Build API"]',
    "aliases: [ALPHA, zed]",
    "frameworks: [c++, REACT]",
    "platforms: [LINUX, windows]",
    "domains: [api, WEB]",
    "schema_version: 1",
    "",
  ].join("\n"));

  assert.deepEqual(a, b);
});

test("SPEC-001: E_EGA_METADATA_INVALID preserves structured path and field details", () => {
  const error = captureInvalid(
    "schema_version: 1\nframeworks: [react, c#]\n",
    "skills/frontend/ega.yaml",
  );

  expectMetadataError(error, {
    path: "skills/frontend/ega.yaml",
    field: "frameworks",
  });
});

test("SPEC-001: ega.yaml source bytes remain unchanged after validation", () => {
  const source = encode(
    "# source formatting must remain untouched\r\nschema_version: 1\r\ndomains: [ Web, web ]\r\n",
  );
  const before = Uint8Array.from(source);

  parseEgaMetadata(source, { path: "skills/frontend/ega.yaml" });

  assert.deepEqual(source, before);
});
