import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HubError,
  checkForUpdates,
  discoverUnselectedSkills,
  extractSelectedRoots,
  fetchRefTip,
  parseSourcesYaml,
  resolveRefToCommit,
  sourceConfigDigest,
} from "../../packages/project/dist/index.js";
import { verifyEnvelope } from "../../packages/hashing/dist/index.js";

const SOURCES_YAML = `schema_version: 1
sources:
  plan:
    type: git
    repository: PLACEHOLDER
    ref: main
    namespace: plan
    selection:
      roots:
        - skills/alpha
        - skills/beta
        - skills/gamma
    provenance_files:
      - LICENSE
`;

function git(dir, ...args) {
  execFileSync("git", ["-C", dir, "-c", "user.name=plan", "-c", "user.email=plan@t", "-c", "core.autocrlf=false", ...args], { stdio: "pipe" });
}

function skill(name, body) {
  return `---\nname: ${name}\ndescription: ${name} skill for planning tests.\n---\n\n${body}\n`;
}

/** Builds a local git repo with commit A (alpha+beta) then commit B (beta changed, gamma+delta added). */
function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ega-plan-repo-"));
  git(dir, "init", "-b", "main");
  mkdirSync(join(dir, "skills", "alpha"), { recursive: true });
  mkdirSync(join(dir, "skills", "beta"), { recursive: true });
  writeFileSync(join(dir, "skills", "alpha", "SKILL.md"), skill("alpha", "Alpha body A."));
  writeFileSync(join(dir, "skills", "beta", "SKILL.md"), skill("beta", "Beta body A."));
  writeFileSync(join(dir, "LICENSE"), "License A.\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "A");
  const shaA = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "skills", "beta", "SKILL.md"), skill("beta", "Beta body B, changed."));
  mkdirSync(join(dir, "skills", "gamma"), { recursive: true });
  writeFileSync(join(dir, "skills", "gamma", "SKILL.md"), skill("gamma", "Gamma body B."));
  mkdirSync(join(dir, "skills", "delta"), { recursive: true });
  writeFileSync(join(dir, "skills", "delta", "SKILL.md"), skill("delta", "Delta body B, unselected."));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "B");
  const shaB = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, shaA, shaB };
}

function loadConfig(repoDir) {
  const cfg = parseSourcesYaml(SOURCES_YAML.replace("PLACEHOLDER", repoDir));
  return { cfg, src: cfg.sources["plan"] };
}

