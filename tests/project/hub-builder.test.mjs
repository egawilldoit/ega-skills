import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HubError,
  buildHub,
  digestStagedTree,
  parseSourcesYaml,
  sourceConfigDigest,
  writeJournal,
} from "../../packages/project/dist/index.js";
import { importSkills, openRegistry } from "../../packages/registry/dist/index.js";

function skill(name, body) {
  return `---\nname: ${name}\ndescription: ${name} skill for builder tests.\n---\n\n${body}\n`;
}

function writeSkillFiles(base, skills) {
  for (const { name, body, dir } of skills) {
    const d = join(base, ...(dir ?? [name]).map((s) => s));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), skill(name, body));
  }
}

/**
 * Hub with owned ega/reviewer + external plan (roots skills/alpha,
 * skills/beta; LICENSE provenance). Lock digests are real.
 */
function setupBuildHub(beforeLock, afterLock) {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-build-hub-"));
  mkdirSync(join(hubDir, "owned", "ega", "reviewer"), { recursive: true });
  writeFileSync(join(hubDir, "owned", "ega", "reviewer", "SKILL.md"), skill("reviewer", "Review body."));
  writeFileSync(join(hubDir, "owned", "ega", "reviewer", "ega.yaml"), "schema_version: 1\n");
  mkdirSync(join(hubDir, "owned", "mirror"), { recursive: true });
  const treeBase = join(hubDir, "trees", "plan");
  writeSkillFiles(treeBase, [
    { body: "Alpha body.", dir: ["skills", "alpha"], name: "alpha" },
    { body: "Beta body.", dir: ["skills", "beta"], name: "beta" },
  ]);
  writeFileSync(join(treeBase, "LICENSE"), "License.\n");
  if (beforeLock) beforeLock(hubDir, treeBase);
  const sourcesYaml =
    "schema_version: 1\nsources:\n  plan:\n    type: git\n    repository: https://example.com/plan\n    ref: main\n    namespace: plan\n    selection:\n      roots:\n        - skills/alpha\n        - skills/beta\n    provenance_files:\n      - LICENSE\n";
  writeFileSync(join(hubDir, "sources.yaml"), sourcesYaml);
  writeFileSync(
    join(hubDir, "hub.yaml"),
    "schema_version: 1\nhub:\n  id: personal\nowned:\n  - path: owned/ega\n    namespace: ega\n  - path: owned/mirror\n    namespace: plan\nexternal:\n  - source: plan\n",
  );
  const cfg = parseSourcesYaml(sourcesYaml).sources["plan"];
  const tree = digestStagedTree(treeBase, cfg.selection.roots);
  const lock = {
    schema_version: 1,
    sources: {
      plan: {
        source_config_digest: sourceConfigDigest(cfg),
        repository: "https://example.com/plan",
        requested_ref: "main",
        namespace: "plan",
        selection: { roots: ["skills/alpha", "skills/beta"] },
        provenance_files: ["LICENSE"],
        resolved_commit: "a".repeat(40),
        selected_skill_tree_digest: tree.treeDigest,
        vendored_snapshot_digest: tree.snapshotDigest,
        extraction_contract: 1,
      },
    },
  };
  writeFileSync(join(hubDir, "sources.lock.yaml"), JSON.stringify(lock, null, 2));
  if (afterLock) afterLock(hubDir, treeBase);
  return hubDir;
}

function codeOf(fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        throw new Error("expected HubError, succeeded");
      },
      (e) => {
        assert.ok(e instanceof HubError, `expected HubError, got ${e}`);
        return e.code;
      },
    );
}

