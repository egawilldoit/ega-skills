import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HubError,
  checkForUpdates,
  canonicalSourceManifestDigest,
  digestStagedTree,
  discoverUnselectedSkills,
  discoverUnselectedSkillsFromGit,
  extractSelectedRoots,
  extractSelectedRootsFromGit,
  fetchExactCommit,
  fetchRefTip,
  parseSourcesYaml,
  resolveRefToCommit,
  sourceConfigDigest,
} from "../../packages/project/dist/index.js";
import { canonicalizeJson, sha256Hex, verifyEnvelope } from "../../packages/hashing/dist/index.js";

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

test("Contract A source digest uses the independent canonical manifest preimage", () => {
  const entries = [
    { path: "skills/b/SKILL.md", kind: "file", blob_sha256: `sha256:${"b".repeat(64)}` },
    { path: "LICENSE", kind: "file", blob_sha256: `sha256:${"a".repeat(64)}` },
  ];
  const expected = `sha256:${sha256Hex(canonicalizeJson([
    entries[1],
    entries[0],
  ]))}`;
  assert.equal(canonicalSourceManifestDigest(entries), expected);
  assert.equal(
    canonicalSourceManifestDigest([
      { ...entries[0], scope: "selected" },
      { ...entries[1], scope: "provenance" },
    ]),
    expected,
    "implementation-only scope metadata must not enter the Contract A preimage",
  );
});

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

test("selected parent roots discover nested skills without adopting outside roots", async () => {
  const { dir, shaA, shaB } = makeFixtureRepo();
  const cfg = parseSourcesYaml(SOURCES_YAML.replace("PLACEHOLDER", dir).replace(/        - skills\/alpha\n        - skills\/beta\n        - skills\/gamma/, "        - skills"));
  const src = cfg.sources.plan;
  const adoptedTree = adoptedTreeAt(dir, shaA, ["skills"], src.provenanceFiles);
  const work = mkdtempSync(join(tmpdir(), "ega-plan-parent-root-"));
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
  assert.equal(res.plan.payload.target_commit, shaB);
  assert.deepEqual(res.plan.payload.added_skills.map((entry) => entry.skill_ref), ["plan/delta", "plan/gamma"]);
  assert.ok(!res.plan.payload.unselected_new_skills.includes("skills/delta"));
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
  const extracted = mkdtempSync(join(tmpdir(), "ega-fetch-out-"));
  extractSelectedRootsFromGit(dest, shaA, ["skills/alpha"], [], extracted);
  assert.equal(readFileSync(join(extracted, "skills", "alpha", "SKILL.md"), "utf8").includes("Alpha body A."), true);
});

test("branch wins over same-named annotated tag (fetch precedence)", () => {
  const { dir, shaA, shaB } = makeFixtureRepo();
  git(dir, "tag", "-a", "-m", "release A", "release", shaA);
  git(dir, "branch", "-f", "release", shaB);
  assert.equal(resolveRefToCommit(dir, "release"), shaB);
  const dest = mkdtempSync(join(tmpdir(), "ega-fetch-"));
  fetchRefTip(dir, "release", shaB, dest);
  const extracted = mkdtempSync(join(tmpdir(), "ega-fetch-out-"));
  extractSelectedRootsFromGit(dest, shaB, ["skills/beta"], [], extracted);
  assert.equal(readFileSync(join(extracted, "skills", "beta", "SKILL.md"), "utf8").includes("Beta body B, changed."), true);
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

test("fetchExactCommit ignores a later movement of the tracked branch", () => {
  const { dir, shaB } = makeFixtureRepo();
  writeFileSync(join(dir, "skills", "beta", "SKILL.md"), skill("beta", "Beta body C, moved tip."));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "C");
  const shaC = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.notEqual(shaC, shaB);
  const dest = mkdtempSync(join(tmpdir(), "ega-fetch-exact-"));
  fetchExactCommit(dir, shaB, dest);
  const extracted = mkdtempSync(join(tmpdir(), "ega-fetch-out-"));
  const tree = extractSelectedRootsFromGit(dest, shaB, ["skills/beta"], [], extracted);
  assert.equal(tree.manifest[0].path, "skills/beta/SKILL.md");
  assert.equal(readFileSync(join(extracted, "skills", "beta", "SKILL.md"), "utf8"), skill("beta", "Beta body B, changed."));
});

test("verified ref fallback materializes the approved commit, never the moving ref tip", () => {
  const { dir, shaB } = makeFixtureRepo();
  writeFileSync(join(dir, "skills", "beta", "SKILL.md"), skill("beta", "Beta body C, moved tip."));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "C");
  const shaC = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dest = mkdtempSync(join(tmpdir(), "ega-fetch-fallback-"));

  fetchExactCommit(dir, shaB, dest, { fallbackRef: "main", forceRefFallback: true });

  execFileSync("git", ["-C", dest, "cat-file", "-e", `${shaB}^{commit}`], { stdio: "pipe" });
  assert.notEqual(shaC, shaB);
  const extracted = mkdtempSync(join(tmpdir(), "ega-fetch-out-"));
  extractSelectedRootsFromGit(dest, shaB, ["skills/beta"], [], extracted);
  assert.equal(readFileSync(join(extracted, "skills", "beta", "SKILL.md"), "utf8"), skill("beta", "Beta body B, changed."));
});

