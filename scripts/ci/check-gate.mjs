import { gate } from './classify-changes.mjs';
const needs = JSON.parse(process.env.CI_NEEDS ?? '{}');
const results = Object.fromEntries(Object.entries(needs).map(([name, value]) => [name === 'web-isolation' ? 'isolation' : name, value?.result]));
if (!gate(process.env.CI_MODE, results)) {
  console.error('ci-gate: required job missing or not successful', results);
  process.exit(1);
}
console.log('ci-gate: selected jobs succeeded');
