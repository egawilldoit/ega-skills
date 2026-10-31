import { SourceGuardError } from './guard.ts';
import type { ImportedSource } from './import-github.ts';
import type { OriginalAdd } from './planner.ts';

/** Normalize an explicitly accepted, pinned import without hiding its authorship or license. */
export function normalizeGithubImport(proposal: OriginalAdd, imported: ImportedSource, parseYaml: (text: string) => unknown): OriginalAdd {
  const { location, files, license } = imported;
  if (location.directory.split('/').at(-1) !== proposal.name) throw new SourceGuardError(422, 'E_IMPORT_NAME', 'The skill name must match its source directory.');
  const skill = files.find(file => file.path === 'SKILL.md');
  if (!skill || files.some(file => file.path !== 'SKILL.md' && !/^(?:references|scripts|assets)\//.test(file.path))) throw new SourceGuardError(422, 'E_IMPORT_CONTENT', 'Import has unsupported metadata or dependencies; only SKILL.md and resource directories are supported.');
  if (files.some(file => file.path.toLowerCase() === 'references/upstream-license.txt')) throw new SourceGuardError(422, 'E_IMPORT_CONTENT', 'Import conflicts with the preserved license path.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(skill.bytes); } catch { throw new SourceGuardError(422, 'E_IMPORT_CONTENT', 'SKILL.md must be UTF-8.'); }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  let metadata: unknown;
  try { if (!match) throw new Error(); metadata = parseYaml(match[1]!); } catch { throw new SourceGuardError(422, 'E_IMPORT_CONTENT', 'SKILL.md has invalid frontmatter.'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).sort().join(',') !== 'description,name') throw new SourceGuardError(422, 'E_IMPORT_CONTENT', 'Imported frontmatter must contain only name and description.');
  const value = metadata as Record<string, unknown>;
  if (value.name !== proposal.name || typeof value.description !== 'string' || !value.description.trim() || !match?.[2]?.trim()) throw new SourceGuardError(422, 'E_IMPORT_CONTENT', 'Imported name, description, or body is invalid.');
  const origin = `https://github.com/${location.owner}/${location.repo}/tree/${location.commit}/${location.directory}`;
  const notice = `## Imported source and license\n\nSource: ${origin}\n\nThe source repository license at ${license.path} (Git blob ${license.sha}) is preserved in [references/upstream-license.txt](references/upstream-license.txt). The catalog classifies this skill as original under the accepted normalization policy; this classification does not claim authorship of the imported material.`;
  return { ...proposal, description: value.description, body: `${match[2].trim()}\n\n${notice}`, resources: [...files.filter(file => file.path !== 'SKILL.md').map(file => ({ path: file.path, mode: file.mode, contentBase64: Buffer.from(file.bytes).toString('base64') })), { path: 'references/upstream-license.txt', mode: '100644', contentBase64: Buffer.from(license.text, 'utf8').toString('base64') }] };
}
