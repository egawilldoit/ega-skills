#!/usr/bin/env node
// Build the reviewed immutable deployment HubRelease for the Vercel hosted
// MCP runtime using the EXISTING Contract C build (buildHubRelease).
//
// Content: ONLY real reviewed upstream skills at reviewed pinned commits
// (see docs/evidence/1.1-REAL-UPSTREAM-E2E-2026-09-08.md). No test fixtures,
// no Contract C examples, no invented skills, no acceptance placeholders.
//
//   cursor-pstack  @ 2b8ae2ee306f823d54879d3da7f8496b73c31d5d
//     roots: pstack/skills/architect, pstack/skills/setup-pstack
//   mattpocock     @ 3cca18b368ae95cdbdebbff572ccafa662551015
//     roots: skills/engineering/code-review, skills/engineering/tdd,
//            skills/productivity/grilling
//
// The script fetches the EXACT commits (never a moving ref tip), extracts the
// reviewed roots, computes lock digests with the existing project code,
// writes hub.yaml/sources.yaml/sources.lock.yaml, runs buildHubRelease, gates
// on loadHostedReleaseSnapshot, and copies ONLY the loader-required files
// (hub-release.json, release-package.json, registry.sqlite, cache/sha256)
// plus a PROVENANCE.md record into the output directory.
//
// Usage:
//   pnpm build
//   node scripts/hosted/build-deployment-artifact.mjs [--out packages/mcp/artifact]
//
// Exit 0: validated artifact written. Exit 1: anything failed.
import { mkdirSync, mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildHubRelease,
  extractSelectedRootsFromGit,
  fetchExactCommit,
  parseSourcesYaml,
  sourceConfigDigest,
} from "../../packages/project/dist/index.js";
import { loadHostedReleaseSnapshot } from "../../packages/mcp/dist/index.js";

const OUT = resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "packages/mcp/artifact");

const SOURCES = [
  {
    id: "cursor-pstack",
    repository: "https://github.com/cursor/plugins",
    namespace: "cursor",
    commit: "2b8ae2ee306f823d54879d3da7f8496b73c31d5d",
    roots: ["pstack/skills/architect", "pstack/skills/setup-pstack"],
    provenance: ["pstack/LICENSE"],
    evidenceTree: "sha256:380c3c138f994c93a2cdc107471277985a0bf9e2854d252f82ad2a2be1ccf7b5",
    evidenceSnapshot: "sha256:1c196843be90b605daa100c743790cd8c9ffa87cff88eb31398e24cb558078b1",
  },
  {
    id: "mattpocock",
    repository: "https://github.com/mattpocock/skills",
    namespace: "mattpocock",
    commit: "3cca18b368ae95cdbdebbff572ccafa662551015",
    roots: ["skills/engineering/code-review", "skills/engineering/tdd", "skills/productivity/grilling"],
    provenance: ["LICENSE"],
    evidenceTree: "sha256:2f8d8f27d54c14002c4a58397fb358f3fe244a48a72fda983ab817d3dd4a2ba8",
    evidenceSnapshot: "sha256:33b3f931ef8960b28f7efa3732cc593620df039a8433e81638e78c55c8996971",
  },
];

const EXPECTED_SKILLS = [
  "cursor/architect",
  "cursor/setup-pstack",
  "mattpocock/code-review",
  "mattpocock/grilling",
  "mattpocock/tdd",
];

