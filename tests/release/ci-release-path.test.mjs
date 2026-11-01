import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classify } from '../../scripts/ci/classify-changes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ciPath = new URL('../../.github/workflows/ci.yml', import.meta.url);
const verifyPath = new URL('../../.github/workflows/verify-release.yml', import.meta.url);
const gatePath = fileURLToPath(new URL('../../scripts/ci/check-gate.mjs', import.meta.url));

const read = url => readFileSync(url, 'utf8');

// Minimal line-oriented YAML reader: enough to isolate top-level `on:` and
// `jobs:` keys without adding a YAML dependency to the test gate.
function topLevelBlock(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => new RegExp(`^${key}:\\s*$`).test(line));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i += 1) body.push(lines[i]);
  return body.join('\n');
}

function jobs(text) {
  const block = topLevelBlock(text, 'jobs');
  if (block === null) return new Map();
  const lines = block.split('\n');
  const found = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (!match) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[j])) break;
      body.push(lines[j]);
    }
    found.set(match[1], body.join('\n'));
    i = j - 1;
  }
  return found;
}

function needs(body) {
  const inline = /^\s*needs:\s*\[([^\]]*)\]\s*$/m.exec(body);
  if (inline) return inline[1].split(',').map(value => value.trim()).filter(Boolean);
  const block = /^\s*needs:\s*$\n((?:\s*-\s*\S+\n?)*)/m.exec(body);
  if (block) return [...block[1].matchAll(/-\s*(\S+)/g)].map(match => match[1]);
  const scalar = /^\s*needs:\s*([A-Za-z0-9_-]+)\s*$/m.exec(body);
  return scalar ? [scalar[1]] : [];
}

const ci = read(ciPath);
const ciJobs = jobs(ci);
const gateJob = ciJobs.get('ci-gate');
const verify = existsSync(verifyPath) ? read(verifyPath) : null;

test('ci.yml declares exactly one ci-gate job with the stable check name', () => {
  assert.ok(gateJob, 'ci-gate job missing');
  assert.equal([...ciJobs.keys()].filter(name => name === 'ci-gate').length, 1);
  // The Vercel Deployment Check matches the check run name, so it must be unique
  // across every workflow, not just this file.
  const workflowDir = fileURLToPath(new URL('../../.github/workflows', import.meta.url));
  const named = [];
  for (const file of readdirSync(workflowDir).filter(name => /\.ya?ml$/.test(name))) {
    const text = readFileSync(`${workflowDir}/${file}`, 'utf8');
    if (jobs(text).has('ci-gate')) named.push(`${file}:job`);
    if (/\bname:\s*ci-gate\s*$/m.test(text)) named.push(`${file}:name`);
  }
  assert.deepEqual(named, ['ci.yml:job', 'ci.yml:name']);
});

test('ci-gate always runs and needs every gated job', () => {
  assert.match(gateJob, /^\s*if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/m);
  assert.deepEqual(needs(gateJob).sort(), ['classify', 'docs', 'foundation', 'rls', 'web', 'web-isolation']);
  for (const dependency of needs(gateJob)) assert.ok(ciJobs.has(dependency), `missing dependency job ${dependency}`);
  assert.match(gateJob, /run:\s*node scripts\/ci\/check-gate\.mjs/);
});

test('ci.yml has no production URL, preview dependency, or verification workflow call', () => {
  assert.doesNotMatch(ci, /ega-skills-mcp\.vercel\.app/);
  assert.doesNotMatch(ci, /https?:\/\//);
  assert.doesNotMatch(ci, /verify-release\.ya?ml/);
  assert.doesNotMatch(ci, /deployment_status/);
  assert.doesNotMatch(ci, /api\.vercel\.com/);
});

function triggers(text) {
  const block = topLevelBlock(text, 'on') ?? '';
  const inline = /^on:\s*\[([^\]]*)\]/m.exec(text)?.[1] ?? '';
  const keys = [...block.matchAll(/^\s*([A-Za-z_]+):/gm)].map(match => match[1]);
  return new Set([...keys, ...inline.split(',').map(value => value.trim()).filter(Boolean)]);
}

test('verify-release.yml is a production deployment_status workflow', () => {
  assert.ok(verify, '.github/workflows/verify-release.yml is missing');
  const on = triggers(verify);
  assert.ok(on.size > 0, 'verify-release.yml has no on: triggers');
  assert.ok(on.has('deployment_status'), 'missing deployment_status trigger');
  assert.ok(on.has('workflow_dispatch'), 'missing workflow_dispatch trigger');
  // Deployment verification must never be triggered by a preview/PR deployment.
  assert.equal(on.has('pull_request'), false, 'must not run on pull_request');
  assert.equal(on.has('pull_request_target'), false, 'must not run on pull_request_target');
});

