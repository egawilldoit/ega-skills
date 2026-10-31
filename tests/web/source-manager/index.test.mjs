import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceIndex } from '../../../apps/web/server/source-manager/index.ts';
const make = sources => ({ sha: 'a'.repeat(40), files: { 'upstream-sources.json': JSON.stringify({ sources }), 'skills/example/SKILL.md': '---\nname: example\ndescription: example\n---\n' }, selectedFiles: [] });
test('source index binds descriptions to unique provenance entries', () => {
  const snapshot = make([{ skill: 'example', mode: 'original' }]);
  assert.deepEqual(buildSourceIndex(snapshot, () => ({ name: 'example', description: 'Useful description' })), [{ name: 'example', description: 'Useful description', provenance: 'original' }]);
  assert.throws(() => buildSourceIndex(snapshot, () => ({ name: 'other', description: 'Wrong skill' })), e => e.status === 502);
  assert.throws(() => buildSourceIndex(make([{ skill: 'example', mode: 'original' }, { skill: 'example', mode: 'copied' }]), () => ({ name: 'example', description: 'Useful' })), e => e.status === 502);
});
