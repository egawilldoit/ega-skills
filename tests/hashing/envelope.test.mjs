import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEnvelope,
  digestArtifactPreimage,
  verifyEnvelope,
} from "../../packages/hashing/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// ISOLATION RULE: see tests/hub/source-schemas.test.mjs — vendored copies,
// never scripts/contracts/examples (mutated by contract tests concurrently).
const FIXTURES = join(HERE, "fixtures");

test("frozen vectors: digestArtifactPreimage is stable (JCS/SHA-256)", () => {
  assert.equal(
    digestArtifactPreimage({ object_type: "ega.test-vector", payload: { a: "x", b: [2, 1] }, schema_version: 1 }),
    "sha256:68c68c950b1cac336008dcecb63d6976a541a9fd653ef8bb5492a12e1c280973",
  );
  assert.equal(
    digestArtifactPreimage({ object_type: "ega.test-vector", payload: {}, schema_version: 1 }),
    "sha256:73198997afc205ae0676d69984df4e6f2f74e1294a0028f7f7cb29d89db47fd3",
  );
  assert.equal(
    digestArtifactPreimage({
      object_type: "ega.test-vector",
      payload: { emoji: "こんにちは世界", empty: "" },
      schema_version: 1,
    }),
    "sha256:0a804061bfc175248b854af457dbb0ba23f58962e81959eb5715e80687a9c27c",
  );
});

test("round trip: createEnvelope verifies", () => {
  const doc = createEnvelope({ object_type: "ega.test-vector", payload: { a: "x" }, schema_version: 1 });
  assert.equal(doc.digest, digestArtifactPreimage({ object_type: "ega.test-vector", payload: { a: "x" }, schema_version: 1 }));
  const res = verifyEnvelope(doc);
  assert.equal(res.ok, true);
});

test("frozen Contract B UpdatePlan verifies through the runtime module", () => {
  const doc = JSON.parse(readFileSync(join(FIXTURES, "update-plan.json"), "utf8"));
  const res = verifyEnvelope(doc);
  assert.equal(res.ok, true);
  assert.equal(doc.digest, "sha256:9d8ee63a3ca988aee71f914c658050f1827edd9a98968c8489332c5283a07f2f");
});

test("frozen Contract C HubRelease verifies through the runtime module", () => {
  const doc = JSON.parse(readFileSync(join(FIXTURES, "hub-release.json"), "utf8"));
  const res = verifyEnvelope(doc);
  assert.equal(res.ok, true);
  assert.equal(doc.digest, "sha256:d3838fdcc7c16a5460f2ff381b3ac36df35a62733b053765fbb813074450e649");
});

test("tampered payload fails E_ARTIFACT_DIGEST", () => {
  const doc = createEnvelope({ object_type: "ega.test-vector", payload: { a: "x" }, schema_version: 1 });
  const res = verifyEnvelope({ ...doc, payload: { a: "y" } });
  assert.equal(res.ok, false);
  assert.equal(res.code, "E_ARTIFACT_DIGEST");
});

test("unknown envelope field fails E_ARTIFACT_SCHEMA", () => {
  const doc = createEnvelope({ object_type: "ega.test-vector", payload: {}, schema_version: 1 });
  const res = verifyEnvelope({ ...doc, bogus: true });
  assert.equal(res.ok, false);
  assert.equal(res.code, "E_ARTIFACT_SCHEMA");
});

test("malformed envelopes fail E_ARTIFACT_SCHEMA", () => {
  for (const bad of [null, 42, "x", [], {}, { object_type: "ega.t", schema_version: 1, payload: {} }]) {
    const res = verifyEnvelope(bad);
    assert.equal(res.ok, false, `expected failure for ${JSON.stringify(bad)}`);
    assert.equal(res.code, "E_ARTIFACT_SCHEMA");
  }
  const noPreimage = verifyEnvelope({ object_type: "ega.t", schema_version: 1, payload: undefined, digest: "sha256:0" });
  assert.equal(noPreimage.ok, false);
});

test("non-IJSON payload cannot be enveloped", () => {
  assert.throws(() => createEnvelope({ object_type: "ega.t", payload: { f: () => 0 }, schema_version: 1 }));
});
