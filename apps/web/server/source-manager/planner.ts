import type { ImportLocation } from './import-github.ts';
import { MAX_FILE_BYTES, validSkillName, validSkillPath, validateSourceFiles } from './paths.ts';

/** A complete, pinned text snapshot of the source files needed by the planner. */
export type SourceSnapshot = Readonly<Record<string, string>>;
export interface InterfaceMetadata { displayName: string; shortDescription: string; prompt: string }
export interface TriggerCase {
  direct: string; indirect: string; incomplete: string; negative: string;
  negative_expected: string; collision: string; collision_expected: string; edge: string;
}
export interface OriginalAdd {
  operation: 'add'; name: string; description: string; body: string;
  triggers: string[]; antiTriggers: string[]; interface: InterfaceMetadata; cases: TriggerCase;
  resources?: Array<{ path: string; mode: string; contentBase64: string }>;
  importSource?: { location: ImportLocation; acceptOriginalNormalization: true };
}
export type SourceChange = string | null | { contentBase64: string; mode: string };
export interface ProposalPlan {
  changes: Readonly<Record<string, SourceChange>>;
  errors: readonly string[];
  warnings: readonly string[];
}

const pythonString = (s: string): string => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const metadataPath = 'scripts/sync_openai_yaml.py';
const provenancePath = 'scripts/build_upstream_sources.py';
const casesPath = 'tests/trigger-cases.json';
const registryPath = 'upstream-sources.json';

