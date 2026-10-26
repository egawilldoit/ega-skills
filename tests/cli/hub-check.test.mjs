import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { extractSelectedRootsFromGit, parseSourcesYaml, sourceConfigDigest } from "../../packages/project/dist/index.js";

const cli = fileURLToPath(new URL("../../packages/cli/bin/ega-skills.mjs", import.meta.url));

function assertRejected(result, message) {
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), `${message}\nRun "ega-skills --help" for usage.`);
}

function snapshot(dir) {
  const files = {};
  const walk = (base, prefix = "") => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) walk(join(base, entry.name), rel + "/");
      else files[rel] = createHash("sha256").update(readFileSync(join(base, entry.name))).digest("hex");
    }
  };
  walk(dir);
  return files;
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "ega-cli-check-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo"), hub = join(base, "hub"), tree = join(hub, "external/upstream/repo");
  mkdirSync(repo); mkdirSync(tree, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "core.autocrlf=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(repo, "skills", name), { recursive: true });
    writeFileSync(join(repo, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill.\n---\n\nGuidance.\n`);
    writeFileSync(join(repo, "skills", name, "ega.yaml"), "schema_version: 1\n");
  }
  writeFileSync(join(repo, "LICENSE"), "Test license\n");
  git("add", "."); git("commit", "-qm", "Initial");
  const commit = git("rev-parse", "HEAD");
  const repository = pathToFileURL(repo).href;
  const config = (roots = ["skills/alpha"], overrides = {}) => JSON.stringify({ schema_version: 1, sources: { upstream: { type: "git", repository, ref: "main", namespace: "upstream", selection: { roots }, provenance_files: ["LICENSE"], ...overrides } } });
  const adopted = extractSelectedRootsFromGit(repo, commit, ["skills/alpha"], ["LICENSE"], tree);
  writeFileSync(join(hub, "hub.yaml"), JSON.stringify({ schema_version: 1, hub: { id: "check-test" }, owned: [], external: [{ source: "upstream" }] }));
  writeFileSync(join(hub, "sources.yaml"), config());
  const lock = { schema_version: 1, sources: { upstream: {
    source_config_digest: sourceConfigDigest(parseSourcesYaml(config()).sources.upstream),
    repository, requested_ref: "main", namespace: "upstream", selection: { roots: ["skills/alpha"] }, provenance_files: ["LICENSE"],
    resolved_commit: commit, selected_skill_tree_digest: adopted.treeDigest, vendored_snapshot_digest: adopted.snapshotDigest, extraction_contract: 1,
  } } };
  const writeLock = () => writeFileSync(join(hub, "sources.lock.yaml"), JSON.stringify(lock));
  writeLock();
  const propose = (roots, overrides) => writeFileSync(join(hub, "sources.yaml"), config(roots, overrides));
  const check = () => {
    const before = snapshot(hub);
    const output = join(base, "plan.json");
    const result = spawnSync(process.execPath, [cli, "hub", "check", "upstream", hub, "--output", output], { encoding: "utf8" });
    assert.deepEqual(snapshot(hub), before, "read-only check mutated adopted Hub or proposal");
    return { ...result, output };
  };
  return { repo, hub, tree, commit, git, lock, writeLock, propose, check };
}

test("hub check unchanged source is NO_CHANGE and read-only", (t) => {
  const f = fixture(t), result = f.check();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "NO_CHANGE");
});

test("hub check reports an ordinary metadata-only update", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "skills/alpha/ega.yaml"), "schema_version: 1\ndomains: [architecture]\n");
  f.git("add", "."); f.git("commit", "-qm", "Metadata");
  const result = f.check();
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(result.output));
  assert.deepEqual(plan.payload.changed_skills.map(row => row.skill_ref), ["upstream/alpha"]);
  assert.equal(plan.payload.expected_old.resolved_commit, f.commit);
  assert.equal(plan.payload.target_commit, f.git("rev-parse", "HEAD"));
});

test("hub check adds one newly selected root absent from the old snapshot", (t) => {
  const f = fixture(t);
  f.propose(["skills/alpha", "skills/beta"]);
  const result = f.check();
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(result.output));
  assert.equal(plan.payload.target_commit, f.commit);
  assert.deepEqual(plan.payload.added_skills.map(row => row.skill_ref), ["upstream/beta"]);
  assert.deepEqual(plan.payload.removed_skills, []);
  assert.deepEqual(plan.payload.changed_skills, []);
  assert.equal(plan.payload.expected_old.selected_skill_tree_digest, f.lock.sources.upstream.selected_skill_tree_digest);
});

for (const root of ["skills/missing", "../escape"]) {
  test(`hub check rejects invalid proposed root ${root}`, (t) => {
    const f = fixture(t); f.propose([root]);
    const result = f.check();
    assertRejected(result, root === "skills/missing"
      ? "declared path missing upstream: skills/missing"
      : "sources.yaml source upstream root must be a repository-relative posix path: ../escape");
  });
}

for (const corrupt of ["skill", "provenance", "digest", "lock-identity"]) {
  test(`hub check rejects corrupt adopted ${corrupt} despite proposed selection change`, (t) => {
    const f = fixture(t); f.propose(["skills/alpha", "skills/beta"]);
    if (corrupt === "skill") writeFileSync(join(f.tree, "skills/alpha/SKILL.md"), "tampered");
    if (corrupt === "provenance") writeFileSync(join(f.tree, "LICENSE"), "tampered");
    if (corrupt === "digest") f.lock.sources.upstream.selected_skill_tree_digest = `sha256:${"0".repeat(64)}`;
    if (corrupt === "lock-identity") f.lock.sources.upstream.selection.roots = ["skills/beta"];
    f.writeLock();
    const result = f.check();
    assertRejected(result, corrupt === "lock-identity"
      ? "sources.lock.yaml source upstream source_config_digest mismatch"
      : "adopted tree for upstream no longer matches its lock digests");
  });
}

for (const overrides of [{ namespace: "other" }, { repository: "https://example.test/replaced.git" }]) {
  test(`hub check rejects source identity substitution ${Object.keys(overrides)[0]}`, (t) => {
    const f = fixture(t); f.propose(["skills/alpha", "skills/beta"], overrides);
    const result = f.check();
    assertRejected(result, "hub check cannot substitute an adopted source repository or namespace");
  });
}
