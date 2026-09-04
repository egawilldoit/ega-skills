import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hashing = await import("../../packages/hashing/dist/index.js");
const schema = await import("../../packages/schema/dist/index.js");

const {
  SKILL_VERSION_HASH_SCHEMA_VERSION,
  buildCanonicalSkillVersionManifest,
  canonicalByteSize,
  canonicalBytes,
  classifyContent,
  hashBlobBytes,
  hashCanonicalManifest,
} = hashing;
const { parseEgaMetadata, tokenEstimator } = schema;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vectors = JSON.parse(
  readFileSync(join(root, "fixtures", "hashes", "vectors.json"), "utf8"),
);
const encoder = new TextEncoder();
const encode = (text) => encoder.encode(text);

function hasCode(code) {
  return (error) => error instanceof Error && error.code === code;
}

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "ega-563-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function analyzeFile(file) {
  const bytes = await file.read();
  const kind = classifyContent(bytes);
  const canonical = kind === "TEXT" ? canonicalBytes(bytes) : bytes;
  return {
    role: "other",
    blob_hash: hashBlobBytes(canonical),
    byte_size: kind === "TEXT" ? canonicalByteSize(bytes) : bytes.length,
    content_kind: kind,
  };
}

// SPEC-002 §5.1.20 frozen vectors.

test("SPEC-002 §5.1.20: fixture file declares hash schema 1", () => {
  assert.equal(vectors.schema, 1);
  assert.equal(SKILL_VERSION_HASH_SCHEMA_VERSION, 1);
});

test("SPEC-002 §5.1.20: frozen blob vector matches on this platform", () => {
  assert.equal(hashBlobBytes(encode(vectors.blobs.hello.inputUtf8)), vectors.blobs.hello.expected);
  assert.match(vectors.blobs.hello.expected, /^sha256:[0-9a-f]{64}$/);
});

test("SPEC-002 §5.1.20: CRLF/LF and BOM/no-BOM converge to the frozen blob", () => {
  const { lf, crlf, bomLf, expectedBlob, expectedByteSize } = vectors.textConvergence;
  const hashes = [lf, crlf, bomLf].map((text) => hashBlobBytes(canonicalBytes(encode(text))));
  assert.deepEqual(hashes, [expectedBlob, expectedBlob, expectedBlob]);
  for (const text of [lf, crlf, bomLf]) {
    assert.equal(canonicalByteSize(encode(text)), expectedByteSize);
  }
});

test("SPEC-002 §5.1.20: NFC/NFD source variants remain distinct per frozen vectors", () => {
  const { nfc, nfd, expectedNfcBlob, expectedNfdBlob } = vectors.unicodeDistinct;
  assert.equal(hashBlobBytes(canonicalBytes(encode(nfc))), expectedNfcBlob);
  assert.equal(hashBlobBytes(canonicalBytes(encode(nfd))), expectedNfdBlob);
  assert.notEqual(expectedNfcBlob, expectedNfdBlob);
});

test("SPEC-002 §5.1.20: frozen minimal-skill version hash reproduces", () => {
  const { manifest, expectedVersion } = vectors.minimalManifest;
  assert.equal(hashCanonicalManifest(manifest), expectedVersion);
  const rebuilt = buildCanonicalSkillVersionManifest({
    skillId: manifest.skill_id,
    portable: { name: manifest.portable.name, description: manifest.portable.description },
    routing: {
      domains: manifest.routing.domains,
      platforms: manifest.routing.platforms,
      frameworks: manifest.routing.frameworks,
      triggers: manifest.routing.triggers,
      antiTriggers: manifest.routing.anti_triggers,
      aliases: manifest.routing.aliases,
    },
    files: manifest.files,
  });
  assert.equal(hashCanonicalManifest(rebuilt), expectedVersion);
});

test("SPEC-002 §5.1.20: frozen ega.yaml-formatting invariance reproduces", () => {
  const { sourceA, sourceB, expectedVersion } = vectors.egaFormattingInvariance;
  const toRouting = (source) => {
    const parsed = parseEgaMetadata(encode(source));
    return {
      domains: [...parsed.domains],
      platforms: [...parsed.platforms],
      frameworks: [...parsed.frameworks],
      triggers: [...parsed.triggers],
      antiTriggers: [...parsed.antiTriggers],
      aliases: [...parsed.aliases],
    };
  };
  const skillBlob = vectors.blobs.skillLf.expected;
  const build = (routing) =>
    buildCanonicalSkillVersionManifest({
      skillId: "ega/frontend-design",
      portable: { name: "frontend-design", description: "Build interfaces." },
      routing,
      files: [
        {
          path: "SKILL.md",
          role: "skill-body",
          blob_hash: skillBlob,
          byte_size: vectors.blobs.skillLf.expectedByteSize,
          content_kind: "TEXT",
        },
      ],
    });
  const hashA = hashCanonicalManifest(build(toRouting(sourceA)));
  const hashB = hashCanonicalManifest(build(toRouting(sourceB)));
  assert.equal(hashA, expectedVersion);
  assert.equal(hashB, expectedVersion);
});

