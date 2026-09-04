import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  getCacheBlob,
  openRegistry,
  putCacheBlob,
} from "../../packages/registry/dist/index.js";
import { RegistryError } from "../../packages/registry/dist/errors.js";

const hashing = await import("../../packages/hashing/dist/index.js");
const { canonicalBytes } = hashing;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const encoder = new TextEncoder();
const encode = (text) => encoder.encode(text);

function hasCode(code) {
  return (error) => error instanceof RegistryError && error.code === code;
}

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), "ega-565-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function cacheDir(home) {
  return join(home, "cache", "sha256");
}

// SPEC-003 §5.1.8 layout.

test("SPEC-003 §5.1.8: blob stored at deterministic cache/sha256/ab/<rest> path", async (t) => {
  const home = await tempHome(t);
  const bytes = encode("# Skill\n");
  const result = putCacheBlob(cacheDir(home), bytes);
  const digest = result.hash.slice("sha256:".length);
  assert.match(result.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    result.path,
    join(cacheDir(home), digest.slice(0, 2), digest.slice(2)),
  );
  const parts = result.path.split(sep);
  assert.equal(parts[parts.length - 3], "sha256");
  assert.equal(result.reused, false);
  assert.deepEqual(await readFile(result.path), Buffer.from(bytes));
});

test("SPEC-003 §5.1.8: source bytes are not silently modified by put", async (t) => {
  const home = await tempHome(t);
  const bytes = encode("# Skill\r\nline\r\n");
  const before = Uint8Array.from(bytes);
  putCacheBlob(cacheDir(home), bytes);
  assert.deepEqual(bytes, before);
});

test("SPEC-003 §5.1.8: canonical TEXT bytes dedupe (CRLF converges with LF)", async (t) => {
  const home = await tempHome(t);
  const first = putCacheBlob(cacheDir(home), canonicalBytes(encode("# Skill\n")));
  const second = putCacheBlob(cacheDir(home), canonicalBytes(encode("# Skill\r\n")));
  assert.equal(first.hash, second.hash);
  assert.equal(first.path, second.path);
  assert.equal(second.reused, true);
});

test("SPEC-003 §5.1.8: existing valid blob is reused", async (t) => {
  const home = await tempHome(t);
  const bytes = encode("reuse me");
  const first = putCacheBlob(cacheDir(home), bytes);
  const second = putCacheBlob(cacheDir(home), bytes);
  assert.equal(second.reused, true);
  assert.equal(second.hash, first.hash);
  assert.equal(second.path, first.path);
  assert.deepEqual(getCacheBlob(cacheDir(home), first.hash), Buffer.from(bytes));
});

// SPEC-003 §5.1.9 verification.

test("SPEC-003 §5.1.9: wrong supplied hash fails before finalization", async (t) => {
  const home = await tempHome(t);
  const bytes = encode("some bytes");
  const wrong = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  assert.throws(() => putCacheBlob(cacheDir(home), bytes, wrong), hasCode("E_CACHE_HASH_MISMATCH"));
  // Rejected before any filesystem write: the cache dir is absent or empty.
  let entries = [];
  try {
    entries = readdirSync(cacheDir(home), { recursive: true });
  } catch (error) {
    assert.equal(error?.code, "ENOENT");
  }
  assert.deepEqual(entries, []);
});

test("SPEC-003 §5.1.9: corrupted existing blob is detected and never returned", async (t) => {
  const home = await tempHome(t);
  const stored = putCacheBlob(cacheDir(home), encode("pristine"));
  await writeFile(stored.path, "corrupted!!");
  assert.throws(() => getCacheBlob(cacheDir(home), stored.hash), hasCode("E_CACHE_HASH_MISMATCH"));
  assert.throws(
    () => putCacheBlob(cacheDir(home), encode("pristine")),
    hasCode("E_CACHE_HASH_MISMATCH"),
  );
});

test("SPEC-003 §5.1.9: missing blob reference fails verification", async (t) => {
  const home = await tempHome(t);
  const missing = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  assert.throws(() => getCacheBlob(cacheDir(home), missing), hasCode("E_CACHE_HASH_MISMATCH"));
  assert.throws(() => getCacheBlob(cacheDir(home), "not-a-hash"), hasCode("E_CACHE_HASH_MISMATCH"));
});

