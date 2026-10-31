import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSkillArchive, validateSkillArchive } from '../../../apps/web/server/source-manager/archive.ts';

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
