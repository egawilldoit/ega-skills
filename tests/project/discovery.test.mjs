// SPEC-005 §5.1.1–§5.1.4 exact project discovery (EGA-582).
//
// Covers the normative edge-fixture inventory (§5.1.4): normal repo, worktree
// (`.git` file), nested repo, monorepo package, file-as-projectPath, symlinked
// cwd realpath, filesystem-root termination, config at Git root, config in
// package below Git root, and stray lock without config (ignored).
//
// Tests import the built package (pnpm build) exactly like the other suites.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverConfig,
  resolveEffectiveProjectPath,
} from "../../packages/project/dist/index.js";

const CONFIG = "schema_version: 1\n";
const LOCK = '{"lockfile_version":1}\n';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ega-582-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeProject(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

test("SPEC-005 §5.1.2: nearest .egaskills.yaml wins", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".egaskills.yaml": CONFIG,
    ".egaskills.lock": LOCK, // adjacent to the OUTER config only
    "pkg/.egaskills.yaml": CONFIG,
    "pkg/src/deep/file.ts": "",
  });
  const fromDeep = discoverConfig(join(root, "pkg", "src", "deep"));
  assert.equal(fromDeep.projectPath, join(root, "pkg", "src", "deep"));
  assert.equal(fromDeep.configPath, join(root, "pkg", ".egaskills.yaml"));
  // The outer lock is NOT adjacent to the selected config: never reported.
  assert.equal(fromDeep.lockPath, null);
  // Starting at the config's own directory selects it too.
  assert.equal(discoverConfig(join(root, "pkg")).configPath, join(root, "pkg", ".egaskills.yaml"));
  // Without a nearer config the outermost config wins.
  assert.equal(discoverConfig(join(root, "pkg", "src")).configPath, join(root, "pkg", ".egaskills.yaml"));
});

test("SPEC-005 §5.1.2: .git directory boundary stops the walk (no outer leak)", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".egaskills.yaml": CONFIG, // would leak if the boundary failed
    "repo/.git/HEAD": "ref: refs/heads/main\n",
    "repo/src/file.ts": "",
  });
  const result = discoverConfig(join(root, "repo", "src"));
  assert.equal(result.configPath, null);
  assert.equal(result.lockPath, null);
});

test("SPEC-005 §5.1.2: .git FILE boundary (worktree/submodule) stops the walk", async (t) => {
  const root = await fixture(t);
  const gitDir = join(root, "main-repo", ".git");
  await writeProject(root, {
    ".egaskills.yaml": CONFIG, // outer config that must not leak
    "main-repo/.git/HEAD": "ref: refs/heads/main\n",
    // Worktree: `.git` is a FILE pointing at the main repo git dir.
    "wt/.git": `gitdir: ${gitDir}/worktrees/wt\n`,
    "wt/src/file.ts": "",
  });
  // No config inside the worktree: .git file boundary must stop the walk.
  const result = discoverConfig(join(root, "wt", "src"));
  assert.equal(result.configPath, null);
  assert.equal(result.lockPath, null);
  // A config at the worktree root is still discovered (nearest wins).
  await writeFile(join(root, "wt", ".egaskills.yaml"), CONFIG);
  const withConfig = discoverConfig(join(root, "wt", "src"));
  assert.equal(withConfig.configPath, join(root, "wt", ".egaskills.yaml"));
});

test("SPEC-005 §5.1.2: nested repo never leaks an outer config", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".git/HEAD": "ref: refs/heads/main\n",
    ".egaskills.yaml": CONFIG, // outer repo config
    "inner/.git/HEAD": "ref: refs/heads/main\n",
    "inner/packages/deep/file.ts": "",
  });
  // Deep inside the nested repo, no config: the nested .git stops the walk.
  const result = discoverConfig(join(root, "inner", "packages", "deep"));
  assert.equal(result.configPath, null);
  assert.equal(result.lockPath, null);
});

test("SPEC-005 §5.1.2: nested repo with its own config selects the inner config", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".git/HEAD": "ref: refs/heads/main\n",
    ".egaskills.yaml": CONFIG, // outer repo config
    "inner/.git/HEAD": "ref: refs/heads/main\n",
    "inner/.egaskills.yaml": CONFIG, // nested repo config (different on purpose)
    "inner/src/file.ts": "",
  });
  const result = discoverConfig(join(root, "inner", "src"));
  assert.equal(result.configPath, join(root, "inner", ".egaskills.yaml"));
});

test("SPEC-005 §5.1.2: workspace markers never stop config discovery", async (t) => {
  const root = await fixture(t);
  // Every SPEC-005 §5.1.2 rule 4 marker sits BETWEEN the start and the config.
  await writeProject(root, {
    ".egaskills.yaml": CONFIG,
    "marker-layer/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "marker-layer/lerna.json": "{}\n",
    "marker-layer/nx.json": "{}\n",
    "marker-layer/package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }),
    "marker-layer/Cargo.toml": "[workspace]\nmembers = [\"crates/*\"]\n",
    "marker-layer/deep/src/file.ts": "",
  });
  const result = discoverConfig(join(root, "marker-layer", "deep", "src"));
  assert.equal(result.configPath, join(root, ".egaskills.yaml"));
  // Markers also neither start nor stop discovery when no config exists:
  // the walk continues past them to the filesystem root.
  const lone = await fixture(t);
  await writeProject(lone, {
    "marker-layer/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "marker-layer/deep/file.ts": "",
  });
  assert.equal(discoverConfig(join(lone, "marker-layer", "deep")).configPath, null);
});

