import { posix } from 'node:path';
import { validSkillName, validSkillPath } from './paths.ts';
import type { SourceChange } from './planner.ts';

/**
 * Validate the complete candidate catalog before a removal can be submitted.
 *
 * This mirrors the structural checks in the source repository's
 * `validate_catalog.py`, `validate_ega_metadata.py` and the hard half of
 * `trigger_audit.py`, using the pinned snapshot's file map. It is deliberately
 * fail-closed: missing metadata, unparseable files, and dangling references are
 * errors. Source PR CI remains authoritative for generated-file equivalence and
 * the remaining Python validators.
 */
const SKILLS = 'skills/';
const REGISTRY = 'upstream-sources.json';
const CASES = 'tests/trigger-cases.json';
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
const CASE_FIELDS = ['direct', 'indirect', 'incomplete', 'negative', 'negative_expected', 'collision', 'collision_expected', 'edge'] as const;
const EGA_KEYS = new Set(['schema_version', 'domains', 'platforms', 'frameworks', 'aliases', 'triggers', 'anti_triggers']);
const IDENTIFIER_KEYS = ['domains', 'platforms', 'frameworks', 'aliases'] as const;
const TRIGGER_KEYS = ['triggers', 'anti_triggers'] as const;
const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const BARE_REF = /(?<![\w/])((?:references|scripts|assets)\/[\w./-]+)/g;
const TRAILING = '.,;:)';

type Files = Readonly<Record<string, string>>;
type ParseYaml = (text: string) => unknown;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parse(files: Files, path: string, parseYaml: ParseYaml, errors: string[]): unknown {
  if (!Object.hasOwn(files, path)) { errors.push(`Missing ${path}.`); return undefined; }
  try { return parseYaml(files[path]!); }
  catch { errors.push(`${path} could not be parsed.`); return undefined; }
}

