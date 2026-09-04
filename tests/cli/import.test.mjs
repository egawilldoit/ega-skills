import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntrypoint = join(root, "packages", "cli", "bin", "ega-skills.mjs");

async function isolatedHome(t) {
  const base = await mkdtemp(join(tmpdir(), "ega-570-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cliEntrypoint, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

function cliEnv(base) {
  return { ...process.env, EGA_SKILLS_HOME: join(base, "home") };
}

async function writeSkill(dir, name, options = {}) {
  const skillRoot = join(dir, name);
  await mkdir(skillRoot, { recursive: true });
  const body = options.body ?? `# ${name}\n\nGuidance text for ${name}.\n`;
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options.description ?? `${name} skill`}\n---\n${body}`,
  );
  if (options.core !== undefined) {
    await writeFile(join(skillRoot, "SKILL.core.md"), options.core);
  }
  if (options.egaYaml !== undefined) {
    await writeFile(join(skillRoot, "ega.yaml"), options.egaYaml);
  }
  return skillRoot;
}

function basicYaml(extra = "") {
  return `schema_version: 1\ndomains: [engineering]\ntriggers: [build thing]\n${extra}`;
}

// import: REQUIRED surface (SPEC-003 §5.1.11, §5.1.18).

test("CLI import: valid skill imports through the actual CLI as JSON", async (t) => {
  const base = await isolatedHome(t);
  const skillRoot = await writeSkill(join(base, "src"), "alpha", { egaYaml: basicYaml() });
  const result = runCli(["import", skillRoot, "--namespace", "ega"], cliEnv(base));
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { imported: 1, unchanged: 0, failed: 0, failures: [] });
});

test("CLI import: --namespace is required and usage fails deterministically", async (t) => {
  const base = await isolatedHome(t);
  const skillRoot = await writeSkill(join(base, "src"), "guarded", { egaYaml: basicYaml() });
  const missing = runCli(["import", skillRoot], cliEnv(base));
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.ok(missing.stderr.includes("--namespace"));
  const badValue = runCli(["import", skillRoot, "--namespace", "NOT A NAMESPACE"], cliEnv(base));
  assert.equal(badValue.status, 1);
  assert.ok(badValue.stdout === "");
  const missingPath = runCli(["import"], cliEnv(base));
  assert.equal(missingPath.status, 1);
  assert.ok(missingPath.stderr.includes("<path>"));
});

test("CLI import: nonexistent path is a usage error, bad sibling is summary data", async (t) => {
  const base = await isolatedHome(t);
  const gone = runCli(["import", join(base, "nope"), "--namespace", "ega"], cliEnv(base));
  assert.equal(gone.status, 1);
  assert.equal(gone.stdout, "");
  assert.ok(gone.stderr.length > 0);
  const src = join(base, "src");
  await writeSkill(src, "good", { egaYaml: basicYaml() });
  const bad = join(src, "bad");
  await mkdir(bad, { recursive: true });
  await writeFile(join(bad, "SKILL.md"), "---\nno-name-here: true\n---\nbody\n");
  const partial = runCli(["import", src, "--namespace", "ega"], cliEnv(base));
  assert.equal(partial.status, 0);
  const summary = JSON.parse(partial.stdout);
  assert.equal(summary.imported, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].path, bad);
});

test("CLI import: NO_CHANGE re-import is visible in the summary", async (t) => {
  const base = await isolatedHome(t);
  const skillRoot = await writeSkill(join(base, "src"), "stable", { egaYaml: basicYaml() });
  const env = cliEnv(base);
  assert.deepEqual(JSON.parse(runCli(["import", skillRoot, "--namespace", "ega"], env).stdout), {
    imported: 1,
    unchanged: 0,
    failed: 0,
    failures: [],
  });
  const again = runCli(["import", skillRoot, "--namespace", "ega"], env);
  assert.equal(again.status, 0);
  assert.deepEqual(JSON.parse(again.stdout), {
    imported: 0,
    unchanged: 1,
    failed: 0,
    failures: [],
  });
});

test("CLI import: --namespace=value form is accepted", async (t) => {
  const base = await isolatedHome(t);
  const skillRoot = await writeSkill(join(base, "src"), "eqform", { egaYaml: basicYaml() });
  const result = runCli(["import", skillRoot, "--namespace=ega"], cliEnv(base));
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).imported, 1);
});

// list: convenience, read-only, deterministic.

test("CLI list: canonical IDs with current versions in lexical order", async (t) => {
  const base = await isolatedHome(t);
  const env = cliEnv(base);
  const empty = runCli(["list"], env);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, "");
  await writeSkill(join(base, "src"), "zeta", { egaYaml: basicYaml() });
  await writeSkill(join(base, "src"), "alpha", { egaYaml: basicYaml() });
  assert.equal(runCli(["import", join(base, "src"), "--namespace", "ega"], env).status, 0);
  const listed = runCli(["list"], env);
  assert.equal(listed.status, 0);
  const lines = listed.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("ega/alpha sha256:"));
  assert.ok(lines[1].startsWith("ega/zeta sha256:"));
  // No mutation: a second listing is byte-identical.
  assert.equal(runCli(["list"], env).stdout, listed.stdout);
});

// inspect: convenience, read-only, full local detail.

test("CLI inspect: metadata, versions, L1, tokens and provenance without mutation", async (t) => {
  const base = await isolatedHome(t);
  const env = cliEnv(base);
  await writeSkill(join(base, "src"), "probed", {
    egaYaml: basicYaml("aliases: [probed-alias]\n"),
    core: "---\nname: probed\ndescription: probed skill\n---\n# probed core\n",
  });
  assert.equal(runCli(["import", join(base, "src"), "--namespace", "ega"], env).status, 0);
  const first = runCli(["inspect", "ega/probed"], env);
  assert.equal(first.status, 0);
  const detail = JSON.parse(first.stdout);
  assert.equal(detail.skillId, "ega/probed");
  assert.equal(detail.namespace, "ega");
  assert.equal(detail.name, "probed");
  assert.match(detail.currentVersionHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(detail.aliases, ["probed-alias"]);
  assert.equal(detail.versions.length, 1);
  const version = detail.versions[0];
  assert.equal(version.l1Status, "AUTHORED");
  assert.equal(version.trustLevel, "UNKNOWN");
  assert.ok(version.files.some((f) => f.path === "SKILL.md" && f.role === "skill-body"));
  const l2 = version.files.find((f) => f.path === "SKILL.md");
  assert.ok(l2.byteSize > 0);
  assert.ok(l2.tokenCounts.some((c) => c.estimatorId === "ega-o200k-v1" && c.tokenCount > 0));
  assert.equal(version.sources.length, 1);
  assert.equal(version.sources[0].sourceType, "local");
  assert.ok(version.sources[0].localPath.endsWith(join("src", "probed")));
  // No instruction rewriting: SKILL.md bytes round-trip through the cache path only;
  // inspect carries metadata, never the body text.
  assert.ok(!first.stdout.includes("Guidance text for probed"));
  // No mutation: repeated inspect is byte-identical.
  assert.equal(runCli(["inspect", "ega/probed"], env).stdout, first.stdout);
});

test("CLI inspect: missing skill is a deterministic error", async (t) => {
  const base = await isolatedHome(t);
  const result = runCli(["inspect", "ega/ghost"], cliEnv(base));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes("ega/ghost"));
});

// Offline: the pipeline never touches the network (no proxy/netsim needed;
// the registry source tree contains no fetch/http by contract test, and the
// CLI honors an isolated home with DNS blocked via env scrubbing).
test("CLI works offline with an isolated home", async (t) => {
  const base = await isolatedHome(t);
  const env = { ...cliEnv(base), HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" };
  const skillRoot = await writeSkill(join(base, "src"), "offline", { egaYaml: basicYaml() });
  assert.equal(runCli(["import", skillRoot, "--namespace", "ega"], env).status, 0);
  assert.ok(runCli(["list"], env).stdout.includes("ega/offline"));
  assert.equal(runCli(["inspect", "ega/offline"], env).status, 0);
});
