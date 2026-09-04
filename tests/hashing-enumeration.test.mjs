import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const hashing = await import('../packages/hashing/dist/index.js');
const {
  buildCanonicalFileRecords,
  enumerateCanonicalFileRecords,
  resolveTraversalRoot,
} = hashing;

const OTHER = 'other';

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function analyzeExact(file) {
  const bytes = await file.read();
  return {
    role: OTHER,
    blob_hash: sha256(bytes),
    byte_size: bytes.length,
    content_kind: 'BINARY',
  };
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ega-560-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('hashing exports canonical package enumeration APIs', () => {
  assert.equal(typeof enumerateCanonicalFileRecords, 'function');
  assert.equal(typeof buildCanonicalFileRecords, 'function');
});

test('enumeration skips exactly the frozen hashing exclusions while retaining discovery-only exclusions', async (t) => {
  const root = await tempRoot(t);

  await writeFile(path.join(root, 'SKILL.md'), '# Skill\n');
  await writeFile(path.join(root, '.DS_Store'), 'ignore');
  await writeFile(path.join(root, 'Thumbs.db'), 'ignore');
  await writeFile(path.join(root, 'desktop.ini'), 'ignore');

  for (const directory of ['.git', 'node_modules', '.venv', '__pycache__']) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'ignored.txt'), directory);
  }

  for (const directory of ['dist', 'build', '.next', 'coverage']) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'kept.txt'), directory);
  }

  const traversalRoot = await resolveTraversalRoot(root);
  const records = await enumerateCanonicalFileRecords(traversalRoot, analyzeExact);

  assert.deepEqual(records.map((record) => record.path), [
    '.next/kept.txt',
    'SKILL.md',
    'build/kept.txt',
    'coverage/kept.txt',
    'dist/kept.txt',
  ]);
});

test('excluded directories are pruned before link traversal', async (t) => {
  const root = await tempRoot(t);
  const outside = await tempRoot(t);
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(outside, 'outside.txt'), 'outside');

  const linkPath = path.join(root, '.git', 'escape');
  try {
    if (process.platform === 'win32') {
      await symlink(outside, linkPath, 'junction');
    } else {
      await symlink(outside, linkPath, 'dir');
    }
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('runner does not permit symlink/junction creation');
      return;
    }
    throw error;
  }

  const traversalRoot = await resolveTraversalRoot(root);
  const records = await enumerateCanonicalFileRecords(traversalRoot, analyzeExact);
  assert.deepEqual(records, []);
});

test('nested canonical paths use forward slashes and sort by UTF-16 code units', async (t) => {
  const root = await tempRoot(t);
  await mkdir(path.join(root, 'nested'), { recursive: true });

  for (const name of ['zeta.txt', 'a_beta.txt', 'a.beta.txt', 'a-beta.txt', 'a+beta.txt']) {
    await writeFile(path.join(root, 'nested', name), name);
  }

  const traversalRoot = await resolveTraversalRoot(root);
  const records = await enumerateCanonicalFileRecords(traversalRoot, analyzeExact);

  assert.deepEqual(records.map((record) => record.path), [
    'nested/a+beta.txt',
    'nested/a-beta.txt',
    'nested/a.beta.txt',
    'nested/a_beta.txt',
    'nested/zeta.txt',
  ]);
  for (const record of records) {
    assert.equal(record.path.includes('\\'), false);
  }
});

test('hard-linked regular files retain distinct lexical paths and may share blob hashes', async (t) => {
  const root = await tempRoot(t);
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  await writeFile(first, 'same bytes');
  await link(first, second);

  const traversalRoot = await resolveTraversalRoot(root);
  const records = await enumerateCanonicalFileRecords(traversalRoot, analyzeExact);

  assert.deepEqual(records.map((record) => record.path), ['first.txt', 'second.txt']);
  assert.equal(records[0].blob_hash, records[1].blob_hash);
});

test('record assembly rejects duplicate canonical paths with E_HASH_DUPLICATE_PATH', async () => {
  const file = {
    relativePath: 'duplicate.txt',
    lexicalPath: '/tmp/duplicate.txt',
    realPath: '/tmp/duplicate.txt',
    async read() {
      return Buffer.from('duplicate');
    },
  };

  await assert.rejects(
    () => buildCanonicalFileRecords([file, file], analyzeExact),
    (error) => error?.code === 'E_HASH_DUPLICATE_PATH' && error?.path === 'duplicate.txt',
  );
});

test('record assembly preserves canonical byte_size supplied by content analysis instead of source byte size', async () => {
  const source = Buffer.from('\ufeffline one\r\nline two\r\n', 'utf8');
  const canonical = Buffer.from('line one\nline two\n', 'utf8');
  const file = {
    relativePath: 'notes.txt',
    lexicalPath: '/tmp/notes.txt',
    realPath: '/tmp/notes.txt',
    async read() {
      return source;
    },
  };

  const [record] = await buildCanonicalFileRecords([file], async () => ({
    role: OTHER,
    blob_hash: sha256(canonical),
    byte_size: canonical.length,
    content_kind: 'TEXT',
  }));

  assert.notEqual(source.length, canonical.length);
  assert.equal(record.byte_size, canonical.length);
  assert.equal(record.blob_hash, sha256(canonical));
  assert.equal(record.content_kind, 'TEXT');
});