test("SPEC-005 §5.1.2: walk terminates at the filesystem root", async (t) => {
  const root = await fixture(t);
  await writeProject(root, { "src/deep/file.ts": "" });
  const result = discoverConfig(join(root, "src", "deep"));
  assert.equal(result.projectPath, join(root, "src", "deep"));
  assert.equal(result.configPath, null);
  assert.equal(result.lockPath, null);
});

test("SPEC-005 §5.1.2: config at the Git root is discovered (config wins over .git)", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".git/HEAD": "ref: refs/heads/main\n",
    ".egaskills.yaml": CONFIG,
    "packages/app/src/file.ts": "",
  });
  const result = discoverConfig(join(root, "packages", "app", "src"));
  assert.equal(result.configPath, join(root, ".egaskills.yaml"));
});

test("SPEC-005 §5.1.2: config in a package below the Git root is discovered", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".git/HEAD": "ref: refs/heads/main\n",
    "packages/app/.egaskills.yaml": CONFIG,
    "packages/app/src/deep/file.ts": "",
  });
  const fromPackage = discoverConfig(join(root, "packages", "app", "src", "deep"));
  assert.equal(fromPackage.configPath, join(root, "packages", "app", ".egaskills.yaml"));
  // From the Git root itself there is no config: the boundary stops the walk.
  const fromRoot = discoverConfig(root);
  assert.equal(fromRoot.configPath, null);
  assert.equal(fromRoot.lockPath, null);
});

test("SPEC-005 §5.1.1: file-as-projectPath uses the parent directory", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".egaskills.yaml": CONFIG,
    "src/main.ts": "export {};\n",
  });
  const file = join(root, "src", "main.ts");
  assert.equal(resolveEffectiveProjectPath(file), join(root, "src"));
  const result = discoverConfig(file);
  assert.equal(result.projectPath, join(root, "src"));
  assert.equal(result.configPath, join(root, ".egaskills.yaml"));
  // Symlinked file resolves to the real file, then its parent directory.
  await symlink(file, join(root, "main-link.ts"), "junction");
  assert.equal(resolveEffectiveProjectPath(join(root, "main-link.ts")), join(root, "src"));
});

test("SPEC-005 §5.1.1: symlinked cwd and real path resolve identically (G042)", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    "real/.egaskills.yaml": CONFIG,
  });
  await symlink(join(root, "real"), join(root, "link"), "junction");
  const previousCwd = process.cwd();
  process.chdir(join(root, "link"));
  try {
    const viaCwd = resolveEffectiveProjectPath();
    const direct = resolveEffectiveProjectPath(join(root, "real"));
    assert.equal(join(root, "real"), direct);
    assert.equal(viaCwd, direct);
    // Full discovery from the symlinked cwd lands on the real directory.
    const result = discoverConfig();
    assert.equal(result.projectPath, join(root, "real"));
    assert.equal(result.configPath, join(root, "real", ".egaskills.yaml"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("SPEC-005 §5.1.2: stray lock without the selected config is ignored", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".egaskills.yaml": CONFIG,
    "stray/.egaskills.lock": LOCK, // not adjacent to any selected config
    "stray/src/file.ts": "",
  });
  const fromStray = discoverConfig(join(root, "stray", "src"));
  assert.equal(fromStray.configPath, join(root, ".egaskills.yaml"));
  assert.equal(fromStray.lockPath, null);
  const fromRoot = discoverConfig(root);
  assert.equal(fromRoot.configPath, join(root, ".egaskills.yaml"));
  assert.equal(fromRoot.lockPath, null);
});

test("SPEC-005 §5.1.2: lock with NO config anywhere is never reported", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".egaskills.lock": LOCK,
    "src/file.ts": "",
  });
  const result = discoverConfig(join(root, "src"));
  assert.equal(result.configPath, null);
  assert.equal(result.lockPath, null);
});

test("SPEC-005 §5.1.2: adjacent lock to the selected config is in force", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".egaskills.yaml": CONFIG,
    ".egaskills.lock": LOCK,
    "src/file.ts": "",
  });
  const result = discoverConfig(join(root, "src"));
  assert.equal(result.configPath, join(root, ".egaskills.yaml"));
  assert.equal(result.lockPath, join(root, ".egaskills.lock"));
});

test("SPEC-005 §5.1.1: nonexistent project path fails deterministically", async (t) => {
  const root = await fixture(t);
  assert.throws(() => resolveEffectiveProjectPath(join(root, "nope")), /does not exist/);
  assert.throws(() => resolveEffectiveProjectPath(join(root, "nope", "deeper")), /does not exist/);
});

test("SPEC-005 §5.1.2: discovery result is deterministic across runs", async (t) => {
  const root = await fixture(t);
  await writeProject(root, {
    ".git/HEAD": "ref: refs/heads/main\n",
    ".egaskills.yaml": CONFIG,
    "pkg/.egaskills.lock": LOCK,
    "pkg/src/file.ts": "",
  });
  const first = discoverConfig(join(root, "pkg", "src"));
  assert.deepEqual(discoverConfig(join(root, "pkg", "src")), first);
  assert.deepEqual(Object.keys(first).sort(), ["configPath", "lockPath", "projectPath"]);
});