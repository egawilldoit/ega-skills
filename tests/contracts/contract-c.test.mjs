import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, sha256Hex } from "../../packages/hashing/dist/identities.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VALIDATOR = join(REPO, "scripts", "contracts", "validate-contract-c.mjs");
const EXAMPLES = join(REPO, "scripts", "contracts", "examples", "contract-c");

const RELEASE_DIGEST = "sha256:d3838fdcc7c16a5460f2ff381b3ac36df35a62733b053765fbb813074450e649";

function read(p) {
  return readFileSync(join(EXAMPLES, p), "utf8");
}

function withSwappedFiles(files, fn) {
  const saved = new Map();
  try {
    for (const [name, content] of Object.entries(files)) {
      const p = join(EXAMPLES, name);
      saved.set(name, readFileSync(p, "utf8"));
      writeFileSync(p, content);
    }
    return fn();
  } finally {
    for (const [name, content] of saved) writeFileSync(join(EXAMPLES, name), content);
  }
}

function resignRelease(doc) {
  doc.digest = `sha256:${sha256Hex(
    canonicalizeJson({ object_type: doc.object_type, payload: doc.payload, schema_version: doc.schema_version }),
  )}`;
  return JSON.stringify(doc, null, 2);
}

function digestOf(value) {
  return `sha256:${sha256Hex(canonicalizeJson(value))}`;
}

function rebindSemanticFiles({ aliasMap, tokenArtifact, searchIndexInput }) {
  const release = JSON.parse(read("hub-release.json"));
  if (aliasMap !== undefined) release.payload.alias_map_digest = digestOf(aliasMap);
  if (tokenArtifact !== undefined) release.payload.token_artifact_digest = digestOf(tokenArtifact);
  if (searchIndexInput !== undefined) release.payload.search_index_input_digest = digestOf(searchIndexInput);
  const releaseText = resignRelease(release);
  const rebound = JSON.parse(releaseText);
  const pkg = JSON.parse(read("release-package.json"));
  pkg.hub_release_digest = rebound.digest;
  const stable = JSON.parse(read("stable.json"));
  stable.stable_release_digest = rebound.digest;
  return {
    ...(aliasMap === undefined ? {} : { "alias-map.json": JSON.stringify(aliasMap, null, 2) }),
    ...(tokenArtifact === undefined ? {} : { "token-artifact.json": JSON.stringify(tokenArtifact, null, 2) }),
    ...(searchIndexInput === undefined ? {} : { "search-index-input.json": JSON.stringify(searchIndexInput, null, 2) }),
    "hub-release.json": releaseText,
    "release-package.json": JSON.stringify(pkg, null, 2),
    "stable.json": JSON.stringify(stable, null, 2),
  };
}

function runOk() {
  return execFileSync("node", [VALIDATOR], { encoding: "utf8" });
}

