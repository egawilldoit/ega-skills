import { parseProposalRequest } from './input.ts';
import { planOriginalAdd, planSkillRemoval, planSkillUpdate } from './planner.ts';
import type { SourceChange } from './planner.ts';
import { SourceGuardError } from './guard.ts';
import type { PinnedSourceSnapshot, SourcePullRequest, SourceSubmission } from './github.ts';
import { createHash } from 'node:crypto';
import { normalizeGithubImport } from './normalize-import.ts';
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
  if (add && imports) {
    const wanted = new Set(add.triggers.map(value => value.trim().toLowerCase().replace(/\s+/g, ' ')));
    const matches: string[] = [];
    for (const [path, content] of Object.entries(snapshot.files)) {
      const skill = /^skills\/([^/]+)\/ega\.yaml$/.exec(path)?.[1];
      if (!skill || skill === add.name) continue;
      let metadata: unknown;
      try { metadata = imports.parseYaml(content); } catch { throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source routing metadata is invalid.'); }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source routing metadata is invalid.');
      const triggers = (metadata as Record<string, unknown>).triggers ?? [];
      if (!Array.isArray(triggers) || triggers.some(value => typeof value !== 'string')) throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source routing metadata is invalid.');
      if (triggers.some(value => wanted.has((value as string).trim().toLowerCase().replace(/\s+/g, ' ')))) matches.push(skill);
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
  const result = { baseSha, operation: proposal.operation, name: proposal.name, provenance, changes, errors: plan.errors, warnings };
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
  if (preview.operation === 'remove') throw new SourceGuardError(503, 'E_SOURCE_VALIDATION_UNAVAILABLE', 'Full source validation is required before a removal can be proposed.');
  if (preview.operation !== 'add' && preview.operation !== 'update') throw new SourceGuardError(400, 'E_SOURCE_INPUT_INVALID', 'Proposal input is invalid.');
  if (preview.provenance !== 'copied' && preview.provenance !== 'adapted' && preview.provenance !== 'original') throw new SourceGuardError(502, 'E_SOURCE_INVALID', 'Source provenance is invalid.');
  return source.submit({ operation: preview.operation, name: preview.name, baseSha: preview.baseSha, provenance: preview.provenance, changes, validationSummary: 'Provisional preview only; full source validation requires PR CI.' });
}
