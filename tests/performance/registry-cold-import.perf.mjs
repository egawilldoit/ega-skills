import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import process from "node:process";
import test from "node:test";
import { join } from "node:path";

import { importSkills } from "../../packages/registry/dist/index.js";
import { basicYaml, isolatedImport, writeSkill } from "../helpers/registry-import-fixture.mjs";

test("SPEC-003 §5.1.11: isolated 100-skill cold import meets platform budget", async (t) => {
  const { registry, src } = await isolatedImport(t);
  for (let i = 0; i < 100; i += 1) {
    const name = `cold-${String(i).padStart(3, "0")}`;
    await writeSkill(join(src, "cold"), name, { egaYaml: basicYaml() });
  }

  const budget = process.platform === "win32" ? 30000 : 5000;
  const start = performance.now();
  const summary = await importSkills(registry, { path: join(src, "cold"), namespace: "ega" });
  const elapsed = performance.now() - start;

  console.log(`ℹ registry cold import: platform=${process.platform} node=${process.version} elapsed=${elapsed.toFixed(0)} ms budget=${budget} ms`);
  assert.deepEqual(summary, { imported: 100, unchanged: 0, failed: 0, failures: [] });
  assert.ok(elapsed <= budget, `cold import elapsed ${elapsed.toFixed(0)} ms exceeds budget ${budget} ms on ${process.platform}`);
}, { timeout: 120000 });
