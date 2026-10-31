import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceInterfaceDefaults } from '../../../apps/web/src/pages/sourceInterfaceDefaults.ts';

test('interface suggestions use the skill name and safe bounded description', () => {
  const result = sourceInterfaceDefaults('review-change', 'Review "changes" and record evidence for teammates.');
  assert.equal(result.displayName, 'Review Change');
  assert.equal(result.shortDescription, 'Review changes and record evidence for teammates.');
  assert.match(result.prompt, /\$review-change/);
  assert.ok(result.shortDescription.length >= 25 && result.shortDescription.length <= 64);
  assert.doesNotMatch(Object.values(result).join(''), /["\\\r\n]/);
});

test('short and long descriptions produce bounded suggestions', () => {
  for (const description of ['', 'Short', 'x'.repeat(200)]) {
    const { shortDescription } = sourceInterfaceDefaults('test-skill', description);
    assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64);
  }
});