function fail(message) {
  process.stderr.write(`build-deployment-artifact: FAIL ${message}\n`);
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), "ega-deploy-artifact-"));
try {
  const hubDir = join(workspace, "hub");
  mkdirSync(hubDir, { recursive: true });

  const configs = Object.fromEntries(
    SOURCES.map((source) => [
      source.id,
      {
        type: "git",
        repository: source.repository,
        ref: "main",
        namespace: source.namespace,
        selection: { roots: source.roots },
        provenance_files: source.provenance,
      },
    ]),
  );
  const parsed = parseSourcesYaml(JSON.stringify({ schema_version: 1, sources: configs }));
  const locks = {};
  for (const source of SOURCES) {
    const fetched = join(workspace, `${source.id}-fetched`);
    try {
      fetchExactCommit(source.repository, source.commit, fetched);
    } catch (error) {
      fail(`cannot fetch ${source.id}@${source.commit}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const treeDir = join(hubDir, "external", source.id, "repo");
    mkdirSync(treeDir, { recursive: true });
    const tree = extractSelectedRootsFromGit(fetched, source.commit, source.roots, source.provenance, treeDir);
    if (tree.treeDigest !== source.evidenceTree || tree.snapshotDigest !== source.evidenceSnapshot) {
      fail(
        `${source.id} digest drift vs reviewed evidence: ` +
          `tree ${tree.treeDigest} (expected ${source.evidenceTree}), ` +
          `snapshot ${tree.snapshotDigest} (expected ${source.evidenceSnapshot})`,
      );
    }
    const config = parsed.sources[source.id];
    locks[source.id] = {
      source_config_digest: sourceConfigDigest(config),
      repository: source.repository,
      requested_ref: "main",
      namespace: source.namespace,
      selection: { roots: source.roots },
      provenance_files: source.provenance,
      resolved_commit: source.commit,
      selected_skill_tree_digest: tree.treeDigest,
      vendored_snapshot_digest: tree.snapshotDigest,
      extraction_contract: 1,
    };
    process.stdout.write(`build-deployment-artifact: vendored ${source.id}@${source.commit}\n`);
  }

  writeFileSync(
    join(hubDir, "hub.yaml"),
    JSON.stringify({
      schema_version: 1,
      hub: { id: "personal" },
      owned: [],
      external: SOURCES.map(({ id: sourceId }) => ({ source: sourceId })),
    }),
  );
  writeFileSync(join(hubDir, "sources.yaml"), JSON.stringify({ schema_version: 1, sources: configs }));
  writeFileSync(join(hubDir, "sources.lock.yaml"), JSON.stringify({ schema_version: 1, sources: locks }));

  const build = await buildHubRelease(hubDir);
  const skillIds = build.skills.map(({ skillId }) => skillId);
  if (JSON.stringify(skillIds) !== JSON.stringify(EXPECTED_SKILLS)) {
    fail(`unexpected catalog ${JSON.stringify(skillIds)}, expected ${JSON.stringify(EXPECTED_SKILLS)}`);
  }

  // Gate on the SAME verification the runtime performs at startup.
  const snapshot = loadHostedReleaseSnapshot(build.registryHome);

  mkdirSync(OUT, { recursive: true });
  for (const file of ["hub-release.json", "release-package.json", "registry.sqlite"]) {
    cpSync(join(build.registryHome, file), join(OUT, file));
  }
  rmSync(join(OUT, "cache"), { force: true, recursive: true });
  cpSync(join(build.registryHome, "cache"), join(OUT, "cache"), { recursive: true });

  const provenance = [
    "# Deployment artifact provenance",
    "",
    "Built with the existing Contract C build (`buildHubRelease`); no fixtures,",
    "no examples, no invented content.",
    "",
    `Built: ${new Date().toISOString()}`,
    `Release digest: ${snapshot.releaseDigest}`,
    `Hub id: ${snapshot.release.payload.hub_id}`,
    `Skills: ${skillIds.join(", ")}`,
    "",
    "## Sources (pinned reviewed commits)",
    "",
    ...SOURCES.map(
      (source) =>
        `- ${source.id} (${source.namespace}): ${source.repository}@${source.commit}\n` +
        `  roots: ${source.roots.join(", ")}\n` +
        `  tree: ${source.evidenceTree}\n` +
        `  snapshot: ${source.evidenceSnapshot}`,
    ),
    "",
    "Evidence: docs/evidence/1.1-REAL-UPSTREAM-E2E-2026-09-08.md",
    "Reproduce: pnpm build && node scripts/hosted/build-deployment-artifact.mjs",
    "Validate: node scripts/hosted/validate-artifact.mjs packages/mcp/artifact",
    "",
  ].join("\n");
  writeFileSync(join(OUT, "PROVENANCE.md"), provenance);

  // The copied directory must verify standalone (relocatable, exact identity).
  const reloaded = loadHostedReleaseSnapshot(OUT);
  if (reloaded.releaseDigest !== snapshot.releaseDigest) fail("relocated artifact digest changed");
  process.stdout.write(`build-deployment-artifact: OK digest=${snapshot.releaseDigest} skills=${skillIds.length} out=${OUT}\n`);
} finally {
  rmSync(workspace, { force: true, recursive: true });
}
