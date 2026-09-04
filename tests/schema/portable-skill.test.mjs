import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SchemaValidationError,
  isPortableSkillName,
  parsePortableSkill,
  validatePortableSkillName,
} from "../../packages/schema/dist/index.js";

const encoder = new TextEncoder();

function encode(text) {
  return encoder.encode(text);
}

function skillMd({
  name = "frontend-design",
  description = "Build polished frontend interfaces.",
  extra = "",
} = {}) {
  const extraBlock = extra ? `\n${extra.trimEnd()}` : "";
  return encode(
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}${extraBlock}\n---\n\n# ${name}\n`,
  );
}

function expectSchemaError(fn, code, expected = {}) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof SchemaValidationError);
    assert.equal(error.code, code);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 0);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(error[key], value);
    }
    return true;
  });
}

test("SPEC-001: a valid SKILL.md-only skill parses without source mutation", () => {
  const source = skillMd();
  const before = Uint8Array.from(source);

  const parsed = parsePortableSkill({
    directoryName: "frontend-design",
    skillMd: source,
  });

  assert.deepEqual(parsed, {
    name: "frontend-design",
    description: "Build polished frontend interfaces.",
  });
  assert.deepEqual(source, before);
  assert.equal(Object.hasOwn(parsed, "displayName"), false);
});

test("SPEC-001: optional portable fields are preserved with frozen types", () => {
  const parsed = parsePortableSkill({
    directoryName: "frontend-design",
    skillMd: skillMd({
      extra: `license: MIT\ncompatibility: Node.js 24\nmetadata:\n  owner: ega\n  stage: stable\nallowed-tools: Bash(git:*)`,
    }),
  });

  assert.deepEqual(parsed, {
    name: "frontend-design",
    description: "Build polished frontend interfaces.",
    license: "MIT",
    compatibility: "Node.js 24",
    metadata: { owner: "ega", stage: "stable" },
    allowedTools: "Bash(git:*)",
  });
});

test("SPEC-001: missing SKILL.md is structured E_SKILL_FILE_MISSING", () => {
  expectSchemaError(
    () => parsePortableSkill({ directoryName: "frontend-design" }),
    "E_SKILL_FILE_MISSING",
    { path: "frontend-design/SKILL.md" },
  );
});

test("SPEC-001: invalid UTF-8 and NUL control files fail before semantic validation", () => {
  expectSchemaError(
    () =>
      parsePortableSkill({
        directoryName: "frontend-design",
        skillMd: Uint8Array.of(0xc3, 0x28),
      }),
    "E_CONTROL_FILE_ENCODING",
    { path: "frontend-design/SKILL.md" },
  );

  expectSchemaError(
    () =>
      parsePortableSkill({
        directoryName: "frontend-design",
        skillMd: skillMd({ name: "INVALID" }),
        skillCoreMd: encode("valid\0invalid"),
      }),
    "E_CONTROL_FILE_ENCODING",
    { path: "frontend-design/SKILL.core.md" },
  );

  expectSchemaError(
    () =>
      parsePortableSkill({
        directoryName: "frontend-design",
        skillMd: skillMd(),
        egaYaml: Uint8Array.of(0xff),
      }),
    "E_CONTROL_FILE_ENCODING",
    { path: "frontend-design/ega.yaml" },
  );
});

test("SPEC-001: malformed and unknown frontmatter fields are rejected", () => {
  expectSchemaError(
    () =>
      parsePortableSkill({
        directoryName: "frontend-design",
        skillMd: encode("---\nname: [\n---\nbody\n"),
      }),
    "E_SKILL_FRONTMATTER_INVALID",
    { path: "frontend-design/SKILL.md" },
  );

  expectSchemaError(
    () =>
      parsePortableSkill({
        directoryName: "frontend-design",
        skillMd: skillMd({ extra: "future-field: nope" }),
      }),
    "E_SKILL_FRONTMATTER_INVALID",
    { path: "frontend-design/SKILL.md" },
  );
});

test("SPEC-001: portable-name validator accepts only the frozen portable grammar", () => {
  assert.equal(isPortableSkillName("frontend-design"), true);
  assert.equal(isPortableSkillName("a"), true);
  assert.equal(isPortableSkillName("a".repeat(64)), true);

  for (const value of [
    "my_skill",
    "my.skill",
    "My-skill",
    "-skill",
    "skill-",
    "skill--name",
    "a".repeat(65),
    "",
  ]) {
    assert.equal(isPortableSkillName(value), false, value);
  }

  assert.equal(validatePortableSkillName("frontend-design"), "frontend-design");
  expectSchemaError(
    () => validatePortableSkillName("my_skill"),
    "E_SKILL_NAME_INVALID",
    { field: "name" },
  );
});

test("SPEC-001: missing and invalid portable names use distinct structured codes", () => {
  expectSchemaError(
    () =>
      parsePortableSkill({
        directoryName: "frontend-design",
        skillMd: encode('---\ndescription: "desc"\n---\nbody\n'),
      }),
    "E_SKILL_NAME_REQUIRED",
    { path: "frontend-design/SKILL.md", field: "name" },
  );

  for (const name of ["my_skill", "my.skill", "UPPER", "bad--name"]) {
    expectSchemaError(
      () =>
        parsePortableSkill({
          directoryName: name,
          skillMd: skillMd({ name }),
        }),
      "E_SKILL_NAME_INVALID",
      { field: "name" },
    );
  }
});

test("SPEC-001: portable name must exactly match the skill-root directory", () => {
  expectSchemaError(
    () =>
      parsePortableSkill({
        directoryName: "frontend-design",
        skillMd: skillMd({ name: "testing" }),
      }),
    "E_SKILL_DIRECTORY_NAME_MISMATCH",
    { path: "frontend-design/SKILL.md", field: "name" },
  );
});

test("SPEC-001: description required and Unicode code-point limit is 1024", () => {
  for (const description of [undefined, "", "   "]) {
    const source =
      description === undefined
        ? encode("---\nname: frontend-design\n---\nbody\n")
        : skillMd({ description });
    expectSchemaError(
      () =>
        parsePortableSkill({
          directoryName: "frontend-design",
          skillMd: source,
        }),
      "E_SKILL_DESCRIPTION_REQUIRED",
      { path: "frontend-design/SKILL.md", field: "description" },
    );
  }

  const accepted = "😀".repeat(1024);
  assert.equal(
    parsePortableSkill({
      directoryName: "frontend-design",
      skillMd: skillMd({ description: accepted }),
    }).description,
    accepted,
  );

  expectSchemaError(
    () =>
      parsePortableSkill({
        directoryName: "frontend-design",
        skillMd: skillMd({ description: "😀".repeat(1025) }),
      }),
    "E_SKILL_DESCRIPTION_TOO_LARGE",
    { path: "frontend-design/SKILL.md", field: "description" },
  );
});

test("SPEC-001: optional portable metadata type violations are frontmatter errors", () => {
  expectSchemaError(
    () =>
      parsePortableSkill({
        directoryName: "frontend-design",
        skillMd: skillMd({ extra: "metadata:\n  owner: 123" }),
      }),
    "E_SKILL_FRONTMATTER_INVALID",
    { path: "frontend-design/SKILL.md" },
  );
});
