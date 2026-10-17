#!/usr/bin/env node
// Contract G validator: fail closed on envelope, field, digest, and value
// violations. The implementation is shared with the intake planner so this
// command cannot drift into a second interpretation of the artifact.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { verifyImportPlan } from "../../packages/registry/dist/index.js";

const filename = process.argv[2];
if (filename === undefined || process.argv.length !== 3) {
  console.error("Usage: node scripts/contracts/validate-contract-g.mjs <plan.json>");
  process.exitCode = 2;
} else {
  try {
    const plan = JSON.parse(readFileSync(resolve(filename), "utf8"));
    const verified = verifyImportPlan(plan);
    console.log(`CONTRACT-G-OK ${verified.digest}`);
  } catch (error) {
    console.error(`CONTRACT-G-ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
