import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { classify, gate, isReleaseSensitive, MODES, REQUIRED_JOBS, WINDOWS_JOBS, ALL_JOBS, windowsSelected } from '../../scripts/ci/classify-changes.mjs';
import { buildShardPartitions, describeShard } from '../../scripts/ci/sharding.mjs';
import { verifyShards } from '../../scripts/ci/verify-shards.mjs';

test('README modifications select docs', () => {
  assert.equal(classify([{ status: 'M', path: 'README.md' }]).mode, 'docs');
});
test('existing frontend modifications select web', () => {
  assert.equal(classify([{ status: 'M', path: 'apps/web/src/components/StatCard.tsx' }]).mode, 'web');
});
test('uncertain, security, and global changes select full', () => {
  for (const entries of [[], [{status:'A',path:'apps/web/src/new.tsx'}], [{status:'D',path:'README.md'}], [{status:'R100',path:'README.md'}], [{status:'M',path:'supabase/schema.sql'}], [{status:'M',path:'apps/web/src/pages/SecurityPage.tsx'}], [{status:'M',path:'apps/web/src/pages/MembersPage.tsx'}], [{status:'M',path:'apps/web/src/App.tsx'}], [{status:'M',path:'apps/web/src/workspace/WorkspaceProvider.tsx'}], [{status:'M',path:'packages/hashing/index.ts'}], [{status:'M',path:'pnpm-lock.yaml'}], [{status:'M',path:'scripts/ci/classify-changes.mjs'}], [{status:'M',path:'unknown'}], Array.from({length:301}, () => ({status:'M',path:'README.md'}))]) {
    assert.equal(classify(entries).mode, 'full');
  }
});

test('release-sensitive paths are explicitly full', () => {
  const paths = [
    '.github/workflows/ci.yml',
    '.github/workflows/verify-release.yml',
    '.github/workflows/new-release.yml',
    'scripts/release/verify-live.mjs',
    'scripts/release/recover-production.mjs',
    'scripts/release/verify-release.mjs',
    'scripts/ci/classify-changes.mjs',
    'scripts/ci/check-gate.mjs',
    'scripts/ci/test-ownership.json',
    'scripts/hosted/validate-artifact.mjs',
    'packages/mcp/artifact/hub-release.json',
    'packages/mcp/artifact/release-package.json',
    'packages/mcp/vercel.json',
    'packages/mcp/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'supabase/migrations/0001_init.sql',
  ];
  for (const path of paths) {
    assert.equal(isReleaseSensitive(path), true, path);
    assert.equal(classify([{ status: 'M', path }]).mode, 'full', path);
    // A release path must stay full even when mixed with an otherwise docs-only change.
    assert.equal(classify([{ status: 'M', path: 'README.md' }, { status: 'M', path }]).mode, 'full', path);
  }
});

test('release-sensitive lookalikes and unrelated paths are not broadened', () => {
  for (const path of ['README.md', 'apps/web/src/components/StatCard.tsx', 'packages/mcp/README.md', 'scripts/release-notes.md', '.github/CODEOWNERS']) {
    assert.equal(isReleaseSensitive(path), false, path);
  }
  assert.equal(classify([{ status: 'M', path: '.github/CODEOWNERS' }]).mode, 'full');
});

test('mixed docs and web selects web, shared security mutation selects full', () => {
  assert.equal(classify([{status:'M',path:'README.md'},{status:'M',path:'apps/web/src/components/StatCard.tsx'}]).mode, 'web');
  assert.equal(classify([{status:'M',path:'apps/web/src/components/StatCard.tsx'},{status:'M',path:'packages/control-plane/security.ts'}]).mode, 'full');
});

// Every gate fixture must now carry the whole `needs` key set: the six Linux jobs,
// the two Windows shards and the Windows aggregator.
const baseJobs = {classify:'success', docs:'success', foundation:'success', web:'success', isolation:'success', rls:'success'};
const windowsSkipped = {'foundation-windows-shard-1':'skipped','foundation-windows-shard-2':'skipped','foundation-windows':'skipped'};
const windowsSucceeded = {'foundation-windows-shard-1':'success','foundation-windows-shard-2':'success','foundation-windows':'success'};
const ok = {...baseJobs, ...windowsSkipped};

