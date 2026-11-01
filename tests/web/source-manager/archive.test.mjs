import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { prepareSkillArchive, validateSkillArchive } from '../../../apps/web/server/source-manager/archive.ts';
import { readZipEntries } from '../../../apps/web/server/source-manager/zip.ts';

/** Build a real ZIP in memory so the reader is exercised, not mocked. */
function zip(entries, { method = 0, flags = 0x0800, declared = new Map(), encrypted = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of entries) {
    const name = Buffer.from(file.path, 'utf8');
    const content = Buffer.from(file.content);
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const uncompressedSize = declared.get(file.path) ?? content.length;
    const entryFlags = encrypted ? flags | 0x0001 : flags;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entryFlags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entryFlags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const archiveFiles = [
  { path: 'sample/SKILL.md', content: '---\nname: sample\ndescription: A skill\n---\n# Sample\n' },
  { path: 'sample/scripts/check.sh', content: '#!/bin/sh\ntrue\n', mode: 0o100755 },
];

const entry = (path, content, overrides = {}) => {
  const bytes = Buffer.from(content);
  return { path, compressedSize: bytes.length, uncompressedSize: bytes.length, unixMode: 0o100644, encrypted: false, directory: false, async *read() { yield bytes; }, ...overrides };
};
const skill = () => entry('sample/SKILL.md', '---\nname: sample\ndescription: A skill\n---\n# Sample\n');

test('accepts a bounded skill archive and preserves executable scripts', async () => {
  const result = await validateSkillArchive([skill(), entry('sample/references/guide.txt', 'guide'), entry('sample/scripts/check.sh', 'script', { unixMode: 0o100755 })]);
  assert.equal(result.name, 'sample');
  assert.equal(result.files.find(file => file.path === 'scripts/check.sh').mode, '100755');
  assert.equal(Buffer.from(result.files[1].bytes).toString(), 'guide');
});

test('rejects traversal, collisions, symlinks, encryption and archive bombs before reading', async () => {
  for (const other of [
    entry('sample/../escape', 'x'), entry('sample/references/Guide.txt', 'x'),
    entry('sample/assets/link', 'x', { unixMode: 0o120777 }), entry('sample/assets/encrypted', 'x', { encrypted: true }),
    entry('sample/assets/bomb', 'x', { compressedSize: 1, uncompressedSize: 101 }),
    entry('another/assets/file', 'x'), entry('sample/agents/openai.yaml', 'x'),
    entry('sample/assets/file', 'x', { unixMode: 0o100755 }),
  ]) {
    const entries = [skill(), other];
    if (other.path.endsWith('Guide.txt')) entries.push(entry('sample/references/guide.txt', 'x'));
    await assert.rejects(validateSkillArchive(entries), error => error.code === 'E_UPLOAD_ARCHIVE');
  }
});

test('rejects entry streams exceeding or falling short of declared sizes', async () => {
  for (const declared of [1, 3]) {
    await assert.rejects(validateSkillArchive([skill(), entry('sample/assets/file', 'xx', { uncompressedSize: declared })]), error => error.code === 'E_UPLOAD_ARCHIVE');
  }
});

test('preserves streamed bytes when a reader reuses its buffer', async () => {
  const resource = entry('sample/assets/file', 'abcd', {
    async *read() {
      const buffer = Buffer.from('ab');
      yield buffer;
      buffer.write('cd');
      yield buffer;
    },
  });
  const result = await validateSkillArchive([skill(), resource]);
  assert.equal(Buffer.from(result.files[1].bytes).toString(), 'abcd');
});

test('prepares validated archive content and preserves resource bytes and modes', async () => {
  const result = await prepareSkillArchive([skill(), entry('sample/scripts/check.sh', '#!/bin/sh\n', { unixMode: 0o100755 })], () => ({ name: 'sample', description: 'A skill' }));
  assert.equal(result.name, 'sample');
  assert.equal(result.description, 'A skill');
  assert.equal(result.body, '# Sample');
  assert.equal(result.resources[0].mode, '100755');
  assert.equal(Buffer.from(result.resources[0].contentBase64, 'base64').toString(), '#!/bin/sh\n');
});

test('refuses invalid or unsupported archive frontmatter', async () => {
  for (const parse of [() => ({ name: 'another', description: 'A skill' }), () => ({ name: 'sample', description: 'A skill', license: 'MIT' }), () => { throw new Error('invalid YAML'); }]) {
    await assert.rejects(prepareSkillArchive([skill()], parse), error => error.code === 'E_UPLOAD_ARCHIVE');
  }
});

test('reads stored and deflated ZIP entries and preserves executable modes', async () => {
  for (const method of [0, 8]) {
    const result = await validateSkillArchive(readZipEntries(zip(archiveFiles, { method })));
    assert.equal(result.name, 'sample');
    assert.equal(result.files.find(file => file.path === 'scripts/check.sh').mode, '100755');
    assert.equal(Buffer.from(result.files.find(file => file.path === 'SKILL.md').bytes).toString(), archiveFiles[0].content);
  }
});

test('ZIP decompression stops at the declared size instead of expanding a bomb', async () => {
  const buffer = zip([{ path: 'sample/SKILL.md', content: archiveFiles[0].content }, { path: 'sample/assets/bomb', content: 'x'.repeat(50_000) }], { method: 8, declared: new Map([['sample/assets/bomb', 10]]) });
  await assert.rejects(validateSkillArchive(readZipEntries(buffer)), error => error.code === 'E_UPLOAD_ARCHIVE');
});

test('ZIP reader refuses encryption, multi-disk and truncated archives before reading entries', async () => {
  for (const buffer of [
    zip(archiveFiles, { encrypted: true }),
    Buffer.from('not a zip'),
  ]) await assert.rejects(Promise.resolve().then(() => readZipEntries(buffer)), error => error.code === 'E_UPLOAD_ARCHIVE');
  const multi = zip(archiveFiles);
  multi.writeUInt16LE(1, multi.length - 18);
  assert.throws(() => readZipEntries(multi), error => error.code === 'E_UPLOAD_ARCHIVE');
});

test('ZIP traversal never reaches the archive validator as a read entry', async () => {
  const buffer = zip([{ path: 'sample/../escape', content: 'x' }, ...archiveFiles]);
  await assert.rejects(validateSkillArchive(readZipEntries(buffer)), error => error.code === 'E_UPLOAD_ARCHIVE');
});
