import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, gate, isReleaseSensitive, MODES, REQUIRED_JOBS } from '../../scripts/ci/classify-changes.mjs';

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

test('gate rejects failed, missing, cancelled or skipped selected jobs', () => {
  const ok = {classify:'success', docs:'success', foundation:'success', web:'success', isolation:'success', rls:'success'};
  assert.equal(gate('full', ok), true);
  for (const job of Object.keys(ok)) for (const value of ['failure','cancelled','skipped','', null, undefined]) assert.equal(gate('full', {...ok,[job]:value}), false);
  assert.equal(gate('docs', {...ok,foundation:'skipped',web:'skipped',isolation:'skipped',rls:'skipped'}), true);
  assert.equal(gate('web', {...ok,isolation:'skipped',rls:'skipped'}), true);
});

test('gate is fail-closed for unknown modes and malformed results', () => {
  const ok = {classify:'success', docs:'success', foundation:'success', web:'success', isolation:'success', rls:'success'};
  for (const mode of ['bogus', '', 'FULL', 'full ', undefined, null, 0, ['full']]) assert.equal(gate(mode, ok), false);
  for (const results of [undefined, null, {}, [], 'success']) assert.equal(gate('full', results), false);
  // A required job absent from `needs` must fail even when every present job passed.
  for (const job of REQUIRED_JOBS) {
    const missing = {...ok}; delete missing[job];
    assert.equal(gate('full', missing), false, job);
    assert.equal(gate('docs', missing), false, job);
    assert.equal(gate('web', missing), false, job);
  }
  // An extra, ungated job in `needs` also fails closed.
  assert.equal(gate('full', {...ok, extra:'failure'}), false);
  assert.equal(gate('docs', {...ok, extra:'failure'}), false);
});

test('mode table only exposes the known modes', () => {
  assert.deepEqual(Object.keys(MODES).sort(), ['docs', 'full', 'web']);
  assert.deepEqual(REQUIRED_JOBS, ['classify', 'docs', 'foundation', 'web', 'isolation', 'rls']);
  assert.deepEqual(MODES.full, REQUIRED_JOBS);
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
    assert.match(readFileSync(output,'utf8'), /^mode=full\n/);
    const needs = Object.fromEntries(['classify','docs','foundation','web','web-isolation','rls'].map(name => [name,{result:name === 'rls' ? 'skipped' : 'success'}]));
    const check = spawnSync(process.execPath, ['scripts/ci/check-gate.mjs'], {env:{...process.env, CI_MODE:'full', CI_NEEDS:JSON.stringify(needs)},encoding:'utf8'});
    assert.notEqual(check.status, 0);
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
