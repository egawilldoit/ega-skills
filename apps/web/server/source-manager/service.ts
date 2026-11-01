import { parseProposalRequest } from './input.ts';
import { planOriginalAdd, planSkillRemoval, planSkillUpdate } from './planner.ts';
import type { SourceChange } from './planner.ts';
import { applySourceChanges, validateCatalog } from './catalog-validation.ts';
import { SourceGuardError } from './guard.ts';
import type { PinnedSourceSnapshot, SourcePullRequest, SourceSubmission } from './github.ts';
import { createHash } from 'node:crypto';
import { normalizeGithubImport } from './normalize-import.ts';
import { descriptionOverlap } from './description-overlap.ts';
import type { ImportLocation, ImportedSource } from './import-github.ts';

export interface PreviewSource {
  mainSha(): Promise<string>;
  snapshot(baseSha: string, name: string): Promise<PinnedSourceSnapshot>;
}
export interface SourcePreview {
  baseSha: string;
  operation: string;
  name: string;
  provenance: string;
  changes: readonly { path: string; before: string | null; after: string | null; binary?: boolean; mode?: string }[];
  errors: readonly string[];
  warnings: readonly string[];
  digest: string;
}

/** Re-read the requested source commit and produce the exact proposed text changes. */
export interface ImportDependencies { read(location: ImportLocation): Promise<ImportedSource>; parseYaml(text: string): unknown }

async function buildPreview(source: PreviewSource, raw: unknown, imports?: ImportDependencies): Promise<{ preview: SourcePreview; changes: Readonly<Record<string, SourceChange>> }> {
  const { baseSha, proposal } = parseProposalRequest(raw);
  if (await source.mainSha() !== baseSha) throw new SourceGuardError(409, 'E_SOURCE_STALE', 'Source main changed. Refresh and compare again.');
  const snapshot = await source.snapshot(baseSha, proposal.name);
  if (snapshot.sha !== baseSha) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source snapshot identity does not match.');
  let add = proposal.operation === 'add' ? proposal : undefined;
  if (add?.importSource) {
    if (!imports) throw new SourceGuardError(503, 'E_IMPORT_UNAVAILABLE', 'GitHub import is unavailable.');
    add = normalizeGithubImport(add, await imports.read(add.importSource.location), imports.parseYaml);
  }
  const plan = proposal.operation === 'add' ? planOriginalAdd(snapshot.files, add!) : proposal.operation === 'update' ? planSkillUpdate(snapshot.files, proposal, imports?.parseYaml) : planSkillRemoval(snapshot.files, proposal);
  let provenance = 'original';
  if (proposal.operation !== 'add') {
    try {
      const registry = JSON.parse(snapshot.files['upstream-sources.json'] ?? '') as { sources: Array<{ skill: string; mode: string }> };
      const matches = registry.sources.filter(row => row.skill === proposal.name);
      if (matches.length !== 1 || !['copied', 'adapted', 'original'].includes(matches[0]!.mode)) throw new Error();
      provenance = matches[0]!.mode;
    } catch { throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source provenance is invalid.'); }
  }
  const warnings = [...plan.warnings];
  const errors = [...plan.errors];
  if (proposal.operation === 'remove') {
    if (!imports) {
      errors.push('Full source catalog validation is unavailable; removal cannot be proposed.');
    } else {
      errors.push(...validateCatalog(applySourceChanges(snapshot.files, plan.changes), imports.parseYaml));
    }
  }
  if (proposal.operation !== 'remove' && imports) {
    const description = add?.description ?? (proposal.operation === 'update' ? proposal.description : '');
    const overlaps: string[] = [];
    for (const [path, content] of Object.entries(snapshot.files)) {
      const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1];
      if (!skill || skill === proposal.name) continue;
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      let metadata: unknown;
      try { metadata = frontmatter && imports.parseYaml(frontmatter); } catch { throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'A source skill has invalid frontmatter.'); }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof (metadata as Record<string, unknown>).description !== 'string') throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'A source skill has invalid frontmatter.');
      const shared = descriptionOverlap(description, (metadata as { description: string }).description);
      if (shared.length) overlaps.push(`${skill} (${shared.join(', ')})`);
    }
    if (overlaps.length) warnings.push(`Description wording overlaps with: ${overlaps.sort().slice(0, 10).join('; ')}${overlaps.length > 10 ? `; and ${overlaps.length - 10} more` : ''}. Review whether these skills overlap.`);
  }
  const proposedTriggers = add?.triggers ?? (proposal.operation === 'update' ? proposal.routing?.triggers : undefined);
  const proposedAliases = add?.routingTags?.aliases ?? (proposal.operation === 'update' ? proposal.routing?.tags?.aliases : undefined);
  if ((proposedTriggers || proposedAliases?.length) && imports) {
    const wanted = new Set((proposedTriggers ?? []).map(value => value.trim().toLowerCase().replace(/\s+/g, ' ')));
    const aliases = new Set((proposedAliases ?? []).map(value => value.trim().toLowerCase()));
    const matches: string[] = [];
    for (const [path, content] of Object.entries(snapshot.files)) {
      const skill = /^skills\/([^/]+)\/ega\.yaml$/.exec(path)?.[1];
      if (!skill || skill === proposal.name) continue;
      let metadata: unknown;
      try { metadata = imports.parseYaml(content); } catch { throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source routing metadata is invalid.'); }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source routing metadata is invalid.');
      const triggers = (metadata as Record<string, unknown>).triggers ?? [];
      if (!Array.isArray(triggers) || triggers.some(value => typeof value !== 'string')) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source routing metadata is invalid.');
      if (triggers.some(value => wanted.has((value as string).trim().toLowerCase().replace(/\s+/g, ' ')))) matches.push(skill);
      const existingAliases = (metadata as Record<string, unknown>).aliases ?? [];
      if (!Array.isArray(existingAliases) || existingAliases.some(value => typeof value !== 'string')) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source routing metadata is invalid.');
      for (const alias of existingAliases as string[]) if (aliases.has(alias.trim().toLowerCase())) errors.push(`Alias ${alias} is already owned by ${skill}.`);
    }
    if (matches.length) warnings.push(`Exact trigger wording overlaps with: ${matches.sort().join(', ')}. Review routing boundaries.`);
  }
  const changes = Object.entries(plan.changes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, after]) => {
    const prefix = `skills/${proposal.name}/`;
    const resource = after !== null && typeof after !== 'string' ? after : undefined;
    const resourceBytes = resource ? Buffer.from(resource.contentBase64, 'base64') : undefined;
    const displayedAfter = resourceBytes ? (/\.(?:md|txt|ya?ml|json|py|sh|js|ts)$/i.test(path) ? resourceBytes.toString('utf8') : `[binary file: ${resourceBytes.length} bytes, sha256 ${createHash('sha256').update(resourceBytes).digest('hex')}]`) : after as string | null;
    const extra = resource ? { mode: resource.mode, ...(!/\.(?:md|txt|ya?ml|json|py|sh|js|ts)$/i.test(path) ? { binary: true } : {}) } : {};
    const selected = path.startsWith(prefix) ? snapshot.selectedFiles.find(file => file.path === path.slice(prefix.length)) : undefined;
    if (selected && !/\.(?:md|txt|ya?ml|json|py|sh|js|ts)$/i.test(path)) {
      return { path, before: `[binary file: ${selected.bytes.length} bytes, sha256 ${createHash('sha256').update(selected.bytes).digest('hex')}]`, after: displayedAfter, binary: true, ...extra };
    }
    return { path, before: snapshot.files[path] ?? null, after: displayedAfter, ...extra };
  });
  const result = { baseSha, operation: proposal.operation, name: proposal.name, provenance, changes, errors, warnings };
  return { preview: { ...result, digest: createHash('sha256').update(JSON.stringify(result)).digest('hex') }, changes: plan.changes };
}

