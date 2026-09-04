import assert from "node:assert/strict";
import test from "node:test";

const hashing = await import("../../packages/hashing/dist/index.js");
const schema = await import("../../packages/schema/dist/index.js");

const { buildCanonicalSkillVersionManifest } = hashing;
const { parseEgaMetadata } = schema;

const encoder = new TextEncoder();
function encode(text) {
  return encoder.encode(text);
}

function baseFiles() {
  return [
    {
      path: "SKILL.md",
      role: "skill-body",
      blob_hash: "sha256:aaa",
      byte_size: 100,
      content_kind: "TEXT",
    },
    {
      path: "references/guide.md",
      role: "reference",
      blob_hash: "sha256:bbb",
      byte_size: 50,
      content_kind: "TEXT",
    },
    {
      path: "assets/logo.png",
      role: "asset",
      blob_hash: "sha256:ccc",
      byte_size: 1000,
      content_kind: "BINARY",
    },
  ];
}

function baseInput() {
  return {
    skillId: "ega/frontend-design",
    portable: { name: "frontend-design", description: "Build interfaces." },
    routing: {
      domains: ["web"],
      platforms: ["linux"],
      frameworks: ["react"],
      triggers: ["Build API"],
      antiTriggers: ["Legacy"],
      aliases: ["design"],
    },
    files: baseFiles(),
  };
}

function toRouting(normalized) {
  return {
    domains: [...normalized.domains],
    platforms: [...normalized.platforms],
    frameworks: [...normalized.frameworks],
    triggers: [...normalized.triggers],
    antiTriggers: [...normalized.antiTriggers],
    aliases: [...normalized.aliases],
  };
}

test("SPEC-002 §5.1.15: manifest uses exact snake_case wire keys", () => {
  const manifest = buildCanonicalSkillVersionManifest(baseInput());
  assert.deepEqual(Object.keys(manifest).sort(), [
    "files",
    "portable",
    "routing",
    "schema_version",
    "skill_id",
  ]);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.skill_id, "ega/frontend-design");
  assert.deepEqual(Object.keys(manifest.routing).sort(), [
    "aliases",
    "anti_triggers",
    "domains",
    "frameworks",
    "platforms",
    "triggers",
  ]);
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes("allowedTools"), "camelCase must not leak");
  assert.ok(!serialized.includes("antiTriggers"), "camelCase must not leak");
  assert.ok(!serialized.includes("skillId"), "camelCase must not leak");
  for (const record of manifest.files) {
    assert.deepEqual(Object.keys(record).sort(), [
      "blob_hash",
      "byte_size",
      "content_kind",
      "path",
      "role",
    ]);
  }
});

test("SPEC-002 §5.1.15: allowedTools maps to allowed_tools wire key", () => {
  const input = baseInput();
  input.portable.allowedTools = "Read, Bash";
  const manifest = buildCanonicalSkillVersionManifest(input);
  assert.equal(manifest.portable.allowed_tools, "Read, Bash");
  assert.ok(!Object.hasOwn(manifest.portable, "allowedTools"));
});

test("SPEC-002 §5.1.3: absent optionals are omitted, never null/undefined", () => {
  const manifest = buildCanonicalSkillVersionManifest(baseInput());
  for (const key of ["license", "compatibility", "metadata", "allowed_tools"]) {
    assert.equal(Object.hasOwn(manifest.portable, key), false);
  }
  assert.ok(!JSON.stringify(manifest).includes("null"));
  const full = buildCanonicalSkillVersionManifest({
    ...baseInput(),
    portable: {
      name: "frontend-design",
      description: "Build interfaces.",
      license: "MIT",
      compatibility: "node24",
      metadata: { team: "ega" },
      allowedTools: "Read",
    },
  });
  assert.equal(full.portable.license, "MIT");
  assert.deepEqual(full.portable.metadata, { team: "ega" });
});

