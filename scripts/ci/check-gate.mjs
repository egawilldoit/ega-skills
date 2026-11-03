import { gate } from './classify-changes.mjs';

function readNeeds() {
  const raw = process.env.CI_NEEDS;
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('CI_NEEDS missing');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CI_NEEDS is not an object');
  return parsed;
}

// `web-isolation` is the workflow job id; the gate calls it `isolation`.
const needs = readNeeds();
const results = Object.fromEntries(Object.entries(needs).map(([name, value]) => [name === 'web-isolation' ? 'isolation' : name, value?.result]));
// Windows is expected only on the events the workflow itself selects it for. The
// value is derived from the same predicate independently of `classify`, so a
// disagreement shows up as a red gate instead of a silently skipped shard.
const windows = process.env.CI_WINDOWS === 'true';

if (!gate(process.env.CI_MODE, results, { windows })) {
  console.error('ci-gate: required job missing or not successful', {mode: process.env.CI_MODE, windows, results});
  process.exit(1);
}
console.log(`ci-gate: selected jobs succeeded (windows=${windows})`);