test('verify-release.yml filters the production ega-skills-mcp deployment on main', () => {
  assert.ok(verify, '.github/workflows/verify-release.yml is missing');
  assert.match(verify, /ega-skills-mcp/);
  assert.match(verify, /\bmain\b/);
  // Production is required either by an environment comparison or an environment key.
  const requiresProduction =
    /startsWith\(\s*github\.event\.deployment\.environment\s*,\s*['"]Production['"]\s*\)/.test(verify) ||
    /(?:deployment_status\.environment|github\.event\.deployment\.environment)[^\n]*[Pp]roduction/.test(verify) ||
    /[Pp]roduction[^\n]*(?:deployment_status\.environment|github\.event\.deployment\.environment)/.test(verify) ||
    /environment:\s*production\b/.test(verify);
  assert.ok(requiresProduction, 'verify-release.yml does not require the production environment');
  assert.match(verify, /contains\(\s*github\.event\.deployment\.environment\s*,\s*['"]ega-skills-mcp['"]\s*\)/);
  assert.match(verify, /github\.event\.deployment\.ref\s*==\s*['"]main['"]/);
  const allowsPreview =
    /(?:deployment_status\.environment|github\.event\.deployment\.environment)[^\n]*==[^\n]*['"]preview['"]/.test(verify) ||
    /environment:\s*preview\b/.test(verify);
  assert.equal(allowsPreview, false, 'verify-release.yml must not run on preview');
});

test('verify-release.yml serializes verification and invokes both release scripts', () => {
  assert.ok(verify, '.github/workflows/verify-release.yml is missing');
  const concurrency = topLevelBlock(verify, 'concurrency');
  assert.ok(concurrency, 'verify-release.yml has no concurrency block');
  assert.match(concurrency, /^\s*group:/m);
  assert.match(concurrency, /^\s*cancel-in-progress:\s*false\s*$/m);
  assert.match(verify, /scripts\/release\/verify-live\.mjs/);
  assert.match(verify, /scripts\/release\/recover-production\.mjs/);
});

test('release-sensitive paths always classify as full', () => {
  const paths = [
    '.github/workflows/ci.yml',
    '.github/workflows/verify-release.yml',
    'scripts/release/verify-live.mjs',
    'scripts/release/recover-production.mjs',
    'scripts/ci/check-gate.mjs',
    'scripts/hosted/validate-artifact.mjs',
    'packages/mcp/artifact/hub-release.json',
    'packages/mcp/vercel.json',
    'packages/mcp/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'supabase/migrations/0001_init.sql',
  ];
  for (const path of paths) assert.equal(classify([{ status: 'M', path }]).mode, 'full', path);
});

const okNeeds = {
  classify: { result: 'success' },
  docs: { result: 'success' },
  foundation: { result: 'success' },
  web: { result: 'success' },
  'web-isolation': { result: 'success' },
  rls: { result: 'success' },
};

function runGate(mode, needsJson) {
  const env = { ...process.env, CI_MODE: mode };
  if (needsJson === undefined) delete env.CI_NEEDS;
  else env.CI_NEEDS = needsJson;
  return spawnSync(process.execPath, [gatePath], { cwd: root, env, encoding: 'utf8' });
}

test('check-gate entry point exits 0 only when every required job succeeded', () => {
  const success = runGate('full', JSON.stringify(okNeeds));
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /selected jobs succeeded/);

  const failure = runGate('full', JSON.stringify({ ...okNeeds, web: { result: 'failure' } }));
  assert.notEqual(failure.status, 0, 'a failed dependency must fail the gate');

  const skipped = runGate('full', JSON.stringify({ ...okNeeds, rls: { result: 'skipped' } }));
  assert.notEqual(skipped.status, 0, 'a skipped dependency must fail the gate');

  const missing = { ...okNeeds };
  delete missing.foundation;
  const missingGate = runGate('full', JSON.stringify(missing));
  assert.notEqual(missingGate.status, 0, 'a missing dependency must fail the gate');

  const absent = runGate('full', undefined);
  assert.notEqual(absent.status, 0, 'missing CI_NEEDS must fail the gate');

  const unknownMode = runGate('bogus', JSON.stringify(okNeeds));
  assert.notEqual(unknownMode.status, 0, 'unknown mode must fail the gate');

  const emptyMode = runGate('', JSON.stringify(okNeeds));
  assert.notEqual(emptyMode.status, 0, 'absent classification must fail the gate');
});

test('docs and web modes gate their own subset but still require the full job set', () => {
  const docsNeeds = {
    ...okNeeds,
    foundation: { result: 'skipped' },
    web: { result: 'skipped' },
    'web-isolation': { result: 'skipped' },
    rls: { result: 'skipped' },
  };
  assert.equal(runGate('docs', JSON.stringify(docsNeeds)).status, 0);
  assert.notEqual(runGate('docs', JSON.stringify({ ...docsNeeds, docs: { result: 'failure' } })).status, 0);

  const webNeeds = { ...okNeeds, 'web-isolation': { result: 'skipped' }, rls: { result: 'skipped' } };
  assert.equal(runGate('web', JSON.stringify(webNeeds)).status, 0);
  assert.notEqual(runGate('web', JSON.stringify({ ...webNeeds, web: { result: 'failure' } })).status, 0);
});
