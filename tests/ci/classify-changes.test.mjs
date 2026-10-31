import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, gate } from '../../scripts/ci/classify-changes.mjs';

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
test('mixed docs and web selects web, shared security mutation selects full', () => {
  assert.equal(classify([{status:'M',path:'README.md'},{status:'M',path:'apps/web/src/components/StatCard.tsx'}]).mode, 'web');
  assert.equal(classify([{status:'M',path:'apps/web/src/components/StatCard.tsx'},{status:'M',path:'packages/control-plane/security.ts'}]).mode, 'full');
});
test('gate rejects failed, missing, cancelled or skipped selected jobs', () => {
  const ok = {classify:'success', docs:'success', foundation:'success', web:'success', isolation:'success', rls:'success'};
  assert.equal(gate('full', ok), true);
  for (const job of Object.keys(ok)) for (const value of ['failure','cancelled','skipped','']) assert.equal(gate('full', {...ok,[job]:value}), false);
  assert.equal(gate('docs', {...ok,foundation:'skipped',web:'skipped',isolation:'skipped',rls:'skipped'}), true);
  assert.equal(gate('web', {...ok,isolation:'skipped',rls:'skipped'}), true);
  assert.equal(gate('bogus', ok), false);
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
    writeFileSync(join(dir,'README.md'),'base\n');
    writeFileSync(join(dir,'apps/web/src/components/StatCard.tsx'),'base\n');
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
    renameSync(join(dir,'README.md'),join(dir,'RENAMED.md')); git('add','-A'); git('commit','-m','rename');
    assert.equal(select(git('rev-parse','HEAD')),'full');
    writeFileSync(join(dir,'.git/shallow'),`${base}\n`);
    assert.equal(select(git('rev-parse','HEAD')),'full');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
