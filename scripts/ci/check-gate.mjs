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

if (!gate(process.env.CI_MODE, results)) {
  console.error('ci-gate: required job missing or not successful', {mode: process.env.CI_MODE, results});
  process.exit(1);
}
console.log('ci-gate: selected jobs succeeded');
