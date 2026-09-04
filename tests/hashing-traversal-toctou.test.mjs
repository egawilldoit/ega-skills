import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const hashing = await import('../packages/hashing/dist/index.js');

async function tempDir(t, prefix = 'ega-559-toctou-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function hasCode(code) {
  return (error) => error instanceof hashing.HashTraversalError && error.code === code;
}

test('a file mutated after validation but before read fails with E_IMPORT_SOURCE_CHANGED', async (t) => {
  const root = await tempDir(t);
  const source = path.join(root, 'source.txt');
  await writeFile(source, 'before');

  const [file] = await hashing.traverseFiles(await hashing.resolveTraversalRoot(root));
  await writeFile(source, 'after-with-a-different-size');

  await assert.rejects(file.read(), hasCode('E_IMPORT_SOURCE_CHANGED'));
});

test('a validated path replaced by a different file fails with E_IMPORT_SOURCE_CHANGED', async (t) => {
  const root = await tempDir(t);
  const source = path.join(root, 'source.txt');
  const old = path.join(root, 'old.txt');
  await writeFile(source, 'same-size');

  const [file] = await hashing.traverseFiles(await hashing.resolveTraversalRoot(root));
  await rename(source, old);
  await writeFile(source, 'same-size');

  await assert.rejects(file.read(), hasCode('E_IMPORT_SOURCE_CHANGED'));
});

test('a validated file replaced by a directory fails with E_IMPORT_SOURCE_CHANGED', async (t) => {
  const root = await tempDir(t);
  const source = path.join(root, 'source.txt');
  await writeFile(source, 'file');

  const [file] = await hashing.traverseFiles(await hashing.resolveTraversalRoot(root));
  await unlink(source);
  await mkdir(source);

  await assert.rejects(file.read(), hasCode('E_IMPORT_SOURCE_CHANGED'));
});

test('a validated symlink retargeted before read fails with E_IMPORT_SOURCE_CHANGED', { skip: process.platform === 'win32' }, async (t) => {
  const root = await tempDir(t);
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  const alias = path.join(root, 'alias.txt');
  await writeFile(first, 'first');
  await writeFile(second, 'second');
  await symlink(first, alias, 'file');

  const files = await hashing.traverseFiles(await hashing.resolveTraversalRoot(root));
  const file = files.find((candidate) => candidate.relativePath === 'alias.txt');
  assert.ok(file);

  await unlink(alias);
  await symlink(second, alias, 'file');

  await assert.rejects(file.read(), hasCode('E_IMPORT_SOURCE_CHANGED'));
});

test('ordinary hard-linked files are not rejected as a symlink cycle', async (t) => {
  const root = await tempDir(t);
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  await writeFile(first, 'shared');
  await link(first, second);

  const files = await hashing.traverseFiles(await hashing.resolveTraversalRoot(root));
  assert.deepEqual(
    files.map((file) => file.relativePath).sort(),
    ['first.txt', 'second.txt'],
  );
  assert.equal((await files[0].read()).toString('utf8'), 'shared');
  assert.equal((await files[1].read()).toString('utf8'), 'shared');
});