/** Extracts the adopted tree at an exact commit via an isolated clone. */
function adoptedTreeAt(repoDir, rev, roots, provenanceFiles) {
  const clone = mkdtempSync(join(tmpdir(), "ega-plan-adopt-"));
  const dest = mkdtempSync(join(tmpdir(), "ega-adopt-"));
  try {
    execFileSync("git", ["clone", "-q", repoDir, clone], { stdio: "pipe" });
    execFileSync("git", ["-C", clone, "checkout", "-q", rev], { stdio: "pipe" });
    return extractSelectedRoots(clone, roots, provenanceFiles, dest);
  } finally {
    rmSync(clone, { force: true, recursive: true });
    rmSync(dest, { force: true, recursive: true });
  }
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

test("resolveRefToCommit pins the exact tip", () => {
  const { dir, shaB } = makeFixtureRepo();
  assert.equal(resolveRefToCommit(dir, "main"), shaB);
});

test("NO_CHANGE when adopted equals upstream tip", async () => {
  const { dir, shaB } = makeFixtureRepo();
  const { src } = loadConfig(dir);
  const work = mkdtempSync(join(tmpdir(), "ega-plan-work-"));
  const res = await checkForUpdates({
    adopted: { commit: shaB, snapshotDigest: "sha256:0", treeDigest: "sha256:0", versions: {} },
    config: src,
    sourceId: "plan",
    workDir: work,
  });
  // NOTE: adopted digests are bogus here, but equal-commit short-circuits
  // before any fetch: the same commit cannot yield changes.
  assert.equal(res.status, "NO_CHANGE");
  assert.equal(res.targetCommit, shaB);
});

test("UPDATE_AVAILABLE carries exact commit, change sets, and a verifying digest", async () => {
  const { dir, shaA, shaB } = makeFixtureRepo();
  const { cfg, src } = loadConfig(dir);
  const work = mkdtempSync(join(tmpdir(), "ega-plan-work-"));
  // Adopted tree state for the exact commit A (isolated clone at shaA, using
  // only the roots that exist at A): the NO_CHANGE path matches these digests
  // if check ever targets A again.
  const adoptedTree = adoptedTreeAt(dir, shaA, ["skills/alpha", "skills/beta"], src.provenanceFiles);
  const res = await checkForUpdates({
    adopted: {
      commit: shaA,
      snapshotDigest: adoptedTree.snapshotDigest,
      treeDigest: adoptedTree.treeDigest,
      versions: { "plan/alpha": "sha256:aa", "plan/beta": "sha256:bb" },
    },
    config: src,
    sourceId: "plan",
    workDir: work,
  });
  assert.equal(res.status, "UPDATE_AVAILABLE");
  const plan = res.plan;
  assert.equal(plan.object_type, "ega.update-plan");
  assert.equal(plan.payload.target_commit, shaB);
  assert.equal(plan.payload.source_config_digest, sourceConfigDigest(src));
  assert.ok(!("target_ref" in plan.payload) && !("ref" in plan.payload) && !("branch" in plan.payload));
  const added = plan.payload.added_skills.map((s) => s.skill_ref);
  assert.ok(added.includes("plan/gamma"), `gamma added, got ${added}`);
  assert.ok(!added.includes("plan/delta") && !JSON.stringify(plan.payload).includes("plan/delta"), "unselected delta never adopted");
  const beta = plan.payload.changed_skills.find((s) => s.skill_ref === "plan/beta");
  assert.ok(beta, "beta changed");
  assert.equal(beta.old_version, "sha256:bb");
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(beta.new_version) && beta.new_version !== "sha256:bb");
  assert.equal(beta.raw_changed, true);
  assert.ok(plan.payload.unselected_new_skills.includes("skills/delta"), "delta reported, not adopted");
  const v = verifyEnvelope(plan);
  assert.equal(v.ok, true);
  assert.ok(cfg);
});

test("plan change lists are sorted by skill_ref (Contract B set-list rule)", async () => {
  const { dir, shaA } = makeFixtureRepo();
  const { src } = loadConfig(dir);
  const work = mkdtempSync(join(tmpdir(), "ega-plan-work-"));
  const zeros = `sha256:${"00".repeat(32)}`;
  // Reverse insertion order on purpose: output must still be sorted.
  const res = await checkForUpdates({
    adopted: {
      commit: shaA,
      snapshotDigest: zeros,
      treeDigest: zeros,
      versions: { "plan/beta": zeros, "plan/alpha": zeros, "plan/zulu": zeros },
    },
    config: src,
    sourceId: "plan",
    workDir: work,
  });
  assert.equal(res.status, "UPDATE_AVAILABLE");
  assert.deepEqual(
    res.plan.payload.changed_skills.map((s) => s.skill_ref),
    ["plan/alpha", "plan/beta"],
  );
  assert.deepEqual(
    res.plan.payload.removed_skills.map((s) => s.skill_ref),
    ["plan/zulu"],
  );
  assert.deepEqual(
    res.plan.payload.added_skills.map((s) => s.skill_ref),
    ["plan/gamma"],
  );
});

test("symlink escape fails E_EXTRACTION_POLICY", () => {
  const { dir } = makeFixtureRepo();
  symlinkSync(join(dir, "LICENSE"), join(dir, "skills", "alpha", "evil.md"));
  assert.throws(() => extractSelectedRoots(dir, ["skills/alpha"], [], mkdtempSync(join(tmpdir(), "ega-x-"))), (e) => e instanceof HubError && e.code === "E_EXTRACTION_POLICY");
});

