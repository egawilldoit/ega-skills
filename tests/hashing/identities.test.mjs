import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hashing = await import("../../packages/hashing/dist/index.js");

const {
  HashIdentityError,
  buildCanonicalSkillVersionManifest,
  canonicalizeJson,
  hashBlobBytes,
  hashCanonicalManifest,
} = hashing;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const decoder = new TextDecoder();

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function expectHashError(fn, code) {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.ok(error instanceof HashIdentityError);
    assert.equal(error.code, code);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 0);
  }
}

function manifestWith(overrides = {}) {
  return buildCanonicalSkillVersionManifest({
    skillId: "ega/frontend-design",
    portable: { name: "frontend-design", description: "Build interfaces." },
    routing: {
      domains: ["web"],
      platforms: [],
      frameworks: [],
      triggers: [],
      antiTriggers: [],
      aliases: [],
    },
    files: [
      {
        path: "SKILL.md",
        role: "skill-body",
        blob_hash: hashBlobBytes(new TextEncoder().encode("# Skill\n")),
        byte_size: 8,
        content_kind: "TEXT",
      },
    ],
    ...overrides,
  });
}

test("SPEC-002 §5.1.1: canonicalize@4.0.0 is the normative JCS implementation", () => {
  const pkg = JSON.parse(
    readFileSync(join(root, "packages", "hashing", "package.json"), "utf8"),
  );
  assert.equal(pkg.dependencies?.canonicalize, "4.0.0");
  const installed = JSON.parse(
    readFileSync(
      join(root, "packages", "hashing", "node_modules", "canonicalize", "package.json"),
      "utf8",
    ),
  );
  assert.equal(installed.version, "4.0.0");
  assert.equal(typeof canonicalizeJson, "function");
});

test("SPEC-002 §5.1.14: JCS key ordering, nesting and whitespace behavior", () => {
  assert.equal(decoder.decode(canonicalizeJson({ b: 1, a: 2 })), '{"a":2,"b":1}');
  assert.equal(
    decoder.decode(canonicalizeJson({ z: [3, 2, 1], a: { d: 4, c: 3 } })),
    '{"a":{"c":3,"d":4},"z":[3,2,1]}',
  );
  // Arrays keep order; objects sort; no insignificant whitespace.
  const out = decoder.decode(canonicalizeJson({ b: [2, 1], a: 1 }));
  assert.equal(out, '{"a":1,"b":[2,1]}');
  assert.ok(!out.includes(" "));
});

test("SPEC-002 §5.1.14: JCS unicode and number behavior", () => {
  assert.equal(decoder.decode(canonicalizeJson({ é: "ü" })), '{"é":"ü"}');
  assert.equal(decoder.decode(canonicalizeJson({ n: 1.1 })), '{"n":1.1}');
  assert.equal(decoder.decode(canonicalizeJson({ n: -0 })), '{"n":0}');
  assert.equal(
    decoder.decode(canonicalizeJson({ s: 'quote"back\\slash' })),
    '{"s":"quote\\"back\\\\slash"}',
  );
});

test("SPEC-002 §5.1.1: blob hash is lowercase sha256:<64 hex>", () => {
  const bytes = new TextEncoder().encode("hello");
  assert.equal(hashBlobBytes(bytes), sha256(bytes));
  assert.match(hashBlobBytes(bytes), /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashBlobBytes(new Uint8Array(0)), sha256(new Uint8Array(0)));
});

test("SPEC-002 §5.1.3: version hash is SHA256 of JCS UTF-8 manifest", () => {
  const manifest = manifestWith();
  const expected = sha256(canonicalizeJson(manifest));
  assert.equal(hashCanonicalManifest(manifest), expected);
  assert.match(hashCanonicalManifest(manifest), /^sha256:[0-9a-f]{64}$/);
});

test("SPEC-002 §5.1.3: version hash changes on semantic content change", () => {
  const a = manifestWith();
  const b = manifestWith({
    routing: {
      domains: ["api"],
      platforms: [],
      frameworks: [],
      triggers: [],
      antiTriggers: [],
      aliases: [],
    },
  });
  assert.notEqual(hashCanonicalManifest(a), hashCanonicalManifest(b));
});

test("SPEC-002 §5.1.3: deterministic for identical canonical input", () => {
  const a = manifestWith();
  const b = manifestWith();
  assert.equal(hashCanonicalManifest(a), hashCanonicalManifest(b));
  assert.equal(
    decoder.decode(canonicalizeJson(a)),
    decoder.decode(canonicalizeJson(b)),
  );
});

test("SPEC-002 §5.1.3: non-I-JSON values map to E_HASH_IJSON", () => {
  expectHashError(() => hashCanonicalManifest({ a: NaN }), "E_HASH_IJSON");
  expectHashError(() => hashCanonicalManifest({ a: Infinity }), "E_HASH_IJSON");
  expectHashError(() => hashCanonicalManifest({ a: undefined }), "E_HASH_IJSON");
  expectHashError(
    () => hashCanonicalManifest({ a: () => 1 }),
    "E_HASH_IJSON",
  );
  expectHashError(() => hashCanonicalManifest({ a: 1n }), "E_HASH_IJSON");
});

test("SPEC-002 §5.1.3: canonical-JSON structural failures map to E_HASH_CANONICAL_JSON", () => {
  const circular = {};
  circular.self = circular;
  expectHashError(() => hashCanonicalManifest(circular), "E_HASH_CANONICAL_JSON");
  expectHashError(() => hashCanonicalManifest(undefined), "E_HASH_IJSON");
});
