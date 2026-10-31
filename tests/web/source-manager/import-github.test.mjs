import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readGithubImport, validateImportLocation } from '../../../apps/web/server/source-manager/import-github.ts';

const commit = 'a'.repeat(40), treeSha = 'b'.repeat(40);
const location = { owner: 'example', repo: 'skills', commit, directory: 'skills/sample' };
const blob = text => ({ text, sha: createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex') });

function transportFor(extra = []) {
  const files = [
    ['skills/sample/SKILL.md', '100644', blob('---\nname: sample\ndescription: Test skill\n---\nBody')],
    ['skills/sample/scripts/example.sh', '100755', blob('#!/bin/sh\nexit 0\n')],
    ['LICENSE', '100644', blob('License text')], ...extra,
  ];
  const calls = [];
  const transport = async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.redirect, 'error');
    const path = url.slice('https://api.github.com/repos/example/skills'.length);
    if (path === `/git/commits/${commit}`) return new Response(JSON.stringify({ sha: commit, tree: { sha: treeSha } }));
    if (path === `/git/trees/${treeSha}?recursive=1`) return new Response(JSON.stringify({ truncated: false, tree: files.map(([path, mode, value]) => ({ path, mode, type: 'blob', size: Buffer.byteLength(value.text), sha: value.sha })) }));
    const value = files.find(([, , value]) => path === `/git/blobs/${value.sha}`)?.[2];
    if (value) return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(value.text).toString('base64') }));
    throw new Error('Unexpected request');
  };
  return { transport, calls };
}

test('reads only a pinned GitHub directory and its pinned license without forwarding credentials', async () => {
  const fake = transportFor();
  const result = await readGithubImport(location, fake.transport);
  assert.deepEqual(result.files.map(file => [file.path, file.mode]), [['SKILL.md', '100644'], ['scripts/example.sh', '100755']]);
  assert.equal(result.license.text, 'License text');
  assert.ok(fake.calls.every(url => url.startsWith('https://api.github.com/repos/example/skills/')));
});

test('rejects arbitrary hosts, mutable revisions, traversal, and ambiguous license before import', async () => {
  for (const candidate of [{ ...location, owner: 'evil.example' }, { ...location, commit: 'main' }, { ...location, directory: '../other' }, { ...location, url: 'https://elsewhere/' }]) assert.throws(() => validateImportLocation(candidate));
  await assert.rejects(readGithubImport(location, transportFor([['LICENCE.txt', '100644', blob('another license')]]).transport), e => e.status === 422);
  await assert.rejects(readGithubImport(location, transportFor([['skills/sample/../evil', '100644', blob('bad')]]).transport), e => e.status === 422);
  await assert.rejects(readGithubImport(location, transportFor([['skills/sample/scripts/evil', '120000', blob('link')]]).transport), e => e.status === 422);
});
