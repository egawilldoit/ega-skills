/**
 * Exact source navigation rules for EGA-822.
 *
 * These assertions call the production resolver with concrete released
 * identities and pinned index fixtures. They cover the negative cases that
 * matter most: a similar name, another namespace, a renamed identity and a
 * changed source revision must never produce a match.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSourceSkill, sourceSkillHref } from '../../apps/web/src/pages/sourceSkillNavigation.ts';

const SOURCE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const sourceIndex = {
  sha: SOURCE_SHA,
  total: 2,
  items: [
    { name: 'alpha', description: 'Alpha skill', provenance: 'original' },
    { name: 'alpha-two', description: 'Another alpha', provenance: 'adapted' },
  ],
};

test('exact canonical source identity opens the matching item and carries the pinned revision', () => {
  const result = resolveSourceSkill('egawilldoit/alpha', sourceIndex, { declaredName: 'alpha', expectedSha: SOURCE_SHA });
  assert.deepEqual(result, { status: 'match', name: 'alpha', item: sourceIndex.items[0] });
  assert.equal(sourceSkillHref('egawilldoit/alpha', SOURCE_SHA), `/source-skills?skill=egawilldoit%2Falpha&sha=${SOURCE_SHA}`);
});

test('a missing source name is reported and never resolves to a similar item', () => {
  const result = resolveSourceSkill('egawilldoit/alph', sourceIndex, { declaredName: 'alph', expectedSha: SOURCE_SHA });
  assert.equal(result.status, 'missing');
  assert.equal('item' in result, false);
  assert.match(result.reason, /alph/);
});

test('an unsupported namespace is refused instead of opening another namespace source', () => {
  const result = resolveSourceSkill('mattpocock/alpha', sourceIndex);
  assert.equal(result.status, 'unsupported');
  assert.equal('item' in result, false);
  assert.match(result.reason, /egawilldoit/);
});

test('renamed or malformed identities are refused', () => {
  assert.equal(resolveSourceSkill('egawilldoit/alpha', sourceIndex, { declaredName: 'beta' }).status, 'unsupported');
  assert.equal(resolveSourceSkill('egawilldoit/alpha/extra', sourceIndex).status, 'unsupported');
  assert.equal(resolveSourceSkill('egawilldoit/Alpha', sourceIndex).status, 'unsupported');
});

test('a changed pinned revision is stale and returns no item', () => {
  const changed = resolveSourceSkill('egawilldoit/alpha', sourceIndex, { expectedSha: OTHER_SHA });
  assert.equal(changed.status, 'stale');
  assert.equal('item' in changed, false);
  assert.match(changed.reason, /changed/);
  const invalid = resolveSourceSkill('egawilldoit/alpha', sourceIndex, { expectedSha: 'not-a-sha' });
  assert.equal(invalid.status, 'stale');
  assert.equal('item' in invalid, false);
});