function parseFrontmatter(text: string, parseYaml: ParseYaml): { metadata: Record<string, unknown>; body: string } | undefined {
  const match = FRONTMATTER.exec(text);
  if (!match) return undefined;
  const metadata = record(parseYaml(match[1]!));
  return metadata ? { metadata, body: text.slice(match[0].length) } : undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function exists(files: Files, path: string): boolean {
  if (Object.hasOwn(files, path)) return true;
  const prefix = `${path.replace(/\/$/, '')}/`;
  return Object.keys(files).some(candidate => candidate.startsWith(prefix));
}

function checkReference(files: Files, skill: string, source: string, rawTarget: string, errors: string[]): void {
  let target = rawTarget.trim().replace(new RegExp(`[${TRAILING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+$`), '');
  if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#') || target.startsWith('mailto:')) return;
  target = target.split('#', 1)[0]!.trim();
  if (!target) return;
  const resolved = [
    posix.resolve('/', posix.dirname(source), target).slice(1),
    posix.resolve('/', `${SKILLS}${skill}`, target).slice(1),
  ];
  if (resolved.some(path => exists(files, path))) return;
  errors.push(`${skill}: broken reference '${rawTarget.trim()}' in ${source}.`);
}

/** Apply planner output to the snapshot, keeping binary identity without its bytes. */
export function applySourceChanges(files: Files, changes: Readonly<Record<string, SourceChange>>): Record<string, string> {
  const after: Record<string, string> = { ...files };
  for (const [path, change] of Object.entries(changes)) {
    if (change === null) delete after[path];
    else after[path] = typeof change === 'string' ? change : '';
  }
  return after;
}

export function validateCatalog(files: Files, parseYaml: ParseYaml): string[] {
  const errors: string[] = [];
  const registry = record(parse(files, REGISTRY, parseYaml, errors));
  const rawSources = registry?.sources;
  if (!Array.isArray(rawSources) || rawSources.length > 1000) {
    errors.push('upstream-sources.json must contain a sources array.');
  }
  const sources = Array.isArray(rawSources) ? rawSources : [];
  const recorded = new Set<string>();
  for (const raw of sources) {
    const row = record(raw);
    if (!row || typeof row.skill !== 'string' || !validSkillName(row.skill, 'ega-skills') || typeof row.mode !== 'string' || !['copied', 'adapted', 'original'].includes(row.mode)) {
      errors.push('upstream-sources.json contains an invalid provenance entry.');
      continue;
    }
    if (recorded.has(row.skill)) errors.push(`upstream-sources.json contains duplicate entry ${row.skill}.`);
    recorded.add(row.skill);
    if (row.mode !== 'original' && (typeof row.source_commit !== 'string' || !row.source_commit || typeof row.license !== 'string' || !row.license)) {
      errors.push(`upstream-sources.json: ${row.skill} is missing source_commit or license.`);
    }
  }

  const directories = new Set<string>();
  const seenPaths = new Set<string>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(SKILLS)) continue;
    const parts = path.split('/');
    const skill = parts[1];
    if (!skill) { errors.push(`Invalid source path ${path}.`); continue; }
    directories.add(skill);
    const relative = parts.slice(2).join('/');
    if (!validSkillName(skill, 'ega-skills') || !validSkillPath(relative)) errors.push(`Invalid source path ${path}.`);
    const key = path.normalize('NFC').toLowerCase();
    if (seenPaths.has(key)) errors.push(`Duplicate or case-colliding source path ${path}.`);
    seenPaths.add(key);
  }
  const catalog = [...directories].filter(skill => Object.hasOwn(files, `${SKILLS}${skill}/SKILL.md`)).sort();
  for (const skill of directories) {
    if (!Object.hasOwn(files, `${SKILLS}${skill}/SKILL.md`)) errors.push(`${skill}: no SKILL.md.`);
  }
  for (const skill of catalog) {
    if (!recorded.has(skill)) errors.push(`upstream-sources.json: missing entry for ${skill}.`);
  }
  for (const skill of recorded) {
    if (!catalog.includes(skill)) errors.push(`upstream-sources.json: unknown entry ${skill}.`);
  }

  const aliases = new Map<string, string>();
  for (const skill of catalog) {
    const prefix = `${SKILLS}${skill}/`;
    const skillMd = files[`${prefix}SKILL.md`]!;
    const frontmatter = (() => {
      try { return parseFrontmatter(skillMd, parseYaml); } catch { return undefined; }
    })();
    if (!frontmatter) {
      errors.push(`${skill}: SKILL.md frontmatter is invalid.`);
    } else {
      const { metadata } = frontmatter;
      if (Object.keys(metadata).sort().join(',') !== 'description,name') errors.push(`${skill}: SKILL.md frontmatter must contain only name and description.`);
      if (metadata.name !== skill) errors.push(`${skill}: frontmatter name does not match its directory.`);
      if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024 || /[<>]/.test(metadata.description)) errors.push(`${skill}: description is invalid.`);
    }

    const openai = parse(files, `${prefix}agents/openai.yaml`, parseYaml, errors);
    const openaiRecord = record(openai);
    const ui = record(openaiRecord?.interface);
    if (!ui) errors.push(`${skill}: agents/openai.yaml is missing a valid interface.`);
    else {
      for (const field of ['display_name', 'short_description', 'default_prompt'] as const) {
        if (typeof ui[field] !== 'string' || !ui[field]) errors.push(`${skill}: agents/openai.yaml interface.${field} is required.`);
      }
      if (typeof ui.short_description === 'string' && (ui.short_description.length < 25 || ui.short_description.length > 64)) errors.push(`${skill}: short_description must be 25-64 characters.`);
      if (typeof ui.default_prompt === 'string' && !ui.default_prompt.includes(`$${skill}`)) errors.push(`${skill}: default_prompt must mention $${skill}.`);
    }

    const egaValue = parse(files, `${prefix}ega.yaml`, parseYaml, errors);
    const ega = record(egaValue);
    if (!ega) errors.push(`${skill}: ega.yaml must be a mapping.`);
    else {
      if (ega.schema_version !== 1) errors.push(`${skill}: ega.yaml must declare schema_version: 1.`);
      for (const key of Object.keys(ega)) if (!EGA_KEYS.has(key)) errors.push(`${skill}: ega.yaml contains unsupported key ${key}.`);
      for (const field of IDENTIFIER_KEYS) {
        const value = ega[field];
        if (value === undefined) continue;
        if (!stringArray(value)) { errors.push(`${skill}: ega.yaml ${field} must be an array of strings.`); continue; }
        for (const entry of value) {
          const canonical = entry.trim().toLowerCase();
          if (!IDENTIFIER.test(canonical)) errors.push(`${skill}: ega.yaml ${field} contains invalid identifier ${JSON.stringify(entry)}.`);
          if (field === 'aliases') {
            const owner = aliases.get(canonical);
            if (owner && owner !== skill) errors.push(`${skill}: alias ${canonical} is already owned by ${owner}.`);
            else aliases.set(canonical, skill);
          }
        }
      }
      for (const field of TRIGGER_KEYS) {
        const value = ega[field];
        if (value === undefined) continue;
        if (!stringArray(value)) { errors.push(`${skill}: ega.yaml ${field} must be an array of strings.`); continue; }
        for (const entry of value) {
          if (!entry.replace(/\r\n?/g, '\n').trim()) errors.push(`${skill}: ega.yaml ${field} contains an empty value.`);
        }
      }
    }

    for (const [path, text] of Object.entries(files)) {
      if (!path.startsWith(prefix) || !path.endsWith('.md')) continue;
      const visible = text.replace(/```[\s\S]*?```/g, '');
      for (const match of visible.matchAll(LINK)) checkReference(files, skill, path, match[1]!, errors);
      for (const match of visible.matchAll(BARE_REF)) checkReference(files, skill, path, match[1]!, errors);
    }
  }

  const rawCases = (() => {
    if (!Object.hasOwn(files, CASES)) { errors.push(`Missing ${CASES}.`); return undefined; }
    try { return JSON.parse(files[CASES]!) as unknown; } catch { errors.push(`${CASES} is invalid JSON.`); return undefined; }
  })();
  if (!Array.isArray(rawCases) || rawCases.length > 1000) {
    errors.push('tests/trigger-cases.json must be an array.');
  } else {
    const seen = new Set<string>();
    for (const raw of rawCases) {
      const row = record(raw);
      if (!row || typeof row.skill !== 'string') { errors.push('tests/trigger-cases.json contains an invalid case.'); continue; }
      const skill = row.skill;
      if (!catalog.includes(skill)) errors.push(`tests/trigger-cases.json contains unknown skill ${skill}.`);
      if (seen.has(skill)) errors.push(`tests/trigger-cases.json contains duplicate case ${skill}.`);
      seen.add(skill);
      for (const field of CASE_FIELDS) if (typeof row[field] !== 'string' || !row[field].trim()) errors.push(`${skill}: trigger case ${field} is required.`);
      for (const field of ['negative_expected', 'collision_expected'] as const) {
        if (typeof row[field] === 'string' && !catalog.includes(row[field])) errors.push(`${skill}: trigger case ${field} is not a catalog skill.`);
      }
    }
    for (const skill of catalog) if (!seen.has(skill)) errors.push(`tests/trigger-cases.json is missing skill ${skill}.`);
  }

  return [...new Set(errors)];
}
