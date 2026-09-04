import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyContent } from "../../packages/hashing/dist/index.js";
import {
  SchemaValidationError,
  parsePortableSkill,
} from "../../packages/schema/dist/index.js";

const encoder = new TextEncoder();

function encode(text) {
  return encoder.encode(text);
}

function expectControlEncodingError(source) {
  assert.throws(
    () =>
      parsePortableSkill({
        directoryName: "canonical-text",
        skillMd: source,
      }),
    (error) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.code, "E_CONTROL_FILE_ENCODING");
      assert.equal(error.path, "canonical-text/SKILL.md");
      return true;
    },
  );
}

test("SPEC-001/SPEC-002 boundary: invalid UTF-8 control input is rejected, not silently accepted as binary", () => {
  const source = Uint8Array.of(0xc3, 0x28);
  assert.equal(classifyContent(source), "BINARY");
  expectControlEncodingError(source);
});

test("SPEC-001/SPEC-002 boundary: NUL-bearing control input is rejected, not silently accepted as binary", () => {
  const source = encode(
    '---\nname: canonical-text\ndescription: "valid description"\n---\nbody\0tail\n',
  );
  assert.equal(classifyContent(source), "BINARY");
  expectControlEncodingError(source);
});
