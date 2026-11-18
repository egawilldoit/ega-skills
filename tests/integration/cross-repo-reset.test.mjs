/**
 * Cross-repository reset consistency checks.
 *
 * This does not contact either remote and does not assert real CI results.
 * It guards the documented contract: the source pin used by source-manager
 * tests stays on the historical baseline, and the published operating model
 * keeps the production verification/recovery sequence intact.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const HUB_BASE = "f76f3a674069fde70e082ff73130b71d33a63c0d";
const SOURCE_BASE = "5ec137b05995219d11ff6633263fc855bf6fbeab";
const SOURCE_PIN = "8f264fc5fcb5691694c3653287f4d9370c5b025c";

test("the two reset base commits and the source pin are distinct valid SHAs", () => {
  for (const sha of [HUB_BASE, SOURCE_BASE, SOURCE_PIN]) assert.match(sha, /^[0-9a-f]{40}$/u);
  assert.equal(new Set([HUB_BASE, SOURCE_BASE, SOURCE_PIN]).size, 3);
});

test("CI keeps the historical source fixture pin used by source-manager tests", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, new RegExp(SOURCE_PIN, "u"), "ci.yml must keep the pinned source fixture");
  assert.match(ci, /repository: egawilldoit\/skills/u);
  assert.match(ci, /node --test tests\/web\/source-manager\/\*\.test\.mjs/u);
  assert.match(ci, /validate_catalog\.py/u);
  assert.match(ci, /EGA_SOURCE_FIXTURE/u);
});

test("production verification still gates on the canonical alias and can recover", () => {
  const verify = read(".github/workflows/verify-release.yml");
  assert.match(verify, /deployment_status:/u);
  assert.match(verify, /workflow_dispatch:/u);
  assert.match(verify, /ega-skills-mcp/u);
  assert.match(verify, /scripts\/release\/verify-live\.mjs/u);
  assert.match(verify, /scripts\/release\/recover-production\.mjs/u);
  // No PR-triggered deployment verification: previews are not production.
  assert.doesNotMatch(verify, /^\s*pull_request(_target)?:\s*$/mu);
});

test("the documented cross-repo sequence names both bases and the preserved pin", () => {
  const doc = read("docs/operations/CLEAN-CATALOG-RESET.md");
  for (const sha of [HUB_BASE, SOURCE_BASE, SOURCE_PIN]) {
    assert.ok(doc.includes(sha), `CLEAN-CATALOG-RESET.md must document ${sha}`);
  }
  assert.match(doc, /egawilldoit\/skills/u);
  assert.match(doc, /egawilldoit\/ega-skills/u);
  assert.match(doc, /no manual publisher/iu);
  assert.match(doc, /must not rewrite the pin/iu);
});
