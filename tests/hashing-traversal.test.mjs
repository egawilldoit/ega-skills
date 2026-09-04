import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const hashing = await import('../packages/hashing/dist/index.js');

async function tempDir(t, prefix = 'ega-559-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function hasCode(code) {
  return (error) => error instanceof Error && error.code === code;
}

async function createDirectoryLink(target, link) {
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

test('resolveTraversalRoot keeps lexical and real roots separate for a valid directory', async (t) => {
  const root = await tempDir(t, 'ega-559-root-');

  assert.equal(typeof hashing.resolveTraversalRoot, 'function');

  const resolved = await hashing.resolveTraversalRoot(root);
  assert.equal(resolved.lexicalRoot, path.resolve(root));
  assert.equal(resolved.realRoot, await realpath(root));
});

test('resolveTraversalRoot rejects a missing root without exposing a raw filesystem error', async (t) => {
  const parent = await tempDir(t, 'ega-559-missing-');
  const missing = path.join(parent, 'does-not-exist');

  await assert.rejects(
    hashing.resolveTraversalRoot(missing),
    (error) => error instanceof Error
      && error.name === 'Error'
      && error.message === `Traversal root does not exist: ${path.resolve(missing)}`
      && !('code' in error),
  );
});

test('resolveTraversalRoot rejects a root that is not a directory', async (t) => {
  const parent = await tempDir(t, 'ega-559-file-root-');
  const file = path.join(parent, 'file.txt');
  await writeFile(file, 'not a directory');

  await assert.rejects(
    hashing.resolveTraversalRoot(file),
    (error) => error instanceof Error
      && error.message === `Traversal root is not a directory: ${path.resolve(file)}`,
  );
});

test('traverseFiles returns normal files with lexical paths and readable bytes', async (t) => {
  const root = await tempDir(t, 'ega-559-file-');
  const mixed = path.join(root, 'MiXeD');
  await mkdir(mixed);
  await writeFile(path.join(mixed, 'File.TXT'), 'hello');

  assert.equal(typeof hashing.traverseFiles, 'function');
  const traversalRoot = await hashing.resolveTraversalRoot(root);
  const files = await hashing.traverseFiles(traversalRoot);

  assert.equal(files.length, 1);
  assert.equal(files[0].relativePath, path.join('MiXeD', 'File.TXT'));
  assert.equal(files[0].lexicalPath, path.join(traversalRoot.lexicalRoot, 'MiXeD', 'File.TXT'));
  assert.equal(files[0].realPath, await realpath(path.join(mixed, 'File.TXT')));
  assert.equal((await files[0].read()).toString('utf8'), 'hello');
});

test('Linux follows an internal file symlink while preserving the lexical link path', { skip: process.platform === 'win32' }, async (t) => {
  const root = await tempDir(t, 'ega-559-file-link-');
  const target = path.join(root, 'target.txt');
  const link = path.join(root, 'Alias.TXT');
  await writeFile(target, 'linked');
  await symlink(target, link, 'file');

  const files = await hashing.traverseFiles(await hashing.resolveTraversalRoot(root));
  const linked = files.find((file) => file.relativePath === 'Alias.TXT');

  assert.ok(linked);
  assert.equal(linked.lexicalPath, link);
  assert.equal(linked.realPath, await realpath(target));
  assert.equal((await linked.read()).toString('utf8'), 'linked');
});

test('follows an internal directory symlink or Windows junction', async (t) => {
  const root = await tempDir(t, 'ega-559-dir-link-');
  const target = path.join(root, 'target');
  const link = path.join(root, 'AliasDir');
  await mkdir(target);
  await writeFile(path.join(target, 'Nested.TXT'), 'nested');
  await createDirectoryLink(target, link);

  const files = await hashing.traverseFiles(await hashing.resolveTraversalRoot(root));
  const linked = files.find((file) => file.relativePath === path.join('AliasDir', 'Nested.TXT'));

  assert.ok(linked);
  assert.equal((await linked.read()).toString('utf8'), 'nested');
});

test('rejects an external directory symlink or junction with E_HASH_LINK_ESCAPE', async (t) => {
  const root = await tempDir(t, 'ega-559-external-root-');
  const outside = await tempDir(t, 'ega-559-external-target-');
  await writeFile(path.join(outside, 'outside.txt'), 'outside');
  await createDirectoryLink(outside, path.join(root, 'escape'));

  await assert.rejects(
    hashing.traverseFiles(await hashing.resolveTraversalRoot(root)),
    hasCode('E_HASH_LINK_ESCAPE'),
  );
});

test('rejects a broken link with E_HASH_LINK_BROKEN', { skip: process.platform === 'win32' }, async (t) => {
  const root = await tempDir(t, 'ega-559-broken-');
  await symlink(path.join(root, 'missing.txt'), path.join(root, 'broken.txt'), 'file');

  await assert.rejects(
    hashing.traverseFiles(await hashing.resolveTraversalRoot(root)),
    hasCode('E_HASH_LINK_BROKEN'),
  );
});

test('rejects a directory-link cycle with E_HASH_LINK_CYCLE', async (t) => {
  const root = await tempDir(t, 'ega-559-cycle-');
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  await createDirectoryLink(root, path.join(nested, 'back'));

  await assert.rejects(
    hashing.traverseFiles(await hashing.resolveTraversalRoot(root)),
    hasCode('E_HASH_LINK_CYCLE'),
  );
});

test('resolveTraversalFile rejects lexical path escape with E_HASH_PATH_ESCAPE', async (t) => {
  const root = await tempDir(t, 'ega-559-path-root-');
  const outside = path.join(path.dirname(root), 'outside.txt');
  await writeFile(outside, 'outside');
  t.after(() => rm(outside, { force: true }));

  assert.equal(typeof hashing.resolveTraversalFile, 'function');
  await assert.rejects(
    hashing.resolveTraversalFile(await hashing.resolveTraversalRoot(root), '../outside.txt'),
    hasCode('E_HASH_PATH_ESCAPE'),
  );
});

test('relative-path containment rejects sibling prefixes without raw prefix semantics', () => {
  assert.equal(typeof hashing.isPathContained, 'function');
  const root = path.resolve(path.sep, 'tmp', 'skill');
  assert.equal(hashing.isPathContained(root, path.join(root, 'inside.txt')), true);
  assert.equal(hashing.isPathContained(root, path.resolve(path.sep, 'tmp', 'skill-other', 'outside.txt')), false);
});

test('Windows containment is case-insensitive for drive paths', { skip: process.platform !== 'win32' }, () => {
  assert.equal(hashing.isPathContained('C:\\Skills\\Root', 'c:\\skills\\root\\Child\\file.txt'), true);
  assert.equal(hashing.isPathContained('C:\\Skills\\Root', 'c:\\skills\\root-other\\file.txt'), false);
});

test('Windows UNC containment tolerates server/share/root case differences', { skip: process.platform !== 'win32' }, () => {
  assert.equal(hashing.isPathContained('\\\\Server\\Share\\Root', '\\\\server\\share\\root\\Child'), true);
  assert.equal(hashing.isPathContained('\\\\Server\\Share\\Root', '\\\\server\\share\\root-other\\Child'), false);
});

test('structured traversal errors expose only the frozen public code', async (t) => {
  const root = await tempDir(t, 'ega-559-structured-');
  const outside = await tempDir(t, 'ega-559-structured-out-');
  await createDirectoryLink(outside, path.join(root, 'escape'));

  await assert.rejects(
    hashing.traverseFiles(await hashing.resolveTraversalRoot(root)),
    (error) => error instanceof hashing.HashTraversalError
      && error.name === 'HashTraversalError'
      && error.code === 'E_HASH_LINK_ESCAPE'
      && typeof error.message === 'string'
      && !error.message.includes('ENOENT'),
  );
});