function runBad() {
  try {
    execFileSync("node", [VALIDATOR], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
  throw new Error("validator unexpectedly passed on negative fixture");
}

test("valid release + FTS isolation proof (CONTRACT-C-OK)", () => {
  const out = runOk();
  assert.match(out, /CONTRACT-C-OK/);
  assert.match(out, /FTS isolation proven/);
  assert.match(out, /CAS pointer valid/);
});

test("tampered release digest fails E_RELEASE_DIGEST", () => {
  const bad = read("hub-release.json").replace(RELEASE_DIGEST, "sha256:0000000000000000000000000000000000000000000000000000000000000000");
  const out = withSwappedFiles({ "hub-release.json": bad }, runBad);
  assert.match(out, /E_RELEASE_DIGEST/);
});

test("alias leak to unselected skill fails E_ALIAS_SCOPE", () => {
  const doc = JSON.parse(read("alias-map.json"));
  doc.aliases.ghost = "mattpocock/grilling";
  const aliasText = JSON.stringify({ aliases: Object.fromEntries(Object.entries(doc.aliases).sort()) }, null, 2);
  const out = withSwappedFiles({ "alias-map.json": aliasText }, runBad);
  assert.match(out, /E_ALIAS_SCOPE|E_RELEASE_DIGEST/);
});

test("wrong token estimator fails E_TOKEN_ARTIFACT", () => {
  const doc = JSON.parse(read("token-artifact.json"));
  doc.estimator = "ega-o200k-v9";
  const out = withSwappedFiles({ "token-artifact.json": JSON.stringify(doc, null, 2) }, runBad);
  assert.match(out, /E_TOKEN_ARTIFACT|E_RELEASE_DIGEST/);
});

test("self-consistent invented alias fails semantic ownership validation", () => {
  const aliasMap = JSON.parse(read("alias-map.json"));
  aliasMap.aliases.invented = "cursor/architect";
  aliasMap.aliases = Object.fromEntries(Object.entries(aliasMap.aliases).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const out = withSwappedFiles(rebindSemanticFiles({ aliasMap }), runBad);
  assert.match(out, /E_ALIAS_SCOPE/);
});

test("self-consistent wrong token value fails semantic token validation", () => {
  const tokenArtifact = JSON.parse(read("token-artifact.json"));
  tokenArtifact.counts[0].tokens += 1;
  const out = withSwappedFiles(rebindSemanticFiles({ tokenArtifact }), runBad);
  assert.match(out, /E_TOKEN_ARTIFACT/);
});

test("self-consistent wrong token level fails semantic token validation", () => {
  const tokenArtifact = JSON.parse(read("token-artifact.json"));
  tokenArtifact.counts[0].level = "L1";
  const out = withSwappedFiles(rebindSemanticFiles({ tokenArtifact }), runBad);
  assert.match(out, /E_TOKEN_ARTIFACT/);
});

test("self-consistent invented normalized search metadata fails semantic validation", () => {
  const searchIndexInput = JSON.parse(read("search-index-input.json"));
  searchIndexInput.rows[0].description = "invented metadata";
  const out = withSwappedFiles(rebindSemanticFiles({ searchIndexInput }), runBad);
  assert.match(out, /E_SEARCH_INPUT/);
});

test("stable pointer mismatch fails E_STABLE", () => {
  const bad = read("stable.json").replace(RELEASE_DIGEST, "sha256:0000000000000000000000000000000000000000000000000000000000000000");
  const out = withSwappedFiles({ "stable.json": bad }, runBad);
  assert.match(out, /E_STABLE/);
});

test("sqlite artifact flip still passes (semantic separation proof)", () => {
  const bad = read("release-package.json").replace(
    "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  );
  const out = withSwappedFiles({ "release-package.json": bad }, runOk);
  assert.match(out, /CONTRACT-C-OK/);
});

test("corpus pollution without rebinding fails", () => {
  const doc = JSON.parse(read("search-index-input.json"));
  doc.rows.push({
    skill_id: "mattpocock/grilling",
    version_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    name: "grilling",
    description: "Grill the user with clarifying questions",
    domains: ["productivity"],
    platforms: ["web"],
    frameworks: [],
    triggers: ["questions"],
    aliases: [],
  });
  const out = withSwappedFiles({ "search-index-input.json": JSON.stringify(doc, null, 2) }, runBad);
  assert.match(out, /E_RELEASE_DIGEST|E_TOKEN_ARTIFACT/);
});

test("unknown release payload field fails closed", () => {
  const doc = JSON.parse(read("hub-release.json"));
  doc.payload.bogus = 1;
  const out = withSwappedFiles({ "hub-release.json": resignRelease(doc) }, runBad);
  assert.match(out, /E_RELEASE_SCHEMA/);
});

test("explicit null fails closed", () => {
  const bad = read("stable.json").replace('"cas_version": 1', '"cas_version": null');
  const out = withSwappedFiles({ "stable.json": bad }, runBad);
  assert.match(out, /E_STABLE|E_RELEASE_SCHEMA/);
});

test("missing release payload fails closed with E_RELEASE_SCHEMA (no canonicalization abort)", () => {
  const doc = JSON.parse(read("hub-release.json"));
  delete doc.payload;
  const out = withSwappedFiles({ "hub-release.json": JSON.stringify(doc, null, 2) }, runBad);
  assert.match(out, /E_RELEASE_SCHEMA: hub-release\.json payload must be an object/);
  assert.match(out, /CONTRACT-C-FAIL/);
  assert.doesNotMatch(out, /HashIdentityError|TypeError|ReferenceError/);
});

test("null search row fails closed with E_SEARCH_INPUT (no stack abort)", () => {
  const doc = JSON.parse(read("search-index-input.json"));
  doc.rows[1] = null;
  const out = withSwappedFiles({ "search-index-input.json": JSON.stringify(doc, null, 2) }, runBad);
  assert.match(out, /E_SEARCH_INPUT: search-index-input\.json rows must be objects/);
  assert.match(out, /CONTRACT-C-FAIL/);
  assert.doesNotMatch(out, /TypeError|ReferenceError/);
});

test("duplicate token count masking an omission fails E_TOKEN_ARTIFACT", () => {
  const doc = JSON.parse(read("token-artifact.json"));
  doc.counts = [doc.counts[0], doc.counts[0], doc.counts[2], doc.counts[3]];
  const out = withSwappedFiles({ "token-artifact.json": JSON.stringify(doc, null, 2) }, runBad);
  assert.match(out, /E_TOKEN_ARTIFACT: token-artifact\.json duplicate count for /);
  assert.match(out, /exactly the R1 catalog/);
});

test("duplicate adopted source masking an omission fails closed", () => {
  const doc = JSON.parse(read("hub-release.json"));
  const first = JSON.parse(JSON.stringify(doc.payload.adopted_sources[0]));
  doc.payload.adopted_sources = [doc.payload.adopted_sources[0], first];
  const out = withSwappedFiles({ "hub-release.json": resignRelease(doc) }, runBad);
  assert.match(out, /E_RELEASE_SCHEMA: hub-release\.json adopted_sources must list exactly the adopted sources/);
  assert.match(out, /CONTRACT-C-FAIL/);
});

test("frozen release digest vector is stable", () => {
  const out = runOk();
  assert.match(out, /CONTRACT-C-OK/);
  assert.match(read("hub-release.json"), new RegExp(RELEASE_DIGEST.replace(/:/, ":")));
});