test("SPEC-003 §5.1.9: filesystem failures map to E_CACHE_WRITE", async (t) => {
  const home = await tempHome(t);
  // Block subdir creation with a regular file so mkdir/write must fail.
  const { sha256DigestHex } = await import("../../packages/registry/dist/index.js");
  const digest = sha256DigestHex(encode("blocked"));
  await mkdir(cacheDir(home), { recursive: true });
  await writeFile(join(cacheDir(home), digest.slice(0, 2)), "blocker");
  assert.throws(
    () => putCacheBlob(cacheDir(home), encode("blocked")),
    hasCode("E_CACHE_WRITE"),
  );
});

test("SPEC-003 §5.1.9: temp files can never become authoritative entries", async (t) => {
  const home = await tempHome(t);
  const stored = putCacheBlob(cacheDir(home), encode("final"));
  const subdir = join(cacheDir(home), stored.hash.slice("sha256:".length, "sha256:".length + 2));
  await writeFile(join(subdir, "tmp-9999-stray"), "stray content");
  const entries = readdirSync(subdir);
  assert.ok(entries.some((name) => name.startsWith("tmp-")));
  // The stray temp file is invisible to reads; only the finalized path resolves.
  assert.deepEqual(getCacheBlob(cacheDir(home), stored.hash), Buffer.from(encode("final")));
  const after = putCacheBlob(cacheDir(home), encode("final"));
  assert.equal(after.reused, true);
});

test("SPEC-003 §5.1.9: failed DB tx leaves orphan blob but no committed reference", async (t) => {
  const home = await tempHome(t);
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  t.after(() => registry.close());
  const blob = putCacheBlob(cacheDir(home), encode("orphan-candidate"));
  const versionHash = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
  registry.db.exec("BEGIN");
  try {
    registry.db
      .prepare("INSERT INTO skills (skill_id, namespace, name, current_version_hash) VALUES (?, ?, ?, ?)")
      .run("ega/orphan", "ega", "orphan", versionHash);
    registry.db
      .prepare("INSERT INTO skill_versions (skill_id, version_hash, manifest_json, l1_status, l2_size_class) VALUES (?, ?, ?, ?, ?)")
      .run("ega/orphan", versionHash, "{}", "MISSING", "NORMAL");
    registry.db
      .prepare("INSERT INTO skill_files (skill_id, version_hash, path, role, blob_hash, byte_size, content_kind) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("ega/orphan", versionHash, "SKILL.md", "skill-body", blob.hash, 15, "TEXT");
    throw new Error("simulated import failure before commit");
  } catch {
    registry.db.exec("ROLLBACK");
  }
  // Orphan blob on disk is acceptable; committed broken reference is forbidden.
  assert.deepEqual(await readFile(blob.path), Buffer.from(encode("orphan-candidate")));
  const refs = registry.db
    .prepare("SELECT COUNT(*) AS n FROM skill_files WHERE blob_hash = ?")
    .get(blob.hash);
  assert.equal(refs.n, 0);
});

test("SPEC-003 §5.1.9: warm valid cache get trends toward <= 50 ms", async (t) => {
  const home = await tempHome(t);
  const stored = putCacheBlob(cacheDir(home), encode("warm data"));
  getCacheBlob(cacheDir(home), stored.hash);
  const start = performance.now();
  for (let index = 0; index < 20; index += 1) {
    getCacheBlob(cacheDir(home), stored.hash);
  }
  const elapsed = performance.now() - start;
  console.log(`ℹ warm cache get x20: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed / 20 <= 50, `warm get averaged ${(elapsed / 20).toFixed(1)} ms`);
});

test("SPEC-003 §5.1.8–§5.1.9: no GC, network, or remote-store behavior", () => {
  const sources = readdirSync(join(root, "packages", "registry", "src"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFileSync(join(root, "packages", "registry", "src", file), "utf8"));
  for (const source of sources) {
    assert.ok(!source.includes("fetch("), "registry must not fetch");
    assert.ok(!source.includes("node:http"), "registry must not use http");
  }
  const cacheSource = readFileSync(join(root, "packages", "registry", "src", "cache.ts"), "utf8");
  assert.ok(!cacheSource.includes("unlinkSync(finalPath"), "cache must never GC finalized blobs");
});
