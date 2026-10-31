import type { CatalogPage } from '../api/contracts';

/** Read one release consistently before advertising links to its skill details. */
export async function sourcePublishedLinks(fetchPage: (offset: number) => Promise<CatalogPage>): Promise<Set<string>> {
  const result = new Set<string>();
  let offset = 0;
  let releaseDigest: string | undefined;
  let expectedTotal: number | undefined;
  do {
    const page = await fetchPage(offset);
    if (!page.release || page.offset !== offset || page.total > 10_000 || (releaseDigest !== undefined && (page.release.release_digest !== releaseDigest || page.total !== expectedTotal))) throw new Error('Published catalog changed while loading.');
    releaseDigest = page.release.release_digest;
    expectedTotal = page.total;
    if (!page.skills.length && offset < page.total) throw new Error('Published catalog page is incomplete.');
    for (const skill of page.skills) if (skill.namespace === 'egawilldoit' && skill.skill_id === `egawilldoit/${skill.name}`) result.add(skill.skill_id);
    offset += page.skills.length;
    if (offset > page.total) throw new Error('Published catalog page is invalid.');
  } while (offset < expectedTotal);
  return result;
}
