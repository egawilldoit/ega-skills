import test from 'node:test';
import assert from 'node:assert/strict';
import { descriptionOverlap } from '../../../apps/web/server/source-manager/description-overlap.ts';

test('description overlap reports shared evidence rather than common words', () => {
  assert.deepEqual(descriptionOverlap('Review deployment readiness and release evidence', 'Check release evidence for deployment readiness'), ['deployment', 'evidence', 'readiness', 'release']);
  assert.deepEqual(descriptionOverlap('Review these changes with your team', 'Help with other work from your team'), []);
});
