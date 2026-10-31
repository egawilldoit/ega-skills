import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcePublishedLinks } from '../../../apps/web/src/pages/sourcePublishedLinks.ts';

test('published links are restricted to matching skills in a single release', async () => {
  const page = (offset, skills, digest = 'one') => ({ offset, total: 3, skills, release: { release_digest: digest } });
  const pages = [page(0, [{ namespace: 'egawilldoit', name: 'one', skill_id: 'egawilldoit/one' }, { namespace: 'other', name: 'two', skill_id: 'other/two' }]), page(2, [{ namespace: 'egawilldoit', name: 'three', skill_id: 'egawilldoit/three' }])];
  assert.deepEqual(await sourcePublishedLinks(async offset => pages.find(p => p.offset === offset)), new Set(['egawilldoit/one', 'egawilldoit/three']));
  await assert.rejects(sourcePublishedLinks(async offset => offset === 0 ? pages[0] : page(2, pages[1].skills, 'two')), /changed/);
  await assert.rejects(sourcePublishedLinks(async offset => page(offset, [])), /incomplete/);
});