test("exact-commit fallback fails closed for unavailable or malformed approvals", () => {
  const { dir } = makeFixtureRepo();
  const unavailable = mkdtempSync(join(tmpdir(), "ega-fetch-unavailable-"));
  assert.throws(
    () => fetchExactCommit(dir, "f".repeat(40), unavailable, { fallbackRef: "main", forceRefFallback: true }),
    (error) => error instanceof HubError && error.code === "E_PLAN_FETCH" && /could not acquire approved commit/.test(error.message),
  );

  const malformed = mkdtempSync(join(tmpdir(), "ega-fetch-malformed-"));
  assert.throws(
    () => fetchExactCommit(dir, "not-a-commit", malformed, { fallbackRef: "main", forceRefFallback: true }),
    (error) => error instanceof HubError && error.code === "E_PLAN_FETCH" && /40 lowercase hex/.test(error.message),
  );

  const missingFallback = mkdtempSync(join(tmpdir(), "ega-fetch-no-fallback-"));
  const { shaB } = makeFixtureRepo();
  assert.throws(
    () => fetchExactCommit(dir, shaB, missingFallback, { forceRefFallback: true }),
    (error) => error instanceof HubError && error.code === "E_PLAN_FETCH" && /no verified fallback ref/.test(error.message),
  );
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

test("overlapping selected and provenance declarations form one canonical set", () => {
  const { dir } = makeFixtureRepo();
  const dest = mkdtempSync(join(tmpdir(), "ega-overlap-"));
  const extracted = extractSelectedRoots(dir, ["skills/alpha"], ["skills/alpha/SKILL.md"], dest);
  assert.deepEqual(extracted.manifest.map((entry) => entry.path), ["skills/alpha/SKILL.md"]);
  const staged = digestStagedTree(dest, ["skills/alpha"]);
  assert.equal(extracted.treeDigest, staged.treeDigest);
  assert.equal(extracted.snapshotDigest, staged.snapshotDigest);
});

test("raw Git extraction bypasses smudge/LFS filters and hashes committed bytes", () => {
  const repo = mkdtempSync(join(tmpdir(), "ega-raw-git-"));
  const marker = join(repo, "filter-marker");
  const filter = join(repo, "fake-filter.cjs");
  writeFileSync(filter, "process.stdin.pipe(process.stdout); process.stdin.on('end', () => { require('node:fs').writeFileSync(process.env.EGA_FILTER_MARKER, 'ran'); });\n");
  git(repo, "init", "-b", "main");
  mkdirSync(join(repo, "skills", "raw"), { recursive: true });
  const rawSkill = Buffer.from(skill("raw", "raw bytes\n"));
  const rawAsset = Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n");
  writeFileSync(join(repo, "skills", "raw", "SKILL.md"), rawSkill);
  writeFileSync(join(repo, "skills", "raw", "asset.bin"), rawAsset);
  writeFileSync(join(repo, "LICENSE"), Buffer.from("raw license\r\n"));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "raw fixture");
  // Add attributes only after the content commit. This prevents a developer
  // or CI-installed filter.lfs.clean from changing the committed test bytes.
  writeFileSync(join(repo, ".gitattributes"), "skills/raw/SKILL.md filter=fake\nskills/raw/asset.bin filter=lfs\nLICENSE filter=fake\n");
  git(repo, "add", ".gitattributes");
  git(repo, "commit", "-qm", "raw filter attributes");
  const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const filterCommand = `"${process.execPath.replaceAll('"', '\\"')}" "${filter.replaceAll('"', '\\"')}"`;
  execFileSync("git", ["-C", repo, "config", "filter.fake.smudge", filterCommand], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "filter.lfs.smudge", filterCommand], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "core.autocrlf", "true"], { stdio: "pipe" });

  // Control: the old checkout-based source path executes the configured filter.
  rmSync(join(repo, "skills"), { force: true, recursive: true });
  rmSync(join(repo, "LICENSE"), { force: true });
  execFileSync("git", ["-C", repo, "checkout", "--force", commit], {
    env: { ...process.env, EGA_FILTER_MARKER: marker },
    stdio: "pipe",
  });
  assert.equal(existsSync(marker), true, "checkout control must demonstrate the old smudge hazard");
  rmSync(marker, { force: true });

  const dest = mkdtempSync(join(tmpdir(), "ega-raw-out-"));
  const extracted = extractSelectedRootsFromGit(repo, commit, ["skills/raw"], ["LICENSE"], dest);
  assert.equal(existsSync(marker), false, "raw extraction must not invoke any smudge filter");
  assert.deepEqual(readFileSync(join(dest, "skills", "raw", "SKILL.md")), rawSkill);
  assert.deepEqual(readFileSync(join(dest, "skills", "raw", "asset.bin")), rawAsset);
  assert.deepEqual(readFileSync(join(dest, "LICENSE")), Buffer.from("raw license\r\n"));
  const expected = `sha256:${sha256Hex(canonicalizeJson([
    { path: "skills/raw/SKILL.md", kind: "file", blob_sha256: `sha256:${sha256Hex(rawSkill)}` },
    { path: "skills/raw/asset.bin", kind: "file", blob_sha256: `sha256:${sha256Hex(rawAsset)}` },
  ]))}`;
  assert.equal(extracted.treeDigest, expected);
  assert.equal(extracted.manifest.every((entry) => !Object.hasOwn(entry, "scope")), false, "scope may remain internal metadata");
  assert.equal(extracted.manifest.some((entry) => entry.path === "LICENSE"), true);
});

test("frozen Contract B example plan still verifies (no drift)", () => {
  const doc = JSON.parse(readFileSync(new URL("../../scripts/contracts/examples/contract-b/update-plan.json", import.meta.url), "utf8"));
  assert.equal(verifyEnvelope(doc).ok, true);
});
