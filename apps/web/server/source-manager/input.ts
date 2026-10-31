import type { OriginalAdd, SkillRemoval, SkillUpdate } from './planner.ts';
import { SourceGuardError } from './guard.ts';
import { validateImportLocation } from './import-github.ts';
import { validSkillName, validSkillPath, validateSourceFiles } from './paths.ts';

export type ProposalInput = OriginalAdd | SkillUpdate | SkillRemoval;
export interface ProposalRequest { baseSha: string; proposal: ProposalInput }
function invalid(): never { throw new SourceGuardError(400, 'E_SOURCE_INPUT_INVALID', 'Proposal input is invalid.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid();
  return result;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return invalid();
  return value;
}
function texts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) return invalid();
  return value.map(item => text(item, 1024));
}

/** Parse only fields the planner understands; no paths or GitHub targets come from the client. */
export function parseProposalRequest(value: unknown): ProposalRequest {
  const root = record(value, ['baseSha', 'proposal']);
  const baseSha = text(root.baseSha, 40);
  if (!/^[0-9a-f]{40}$/.test(baseSha)) return invalid();
  if (!root.proposal || typeof root.proposal !== 'object' || Array.isArray(root.proposal)) return invalid();
  const type = (root.proposal as Record<string, unknown>).operation;
  if (type === 'remove') {
    const p = record(root.proposal, ['operation', 'name', 'confirmation']);
    const name = text(p.name, 64);
    if (!validSkillName(name, 'ega-skills')) return invalid();
    return { baseSha, proposal: { operation: 'remove', name, confirmation: text(p.confirmation, 64) } };
  }
  if (type === 'update') {
    const keys = ['operation', 'name', 'description', 'body'];
    if (Object.hasOwn(root.proposal, 'routing')) keys.push('routing');
    if (Object.hasOwn(root.proposal, 'references')) keys.push('references');
    const p = record(root.proposal, keys);
    const name = text(p.name, 64);
    if (!validSkillName(name, 'ega-skills')) return invalid();
    let routing: SkillUpdate['routing'];
    if (p.routing !== undefined) { const r = record(p.routing, ['triggers', 'antiTriggers']); routing = { triggers: texts(r.triggers), antiTriggers: texts(r.antiTriggers) }; }
    let references: SkillUpdate['references'];
    if (p.references !== undefined) {
      if (!Array.isArray(p.references) || p.references.length > 100) return invalid();
      references = p.references.map(raw => { const file = record(raw, ['path', 'content']); const path = text(file.path, 240); const content = text(file.content, 200_000); if (!/^references\//.test(path) || !/\.(?:md|txt)$/i.test(path) || !validSkillPath(path)) return invalid(); return { path, content }; });
      if (new Set(references.map(file => file.path.toLowerCase())).size !== references.length) return invalid();
    }
    return { baseSha, proposal: { operation: 'update', name, description: text(p.description, 1024), body: text(p.body, 200_000), ...(routing ? { routing } : {}), ...(references ? { references } : {}) } };
  }
  if (type === 'add') {
    const keys = ['operation', 'name', 'description', 'body', 'triggers', 'antiTriggers', 'interface', 'cases'];
    if (Object.hasOwn(root.proposal, 'resources')) keys.push('resources');
    if (Object.hasOwn(root.proposal, 'importSource')) keys.push('importSource');
    const p = record(root.proposal, keys);
    const name = text(p.name, 64);
    if (!validSkillName(name, 'ega-skills')) return invalid();
    const display = record(p.interface, ['displayName', 'shortDescription', 'prompt']);
    const cases = record(p.cases, ['direct', 'indirect', 'incomplete', 'negative', 'negative_expected', 'collision', 'collision_expected', 'edge']);
    let resources: Array<{ path: string; mode: string; contentBase64: string }> | undefined;
    if (p.resources !== undefined) {
      if (!Array.isArray(p.resources) || p.resources.length > 100) return invalid();
      resources = p.resources.map(raw => { const file = record(raw, ['path', 'mode', 'contentBase64']); return { path: text(file.path, 240), mode: text(file.mode, 6), contentBase64: text(file.contentBase64, 333_336) }; });
      if (resources.some(file => !/^(?:references|scripts|assets)\//.test(file.path) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64) || Buffer.from(file.contentBase64, 'base64').toString('base64') !== file.contentBase64) || validateSourceFiles(resources.map(file => ({ path: file.path, mode: file.mode, bytes: Buffer.from(file.contentBase64, 'base64') }))).length) return invalid();
    }
    let importSource: OriginalAdd['importSource'];
    if (p.importSource !== undefined) {
      const origin = record(p.importSource, ['location', 'acceptOriginalNormalization']);
      if (origin.acceptOriginalNormalization !== true || resources) return invalid();
      importSource = { location: validateImportLocation(origin.location), acceptOriginalNormalization: true };
    }
    return { baseSha, proposal: { operation: 'add', name, description: text(p.description, 1024), body: text(p.body, 200_000), triggers: texts(p.triggers), antiTriggers: texts(p.antiTriggers), interface: { displayName: text(display.displayName, 128), shortDescription: text(display.shortDescription, 64), prompt: text(display.prompt, 1024) }, cases: { direct: text(cases.direct, 1024), indirect: text(cases.indirect, 1024), incomplete: text(cases.incomplete, 1024), negative: text(cases.negative, 1024), negative_expected: text(cases.negative_expected, 64), collision: text(cases.collision, 1024), collision_expected: text(cases.collision_expected, 64), edge: text(cases.edge, 1024) }, ...(resources ? { resources } : {}), ...(importSource ? { importSource } : {}) } };
  }
  return invalid();
}
