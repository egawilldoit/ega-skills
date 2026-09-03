#!/usr/bin/env node
/**
 * EGA Skills Hub V1 — spec-drift guardrail (EGA-550).
 *
 * Mechanical checks only: file presence, placeholders, superseded contracts,
 * golden inventory completeness, required headings. This checker does NOT
 * validate English semantics.
 *
 * Usage: pnpm specs:check   (or: node scripts/specs/check-specs.mjs)
 * Exit 0 = pass, exit 1 = drift found.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = join(ROOT, "docs", "specs");

const EXPECTED_FILES = [
  "SPEC-001-Skill-Schema-v1.md",
  "SPEC-002-Canonical-Hashing.md",
  "SPEC-003-Local-Registry-and-Cache.md",
  "SPEC-004-Router-and-Resolution-Contract.md",
  "SPEC-005-Project-Config-and-Lockfile.md",
  "SPEC-006-MCP-Runtime-Contract.md",
  "TEST-001-Router-Golden-Scenarios.md",
  "TEST-002-Token-Estimator-Vectors.md",
];

const REQUIRED_HEADINGS = {
  "SPEC-001-Skill-Schema-v1.md": ["## §5.1.1", "## §5.1.20", "## §5.2"],
  "SPEC-002-Canonical-Hashing.md": ["## §5.1.1", "## §5.1.15", "## §5.2"],
  "SPEC-003-Local-Registry-and-Cache.md": ["## §5.1.1", "## §5.1.10", "## §5.2"],
  "SPEC-004-Router-and-Resolution-Contract.md": ["## §5.1.1", "## §5.1.20", "## §5.2"],
  "SPEC-005-Project-Config-and-Lockfile.md": ["## §5.1.1", "## §5.1.16", "## §5.2"],
  "SPEC-006-MCP-Runtime-Contract.md": ["## §5.1.1", "## §5.1.8", "## §5.2"],
  "TEST-001-Router-Golden-Scenarios.md": ["## §5.1.0", "## §5.1.2", "## §5.1.4", "## §5.1.5"],
  "TEST-002-Token-Estimator-Vectors.md": ["## §6.1", "## §6.4", "## §6.5"],
};

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`DRIFT: ${msg}`);
};
const pass = (msg) => console.log(`ok: ${msg}`);

const files = {};
for (const name of EXPECTED_FILES) {
  const p = join(SPECS, name);
  if (!existsSync(p)) {
    fail(`missing spec file docs/specs/${name}`);
    continue;
  }
  const content = readFileSync(p, "utf8");
  files[name] = content;
  if (content.trim().length === 0) fail(`empty spec file docs/specs/${name}`);
  else pass(`docs/specs/${name} exists and is non-empty`);
  if (statSync(p).size < 1024) fail(`suspiciously small spec file docs/specs/${name}`);
}

// Every file must declare frozen normative status.
for (const [name, content] of Object.entries(files)) {
  if (!content.includes("Status:** FROZEN")) fail(`${name} lacks frozen status declaration`);
}

// No TODO/TBD/FIXME placeholders in frozen docs.
for (const [name, content] of Object.entries(files)) {
  const m = content.match(/\b(TODO|TBD|FIXME)\b/);
  if (m) fail(`${name} contains placeholder token "${m[1]}"`);
}

// No "if amendment approved"-style conditional wording.
for (const [name, content] of Object.entries(files)) {
  if (/if amendment.{0,30}approv/i.test(content)) fail(`${name} contains conditional amendment-approval wording`);
  if (/amendment.{0,20}(pending|proposed|draft)\b/i.test(content) && !/amendment payload/i.test(content))
    fail(`${name} contains pending-amendment wording`);
}

// No stale pre-amendment source-of-truth wording.
for (const [name, content] of Object.entries(files)) {
  if (/keep the previously frozen/i.test(content)) fail(`${name} references unmaterialized "previously frozen" content`);
  if (/pre-amendment bundle.{0,60}(authoritative|source of truth)/i.test(content))
    fail(`${name} treats the pre-amendment bundle as authority`);
}

// Single canonical path-escape code: E_SKILL_PATH_ESCAPE may only appear in
// lines that explicitly retire it. SPEC-001 retires it, SPEC-002 owns
// E_HASH_PATH_ESCAPE; other specs must not use either code normatively.
for (const [name, content] of Object.entries(files)) {
  for (const line of content.split("\n")) {
    if (line.includes("E_SKILL_PATH_ESCAPE") && !/(REMOVED|stale|MUST NOT|defines no)/.test(line))
      fail(`${name} uses retired code E_SKILL_PATH_ESCAPE normatively: ${line.trim().slice(0, 120)}`);
  }
}
for (const name of ["SPEC-001-Skill-Schema-v1.md", "SPEC-002-Canonical-Hashing.md"]) {
  if (files[name] && !files[name].includes("E_HASH_PATH_ESCAPE"))
    fail(`${name} never names canonical E_HASH_PATH_ESCAPE`);
}

// Superseded free-form "conflicting evidence" heuristic must not remain in force.
for (const [name, content] of Object.entries(files)) {
  for (const line of content.split("\n")) {
    if (/conflicting evidence/i.test(line) && !/\b(NO|NOT|never|removed)\b/.test(line))
      fail(`${name} retains free-form conflicting-evidence heuristic: ${line.trim().slice(0, 120)}`);
  }
}

// `timings` must never be a ResolutionResult field.
for (const [name, content] of Object.entries(files)) {
  for (const line of content.split("\n")) {
    if (/`timings`/.test(line) && !/\b(NO|NOT|never)\b/.test(line))
      fail(`${name} treats timings as a result field: ${line.trim().slice(0, 120)}`);
  }
}

// Undefined "configured source" namespace exception must not remain in force.
for (const [name, content] of Object.entries(files)) {
  for (const line of content.split("\n")) {
    if (/configured source/i.test(line) && !/\b(no|removed|post-V1|never)\b/i.test(line))
      fail(`${name} retains undefined configured-source mechanism: ${line.trim().slice(0, 120)}`);
  }
}

// TEST-001: G001..G042 scenario headings exactly once each.
if (files["TEST-001-Router-Golden-Scenarios.md"]) {
  const t1 = files["TEST-001-Router-Golden-Scenarios.md"];
  const headings = [...t1.matchAll(/^#### (G\d{3})\b/gm)].map((m) => m[1]);
  const want = Array.from({ length: 42 }, (_, i) => `G${String(i + 1).padStart(3, "0")}`);
  const counts = new Map();
  for (const h of headings) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const id of want) {
    if ((counts.get(id) ?? 0) !== 1) fail(`TEST-001 scenario ${id} defined ${(counts.get(id) ?? 0)} times (want exactly 1)`);
  }
  for (const h of counts.keys()) {
    if (!want.includes(h)) fail(`TEST-001 contains unexpected scenario ${h}`);
  }
  if (failures === 0 || ![...counts.values()].some((c) => c !== 1)) pass("TEST-001 defines G001–G042 exactly once each");
  // Assertion vocabulary presence.
  for (const term of [
    "mustSelect", "mustNotSelect", "maySelect", "mustExplicit", "mustCandidate",
    "requiredReasonsBySkill", "requiredWarnings", "EXPLICIT_OVER_BUDGET",
    "skillCatalogFixture",
  ]) {
    if (!t1.includes(term)) fail(`TEST-001 lacks assertion vocabulary "${term}"`);
  }
}

// TEST-002: T001..T009 vectors present with frozen ega-o200k-v1 counts/inputs.
if (files["TEST-002-Token-Estimator-Vectors.md"]) {
  const t2 = files["TEST-002-Token-Estimator-Vectors.md"];
  for (let i = 1; i <= 9; i++) {
    const id = `T${String(i).padStart(3, "0")}`;
    if (!new RegExp(`\\b${id}\\b`).test(t2)) fail(`TEST-002 lacks vector ${id}`);
  }
  if (!t2.includes("ega-o200k-v1")) fail("TEST-002 lacks estimator id ega-o200k-v1");

  // Frozen vector contract: parse the normative markdown table rows
  // "| T00x | <exact input> | <count> |" and check semantic id -> count.
  const FROZEN_COUNTS = new Map([
    ["T001", 0],
    ["T002", 1],
    ["T003", 2],
    ["T004", 2],
    ["T005", 4],
    ["T006", 1],
    ["T007", 2],
    ["T008", 2],
    ["T009", 9],
  ]);
  const rows = [...t2.matchAll(/^\|\s*(T00[1-9])\s*\|(.*?)\|\s*(\d+)\s*\|/gm)];
  const seen = new Map();
  for (const m of rows) {
    const [, id, , countStr] = m;
    seen.set(id, (seen.get(id) ?? []).concat(Number(countStr)));
  }
  for (const [id, want] of FROZEN_COUNTS) {
    const got = seen.get(id) ?? [];
    if (got.length !== 1) {
      fail(`TEST-002 vector ${id} table row defined ${got.length} times (want exactly 1)`);
    } else if (got[0] !== want) {
      fail(`TEST-002 vector ${id} count is ${got[0]} (want exactly ${want})`);
    }
  }
  for (const id of seen.keys()) {
    if (!FROZEN_COUNTS.has(id)) fail(`TEST-002 contains unexpected vector row ${id}`);
  }
  if (rows.length !== 9) fail(`TEST-002 vector table has ${rows.length} data rows (want exactly 9)`);

  // Frozen exact inputs: each table row's middle cell must carry the exact input.
  const rowById = new Map(rows.map((m) => [m[1], m[2]]));
  const inputChecks = [
    ["T001", /\bempty string\b/i, "empty string"],
    ["T002", /`Hello`/, "`Hello`"],
    ["T003", /`hello world`/, "`hello world`"],
    ["T004", /`Hello world`/, "`Hello world`"],
    ["T005", /`Hello, world!`/, "`Hello, world!`"],
    ["T006", /`こんにちは`/, "konnichiwa"],
    ["T007", /`こんにちは世界`/, "konnichiwa+sekai"],
    ["T008", /`你好世界`/, "ni-hao-shi-jie"],
    ["T009", /`The quick brown fox jumps over the lazy dog`/, "quick-brown-fox"],
  ];
  for (const [id, re, label] of inputChecks) {
    const cell = rowById.get(id) ?? "";
    if (!re.test(cell)) fail(`TEST-002 vector ${id} row lacks exact input ${label}`);
  }
  // T001 must be the empty string: guard against encoding the words as input.
  if (!/T001 input is exactly `""`/.test(t2))
    fail("TEST-002 lacks explicit T001 empty-string clarification (input is exactly \"\")");

  // Estimator pinning must name package + encoding.
  if (!t2.includes("js-tiktoken@1.0.21")) fail("TEST-002 lacks pinned package js-tiktoken@1.0.21");
  if (!t2.includes("o200k_base")) fail("TEST-002 lacks encoding o200k_base");

  // Estimator versioning rule must name the successor id.
  if (!t2.includes("ega-o200k-v2")) fail("TEST-002 lacks estimator versioning successor ega-o200k-v2");

  // Provenance note (concise, normative).
  if (!/independently verified against\s+js-tiktoken@1\.0\.21\s+using\s+o200k_base\s+before implementation/.test(t2))
    fail("TEST-002 lacks provenance note for T001–T009 verification");

  // Normalization vectors preserved.
  if (!t2.includes("Hello\\r\\nworld") || !t2.includes("Hello\\nworld"))
    fail("TEST-002 lacks CRLF/LF normalization vectors");
  if (!t2.includes("U+FEFF"))
    fail("TEST-002 lacks BOM normalization vector");
  if (!t2.includes("U+0301") && !t2.includes("\\u0301"))
    fail("TEST-002 lacks NFC/NFD code-point-distinct vectors");
  if (!t2.includes("<|endoftext|>")) fail("TEST-002 lacks ordinary special-token vector");
  if (!t2.includes("E_TOKEN_BINARY_INPUT")) fail("TEST-002 lacks binary E_TOKEN_BINARY_INPUT rule");

  // No deferral of the frozen vectors to later implementation.
  for (const re of [
    /exact values will be frozen in EGA-557/i,
    /EGA-557 determines/i,
    /frozen FORWARD by EGA-557/i,
    /implementation will fill/i,
    /fill .*counts later/i,
  ]) {
    if (re.test(t2)) fail(`TEST-002 retains deferral wording matching ${re}`);
  }
}

// Required headings per file.
for (const [name, heads] of Object.entries(REQUIRED_HEADINGS)) {
  if (!files[name]) continue;
  for (const h of heads) {
    if (!files[name].includes(h)) fail(`${name} lacks required heading "${h}"`);
  }
}

if (failures > 0) {
  console.error(`\nSPEC CHECK FAILED: ${failures} drift finding(s).`);
  process.exit(1);
}
console.log("\nSPEC CHECK PASSED: 8 frozen files, no placeholders, no superseded contracts, G001–G042 x1, T001–T009 present.");
