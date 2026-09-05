#!/usr/bin/env node
/**
 * EGA Skills Hub V1 — reference performance evidence (EGA-600).
 *
 * Repeated measurements on reference hardware, NOT a CI gate: CI runners are
 * noisy (see the documented Windows cold-import outlier), so this script
 * records environment + individual runs + median/p95 for the release record.
 * Frozen CI suites assert correctness everywhere; this script quantifies the
 * reference targets of SPEC-002 §5.1.20 / SPEC-003 §5.1.11 and the V1
 * operational budgets (registry open, FTS warm p95, cache get, resolve p95).
 *
 * Usage: node scripts/perf/reference-bench.mjs [--out report.json]
 * The 100-skill corpus is synthetic with shared vocabulary (worst-case-ish
 * FTS fan-out) plus distinctive per-skill terms (realistic routing).
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { cpus } from "node:os";
import {
  buildCanonicalSkillVersionManifest,
  hashCanonicalManifest,
} from "../../packages/hashing/dist/index.js";
import {
  getCacheBlob,
  importSkills,
  openRegistry,
  putCacheBlob,
  searchSkills,
} from "../../packages/registry/dist/index.js";
import { resolveSkills } from "../../packages/router/dist/index.js";

const N = 100;

function stats(runs) {
  const sorted = [...runs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return { runs: runs.map((ms) => Math.round(ms * 10) / 10), median: Math.round(median * 10) / 10, p95: Math.round(p95 * 10) / 10 };
}

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

async function makeCorpus(root) {
  await mkdir(root, { recursive: true });
  for (let i = 0; i < N; i += 1) {
    const name = `bench-${String(i).padStart(3, "0")}`;
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      frontmatter(name, `benchmark skill ${name} shared vocabulary for performance measurement`)
        + `# ${name}\n\nShared vocabulary paragraph for performance measurement. `
        + `Distinctive marker term-${name} routes this skill uniquely.\n`,
    );
  }
}

async function main() {
  const report = {
    env: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: cpus().length,
      cpu_model: cpus()[0]?.model ?? "unknown",
      date_utc: new Date().toISOString(),
    },
    measures: {},
  };

  // 1. Cold hash: manifest build + SHA-256 identity x100 (SPEC-002 §5.1.20 shape).
  {
    const base = {
      portable: { name: "bench", description: "Typical skill." },
      routing: { domains: ["engineering"], platforms: [], frameworks: [], triggers: ["bench"], antiTriggers: [], aliases: [] },
      files: [],
    };
    const runs = [];
    for (let rep = 0; rep < 5; rep += 1) {
      const start = performance.now();
      for (let i = 0; i < N; i += 1) {
        const manifest = buildCanonicalSkillVersionManifest({
          skillId: `ega/bench-${i}`,
          portable: { name: `bench-${i}`, description: base.portable.description },
          routing: base.routing,
          files: base.files,
        });
        hashCanonicalManifest(manifest);
      }
      runs.push(performance.now() - start);
    }
    report.measures.cold_hash_100 = { unit: "ms", target_ms: 5000, ...stats(runs) };
  }

  // 2. Cold import x3 into fresh homes (SPEC-003 §5.1.11 shape).
  const corpusRoot = await mkdtemp(join(tmpdir(), "ega-perf-corpus-"));
  await makeCorpus(join(corpusRoot, "skills"));
  {
    const runs = [];
    for (let rep = 0; rep < 3; rep += 1) {
      const base = await mkdtemp(join(tmpdir(), "ega-perf-home-"));
      const home = join(base, "home");
      const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
      try {
        const start = performance.now();
        const summary = await importSkills(registry, { path: join(corpusRoot, "skills"), namespace: "ega" });
        runs.push(performance.now() - start);
        if (summary.imported !== N) throw new Error(`expected ${N} imports, got ${summary.imported}`);
      } finally {
        registry.close();
        await rm(base, { recursive: true, force: true });
      }
    }
    report.measures.cold_import_100 = { unit: "ms", target_ms: 5000, ...stats(runs) };
  }

  // 3+. Open / FTS / cache / resolve against one warm 100-skill home.
  const base = await mkdtemp(join(tmpdir(), "ega-perf-warm-"));
  const home = join(base, "home");
  const proj = join(base, "proj");
  await mkdir(proj, { recursive: true });
  {
    const registry = openRegistry({ env: { EGA_SKILLS_HOME: home } });
    try {
      await importSkills(registry, { path: join(corpusRoot, "skills"), namespace: "ega" });
    } finally {
      registry.close();
    }

    const openRuns = [];
    for (let i = 0; i < 20; i += 1) {
      const start = performance.now();
      const r = openRegistry({ env: { EGA_SKILLS_HOME: home } });
      r.close();
      openRuns.push(performance.now() - start);
    }
    report.measures.registry_open = { unit: "ms", target_ms: 250, ...stats(openRuns) };

    const registry2 = openRegistry({ env: { EGA_SKILLS_HOME: home } });
    try {
      for (let i = 0; i < 20; i += 1) searchSkills(registry2.db, "shared vocabulary");
      const ftsRuns = [];
      for (let i = 0; i < 100; i += 1) {
        const start = performance.now();
        searchSkills(registry2.db, "shared vocabulary");
        ftsRuns.push(performance.now() - start);
      }
      report.measures.fts_warm_p95 = { unit: "ms", target_ms: 100, ...stats(ftsRuns) };

      const blob = putCacheBlob(join(home, "cache", "sha256"), Buffer.from("perf probe bytes"));
      getCacheBlob(join(home, "cache", "sha256"), blob.hash);
      const cacheRuns = [];
      for (let i = 0; i < 100; i += 1) {
        const start = performance.now();
        getCacheBlob(join(home, "cache", "sha256"), blob.hash);
        cacheRuns.push(performance.now() - start);
      }
      report.measures.cache_get_typical = { unit: "ms", target_ms: 50, ...stats(cacheRuns) };
    } finally {
      registry2.close();
    }

    for (let i = 0; i < 10; i += 1) {
      await resolveSkills({ task: "warmup routing probe", projectPath: proj, env: { EGA_SKILLS_HOME: home } });
    }
    const resolveRuns = [];
    for (let i = 0; i < 50; i += 1) {
      const start = performance.now();
      await resolveSkills({ task: `route the distinctive marker term-bench-${String(i % N).padStart(3, "0")} task`, projectPath: proj, env: { EGA_SKILLS_HOME: home } });
      resolveRuns.push(performance.now() - start);
    }
    report.measures.resolve_warm_100skill_p95 = { unit: "ms", target_ms: 300, ...stats(resolveRuns) };
  }

  await rm(base, { recursive: true, force: true });
  await rm(corpusRoot, { recursive: true, force: true });

  const out = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : null;
  const text = JSON.stringify(report, null, 1);
  if (out) {
    await writeFile(out, text + "\n");
    console.log(`wrote ${out}`);
  } else {
    console.log(text);
  }
  const over = Object.entries(report.measures).filter(([, m]) => m.p95 > m.target_ms || m.median > m.target_ms);
  if (over.length > 0) {
    console.error(`OVER TARGET: ${over.map(([k]) => k).join(", ")} (reference evidence, not a gate)`);
  }
}

await main();
