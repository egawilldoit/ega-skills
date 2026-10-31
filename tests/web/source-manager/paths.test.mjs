import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validSkillName, validSkillPath, validateSourceFiles, MAX_FILE_BYTES } from '../../../apps/web/server/source-manager/paths.ts';

const file = (path, bytes = new TextEncoder().encode('safe'), mode = '100644') => ({ path, bytes, mode });

test('source identity includes the plugin prefix', () => {
  assert.equal(validSkillName('review-change', 'ega-skills'), true);
  assert.equal(validSkillName('A/../b', 'ega-skills'), false);
  assert.equal(validSkillName('a'.repeat(54), 'ega-skills'), false);
});

test('paths are confined to supported skill files', () => {
  for (const path of ['SKILL.md', 'ega.yaml', 'agents/openai.yaml', 'references/guide.md', 'scripts/check.py', 'assets/image.png']) assert.equal(validSkillPath(path), true, path);
  for (const path of ['/SKILL.md', '../SKILL.md', 'references/../SKILL.md', 'references\\x.md', '.git/config', 'scripts/.git/hooks/pre-commit', 'agents/other.yaml', 'references//x', 'references/e\u0301.md']) assert.equal(validSkillPath(path), false, path);
});

test('snapshot validation rejects collisions, modes, invalid text and oversized files', () => {
  const errors = validateSourceFiles([file('SKILL.md'), file('skill.md'), file('scripts/a.sh', new Uint8Array([0xff]), '120000'), file('assets/a.bin', new Uint8Array(MAX_FILE_BYTES + 1))]);
  assert.ok(errors.some(e => e.includes('colliding')));
  assert.ok(errors.some(e => e.includes('mode')));
  assert.ok(errors.some(e => e.includes('UTF-8')));
  assert.ok(errors.some(e => e.includes('large')));
  assert.deepEqual(validateSourceFiles([file('SKILL.md'), file('references/guide.md'), file('scripts/check.sh', undefined, '100755')]), []);
  assert.ok(validateSourceFiles([file('references/x.md', undefined, '100755')]).some(e => e.includes('mode')));
});