/** Add an original skill, preserving every unrelated source file byte-for-byte. */
export function planOriginalAdd(snapshot: SourceSnapshot, input: OriginalAdd): ProposalPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const changes: Record<string, SourceChange> = {};
  const { name, description, body } = input;
  if (!validSkillName(name, 'ega-skills')) errors.push('Invalid skill name or plugin identity is too long.');
  if (!description.trim() || description.length > 1024 || /[<>\r\n]/.test(description)) errors.push('Description must be a nonempty single line without angle brackets, at most 1024 characters.');
  if (!body.trim() || body.includes('\0')) errors.push('Instructions are required and must be text.');
  if (snapshot[`skills/${name}/SKILL.md`] !== undefined) errors.push('Skill already exists.');
  if (!input.interface.displayName.trim() || input.interface.shortDescription.length < 25 || input.interface.shortDescription.length > 64 || !input.interface.prompt.includes(`$${name}`)) errors.push('Display metadata requires a title, a 25–64 character short description, and a prompt naming the skill.');
  // The existing Python renderer interpolates values inside double quotes without escaping.
  if (Object.values(input.interface).some(value => /["\\\r\n\x00-\x1f]/.test(value))) errors.push('Display metadata cannot contain quotes, backslashes, or control characters in the current generator.');
  for (const [label, values] of [['triggers', input.triggers], ['anti-triggers', input.antiTriggers]] as const) {
    if (values.length === 0 || values.some(v => !v.trim() || /[\r\n\0]/.test(v))) errors.push(`${label} must contain nonempty single-line entries.`);
    const normalized = values.map(v => v.trim().toLowerCase().replace(/\s+/g, ' '));
    if (new Set(normalized).size !== normalized.length) errors.push(`${label} contain duplicate entries.`);
  }
  const resources = input.resources ?? [];
  const sourceFiles = resources.map(file => ({ path: file.path, mode: file.mode, bytes: Buffer.from(file.contentBase64, 'base64') }));
  if (resources.some(file => !/^(?:references|scripts|assets)\//.test(file.path) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64) || Buffer.from(file.contentBase64, 'base64').toString('base64') !== file.contentBase64)) errors.push('Resource paths or contents are invalid.');
  errors.push(...validateSourceFiles(sourceFiles));
  let registry: { sources: Array<{ skill: string; mode: string }> };
  let cases: Array<Record<string, string>>;
  try {
    registry = JSON.parse(snapshot[registryPath] ?? '');
    cases = JSON.parse(snapshot[casesPath] ?? '');
    if (!Array.isArray(registry.sources) || !Array.isArray(cases)) throw new Error();
  } catch {
    return { changes: {}, errors: [...errors, 'Source registry or trigger cases have an unknown format.'], warnings };
  }
  if (registry.sources.some(row => row.skill === name) || cases.some(row => row.skill === name)) errors.push('Skill already exists in source metadata.');
  const existingNames = new Set(registry.sources.map(row => row.skill));
  for (const [key, value] of Object.entries(input.cases)) {
    if (typeof value !== 'string' || !value.trim()) errors.push(`Trigger case ${key} is required.`);
  }
  for (const key of ['direct', 'indirect', 'incomplete', 'negative', 'negative_expected', 'collision', 'collision_expected', 'edge'] as const) {
    if (typeof input.cases[key] !== 'string' || !input.cases[key].trim()) errors.push(`Trigger case ${key} is required.`);
  }
  if (!existingNames.has(input.cases.negative_expected) || !existingNames.has(input.cases.collision_expected)) errors.push('Trigger case neighbors must be existing source skills.');
  const metadata = snapshot[metadataPath];
  const provenance = snapshot[provenancePath];
  const metadataAnchor = 'METADATA: dict[str, tuple[str, str, str]] = {\n';
  const originalAnchor = 'ORIGINAL = [\n';
  if (!metadata || metadata.split(metadataAnchor).length !== 2 || !provenance || provenance.split(originalAnchor).length !== 2) errors.push('Source generator format changed; refresh and inspect the generator before proposing.');
  if (errors.length) return { changes: {}, errors: [...new Set(errors)], warnings };
  const entry = `    ${pythonString(name)}: (\n        ${pythonString(input.interface.displayName)},\n        ${pythonString(input.interface.shortDescription)},\n        ${pythonString(input.interface.prompt)},\n    ),\n`;
  changes[metadataPath] = metadata!.replace(metadataAnchor, metadataAnchor + entry);
  changes[provenancePath] = provenance!.replace(originalAnchor, originalAnchor + `    ${pythonString(name)},\n`);
  registry.sources.push({ skill: name, mode: 'original' });
  registry.sources.sort((a, b) => a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0);
  changes[registryPath] = JSON.stringify(registry, null, 2) + '\n';
  cases.push({ skill: name, ...input.cases });
  cases.sort((a, b) => a.skill! < b.skill! ? -1 : a.skill! > b.skill! ? 1 : 0);
  changes[casesPath] = JSON.stringify(cases, null, 2) + '\n';
  changes[`skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`;
  const yamlList = (values: string[]) => values.map(value => `  - ${JSON.stringify(value.trim())}\n`).join('');
  changes[`skills/${name}/ega.yaml`] = `schema_version: 1\ntriggers:\n${yamlList(input.triggers)}anti_triggers:\n${yamlList(input.antiTriggers)}`;
  changes[`skills/${name}/agents/openai.yaml`] = `interface:\n  display_name: "${input.interface.displayName}"\n  short_description: "${input.interface.shortDescription}"\n  default_prompt: "${input.interface.prompt}"\n`;
  for (const file of resources) changes[`skills/${name}/${file.path}`] = { contentBase64: file.contentBase64, mode: file.mode };
  const generatedFiles = ['SKILL.md', 'ega.yaml', 'agents/openai.yaml'].map(path => ({ path, mode: '100644', bytes: Buffer.from(changes[`skills/${name}/${path}`] as string, 'utf8') }));
  const fileErrors = validateSourceFiles([...generatedFiles, ...sourceFiles]);
  if (fileErrors.length) return { changes: {}, errors: [...new Set(fileErrors)], warnings };
  warnings.push('Preview validation is provisional; source PR CI validates the complete catalog.');
  return { changes, errors, warnings };
}

export interface SkillUpdate {
  operation: 'update'; name: string; description: string; body: string;
  routing?: { triggers: string[]; antiTriggers: string[] };
  references?: Array<{ path: string; content: string }>;
}

/** Update selected source files, retaining provenance and unrelated routing fields. */
export function planSkillUpdate(snapshot: SourceSnapshot, input: SkillUpdate, parseYaml?: (text: string) => unknown): ProposalPlan {
  const errors: string[] = [];
  const changes: Record<string, SourceChange> = {};
  if (!validSkillName(input.name, 'ega-skills')) errors.push('Invalid skill name.');
  if (!input.description.trim() || input.description.length > 1024 || /[<>\r\n]/.test(input.description)) errors.push('Invalid description.');
  if (!input.body.trim() || input.body.includes('\0')) errors.push('Instructions are required and must be text.');
  if (Buffer.byteLength(input.body, 'utf8') + Buffer.byteLength(input.description, 'utf8') + 128 > MAX_FILE_BYTES) errors.push('Skill instructions exceed the file size limit.');
  const prefix = `skills/${input.name}/`;
  const path = `${prefix}SKILL.md`;
  const old = snapshot[path];
  let registry: { sources: Array<{ skill: string; mode: string }> };
  try {
    registry = JSON.parse(snapshot[registryPath] ?? '');
    if (!Array.isArray(registry.sources)) throw new Error();
  } catch {
    return { changes: {}, errors: ['Source registry has an unknown format.'], warnings: [] };
  }
  const entries = registry.sources.filter(row => row.skill === input.name);
  if (old === undefined || entries.length !== 1) errors.push('Skill or unique provenance entry is missing.');
  if (entries[0] && !['copied', 'adapted', 'original'].includes(entries[0].mode)) errors.push('Unknown provenance mode.');
  let unchanged = false;
  if (old && parseYaml) {
    try {
      const match = old.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) throw new Error();
      const metadata = parseYaml(match[1]!) as Record<string, unknown>;
      if (!metadata || typeof metadata !== 'object' || Object.keys(metadata).sort().join(',') !== 'description,name' || metadata.name !== input.name || typeof metadata.description !== 'string') throw new Error();
      unchanged = metadata.description === input.description && match[2]!.trim() === input.body.trim();
    } catch { errors.push('Source skill frontmatter has an unknown format.'); }
  }
  if (entries[0]?.mode === 'copied' && !unchanged) errors.push('Copied skill bodies cannot be edited without an explicit provenance conversion.');
  if (old && !unchanged) changes[path] = `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.body.trim()}\n`;
  if (input.routing) {
    for (const [label, values] of [['triggers', input.routing.triggers], ['anti-triggers', input.routing.antiTriggers]] as const) {
      const normalized = values.map(value => value.trim().toLowerCase().replace(/\s+/g, ' '));
      if (values.some(value => !value.trim() || /[\r\n\0]/.test(value)) || new Set(normalized).size !== normalized.length) errors.push(`${label} must contain unique nonempty single-line entries.`);
    }
    const routingPath = `${prefix}ega.yaml`;
    const original = snapshot[routingPath];
    try {
      if (!original || !parseYaml) throw new Error();
      const parsed = parseYaml(original);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      const metadata = parsed as Record<string, unknown>;
      if (metadata.schema_version !== 1 || (metadata.triggers != null && (!Array.isArray(metadata.triggers) || metadata.triggers.some(v => typeof v !== 'string'))) || (metadata.anti_triggers != null && (!Array.isArray(metadata.anti_triggers) || metadata.anti_triggers.some(v => typeof v !== 'string')))) throw new Error();
      const triggers = input.routing.triggers.map(value => value.trim());
      const antiTriggers = input.routing.antiTriggers.map(value => value.trim());
      if (JSON.stringify(metadata.triggers ?? []) !== JSON.stringify(triggers) || JSON.stringify(metadata.anti_triggers ?? []) !== JSON.stringify(antiTriggers)) {
        changes[routingPath] = JSON.stringify({ ...metadata, triggers, anti_triggers: antiTriggers }, null, 2) + '\n';
      }
    } catch { errors.push('Source routing metadata has an unknown format.'); }
  }
  const seen = new Set<string>();
  for (const file of input.references ?? []) {
    const key = file.path.toLowerCase();
    if (seen.has(key) || !file.path.startsWith('references/') || !/\.(?:md|txt)$/i.test(file.path) || !validSkillPath(file.path) || snapshot[prefix + file.path] === undefined || file.content.includes('\0') || Buffer.byteLength(file.content, 'utf8') > MAX_FILE_BYTES) errors.push('Reference edits must target unique existing bounded text references.');
    else if (snapshot[prefix + file.path] !== file.content) {
      if (entries[0]?.mode === 'copied') errors.push('Copied skill references cannot be edited without an explicit provenance conversion.');
      else changes[prefix + file.path] = file.content;
    }
    seen.add(key);
  }
  if (errors.length) return { changes: {}, errors: [...new Set(errors)], warnings: [] };
  return { changes, errors: [], warnings: ['Source PR CI must validate the full catalog.'] };
}

/** Remove one canonical mapping entry only when its exact structure is recognized. */
function removeOne(text: string, expression: RegExp): string | undefined {
  const matches = [...text.matchAll(expression)];
  if (matches.length !== 1 || matches[0]?.index === undefined) return undefined;
  const match = matches[0];
  return text.slice(0, match.index) + text.slice(match.index + match[0].length);
}

export interface SkillRemoval { operation: 'remove'; name: string; confirmation: string }

/** Plan deletion only when no remaining trigger case or text reference names the skill. */
export function planSkillRemoval(snapshot: SourceSnapshot, input: SkillRemoval): ProposalPlan {
  const errors: string[] = [];
  if (!validSkillName(input.name, 'ega-skills')) errors.push('Invalid skill name.');
  if (input.confirmation !== input.name) errors.push('Type the exact skill name to confirm removal.');
  let registry: { sources: Array<{ skill: string; mode: string }> };
  let cases: Array<Record<string, string>>;
  try {
    registry = JSON.parse(snapshot[registryPath] ?? '');
    cases = JSON.parse(snapshot[casesPath] ?? '');
    if (!Array.isArray(registry.sources) || !Array.isArray(cases)) throw new Error();
  } catch {
    return { changes: {}, errors: [...errors, 'Source registry or trigger cases have an unknown format.'], warnings: [] };
  }
  const entries = registry.sources.filter(row => row.skill === input.name);
  if (entries.length !== 1 || !snapshot[`skills/${input.name}/SKILL.md`]) errors.push('Skill or unique provenance entry is missing.');
  if (cases.filter(row => row.skill === input.name).length !== 1) errors.push('Skill must have exactly one trigger case.');
  const incoming = cases.filter(row => row.skill !== input.name && (row.negative_expected === input.name || row.collision_expected === input.name)).map(row => row.skill);
  if (incoming.length) errors.push(`Trigger cases reference this skill: ${incoming.join(', ')}.`);
  const prefix = `skills/${input.name}/`;
  const referenced = Object.entries(snapshot).filter(([path, value]) => path.startsWith('skills/') && !path.startsWith(prefix) && /\.(?:md|ya?ml)$/i.test(path) && (value.includes(`$${input.name}`) || value.includes(`skills/${input.name}/`))).map(([path]) => path);
  if (referenced.length) errors.push(`Other skills reference this skill: ${referenced.join(', ')}.`);
  const name = input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const meta = snapshot[metadataPath];
  const provenance = snapshot[provenancePath];
  const metadata = meta && removeOne(meta, new RegExp(`^    "${name}": \\(\\n(?:        .*\\n){3}    \\),\\n`, 'gm'));
  const mode = entries[0]?.mode;
  let classification: string | undefined;
  if (provenance && mode === 'original') classification = removeOne(provenance, new RegExp(`^    "${name}",\\n`, 'gm'));
  if (provenance && mode === 'copied') classification = removeOne(provenance, new RegExp(`^    "${name}": [^\\n]+,\\n`, 'gm'));
  if (provenance && mode === 'adapted') classification = removeOne(provenance, new RegExp(`^    "${name}": \\[(?:[^\\n]*\\] *,\\n|\\n(?:        [^\\n]+\\n)+    \\],\\n)`, 'gm'));
  if (!metadata || !classification) errors.push('Source generator entry has an unknown or ambiguous format.');
  const files = Object.keys(snapshot).filter(path => path.startsWith(prefix));
  if (!files.length) errors.push('Source skill files are missing.');
  if (errors.length) return { changes: {}, errors, warnings: [] };
  registry.sources = registry.sources.filter(row => row.skill !== input.name);
  cases = cases.filter(row => row.skill !== input.name);
  const changes: Record<string, string | null> = {
    [metadataPath]: metadata!, [provenancePath]: classification!,
    [registryPath]: JSON.stringify(registry, null, 2) + '\n',
    [casesPath]: JSON.stringify(cases, null, 2) + '\n',
  };
  for (const path of files) changes[path] = null;
  return { changes, errors: [], warnings: ['Removal affects only a proposed source PR; published releases remain unchanged.', 'Source PR CI must validate the full catalog.'] };
}