test("happy path builds the exact catalog into an isolated registry", async () => {
  const hubDir = setupBuildHub();
  const out = await buildHub(hubDir);
  assert.deepEqual(
    out.skills.map((s) => s.skillId),
    ["ega/reviewer", "plan/alpha", "plan/beta"],
  );
  for (const s of out.skills) assert.match(s.versionHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(existsSync(join(out.registryHome, "registry.sqlite")));
});

test("developer registry history cannot leak into the build", async () => {
  const decoy = mkdtempSync(join(tmpdir(), "ega-decoy-home-"));
  const registry = openRegistry({ env: { EGA_SKILLS_HOME: decoy }, userHome: tmpdir() });
  try {
    const junk = mkdtempSync(join(tmpdir(), "ega-junk-"));
    writeSkillFiles(junk, [{ body: "Junk.", dir: ["junk"], name: "junk" }]);
    const summary = await importSkills(registry, { namespace: "junk", path: junk });
    assert.equal(summary.failed, 0);
  } finally {
    registry.close();
  }
  const prev = process.env.EGA_SKILLS_HOME;
  process.env.EGA_SKILLS_HOME = decoy;
  try {
    const out = await buildHub(setupBuildHub());
    assert.deepEqual(
      out.skills.map((s) => s.skillId),
      ["ega/reviewer", "plan/alpha", "plan/beta"],
    );
  } finally {
    if (prev === undefined) delete process.env.EGA_SKILLS_HOME;
    else process.env.EGA_SKILLS_HOME = prev;
  }
});

test("import failure fails the build (E_BUILD_ATTESTATION)", async () => {
  // Mutated BEFORE the lock so digests stay consistent: the failure must
  // surface at import with zero tolerance, not as a digest mismatch.
  const hubDir = setupBuildHub((dir) => {
    writeFileSync(join(dir, "trees", "plan", "skills", "beta", "SKILL.md"), "---\nname: beta\n---\nNo description.\n");
  });
  assert.equal(await codeOf(() => buildHub(hubDir)), "E_BUILD_ATTESTATION");
});

test("duplicate canonical IDs fail the build (E_BUILD_ATTESTATION)", async () => {
  // owned/mirror/alpha claims plan/alpha, colliding with the adopted source.
  const hubDir = setupBuildHub(undefined, (dir) => {
    mkdirSync(join(dir, "owned", "mirror", "alpha"), { recursive: true });
    writeFileSync(join(dir, "owned", "mirror", "alpha", "SKILL.md"), skill("alpha", "Owned impostor."));
  });
  assert.equal(await codeOf(() => buildHub(hubDir)), "E_BUILD_ATTESTATION");
});

test("incomplete journal blocks the build (E_RECOVERY_REQUIRED)", async () => {
  const hubDir = setupBuildHub();
  writeJournal(hubDir, {
    backup: ".backup",
    expected_old_commit: "a".repeat(40),
    journal_version: 1,
    source_id: "plan",
    staging: ".staging",
    state: "PREPARED",
    target_commit: "b".repeat(40),
  });
  assert.equal(await codeOf(() => buildHub(hubDir)), "E_RECOVERY_REQUIRED");
});

test("tampered tree fails provenance verification (E_TREE_DIGEST)", async () => {
  const hubDir = setupBuildHub(undefined, (dir) => {
    writeFileSync(join(dir, "trees", "plan", "LICENSE"), "Forged.\n");
  });
  assert.equal(await codeOf(() => buildHub(hubDir)), "E_TREE_DIGEST");
});

test("empty hub builds an empty catalog", async () => {
  const hubDir = mkdtempSync(join(tmpdir(), "ega-build-hub-"));
  mkdirSync(join(hubDir, "owned", "ega"), { recursive: true });
  writeFileSync(join(hubDir, "hub.yaml"), "schema_version: 1\nhub:\n  id: personal\nowned:\n  - path: owned/ega\n    namespace: ega\nexternal: []\n");
  writeFileSync(join(hubDir, "sources.yaml"), "schema_version: 1\nsources: {}\n");
  writeFileSync(join(hubDir, "sources.lock.yaml"), "schema_version: 1\nsources: {}\n");
  const out = await buildHub(hubDir);
  assert.deepEqual(out.skills, []);
});

test("local git history is irrelevant to builders (sanity)", () => {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
});
