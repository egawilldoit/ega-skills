import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProposalRequest } from '../../../apps/web/server/source-manager/input.ts';
const valid = { baseSha: 'a'.repeat(40), proposal: { operation: 'update', name: 'sample-skill', description: 'Description', body: '# Instructions' } };
test('accepts bounded structured proposals and rejects caller-chosen paths or target', () => {
  assert.deepEqual(parseProposalRequest(valid), valid);
  for (const input of [null, { ...valid, repo: 'other' }, { ...valid, baseSha: 'main' }, { ...valid, proposal: { ...valid.proposal, path: '../x' } }, { ...valid, proposal: { ...valid.proposal, name: '../x' } }, { ...valid, proposal: { ...valid.proposal, body: 'a'.repeat(200001) } }]) assert.throws(() => parseProposalRequest(input), e => e.status === 400);
});
test('rejects missing or extra fields on nested metadata', () => {
  const request = { baseSha: valid.baseSha, proposal: { operation: 'add', name: 'sample-skill', description: 'test', body: 'test', triggers: ['a'], antiTriggers: ['b'], interface: { displayName: 'Title', shortDescription: 'A longer short description', prompt: 'Use $sample-skill', target: 'evil' }, cases: {} } };
  assert.throws(() => parseProposalRequest(request), e => e.status === 400);
});

test('rejects unsafe resource paths and encodings during input parsing', () => {
  const p = { operation: 'add', name: 'sample', description: 'Sample', body: 'body', triggers: ['sample'], antiTriggers: ['other'], interface: { displayName: 'Sample', shortDescription: 'A useful sample skill description', prompt: 'Use $sample' }, cases: { direct: 'a', indirect: 'b', incomplete: 'c', negative: 'd', negative_expected: 'other', collision: 'e', collision_expected: 'other', edge: 'f' } };
  for (const resource of [{ path: '../escape', mode: '100644', contentBase64: 'YQ==' }, { path: 'assets/data', mode: '100755', contentBase64: 'YQ==' }, { path: 'assets/data', mode: '100644', contentBase64: '!!!!' }, { path: 'references/text.md', mode: '100644', contentBase64: '/w==' }]) {
    assert.throws(() => parseProposalRequest({ baseSha: 'a'.repeat(40), proposal: { ...p, resources: [resource] } }), e => e.status === 400);
  }
});
