import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const schema = await import("../../packages/schema/dist/index.js");
const { EMPTY_EGA_ROUTING_METADATA, parseEgaMetadata } = schema;

const EMPTY = {
  domains: [],
  platforms: [],
  frameworks: [],
  aliases: [],
  triggers: [],
  antiTriggers: [],
};

function parse(source, path = "ega.yaml") {
  return parseEgaMetadata(source, { path });
}

function captureInvalid(source, path = "ega.yaml") {
  try {
    parse(source, path);
    assert.fail("expected ega.yaml validation to fail");
  } catch (error) {
    return error;
  }
}

function assertMetadataError(error, { path = "ega.yaml", field } = {}) {
  assert.equal(error?.code, "E_EGA_METADATA_INVALID");
  assert.equal(typeof error?.message, "string");
  assert.ok(error.message.length > 0);
  assert.equal(error?.path, path);
  if (field !== undefined) assert.equal(error?.field, field);
}

test("schema exposes the pure ega.yaml normalization API", () => {
  assert.equal(typeof parseEgaMetadata, "function");
  assert.deepEqual(EMPTY_EGA_ROUTING_METADATA, EMPTY);
});

test("missing ega.yaml is valid and returns the frozen empty routing representation", () => {
  assert.deepEqual(parseEgaMetadata(undefined), EMPTY);
});

test("schema_version 1 is valid", () => {
  assert.deepEqual(parse("schema_version: 1\n"), EMPTY);
});

test("missing, non-numeric, and unsupported schema versions are rejected", () => {
  for (const source of [
    "domains: [web]\n",
    "schema_version: \"1\"\n",
    "schema_version: 2\n",
  ]) {
    assertMetadataError(captureInvalid(source), { field: "schema_version" });
  }
});

test("unknown semantic keys are rejected", () => {
  const error = captureInvalid("schema_version: 1\nfuture_field: true\n");
  assertMetadataError(error, { field: "future_field" });
});

test("malformed YAML is mapped to E_EGA_METADATA_INVALID without parser exceptions leaking", () => {
  const error = captureInvalid("schema_version: 1\ndomains: [web\n", "skills/demo/ega.yaml");
  assertMetadataError(error, { path: "skills/demo/ega.yaml" });
  assert.notEqual(error?.name, "YAMLParseError");
});

test("identifier fields must be arrays of strings", () => {
  for (const [field, value] of [
    ["domains", "web"],
    ["platforms", "42"],
    ["frameworks", "{ angular: true }"],
    ["aliases", "null"],
  ]) {
    const error = captureInvalid(`schema_version: 1\n${field}: ${value}\n`);
    assertMetadataError(error, { field });
  }
});

test("Web/web/WEB deduplicate to the canonical web identifier", () => {
  assert.deepEqual(
    parse("schema_version: 1\ndomains: [Web, web, WEB]\n").domains,
    ["web"],
  );
});

test("identifier sets trim ASCII outer whitespace and ASCII-lowercase", () => {
  const normalized = parse([
    "schema_version: 1",
    "domains:",
    "  - \"  Web\\t\"",
    "platforms:",
    "  - \"\\r Windows \\n\"",
    "frameworks:",
    "  - \" Angular  \"",
    "aliases:",
    "  - \"  MY.ALIAS  \"",
    "",
  ].join("\n"));

  assert.deepEqual(normalized.domains, ["web"]);
  assert.deepEqual(normalized.platforms, ["windows"]);
  assert.deepEqual(normalized.frameworks, ["angular"]);
  assert.deepEqual(normalized.aliases, ["my.alias"]);
});

test("identifier punctuation preserves every distinction allowed by the frozen regex", () => {
  const normalized = parse([
    "schema_version: 1",
    "frameworks: [C++, c+, my.company, personal_v1, node-js]",
    "",
  ].join("\n"));

  assert.deepEqual(normalized.frameworks, ["c+", "c++", "my.company", "node-js", "personal_v1"]);
});

test("identifier punctuation outside the frozen regex is rejected rather than stripped", () => {
  for (const value of ["c#", "+cpp", ".web", "_web", "-web", "web/path", "wéB"] ) {
    const error = captureInvalid(`schema_version: 1\nframeworks: [\"${value}\"]\n`);
    assertMetadataError(error, { field: "frameworks" });
  }
});

test("identifier trimming is ASCII-only", () => {
  const error = captureInvalid("schema_version: 1\ndomains: [\"\\u00a0web\\u00a0\"]\n");
  assertMetadataError(error, { field: "domains" });
});

test("identifier boundary accepts 64 characters and rejects 65", () => {
  const valid = `a${"b".repeat(63)}`;
  const invalid = `a${"b".repeat(64)}`;
  assert.deepEqual(parse(`schema_version: 1\naliases: [${valid}]\n`).aliases, [valid]);
  assertMetadataError(captureInvalid(`schema_version: 1\naliases: [${invalid}]\n`), {
    field: "aliases",
  });
});

test("domains normalize deterministically in UTF-16 code-unit order", () => {
  assert.deepEqual(
    parse("schema_version: 1\ndomains: [zeta, a_beta, a.beta, a-beta, a+beta]\n").domains,
    ["a+beta", "a-beta", "a.beta", "a_beta", "zeta"],
  );
});