test("SPEC-002 §5.1.20: token recount does not alter the version hash", () => {
  const { manifest, expectedVersion } = vectors.minimalManifest;
  const before = hashCanonicalManifest(manifest);
  for (const record of manifest.files) {
    if (record.content_kind === "TEXT") {
      tokenEstimator.count("recount probe");
    }
  }
  assert.equal(hashCanonicalManifest(manifest), before);
  assert.equal(before, expectedVersion);
  assert.ok(!JSON.stringify(manifest).includes("token"));
});

test("SPEC-002 §5.1.20: symlink/junction escape still fails frozen traversal", async (t) => {
  const rootDir = await tempRoot(t);
  const outside = await tempRoot(t);
  await writeFile(join(rootDir, "SKILL.md"), "# Skill\n");
  await writeFile(join(outside, "outside.txt"), "outside");
  const linkPath = join(rootDir, "escape-link");
  try {
    if (process.platform === "win32") {
      await symlink(outside, linkPath, "junction");
    } else {
      await symlink(outside, linkPath, "dir");
    }
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("runner does not permit symlink/junction creation");
      return;
    }
    throw error;
  }
  await assert.rejects(
    hashing.traverseFiles(await hashing.resolveTraversalRoot(rootDir)),
    hasCode("E_HASH_LINK_ESCAPE"),
  );
});

test("SPEC-002 §5.1.20: hard links are independent lexical paths sharing one blob", async (t) => {
  const rootDir = await tempRoot(t);
  const content = "# Skill\n";
  await writeFile(join(rootDir, "SKILL.md"), content);
  try {
    await link(join(rootDir, "SKILL.md"), join(rootDir, "COPY.md"));
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EXDEV") {
      t.skip("runner does not permit hard-link creation");
      return;
    }
    throw error;
  }
  const traversalRoot = await hashing.resolveTraversalRoot(rootDir);
  const records = await hashing.buildCanonicalFileRecords(
    await hashing.traverseFiles(traversalRoot),
    analyzeFile,
  );
  assert.deepEqual(records.map((record) => record.path), ["COPY.md", "SKILL.md"]);
  assert.equal(records[0].blob_hash, records[1].blob_hash);
  assert.equal(
    records[0].blob_hash,
    hashBlobBytes(canonicalBytes(encode("# Skill\n"))),
  );
});

test("SPEC-002 §5.1.20: hashing exclusions stay frozen", async (t) => {
  const rootDir = await tempRoot(t);
  await writeFile(join(rootDir, "SKILL.md"), "# Skill\n");
  await mkdir(join(rootDir, ".git"), { recursive: true });
  await writeFile(join(rootDir, ".git", "ignored.txt"), "ignored");
  await writeFile(join(rootDir, ".DS_Store"), "ignored");
  const traversalRoot = await hashing.resolveTraversalRoot(rootDir);
  const records = await hashing.buildCanonicalFileRecords(
    await hashing.traverseFiles(traversalRoot),
    analyzeFile,
  );
  assert.deepEqual(records.map((record) => record.path), ["SKILL.md"]);
});

test("SPEC-002 §5.1.20: 100 typical skills cold-hash within 5 seconds", () => {
  const { manifest } = vectors.minimalManifest;
  const start = Date.now();
  for (let index = 0; index < 100; index += 1) {
    const variant = buildCanonicalSkillVersionManifest({
      skillId: `ega/skill-${index}`,
      portable: { name: `skill-${index}`, description: "Typical skill." },
      routing: {
        domains: manifest.routing.domains,
        platforms: manifest.routing.platforms,
        frameworks: manifest.routing.frameworks,
        triggers: manifest.routing.triggers,
        antiTriggers: manifest.routing.anti_triggers,
        aliases: manifest.routing.aliases,
      },
      files: manifest.files,
    });
    hashCanonicalManifest(variant);
  }
  const elapsed = Date.now() - start;
  console.log(`ℹ 100-skill cold hash: ${elapsed} ms`);
  assert.ok(elapsed <= 5000, `100-skill cold hash took ${elapsed} ms`);
});

test("SPEC-002 §5.1.20: hashing performs zero model/network calls", () => {
  const sources = readdirSync(join(root, "packages", "hashing", "src"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFileSync(join(root, "packages", "hashing", "src", file), "utf8"));
  for (const source of sources) {
    assert.ok(!source.includes("fetch("), "hashing must not fetch");
    assert.ok(!source.includes("node:http"), "hashing must not use http");
    assert.ok(!source.includes("tiktoken"), "hashing must not count tokens");
  }
});
