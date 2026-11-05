import type { ApiClient } from '../api/client';
import type { SourceIndex, SourceIndexItem } from './sourceSkillNavigation';

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const PROVENANCE: readonly SourceIndexItem['provenance'][] = ['copied', 'adapted', 'original'];

/** Validate one page of the pinned source index before the UI trusts it. */
export function decodeSourceIndex(value: unknown): SourceIndex {
  const candidate = value as SourceIndex;
  if (
    !candidate
    || !SOURCE_SHA.test(candidate.sha)
    || !Number.isSafeInteger(candidate.total)
    || candidate.total < 0
    || !Array.isArray(candidate.items)
    || candidate.items.some(item => (
      !item
      || typeof item.name !== 'string'
      || typeof item.description !== 'string'
      || !PROVENANCE.includes(item.provenance)
    ))
  ) {
    throw new Error('Invalid source index');
  }
  return candidate;
}

/**
 * Read the complete pinned source index through the existing guarded route.
 *
 * Every page must describe the same commit and total. A change during loading
 * is an error rather than a partial index: opening an editor from mixed pages
 * could map a released skill to the wrong source tree.
 */
export async function loadSourceIndex(
  client: Pick<ApiClient, 'get'>,
  signal?: AbortSignal,
): Promise<SourceIndex> {
  const first = await client.get<SourceIndex>('/source-skills', {
    query: { limit: 100 },
    ...(signal ? { signal } : {}),
    timeoutMs: 30_000,
    decode: decodeSourceIndex,
  });
  const items = [...first.items];
  while (items.length < first.total) {
    const page = await client.get<SourceIndex>('/source-skills', {
      query: { limit: 100, offset: items.length },
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
      decode: decodeSourceIndex,
    });
    if (page.sha !== first.sha || page.total !== first.total || !page.items.length) {
      throw new Error('Source main changed while loading. Refresh and compare again.');
    }
    items.push(...page.items);
  }
  return { sha: first.sha, total: first.total, items };
}
