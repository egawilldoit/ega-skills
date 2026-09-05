// Deterministic Codex-acceptance fixture builder (EGA-595, SPEC-006 §5.1.10).
//
// Builds a temp EGA home containing exactly one visible skill
// (`ega/contract-probe`, authored L1 + L2 + routing metadata), imports it
// through the real importer, and prints the resulting paths + version hash
// as JSON. All fixture bytes are frozen literals: no timestamps, no random
// ids, no environment-dependent content — so the version hash is stable
// across machines and runs (asserted by codex-smoke.test.mjs).
//
// Usage:
//   node tests/integration/client-codex/fixture.mjs [dest-root]
//   # prints: {"home": "...", "sources": "...", "skillId": "...",
//   #          "versionHash": "...", "registry": "..."}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, importSkills, getCurrentVersionHash } from "../../../packages/registry/dist/index.js";

export const FIXTURE_SKILL_ID = "ega/contract-probe";
export const FIXTURE_NAMESPACE = "ega";

// Frozen fixture content. KEEP IN SYNC with codex-smoke.test.mjs expected hash.
export const FIXTURE_SKILL_MD = `---
name: contract-probe
description: contract probe skill for Codex acceptance
---
# contract-probe

Codex acceptance marker CODEX-ACCEPT-4471. Probe guidance text.
`;

export const FIXTURE_CORE_MD = `# contract-probe core

Condensed core marker CODEX-CORE-4471.
`;

export const FIXTURE_EGA_YAML = `schema_version: 1
domains: [engineering]
triggers: [codex acceptance probe]
`;

export async function buildFixture(destRoot) {
  const root = destRoot ?? (await mkdtemp(join(tmpdir(), "ega-codex-accept-")));
  const home = join(root, "home");
  const sources = join(root, "src", "contract-probe");
  await mkdir(sources, { recursive: true });
  await writeFile(join(sources, "SKILL.md"), FIXTURE_SKILL_MD);
  await writeFile(join(sources, "SKILL.core.md"), FIXTURE_CORE_MD);
  await writeFile(join(sources, "ega.yaml"), FIXTURE_EGA_YAML);

  const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
  try {
    const summary = await importSkills(registry, {
      path: join(root, "src"),
      namespace: FIXTURE_NAMESPACE,
    });
    if (summary.imported !== 1 || summary.failed !== 0) {
      throw new Error(`fixture import unexpected: ${JSON.stringify(summary)}`);
    }
    const versionHash = getCurrentVersionHash(registry.db, FIXTURE_SKILL_ID);
    return {
      root,
      home,
      sources: join(root, "src"),
      skillId: FIXTURE_SKILL_ID,
      versionHash,
      registry: join(home, "registry.sqlite"),
    };
  } finally {
    registry.close();
  }
}

export async function removeFixture(root) {
  await rm(root, { recursive: true, force: true });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("fixture.mjs") || process.argv[1].endsWith("fixture.js"));

if (invokedDirectly) {
  buildFixture(process.argv[2])
    .then((info) => console.log(JSON.stringify(info)))
    .catch((error) => {
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    });
}