test('gate rejects failed, missing, cancelled or skipped selected jobs', () => {
  assert.equal(gate('full', ok), true);
  for (const job of Object.keys(baseJobs)) for (const value of ['failure','cancelled','skipped','', null, undefined]) assert.equal(gate('full', {...ok,[job]:value}), false);
  assert.equal(gate('docs', {...ok,foundation:'skipped',web:'skipped',isolation:'skipped',rls:'skipped'}), true);
  assert.equal(gate('web', {...ok,isolation:'skipped',rls:'skipped'}), true);
});

test('gate requires real Windows shard success when Windows is selected', () => {
  const windowsRun = {...baseJobs, ...windowsSucceeded};
  assert.equal(gate('full', windowsRun, {windows:true}), true);
  assert.equal(gate('web', windowsRun, {windows:true}), true);
  assert.equal(gate('docs', windowsRun, {windows:true}), true);
  // A skipped shard, skipped aggregator, failure or cancellation is never enough.
  for (const job of Object.keys(windowsSucceeded)) {
    for (const value of ['skipped','failure','cancelled','', null, undefined]) {
      assert.equal(gate('full', {...windowsRun,[job]:value}, {windows:true}), false, `${job}=${value}`);
    }
  }
  // Each shard is independently mandatory: losing one loses the gate.
  for (const job of Object.keys(windowsSucceeded)) {
    const missing = {...windowsRun};
    delete missing[job];
    assert.equal(gate('full', missing, {windows:true}), false, job);
  }
});

test('gate requires an explicit Windows skip when Windows is not selected', () => {
  assert.equal(gate('full', ok), true);
  assert.equal(gate('full', ok, {windows:false}), true);
  // Windows work that ran when it was not selected is not a valid state either.
  assert.equal(gate('full', {...baseJobs, ...windowsSucceeded}), false);
  assert.equal(gate('full', {...baseJobs, ...windowsSucceeded}, {windows:false}), false);
  // Windows selected but the jobs are absent from `needs` entirely.
  assert.equal(gate('full', baseJobs, {windows:true}), false);
  assert.equal(gate('full', baseJobs, {windows:false}), false);
});

test('gate is fail-closed for unknown modes and malformed results', () => {
  for (const mode of ['bogus', '', 'FULL', 'full ', undefined, null, 0, ['full']]) assert.equal(gate(mode, ok), false);
  for (const results of [undefined, null, {}, [], 'success']) assert.equal(gate('full', results), false);
  // A required job absent from `needs` must fail even when every present job passed.
  for (const job of ALL_JOBS) {
    const missing = {...ok}; delete missing[job];
    assert.equal(gate('full', missing), false, job);
    assert.equal(gate('docs', missing), false, job);
    assert.equal(gate('web', missing), false, job);
  }
  // An extra, ungated job in `needs` also fails closed.
  assert.equal(gate('full', {...ok, extra:'failure'}), false);
  assert.equal(gate('docs', {...ok, extra:'failure'}), false);
});

test('windows selection matches the workflow predicate', () => {
  assert.equal(windowsSelected({event:'workflow_dispatch'}), true);
  assert.equal(windowsSelected({event:'pull_request', baseRef:'release/2.0'}), true);
  assert.equal(windowsSelected({event:'push', ref:'refs/heads/release/2.0'}), true);
  assert.equal(windowsSelected({event:'pull_request', baseRef:'main'}), false);
  assert.equal(windowsSelected({event:'push', ref:'refs/heads/main'}), false);
  assert.equal(windowsSelected({event:'push', ref:'refs/heads/release/2.0-rc'}), false);
  assert.equal(windowsSelected({}), false);
  assert.equal(windowsSelected(), false);
});

test('mode table only exposes the known modes', () => {
  assert.deepEqual(Object.keys(MODES).sort(), ['docs', 'full', 'web']);
  assert.deepEqual(REQUIRED_JOBS, ['classify', 'docs', 'foundation', 'web', 'isolation', 'rls']);
  assert.deepEqual(MODES.full, REQUIRED_JOBS);
  assert.deepEqual(WINDOWS_JOBS, ['foundation-windows-shard-1','foundation-windows-shard-2','foundation-windows']);
  assert.deepEqual(ALL_JOBS, [...REQUIRED_JOBS, ...WINDOWS_JOBS]);
});