test(".gitmodules fails E_EXTRACTION_POLICY", () => {
  const { dir } = makeFixtureRepo();
  writeFileSync(join(dir, "skills", "alpha", ".gitmodules"), "[submodule]\n");
  assert.throws(() => extractSelectedRoots(dir, ["skills/alpha"], [], mkdtempSync(join(tmpdir(), "ega-x-"))), (e) => e instanceof HubError && e.code === "E_EXTRACTION_POLICY");
});

test("annotated tags resolve to the peeled commit", () => {
  const { dir, shaA } = makeFixtureRepo();
  git(dir, "tag", "-a", "-m", "release A", "v1", shaA);
  assert.equal(resolveRefToCommit(dir, "v1"), shaA);
  const dest = mkdtempSync(join(tmpdir(), "ega-fetch-"));
  fetchRefTip(dir, "v1", shaA, dest);
  assert.equal(readFileSync(join(dest, "skills", "alpha", "SKILL.md"), "utf8").includes("Alpha body A."), true);
});

test("branch wins over same-named annotated tag (fetch precedence)", () => {
  const { dir, shaA, shaB } = makeFixtureRepo();
  git(dir, "tag", "-a", "-m", "release A", "release", shaA);
  git(dir, "branch", "-f", "release", shaB);
  assert.equal(resolveRefToCommit(dir, "release"), shaB);
  const dest = mkdtempSync(join(tmpdir(), "ega-fetch-"));
  fetchRefTip(dir, "release", shaB, dest);
  assert.equal(readFileSync(join(dest, "skills", "beta", "SKILL.md"), "utf8").includes("Beta body B, changed."), true);
});

test("successful checks leave no temp directories behind", async () => {
  const { dir, shaA } = makeFixtureRepo();
  const { src } = loadConfig(dir);
  const work = mkdtempSync(join(tmpdir(), "ega-plan-work-"));
  const adoptedTree = adoptedTreeAt(dir, shaA, ["skills/alpha", "skills/beta"], src.provenanceFiles);
  const res = await checkForUpdates({
    adopted: {
      commit: shaA,
      snapshotDigest: adoptedTree.snapshotDigest,
      treeDigest: adoptedTree.treeDigest,
      versions: { "plan/alpha": "sha256:aa", "plan/beta": "sha256:bb" },
    },
    config: src,
    sourceId: "plan",
    workDir: work,
  });
  assert.equal(res.status, "UPDATE_AVAILABLE");
  assert.deepEqual(readdirSync(work), []);
});

test("fetch tip mismatch fails E_PLAN_FETCH (upstream moved during check)", async () => {
  const { dir, shaA } = makeFixtureRepo();
  const dest = mkdtempSync(join(tmpdir(), "ega-fetch-"));
  assert.equal(await codeOf(() => Promise.resolve(fetchRefTip(dir, "main", shaA, dest))), "E_PLAN_FETCH");
});

test("discoverUnselectedSkills reports outside roots only", () => {
  const { dir } = makeFixtureRepo();
  assert.deepEqual(discoverUnselectedSkills(dir, ["skills/alpha", "skills/beta", "skills/gamma"]), ["skills/delta"]);
});

test("extraction is deterministic across runs", () => {
  const { dir } = makeFixtureRepo();
  const { src } = loadConfig(dir);
  const a = extractSelectedRoots(dir, src.selection.roots, src.provenanceFiles, mkdtempSync(join(tmpdir(), "ega-x-")));
  const b = extractSelectedRoots(dir, src.selection.roots, src.provenanceFiles, mkdtempSync(join(tmpdir(), "ega-x-")));
  assert.equal(a.treeDigest, b.treeDigest);
  assert.deepEqual(a.manifest, b.manifest);
});

test("frozen Contract B example plan still verifies (no drift)", () => {
  const doc = JSON.parse(readFileSync(new URL("../../scripts/contracts/examples/contract-b/update-plan.json", import.meta.url), "utf8"));
  assert.equal(verifyEnvelope(doc).ok, true);
});
