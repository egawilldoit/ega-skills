// SPEC-005 §5.1.5–§5.1.6, §5.1.8 ProjectConfigV1 parse + normalize (EGA-583).
//
// Covers the normative inventory: frozen V1 defaults, canonical-only policy
// entries (namespaces AND canonical skill IDs; no aliases, no bare names, no
// silent lowercase/repair), numeric ranges, mode, malformed YAML, duplicate
// YAML keys, unknown keys, dedupe + UTF-16 sort, determinism, and the frozen
// E_PROJECT_CONFIG_INVALID error code.
//
// Tests import the built package (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import test from "node:test";

import {
  E_PROJECT_CONFIG_INVALID,
  PROJECT_CONFIG_V1_DEFAULTS,
  ProjectConfigError,
  normalizeProjectConfigV1,
  parseProjectConfig,
} from "../../packages/project/dist/index.js";

/** Asserts the input fails with the frozen E_PROJECT_CONFIG_INVALID code. */
function expectConfigInvalid(fn, messagePattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ProjectConfigError, `expected ProjectConfigError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, E_PROJECT_CONFIG_INVALID);
    assert.equal(err.name, "ProjectConfigError");
    if (messagePattern) assert.match(err.message, messagePattern);
    return true;
  });
}

test("SPEC-005 §5.1.5: frozen V1 defaults match the spec block exactly", () => {
  assert.deepEqual(PROJECT_CONFIG_V1_DEFAULTS, {
    schema_version: 1,
    routing: { mode: "suggest", max_skills: 3, max_tokens: 5000 },
    namespaces: { allow: [], deny: [] },
    skills: { prefer: [], deny: [] },
    locking: { required: false },
  });
  // Deep-frozen: every level and both policy lists are immutable.
  const walk = (v) => {
    if (typeof v !== "object" || v === null) return;
    assert.ok(Object.isFrozen(v), `expected frozen: ${JSON.stringify(v)}`);
    for (const key of Object.keys(v)) walk(v[key]);
  };
  walk(PROJECT_CONFIG_V1_DEFAULTS);
});

test("SPEC-005 §5.1.5/§5.1.8: minimal and empty configs materialize to the defaults", () => {
  assert.deepEqual(parseProjectConfig("{}"), PROJECT_CONFIG_V1_DEFAULTS);
  assert.deepEqual(parseProjectConfig("schema_version: 1\n"), PROJECT_CONFIG_V1_DEFAULTS);
  assert.deepEqual(parseProjectConfig("routing:\n  mode: suggest\n"), PROJECT_CONFIG_V1_DEFAULTS);
  assert.deepEqual(parseProjectConfig("namespaces:\n  allow: []\n  deny: []\n"), PROJECT_CONFIG_V1_DEFAULTS);
});

test("SPEC-005 §5.1.8 rule 2: explicit defaults produce the SAME object as omitted fields", () => {
  const explicit = parseProjectConfig(
    "schema_version: 1\n" +
      "routing:\n  mode: suggest\n  max_skills: 3\n  max_tokens: 5000\n" +
      "namespaces:\n  allow: []\n  deny: []\n" +
      "skills:\n  prefer: []\n  deny: []\n" +
      "locking:\n  required: false\n",
  );
  assert.deepEqual(explicit, PROJECT_CONFIG_V1_DEFAULTS);
  assert.deepEqual(explicit, parseProjectConfig("{}"));
});

test("SPEC-005 §5.1.5 rule 1: only routing.mode suggest is accepted in V1", () => {
  assert.equal(parseProjectConfig("routing:\n  mode: suggest\n").routing.mode, "suggest");
  for (const mode of ["auto", "exact", "Suggest", "SUGGEST", "manual", 42, null]) {
    expectConfigInvalid(
      () => parseProjectConfig(`routing:\n  mode: ${JSON.stringify(mode)}\n`),
      /routing\.mode must be "suggest"/,
    );
  }
});

test("SPEC-005 §5.1.5 rule 4: max_skills is an integer 1–3", () => {
  assert.equal(parseProjectConfig("routing:\n  max_skills: 1\n").routing.max_skills, 1);
  assert.equal(parseProjectConfig("routing:\n  max_skills: 3\n").routing.max_skills, 3);
  for (const bad of [0, 4, -1, 1.5, "3", true, null, [3]]) {
    expectConfigInvalid(
      () => parseProjectConfig(`routing:\n  max_skills: ${JSON.stringify(bad)}\n`),
      /routing\.max_skills must be an integer 1–3/,
    );
  }
});

test("SPEC-005 §5.1.5 rule 4: max_tokens is an integer 1–1,000,000", () => {
  assert.equal(parseProjectConfig("routing:\n  max_tokens: 1\n").routing.max_tokens, 1);
  assert.equal(parseProjectConfig("routing:\n  max_tokens: 1000000\n").routing.max_tokens, 1000000);
  for (const bad of [0, -1, 1000001, 2500.5, "5000", true, null, [1]]) {
    expectConfigInvalid(
      () => parseProjectConfig(`routing:\n  max_tokens: ${JSON.stringify(bad)}\n`),
      /routing\.max_tokens must be an integer 1–1,000,000/,
    );
  }
});

test("SPEC-005 §5.1.6 rule 1: namespaces are validated with the frozen regex, never repaired", () => {
  const ok = parseProjectConfig(
    "namespaces:\n  allow: [tools, my-tools.1, a, '9start', under_score]\n  deny: [a_b]\n",
  );
  assert.deepEqual(ok.namespaces.allow, ["9start", "a", "my-tools.1", "tools", "under_score"]);
  assert.deepEqual(ok.namespaces.deny, ["a_b"]);
  // Uppercase, symbols, wrong start, and over-long namespaces are rejected —
  // NOT lowercased or repaired.
  for (const bad of ["Tools", "tool$", ".tools", "-tools", "tool space", "a".repeat(65), ""]) {
    expectConfigInvalid(
      () => parseProjectConfig(`namespaces:\n  allow: [${JSON.stringify(bad)}]\n`),
      bad === "Tools" ? /never lowercased or repaired/ : /must match \^\[a-z0-9\]/,
    );
  }
});

test("SPEC-005 §5.1.6 rule 2: skills entries must be canonical <namespace>/<portable-name>", () => {
  const ok = parseProjectConfig(
    "skills:\n  prefer: [tools/bash-runner, net/http-client]\n  deny: [tools/rm-rf]\n",
  );
  assert.deepEqual(ok.skills.prefer, ["net/http-client", "tools/bash-runner"]);
  assert.deepEqual(ok.skills.deny, ["tools/rm-rf"]);
  // Aliases and bare portable names are NOT accepted in committed policy.
  for (const bad of ["bash-runner", "my-alias", "tools/", "/bash-runner", "tools/a/b", "tools//x"]) {
    expectConfigInvalid(
      () => parseProjectConfig(`skills:\n  prefer: [${JSON.stringify(bad)}]\n`),
      /canonical <namespace>\/<portable-name>/,
    );
  }
  // Both components are validated independently.
  expectConfigInvalid(
    () => parseProjectConfig("skills:\n  prefer: [Tools/bash-runner]\n"),
    /namespace component must match/,
  );
  expectConfigInvalid(
    () => parseProjectConfig("skills:\n  prefer: [tools/Bash-Runner]\n"),
    /portable-name component must match/,
  );
  expectConfigInvalid(
    () => parseProjectConfig("skills:\n  deny: [tools/bad--name]\n"),
    /portable-name component must match/,
  );
  expectConfigInvalid(
    () => parseProjectConfig(`skills:\n  prefer: [tools/${"a".repeat(65)}]\n`),
    /portable-name component must match/,
  );
});

test("SPEC-005 §5.1.6: ASCII outer whitespace is trimmed before validation ONLY", () => {
  const ok = parseProjectConfig(
    "namespaces:\n  allow:\n    - '  tools  '\n    - \"\\tnet\\t\"\n  deny: []\n" +
      "skills:\n  prefer: [\"  tools/bash-runner\\n\"]\n  deny: []\n",
  );
  assert.deepEqual(ok.namespaces.allow, ["net", "tools"]);
  assert.deepEqual(ok.skills.prefer, ["tools/bash-runner"]);
  // Trimming is not a license to repair: uppercase still fails after the trim.
  expectConfigInvalid(
    () => parseProjectConfig("namespaces:\n  allow: ['  Tools  ']\n"),
    /never lowercased or repaired/,
  );
  expectConfigInvalid(
    () => parseProjectConfig("skills:\n  prefer: ['  bash-runner  ']\n"),
    /canonical <namespace>\/<portable-name>/,
  );
});

test("SPEC-005 §5.1.6 rule 3: policy lists are deduplicated and sorted by UTF-16 code units", () => {
  const parsed = parseProjectConfig(
    "namespaces:\n" +
      "  allow: [zeta, alpha, ' zeta ', alpha, a_b, a.b, a-b, 'a-b', a1, a]\n" +
      "  deny: [zeta, zeta]\n" +
      "skills:\n" +
      "  prefer: [tools/zzz, tools/aaa, tools/aaa, net/x, tools/zzz]\n" +
      "  deny: []\n",
  );
  // UTF-16 ascending: '-' (0x2D) < '.' (0x2E) < '_' (0x5F); 'a' < 'a1' < 'a_b' < 'alpha' < 'zeta'.
  assert.deepEqual(parsed.namespaces.allow, ["a", "a-b", "a.b", "a1", "a_b", "alpha", "zeta"]);
  assert.deepEqual(parsed.namespaces.deny, ["zeta"]);
  assert.deepEqual(parsed.skills.prefer, ["net/x", "tools/aaa", "tools/zzz"]);
});

test("SPEC-005 §5.1.6 rule 4: uninstalled namespace/skill references are valid config", () => {
  const parsed = parseProjectConfig(
    "namespaces:\n  allow: [totally-not-installed-ns]\n  deny: []\n" +
      "skills:\n  prefer: [ghost-ns/ghost-skill]\n  deny: []\n",
  );
  assert.deepEqual(parsed.namespaces.allow, ["totally-not-installed-ns"]);
  assert.deepEqual(parsed.skills.prefer, ["ghost-ns/ghost-skill"]);
});

test("SPEC-005 §5.1.5/§5.1.8: locking.required is a boolean, default false", () => {
  assert.equal(parseProjectConfig("{}").locking.required, false);
  assert.equal(parseProjectConfig("locking:\n  required: true\n").locking.required, true);
  for (const bad of ["yes", 1, null, "false"]) {
    expectConfigInvalid(
      () => parseProjectConfig(`locking:\n  required: ${JSON.stringify(bad)}\n`),
      /locking\.required must be a boolean/,
    );
  }
});

test("SPEC-005 §5.1.8: schema_version must be exactly 1", () => {
  assert.equal(parseProjectConfig("{}").schema_version, 1);
  for (const bad of [2, "1", null]) {
    expectConfigInvalid(
      () => parseProjectConfig(`schema_version: ${JSON.stringify(bad)}\n`),
      /schema_version must be 1/,
    );
  }
});

test("spec-005: unknown keys are rejected (frozen V1 schema; nothing is silently ignored)", () => {
  expectConfigInvalid(() => parseProjectConfig("profiles:\n  - dev\n"), /unsupported key "profiles"/);
  expectConfigInvalid(() => parseProjectConfig("routing:\n  strategy: fast\n"), /unsupported key "strategy"/);
  expectConfigInvalid(() => parseProjectConfig("namespaces:\n  force: [x]\n"), /unsupported key "force"/);
  expectConfigInvalid(() => parseProjectConfig("locking:\n  mode: strict\n"), /unsupported key "mode"/);
  expectConfigInvalid(() => parseProjectConfig("schema: v1\n"), /unsupported key "schema"/);
});

test("spec-005: malformed YAML and non-mapping roots fail with E_PROJECT_CONFIG_INVALID", () => {
  expectConfigInvalid(() => parseProjectConfig("routing: [unclosed\n"), /YAML parse error/);
  expectConfigInvalid(() => parseProjectConfig(": : :\n"), /YAML parse error/);
  expectConfigInvalid(() => parseProjectConfig("42\n"), /top level must be a YAML mapping/);
  expectConfigInvalid(() => parseProjectConfig("- a\n- b\n"), /top level must be a YAML mapping/);
  expectConfigInvalid(() => parseProjectConfig(""), /top level must be a YAML mapping/);
  expectConfigInvalid(() => parseProjectConfig("null\n"), /top level must be a YAML mapping/);
});

test("spec-005: duplicate YAML keys are invalid (yaml parser DUPLICATE_KEY)", () => {
  expectConfigInvalid(() => parseProjectConfig("schema_version: 1\nschema_version: 1\n"), /YAML parse error/);
  expectConfigInvalid(
    () => parseProjectConfig("routing:\n  mode: suggest\n  mode: auto\n"),
    /YAML parse error/,
  );
  expectConfigInvalid(
    () => parseProjectConfig("namespaces:\n  allow: [a]\n  allow: [b]\n"),
    /YAML parse error/,
  );
});

test("SPEC-005 §5.1.8: normalized output is deterministic, frozen, and key-stable", () => {
  const source =
    "routing:\n  max_tokens: 1200\nnamespaces:\n  deny: [zeta, aaa]\nskills:\n  prefer: [tools/bbb, tools/aaa, tools/bbb]\n";
  const first = parseProjectConfig(source);
  const second = parseProjectConfig(source);
  assert.deepEqual(second, first);
  assert.equal(second.routing.max_tokens, 1200);
  assert.equal(second.routing.max_skills, 3); // default populated
  assert.deepEqual(second.namespaces.deny, ["aaa", "zeta"]);
  assert.deepEqual(second.skills.prefer, ["tools/aaa", "tools/bbb"]);
  assert.deepEqual(Object.keys(second), ["schema_version", "routing", "namespaces", "skills", "locking"]);
  assert.deepEqual(Object.keys(second.routing), ["mode", "max_skills", "max_tokens"]);
  // Deep-frozen normalized result.
  assert.ok(Object.isFrozen(second));
  assert.ok(Object.isFrozen(second.routing));
  assert.ok(Object.isFrozen(second.namespaces.allow));
  assert.ok(Object.isFrozen(second.skills.prefer));
});

test("normalizeProjectConfigV1 validates raw parsed values directly", () => {
  assert.deepEqual(normalizeProjectConfigV1({}), PROJECT_CONFIG_V1_DEFAULTS);
  assert.deepEqual(
    normalizeProjectConfigV1({ routing: { mode: "suggest", max_skills: 2, max_tokens: 100 } }).routing,
    { mode: "suggest", max_skills: 2, max_tokens: 100 },
  );
  expectConfigInvalid(() => normalizeProjectConfigV1(null), /top level must be a YAML mapping/);
  expectConfigInvalid(() => normalizeProjectConfigV1("not-an-object"), /top level must be a YAML mapping/);
  expectConfigInvalid(() => normalizeProjectConfigV1([]), /top level must be a YAML mapping/);
  expectConfigInvalid(() => normalizeProjectConfigV1({ routing: { mode: "suggest", max_skills: 9 } }), /1–3/);
});