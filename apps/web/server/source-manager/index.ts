import { validSkillName } from './paths.ts';
import { SourceGuardError } from './guard.ts';
import type { PinnedSourceSnapshot } from './github.ts';

export interface SourceIndexItem { name: string; description: string; provenance: 'copied' | 'adapted' | 'original' }
export function buildSourceIndex(snapshot: PinnedSourceSnapshot, parseYaml: (input: string) => unknown): SourceIndexItem[] {
  let rows: unknown;
  try { rows = (JSON.parse(snapshot.files['upstream-sources.json'] ?? '') as { sources: unknown }).sources; }
  catch { throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source provenance is invalid.'); }
  if (!Array.isArray(rows) || rows.length > 1000) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source provenance is invalid.');
  const seen = new Set<string>();
  const items: SourceIndexItem[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source provenance is invalid.');
    const row = raw as Record<string, unknown>;
    if (typeof row.skill !== 'string' || !validSkillName(row.skill, 'ega-skills') || seen.has(row.skill) || !['copied', 'adapted', 'original'].includes(String(row.mode))) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source provenance is invalid.');
    seen.add(row.skill);
    const source = snapshot.files[`skills/${row.skill}/SKILL.md`];
    const frontmatter = source?.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
    if (!frontmatter) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'A source skill has invalid frontmatter.');
    let data: unknown;
    try { data = parseYaml(frontmatter); } catch { throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'A source skill has invalid frontmatter.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'A source skill has invalid frontmatter.');
    const parsed = data as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(',') !== 'description,name' || parsed.name !== row.skill || typeof parsed.description !== 'string' || !parsed.description.trim() || parsed.description.length > 1024) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'A source skill has invalid frontmatter.');
    items.push({ name: row.skill, description: parsed.description, provenance: row.mode as SourceIndexItem['provenance'] });
  }
  return items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
