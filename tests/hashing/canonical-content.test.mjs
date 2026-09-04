import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalByteSize,
  canonicalBytes,
  canonicalizeText,
  classifyContent,
} from "../../packages/hashing/dist/index.js";

const encoder = new TextEncoder();

function encode(text) {
  return encoder.encode(text);
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

test("SPEC-002: plain valid UTF-8 is TEXT and canonical bytes are unchanged", () => {
  const source = encode("Hello, café");
  assert.equal(classifyContent(source), "TEXT");
  assert.equal(canonicalizeText(source), "Hello, café");
  assert.equal(hex(canonicalBytes(source)), hex(source));
});

test("SPEC-002: CRLF, LF, and lone CR normalize exactly to LF", () => {
  const crlf = encode("one\r\ntwo\r\nthree");
  const lf = encode("one\ntwo\nthree");
  const loneCr = encode("one\rtwo\rthree");

  assert.equal(hex(canonicalBytes(crlf)), hex(lf));
  assert.equal(canonicalizeText(crlf), "one\ntwo\nthree");
  assert.equal(canonicalizeText(loneCr), "one\ntwo\nthree");
});

test("SPEC-002: one leading UTF-8 BOM is removed before line-ending normalization", () => {
  const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
  const plain = encode("one\ntwo");
  const bomOnly = Uint8Array.from([...bom, ...plain]);
  const bomCrlf = Uint8Array.from([...bom, ...encode("one\r\ntwo")]);
  const doubleBom = Uint8Array.from([...bom, ...bom, ...encode("x")]);

  assert.equal(hex(canonicalBytes(bomOnly)), hex(plain));
  assert.equal(hex(canonicalBytes(bomCrlf)), hex(plain));
  assert.equal(canonicalizeText(doubleBom), "\ufeffx");
});

test("SPEC-002: Unicode source form is preserved without NFC/NFD normalization", () => {
  const nfc = encode("café");
  const nfd = encode("cafe\u0301");

  assert.equal(canonicalizeText(nfc), "café");
  assert.equal(canonicalizeText(nfd), "cafe\u0301");
  assert.notEqual(hex(canonicalBytes(nfc)), hex(canonicalBytes(nfd)));
});

test("SPEC-002: trailing whitespace and final-newline presence remain significant", () => {
  const trailingSpaces = encode("value  ");
  const noFinalNewline = encode("value");
  const finalNewline = encode("value\n");

  assert.equal(canonicalizeText(trailingSpaces), "value  ");
  assert.equal(hex(canonicalBytes(trailingSpaces)), hex(trailingSpaces));
  assert.notEqual(hex(canonicalBytes(noFinalNewline)), hex(canonicalBytes(finalNewline)));
});

test("SPEC-002: NUL and invalid UTF-8 are BINARY regardless of extension assumptions", () => {
  const nul = Uint8Array.of(0x61, 0x00, 0x62);
  const invalidUtf8 = Uint8Array.of(0xc3, 0x28);

  assert.equal(classifyContent(nul), "BINARY");
  assert.equal(classifyContent(invalidUtf8), "BINARY");
});

test("SPEC-002: arbitrary binary bytes are preserved byte-for-byte", () => {
  const source = Uint8Array.of(0xff, 0x80, 0x00, 0x0d, 0x0a, 0x7f);
  const before = Uint8Array.from(source);
  const canonical = canonicalBytes(source);

  assert.equal(classifyContent(source), "BINARY");
  assert.deepEqual(canonical, before);
  assert.deepEqual(source, before);
  assert.notEqual(canonical, source);
});

test("SPEC-002: canonical byte size uses normalized text bytes and exact binary bytes", () => {
  const text = Uint8Array.of(
    0xef,
    0xbb,
    0xbf,
    ...encode("a\r\nb\r"),
  );
  const binary = Uint8Array.of(0xff, 0x00, 0x0d, 0x0a);

  assert.equal(text.byteLength, 8);
  assert.equal(canonicalizeText(text), "a\nb\n");
  assert.equal(canonicalByteSize(text), 4);
  assert.equal(canonicalByteSize(binary), binary.byteLength);
});

test("SPEC-002: Buffer inputs follow the same Uint8Array byte contract", () => {
  const source = Buffer.from("a\r\nb", "utf8");
  assert.equal(classifyContent(source), "TEXT");
  assert.equal(canonicalizeText(source), "a\nb");
});