test("platforms normalize deterministically", () => {
  assert.deepEqual(
    parse("schema_version: 1\nplatforms: [Windows, linux, WINDOWS, android]\n").platforms,
    ["android", "linux", "windows"],
  );
});

test("frameworks normalize deterministically", () => {
  assert.deepEqual(
    parse("schema_version: 1\nframeworks: [React, angular, REACT, vue.js]\n").frameworks,
    ["angular", "react", "vue.js"],
  );
});

test("aliases normalize deterministically", () => {
  assert.deepEqual(
    parse("schema_version: 1\naliases: [Zed, alpha, ALPHA, my.alias]\n").aliases,
    ["alpha", "my.alias", "zed"],
  );
});

test("triggers preserve Unicode code points and do not normalize NFC/NFD", () => {
  const composed = "Café";
  const decomposed = "Cafe\u0301";
  const normalized = parse([
    "schema_version: 1",
    "triggers:",
    `  - \"${composed}\"`,
    `  - \"${decomposed}\"`,
    "  - \"日本語 Δ\"",
    "",
  ].join("\n"));

  assert.equal(normalized.triggers.includes(composed), true);
  assert.equal(normalized.triggers.includes(decomposed), true);
  assert.equal(normalized.triggers.includes("日本語 Δ"), true);
  assert.equal(normalized.triggers.length, 3);
});

test("trigger case is preserved and case-distinct strings do not deduplicate", () => {
  const normalized = parse("schema_version: 1\ntriggers: [\"Web API\", \"web api\", \"Web API\"]\n");
  assert.deepEqual(normalized.triggers, ["Web API", "web api"]);
});

test("trigger CRLF and lone CR normalize to LF", () => {
  const normalized = parse([
    "schema_version: 1",
    "triggers:",
    "  - \"Line1\\r\\nLine2\\rLine3\"",
    "",
  ].join("\n"));
  assert.deepEqual(normalized.triggers, ["Line1\nLine2\nLine3"]);
});

test("trigger outer whitespace is trimmed without collapsing internal whitespace", () => {
  const normalized = parse([
    "schema_version: 1",
    "triggers:",
    "  - \"  Keep   Internal\\tSpacing  \"",
    "",
  ].join("\n"));
  assert.deepEqual(normalized.triggers, ["Keep   Internal\tSpacing"]);
});

test("duplicate canonical triggers are removed after line-ending and outer-whitespace normalization", () => {
  const normalized = parse([
    "schema_version: 1",
    "triggers:",
    "  - \"  Alpha\\r\\nBeta  \"",
    "  - \"Alpha\\nBeta\"",
    "  - \"Alpha\\rBeta\"",
    "",
  ].join("\n"));
  assert.deepEqual(normalized.triggers, ["Alpha\nBeta"]);
});

test("anti_triggers follow the same Unicode, case, line-ending, trim, dedupe, and sort contract", () => {
  const normalized = parse([
    "schema_version: 1",
    "anti_triggers:",
    "  - \"  Do NOT use\\r\\nhere  \"",
    "  - \"Do NOT use\\nhere\"",
    "  - \"do not use\"",
    "  - \"Éviter\"",
    "",
  ].join("\n"));

  assert.deepEqual(normalized.antiTriggers, ["Do NOT use\nhere", "do not use", "Éviter"]);
});

test("triggers and anti_triggers must be arrays of strings", () => {
  for (const [field, value] of [
    ["triggers", "deploy"],
    ["anti_triggers", "[valid, 42]"],
  ]) {
    const error = captureInvalid(`schema_version: 1\n${field}: ${value}\n`);
    assertMetadataError(error, { field });
  }
});

test("order-insensitive routing inputs produce identical normalized output", () => {
  const a = parse([
    "schema_version: 1",
    "domains: [Web, API]",
    "platforms: [Windows, linux]",
    "frameworks: [React, C++]",
    "aliases: [Zed, alpha]",
    "triggers: [\"Build API\", \"Deploy App\"]",
    "anti_triggers: [\"Legacy only\", \"No deploy\"]",
    "",
  ].join("\n"));

  const b = parse([
    "anti_triggers: [\"No deploy\", \"Legacy only\"]",
    "triggers: [\"Deploy App\", \"Build API\"]",
    "aliases: [ALPHA, zed]",
    "frameworks: [c++, REACT]",
    "platforms: [LINUX, windows]",
    "domains: [api, WEB]",
    "schema_version: 1",
    "",
  ].join("\n"));

  assert.deepEqual(a, b);
});

test("E_EGA_METADATA_INVALID preserves structured path and field details", () => {
  const error = captureInvalid(
    "schema_version: 1\nframeworks: [react, c#]\n",
    "skills/frontend/ega.yaml",
  );
  assertMetadataError(error, {
    path: "skills/frontend/ega.yaml",
    field: "frameworks",
  });
});

test("validation never rewrites source bytes on disk", () => {
  const directory = mkdtempSync(join(tmpdir(), "ega-554-"));
  const path = join(directory, "ega.yaml");
  const source = Buffer.from(
    "# source formatting must remain untouched\r\nschema_version: 1\r\ndomains: [ Web, web ]\r\n",
    "utf8",
  );

  try {
    writeFileSync(path, source);
    const before = readFileSync(path);
    parse(before.toString("utf8"), path);
    const after = readFileSync(path);
    assert.deepEqual(after, before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
