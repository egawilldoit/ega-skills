#!/usr/bin/env node

/**
 * Thin entrypoint for the deterministic human catalog generator.
 *
 * All logic lives in `packages/cli/src/catalog.ts` (which owns the `yaml`
 * dependency and the registry handle), mirroring this repo's convention that
 * `scripts/` are thin wrappers over package logic.
 *
 * Usage:
 *   node scripts/catalog/generate.mjs [--check] [--artifact <dir>]
 *                                    [--presentation <file>] [--out <file>]
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildCatalogModel,
  loadPresentation,
  readL0Metadata,
  renderCatalogMarkdown,
} from "../../packages/cli/dist/index.js";

const DEFAULT_ARTIFACT = "packages/mcp/artifact";
const DEFAULT_PRESENTATION = "catalog/presentation.yaml";
const DEFAULT_OUT = "docs/generated/SKILL-CATALOG.md";

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const artifactDir = resolve(flag("--artifact", DEFAULT_ARTIFACT));
  const presentationPath = resolve(flag("--presentation", DEFAULT_PRESENTATION));
  const outPath = resolve(flag("--out", DEFAULT_OUT));

  if (!existsSync(presentationPath)) {
    process.stderr.write(`catalog: FAIL presentation metadata not found: ${presentationPath}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const env = { ...process.env, EGA_SKILLS_HOME: artifactDir };
    const model = buildCatalogModel(readL0Metadata(env), loadPresentation(presentationPath));

    const release = JSON.parse(await readFile(resolve(artifactDir, "hub-release.json"), "utf8"));
    // Fail closed on an unverifiable identity: the generated document claims to
    // come from a VERIFIED release, so it must never print "undefined" or an
    // unvalidated digest. `validate-artifact.mjs` (CI) verifies the artifact in
    // full; this guard makes the generator safe standalone too.
    if (!/^sha256:[0-9a-f]{64}$/u.test(release.digest ?? "")) {
      throw new Error(
        `artifact ${artifactDir} has no valid release digest (got ${JSON.stringify(release.digest)}); run scripts/hosted/validate-artifact.mjs`,
      );
    }
    const hubId = typeof release.payload?.hub_id === "string" ? release.payload.hub_id : "unknown";
    const identity = { digest: release.digest, hubId };
    const markdown = renderCatalogMarkdown(model, identity);

    if (check) {
      const current = existsSync(outPath) ? await readFile(outPath, "utf8") : null;
      if (current === null) {
        process.stderr.write(`catalog:check FAIL generated catalog is missing: ${outPath}\n`);
        process.exitCode = 1;
        return;
      }
      if (current !== markdown) {
        process.stderr.write(
          `catalog:check FAIL generated catalog is stale: ${outPath}\n` +
            "Run `pnpm generate:catalog` and commit the result.\n",
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `catalog:check OK release=${identity.digest} skills=${model.skillCount} groups=${model.groups.length}\n`,
      );
      return;
    }

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, markdown);
    process.stdout.write(
      `catalog: generated ${outPath} release=${identity.digest} skills=${model.skillCount} groups=${model.groups.length}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`catalog: FAIL ${message}\n`);
    process.exitCode = 1;
  }
}

await main();