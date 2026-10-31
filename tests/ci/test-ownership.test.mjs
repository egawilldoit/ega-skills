import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOwnership } from '../../scripts/ci/ownership.mjs';

test('ownership rejects missing, duplicate and unknown discovered files', () => {
  assert.doesNotThrow(() => validateOwnership(['a', 'b'], { core: ['a'], web: ['b'] }));
  assert.throws(() => validateOwnership(['a', 'b'], { core: ['a'], web: [] }));
  assert.throws(() => validateOwnership(['a'], { core: ['a'], web: ['a'] }));
  assert.throws(() => validateOwnership(['a'], { core: ['a', 'new'], web: [] }));
});

test('current Node discovery is fully and uniquely owned', async () => {
  const { discover, manifest } = await import('../../scripts/ci/ownership.mjs');
  validateOwnership(discover(), manifest);
});