export async function previewProposal(source: PreviewSource, raw: unknown, imports?: ImportDependencies): Promise<SourcePreview> {
  return (await buildPreview(source, raw, imports)).preview;
}

export interface SubmissionSource extends PreviewSource {
  submit(input: SourceSubmission): Promise<SourcePullRequest>;
}

/** Recompute from pinned source; the client cannot choose paths or file contents. */
export async function submitProposal(source: SubmissionSource, raw: unknown, imports?: ImportDependencies): Promise<SourcePullRequest> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SourceGuardError(400, 'E_SOURCE_INPUT_INVALID', 'Proposal input is invalid.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'baseSha,previewDigest,proposal' || typeof value.previewDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.previewDigest)) throw new SourceGuardError(400, 'E_SOURCE_INPUT_INVALID', 'Proposal input is invalid.');
  const { preview, changes } = await buildPreview(source, { baseSha: value.baseSha, proposal: value.proposal }, imports);
  if (preview.digest !== value.previewDigest) throw new SourceGuardError(409, 'E_SOURCE_PREVIEW_CHANGED', 'The proposal changed. Review the new preview before submitting.');
  if (preview.errors.length || !preview.changes.length) throw new SourceGuardError(422, 'E_SOURCE_VALIDATION', 'The proposal has errors or no changes.');
  if (preview.operation !== 'add' && preview.operation !== 'update' && preview.operation !== 'remove') throw new SourceGuardError(400, 'E_SOURCE_INPUT_INVALID', 'Proposal input is invalid.');
  if (preview.provenance !== 'copied' && preview.provenance !== 'adapted' && preview.provenance !== 'original') throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source provenance is invalid.');
  const validationSummary = preview.operation === 'remove'
    ? 'Full candidate catalog validation passed locally. Source PR CI and review remain authoritative.'
    : 'Provisional preview only; full source validation requires PR CI.';
  return source.submit({ operation: preview.operation, name: preview.name, baseSha: preview.baseSha, provenance: preview.provenance, changes, validationSummary });
}