test("SPEC-002 §5.1.3: no provenance/token fields enter the manifest", () => {
  const input = {
    ...baseInput(),
    provenance: { local_path: "/tmp/x" },
    tokenCounts: { l2Tokens: 10 },
    trustLevel: "OWNED",
    l0: { sizeClass: "NORMAL" },
  };
  const manifest = buildCanonicalSkillVersionManifest(input);
  const serialized = JSON.stringify(manifest);
  for (const forbidden of [
    "provenance",
    "tokenCounts",
    "token_counts",
    "trustLevel",
    "trust_level",
    "local_path",
    "source",
    "l0",
    "sizeClass",
  ]) {
    assert.ok(!serialized.includes(forbidden), `must not contain ${forbidden}`);
  }
});

test("SPEC-002 §5.1.11: all file roles/content kinds/blob hashes/byte sizes are represented", () => {
  const manifest = buildCanonicalSkillVersionManifest(baseInput());
  assert.equal(manifest.files.length, 3);
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  assert.equal(byPath.get("SKILL.md").role, "skill-body");
  assert.equal(byPath.get("SKILL.md").content_kind, "TEXT");
  assert.equal(byPath.get("SKILL.md").blob_hash, "sha256:aaa");
  assert.equal(byPath.get("SKILL.md").byte_size, 100);
  assert.equal(byPath.get("assets/logo.png").content_kind, "BINARY");
});

test("SPEC-002 §5.1.8/§5.1.15: files sort by UTF-16 path and raw ega.yaml is excluded", () => {
  const input = baseInput();
  input.files = [
    ...[...baseFiles()].reverse(),
    {
      path: "ega.yaml",
      role: "ega-metadata",
      blob_hash: "sha256:raw",
      byte_size: 20,
      content_kind: "TEXT",
    },
  ];
  const manifest = buildCanonicalSkillVersionManifest(input);
  assert.deepEqual(
    manifest.files.map((f) => f.path),
    ["SKILL.md", "assets/logo.png", "references/guide.md"],
  );
  assert.ok(!manifest.files.some((f) => f.path === "ega.yaml"));
});

test("SPEC-002 §5.1.15: routing arrays use UTF-16 canonical sort", () => {
  const input = baseInput();
  input.routing = {
    domains: ["zeta", "a_beta", "a.beta", "a-beta", "a+beta"],
    platforms: [],
    frameworks: [],
    triggers: ["b", "a"],
    antiTriggers: [],
    aliases: [],
  };
  const manifest = buildCanonicalSkillVersionManifest(input);
  assert.deepEqual(manifest.routing.domains, [
    "a+beta",
    "a-beta",
    "a.beta",
    "a_beta",
    "zeta",
  ]);
  assert.deepEqual(manifest.routing.triggers, ["a", "b"]);
});

test("SPEC-002 §5.1.15: formatting-only ega.yaml change does not alter manifest semantics", () => {
  const a = parseEgaMetadata(
    encode("# comment\nschema_version: 1\ndomains: [Web, API]\n"),
  );
  const b = parseEgaMetadata(
    encode("domains: [api, WEB] # trailing\nschema_version: 1\n"),
  );
  const ma = buildCanonicalSkillVersionManifest({
    ...baseInput(),
    routing: toRouting(a),
  });
  const mb = buildCanonicalSkillVersionManifest({
    ...baseInput(),
    routing: toRouting(b),
  });
  assert.deepEqual(ma.routing, mb.routing);
  assert.deepEqual(ma, mb);
});

test("SPEC-002 §5.1.15: routing semantic change alters the manifest", () => {
  const a = parseEgaMetadata(encode("schema_version: 1\ndomains: [web]\n"));
  const b = parseEgaMetadata(encode("schema_version: 1\ndomains: [api]\n"));
  const ma = buildCanonicalSkillVersionManifest({
    ...baseInput(),
    routing: toRouting(a),
  });
  const mb = buildCanonicalSkillVersionManifest({
    ...baseInput(),
    routing: toRouting(b),
  });
  assert.notDeepEqual(ma, mb);
  assert.notDeepEqual(ma.routing, mb.routing);
});