test('CLI defaults to full when git refs are missing and gate exits nonzero for skipped required job', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ega-ci-selector-'));
  try {
    const output = join(dir, 'output');
    const select = spawnSync(process.execPath, ['scripts/ci/classify-changes.mjs'], {env:{...process.env, CI_EVENT:'pull_request', CI_BASE_REF:'main', CI_BASE_SHA:'bad', CI_HEAD_SHA:'bad', GITHUB_OUTPUT:output}, encoding:'utf8'});
    assert.equal(select.status, 0);
    assert.match(readFileSync(output,'utf8'), /^mode=full\nreason=.*\nwindows=false\n$/);
    const needs = Object.fromEntries(['classify','docs','foundation','web','web-isolation','rls'].map(name => [name,{result:name === 'rls' ? 'skipped' : 'success'}]));
    const check = spawnSync(process.execPath, ['scripts/ci/check-gate.mjs'], {env:{...process.env, CI_MODE:'full', CI_NEEDS:JSON.stringify(needs)},encoding:'utf8'});
    assert.notEqual(check.status, 0);

    const fullNeeds = Object.fromEntries([
      ...['classify','docs','foundation','web','web-isolation','rls'].map(name => [name,{result:'success'}]),
      ...['foundation-windows-shard-1','foundation-windows-shard-2','foundation-windows'].map(name => [name,{result:'skipped'}]),
    ]);
    const clean = spawnSync(process.execPath, ['scripts/ci/check-gate.mjs'], {env:{...process.env, CI_MODE:'full', CI_NEEDS:JSON.stringify(fullNeeds), CI_WINDOWS:'false'},encoding:'utf8'});
    assert.equal(clean.status, 0, clean.stderr);
    // Windows selected but the shard is skipped: the CLI must fail, not accept a green matrix.
    const windowsNeeds = {...fullNeeds, 'foundation-windows-shard-2':{result:'skipped'}};
    const windowsCheck = spawnSync(process.execPath, ['scripts/ci/check-gate.mjs'], {env:{...process.env, CI_MODE:'full', CI_NEEDS:JSON.stringify(windowsNeeds), CI_WINDOWS:'true'},encoding:'utf8'});
    assert.notEqual(windowsCheck.status, 0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('CLI reads real git history and fails closed on deletions, renames and shallow history', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ega-ci-git-'));
  const script = resolve('scripts/ci/classify-changes.mjs');
  const git = (...args) => execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  try {
    git('init'); git('config','user.email','ci@example.invalid'); git('config','user.name','CI test');
    mkdirSync(join(dir,'apps/web/src/components'),{recursive:true});
    mkdirSync(join(dir,'scripts/release'),{recursive:true});
    writeFileSync(join(dir,'README.md'),'base\n');
    writeFileSync(join(dir,'apps/web/src/components/StatCard.tsx'),'base\n');
    writeFileSync(join(dir,'scripts/release/verify-live.mjs'),'base\n');
    git('add','.'); git('commit','-m','base'); const base = git('rev-parse','HEAD');
    const select = head => {
      const output = join(dir,'out');
      const run = spawnSync(process.execPath,[script],{cwd:dir,env:{...process.env,CI_EVENT:'pull_request',CI_BASE_REF:'main',CI_BASE_SHA:base,CI_HEAD_SHA:head,GITHUB_OUTPUT:output},encoding:'utf8'});
      assert.equal(run.status,0,run.stderr);
      const mode = /mode=(\w+)/.exec(readFileSync(output,'utf8'))[1];
      rmSync(output); return mode;
    };
    writeFileSync(join(dir,'README.md'),'changed\n'); git('add','.'); git('commit','-m','docs');
    assert.equal(select(git('rev-parse','HEAD')),'docs');
    writeFileSync(join(dir,'scripts/release/verify-live.mjs'),'changed\n'); git('add','.'); git('commit','-m','release');
    assert.equal(select(git('rev-parse','HEAD')),'full');
    renameSync(join(dir,'README.md'),join(dir,'RENAMED.md')); git('add','-A'); git('commit','-m','rename');
    assert.equal(select(git('rev-parse','HEAD')),'full');
    writeFileSync(join(dir,'.git/shallow'),`${base}\n`);
    assert.equal(select(git('rev-parse','HEAD')),'full');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// --- Windows shard coverage gate -------------------------------------------------
// `scripts/ci/verify-shards.mjs` is the aggregator behind the release-required
// `foundation (windows-2022)` context. These cases replay every way its two shard
// jobs can lie about coverage.

const SHARD_JOBS = ['foundation-windows-shard-1', 'foundation-windows-shard-2'];
// A small synthetic inventory exercises the same partition and digest logic without
// re-globbing the repository once per case.
const SHARD_INVENTORY = Array.from({ length: 20 }, (_, index) => `tests/synthetic/case-${index}.test.mjs`);

function shardNeeds(inventory = SHARD_INVENTORY, count = 2) {
  const partitions = buildShardPartitions(inventory.slice().sort(), count);
  return Object.fromEntries(
    partitions.map((files, position) => {
      const described = describeShard({ index: position + 1, count, files, fullFiles: inventory.slice().sort() });
      return [SHARD_JOBS[position], {
        result: 'success',
        outputs: {
          shard_index: String(described.index),
          shard_count: String(described.count),
          shard_files: String(described.files),
          shard_full_files: String(described.fullFiles),
          shard_selection_digest: described.selectionDigest,
          shard_full_digest: described.fullDigest,
          shard_scope: 'unscoped',
        },
      }];
    }),
  );
}

const verify = (needs, overrides = {}) =>
  verifyShards({ needs, jobs: SHARD_JOBS, count: 2, scope: null, inventory: SHARD_INVENTORY, ...overrides });

test('shard aggregator accepts two disjoint shards that cover discovery exactly once', () => {
  const result = verify(shardNeeds());
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /union=20\/20/);
  assert.match(result.message, /foundation-windows-shard-1=1\/2:10f/);
});

test('shard aggregator rejects failed, cancelled, skipped or missing shards', () => {
  for (const [job, result] of [
    ['foundation-windows-shard-1', 'failure'],
    ['foundation-windows-shard-2', 'failure'],
    ['foundation-windows-shard-1', 'cancelled'],
    ['foundation-windows-shard-2', 'cancelled'],
    ['foundation-windows-shard-1', 'skipped'],
    ['foundation-windows-shard-2', 'skipped'],
  ]) {
    const outcome = verify({ ...shardNeeds(), [job]: { ...shardNeeds()[job], result } });
    assert.equal(outcome.ok, false, `${job}=${result} must fail`);
    assert.match(outcome.message, /did not succeed/);
  }
  const missing = shardNeeds();
  delete missing['foundation-windows-shard-2'];
  const outcome = verify(missing);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /missing from the gate's needs/);
});

test('shard aggregator rejects a duplicated shard index', () => {
  const needs = shardNeeds();
  needs['foundation-windows-shard-2'] = { ...needs['foundation-windows-shard-1'] };
  const outcome = verify(needs);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /reported more than once/);
});

test('shard aggregator rejects shard coverage drift', () => {
  const mutations = [
    ['shard_files', (outputs) => { outputs.shard_files = String(Number(outputs.shard_files) - 1); }, /files does not match/],
    ['shard_selection_digest', (outputs) => { outputs.shard_selection_digest = 'deadbeef'; }, /selectionDigest does not match/],
    ['shard_full_files', (outputs) => { outputs.shard_full_files = '19'; }, /fullFiles does not match/],
    ['shard_full_digest', (outputs) => { outputs.shard_full_digest = 'deadbeef'; }, /fullDigest does not match/],
    ['shard_count', (outputs) => { outputs.shard_count = '3'; }, /count does not match/],
    ['shard_index', (outputs) => { outputs.shard_index = '3'; }, /invalid shard index/],
    ['shard_scope', (outputs) => { outputs.shard_scope = 'core'; }, /reported scope/],
  ];
  for (const [field, mutate, pattern] of mutations) {
    const needs = shardNeeds();
    mutate(needs['foundation-windows-shard-1'].outputs);
    const outcome = verify(needs);
    assert.equal(outcome.ok, false, `${field} drift must fail`);
    assert.match(outcome.message, pattern, field);
  }
  // Dropping the last file from the checked-in inventory is coverage drift too.
  const shrunken = verify(shardNeeds(), { inventory: SHARD_INVENTORY.slice(1) });
  assert.equal(shrunken.ok, false);
  assert.match(shrunken.message, /does not match|unassigned/);
});

test('shard aggregator CLI fails closed on a missing or malformed needs payload', () => {
  const base = { ...process.env };
  delete base.CI_SHARD_SCOPE;
  const missing = spawnSync(process.execPath, ['scripts/ci/verify-shards.mjs'], { env: { ...base, CI_SHARD_JOBS: '[]', CI_SHARD_COUNT: '2' }, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  const malformed = spawnSync(process.execPath, ['scripts/ci/verify-shards.mjs'], { env: { ...base, CI_NEEDS: '{not json', CI_SHARD_JOBS: '[]', CI_SHARD_COUNT: '2' }, encoding: 'utf8' });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /not valid JSON/);
});
