import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { planOriginalAdd } from '../../../apps/web/server/source-manager/planner.ts';

const source = process.env.EGA_SOURCE_FIXTURE;
const paths = ['scripts/sync_openai_yaml.py', 'scripts/build_upstream_sources.py', 'upstream-sources.json', 'tests/trigger-cases.json'];
const input = { operation: 'add', name: 'review-sample-change', description: 'Review a sample change for clear evidence and useful results. Use when a sample change needs an evidence review.', body: '# Review Sample Change\n\nInspect the change and record useful evidence.', triggers: ['review sample change'], antiTriggers: ['ship production release'], interface: { displayName: 'Review Sample Change', shortDescription: 'Review a sample change with clear evidence', prompt: 'Use $review-sample-change to inspect the sample change.' }, cases: { direct: 'Review sample change with clear evidence', indirect: 'Inspect this sample change and record evidence', incomplete: 'review sample', negative: 'verify production target before mutation', negative_expected: 'certify-production-target', collision: 'certify release before production deployment', collision_expected: 'certify-release', edge: 'Review sample change even when evidence already exists' } };

test('original addition updates canonical inputs and generated files deterministically', { skip: !source }, () => {
  const snapshot = Object.fromEntries(paths.map(p => [p, readFileSync(`${source}/${p}`, 'utf8')]));
  const result = planOriginalAdd(snapshot, input);
  assert.deepEqual(result.errors, []);
  assert.equal(Object.keys(result.changes).length, 7);
  assert.deepEqual(planOriginalAdd(snapshot, input), result);
  assert.equal(JSON.parse(result.changes['upstream-sources.json']).sources.find(s => s.skill === input.name).mode, 'original');
  assert.match(result.changes['scripts/sync_openai_yaml.py'], /"review-sample-change": \(/);
  assert.deepEqual(planOriginalAdd({ ...snapshot, [paths[0]]: 'changed format' }, input).changes, {});
  assert.ok(planOriginalAdd(snapshot, { ...input, name: '../escape' }).errors.length);
  if (process.env.EGA_PLAN_OUTPUT) {
    writeFileSync(process.env.EGA_PLAN_OUTPUT, JSON.stringify(result.changes));
  }
});

test('rejects invalid metadata and never returns a partial plan', () => {
  const snapshot = {
    'scripts/sync_openai_yaml.py': 'METADATA: dict[str, tuple[str, str, str]] = {\n}\n',
    'scripts/build_upstream_sources.py': 'ORIGINAL = [\n]\n',
    'upstream-sources.json': JSON.stringify({ sources: [{ skill: 'certify-release', mode: 'original' }, { skill: 'certify-production-target', mode: 'original' }] }),
    'tests/trigger-cases.json': '[]',
  };
  const invalid = planOriginalAdd(snapshot, { ...input, description: '<bad>', interface: { ...input.interface, prompt: 'missing name' } });
  assert.ok(invalid.errors.length >= 2);
  assert.deepEqual(invalid.changes, {});
  assert.equal(planOriginalAdd(snapshot, input).errors.length, 0);
  assert.ok(planOriginalAdd({ ...snapshot, [`skills/${input.name}/SKILL.md`]: 'existing' }, input).errors.some(e => e.includes('exists')));
});

test('source update preserves provenance and copied bodies are protected', { skip: !source }, async () => {
  const { planSkillUpdate } = await import('../../../apps/web/server/source-manager/planner.ts');
  const registry = readFileSync(`${source}/upstream-sources.json`, 'utf8');
  const originalPath = 'skills/ship-one-outcome/SKILL.md';
  const copiedPath = 'skills/blast-radius/SKILL.md';
  const snapshot = { 'upstream-sources.json': registry, [originalPath]: readFileSync(`${source}/${originalPath}`, 'utf8'), [copiedPath]: readFileSync(`${source}/${copiedPath}`, 'utf8') };
  const updated = planSkillUpdate(snapshot, { operation: 'update', name: 'ship-one-outcome', description: 'Use this skill to deliver a bounded outcome.', body: '# Ship One Outcome\n\nCheck the evidence.' });
  assert.deepEqual(updated.errors, []);
  assert.deepEqual(Object.keys(updated.changes), [originalPath]);
  if (process.env.EGA_UPDATE_PLAN_OUTPUT) writeFileSync(process.env.EGA_UPDATE_PLAN_OUTPUT, JSON.stringify(updated.changes));
  assert.ok(planSkillUpdate(snapshot, { operation: 'update', name: 'blast-radius', description: 'Find risks.', body: '# Changed' }).errors.some(e => e.includes('Copied')));
});

test('routing and reference edits preserve unrelated metadata and copied source', async () => {
  const { planSkillUpdate } = await import('../../../apps/web/server/source-manager/planner.ts');
  const skill = '---\nname: example\ndescription: Example description\n---\n\n# Example\n';
  const routing = JSON.stringify({ schema_version: 1, triggers: ['old'], anti_triggers: ['avoid'], aliases: ['keep'] });
  const prefix = 'skills/example/';
  const snapshot = { 'upstream-sources.json': JSON.stringify({ sources: [{ skill: 'example', mode: 'original' }] }), [prefix + 'SKILL.md']: skill, [prefix + 'ega.yaml']: routing, [prefix + 'references/guide.md']: 'old reference' };
  const parse = text => text.startsWith('{') ? JSON.parse(text) : { name: 'example', description: 'Example description' };
  const update = { operation: 'update', name: 'example', description: 'Example description', body: '# Example', routing: { triggers: ['new'], antiTriggers: ['avoid'] }, references: [{ path: 'references/guide.md', content: 'new reference' }] };
  const result = planSkillUpdate(snapshot, update, parse);
  assert.deepEqual(result.errors, []);
  assert.equal(result.changes[prefix + 'SKILL.md'], undefined);
  assert.deepEqual(JSON.parse(result.changes[prefix + 'ega.yaml']), { schema_version: 1, triggers: ['new'], anti_triggers: ['avoid'], aliases: ['keep'] });
  assert.equal(result.changes[prefix + 'references/guide.md'], 'new reference');
  const copied = { ...snapshot, 'upstream-sources.json': JSON.stringify({ sources: [{ skill: 'example', mode: 'copied' }] }) };
  assert.deepEqual(planSkillUpdate(copied, { ...update, references: [] }, parse).errors, []);
  assert.ok(planSkillUpdate(copied, update, parse).errors.some(e => e.includes('Copied')));
  assert.ok(planSkillUpdate(snapshot, { ...update, references: [{ path: 'references/../SKILL.md', content: 'bad' }] }, parse).errors.length);
  assert.ok(planSkillUpdate(snapshot, { ...update, references: [{ path: 'references/guide.md', content: '😀'.repeat(100_000) }] }, parse).errors.length);
  assert.ok(planSkillUpdate(snapshot, { ...update, routing: { triggers: ['new', ' New '], antiTriggers: [] } }, parse).errors.length);
  const tags = { domains: ['Engineering'], platforms: [], frameworks: [], aliases: ['example-alias'] };
  const tagged = planSkillUpdate(snapshot, { ...update, routing: { ...update.routing, tags } }, parse);
  assert.deepEqual(JSON.parse(tagged.changes[prefix + 'ega.yaml']).domains, ['engineering']);
  assert.ok(planSkillUpdate(snapshot, { ...update, routing: { ...update.routing, tags: { ...tags, aliases: ['same', ' SAME '] } } }, parse).errors.length);
});

test('source removal updates generators and refuses dangling trigger references', { skip: !source }, async () => {
  const { planSkillRemoval } = await import('../../../apps/web/server/source-manager/planner.ts');
  const { execFileSync } = await import('node:child_process');
  const names = execFileSync('git', ['-C', source, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');
  const snapshot = Object.fromEntries(names.filter(p => p.startsWith('skills/') || paths.includes(p)).map(p => [p, readFileSync(`${source}/${p}`, 'utf8')]));
  const result = planSkillRemoval(snapshot, { operation: 'remove', name: 'ship-one-outcome', confirmation: 'ship-one-outcome' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.changes['skills/ship-one-outcome/SKILL.md'], null);
  assert.ok(!result.changes['scripts/build_upstream_sources.py'].includes('    "ship-one-outcome",'));
  assert.ok(planSkillRemoval(snapshot, { operation: 'remove', name: 'certify-release', confirmation: 'certify-release' }).errors.some(e => e.includes('Trigger cases reference')));
  assert.ok(planSkillRemoval(snapshot, { operation: 'remove', name: 'ship-one-outcome', confirmation: 'wrong' }).errors.some(e => e.includes('confirm')));
  for (const [path, content] of [
    ['skills/example/references/guide.txt', 'See ../../ship-one-outcome/SKILL.md'],
    ['skills/example/SKILL.md', 'See ../ship-one-outcome/SKILL.md'],
  ]) {
    const withReference = { ...snapshot, [path]: content };
    assert.ok(planSkillRemoval(withReference, { operation: 'remove', name: 'ship-one-outcome', confirmation: 'ship-one-outcome' }).errors.some(e => e.includes(path)));
  }
  if (process.env.EGA_REMOVE_PLAN_OUTPUT) writeFileSync(process.env.EGA_REMOVE_PLAN_OUTPUT, JSON.stringify(result.changes));
});

test('resources retain binary bytes and executable modes and reject collisions', { skip: !source }, () => {
  const snapshot = Object.fromEntries(paths.map(p => [p, readFileSync(`${source}/${p}`, 'utf8')]));
  const resources = [
    { path: 'assets/icon.bin', mode: '100644', contentBase64: Buffer.from([0, 255, 1]).toString('base64') },
    { path: 'scripts/check.sh', mode: '100755', contentBase64: Buffer.from('#!/bin/sh\ntrue\n').toString('base64') },
  ];
  const plan = planOriginalAdd(snapshot, { ...input, resources });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.changes['skills/review-sample-change/assets/icon.bin'], { contentBase64: resources[0].contentBase64, mode: '100644' });
  assert.deepEqual(plan.changes['skills/review-sample-change/scripts/check.sh'], { contentBase64: resources[1].contentBase64, mode: '100755' });
  assert.ok(planOriginalAdd(snapshot, { ...input, resources: [...resources, { ...resources[0], path: 'assets/ICON.bin' }] }).errors.length);
  assert.ok(planOriginalAdd(snapshot, { ...input, resources: [{ ...resources[0], path: '../escape' }] }).errors.length);
  assert.ok(planOriginalAdd(snapshot, { ...input, body: '😀'.repeat(100_000) }).errors.some(e => e.includes('File too large')));
  const manyResources = Array.from({ length: 98 }, (_, i) => ({ path: `assets/${i}.bin`, mode: '100644', contentBase64: 'YQ==' }));
  assert.ok(planOriginalAdd(snapshot, { ...input, resources: manyResources }).errors.some(e => e.includes('Too many')));
});

// --- first-skill bootstrap from the canonical empty generator tables --------

const emptySnapshot = () => ({
  'scripts/sync_openai_yaml.py': 'METADATA: dict[str, tuple[str, str, str]] = {}\n\nMIN_SHORT = 25\n',
  'scripts/build_upstream_sources.py': 'ORIGINAL: list[str] = []\n',
  'upstream-sources.json': '{"sources":[]}',
  'tests/trigger-cases.json': '[]',
});

const firstInput = {
  ...input,
  name: 'first-skill',
  interface: { ...input.interface, prompt: 'Use $first-skill to inspect the evidence.' },
  cases: {
    ...input.cases,
    negative_expected: null,
    collision_expected: null,
    negative: 'Summarize quarterly revenue for the board',
    collision: 'Prepare a financial forecast for next quarter',
  },
};

test('first skill is added from canonical empty generator tables with no-neighbor expectations', async () => {
  const { planSkillRemoval } = await import('../../../apps/web/server/source-manager/planner.ts');
  const snapshot = emptySnapshot();
  const planned = planOriginalAdd(snapshot, firstInput);
  assert.deepEqual(planned.errors, []);
  assert.match(planned.changes['scripts/sync_openai_yaml.py'], /^METADATA: dict\[str, tuple\[str, str, str\]\] = \{\n/m);
  assert.match(planned.changes['scripts/build_upstream_sources.py'], /^ORIGINAL: list\[str\] = \[\n/m);
  assert.equal(snapshot['scripts/sync_openai_yaml.py'], 'METADATA: dict[str, tuple[str, str, str]] = {}\n\nMIN_SHORT = 25\n', 'snapshot is not mutated');
  const cases = JSON.parse(planned.changes['tests/trigger-cases.json']);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].negative_expected, null);
  assert.equal(cases[0].collision_expected, null);
  assert.ok(planned.changes['skills/first-skill/SKILL.md'].includes('name: first-skill'));
  assert.ok(planned.changes['skills/first-skill/ega.yaml'].includes('triggers:'));
  assert.ok(planned.changes['skills/first-skill/agents/openai.yaml'].includes('display_name'));
  const afterFirst = { ...snapshot, ...planned.changes };
  const removed = planSkillRemoval(afterFirst, { operation: 'remove', name: 'first-skill', confirmation: 'first-skill' });
  assert.deepEqual(removed.errors, []);
  assert.match(removed.changes['scripts/sync_openai_yaml.py'], /^METADATA: dict\[str, tuple\[str, str, str\]\] = \{\}$/m);
  assert.match(removed.changes['scripts/build_upstream_sources.py'], /^ORIGINAL: list\[str\] = \[\]$/m);
  assert.deepEqual(JSON.parse(removed.changes['tests/trigger-cases.json']), []);
  assert.equal(removed.changes['skills/first-skill/SKILL.md'], null);
});

test('second skill uses a real neighbor; first skill null expectations stay valid', () => {
  const first = planOriginalAdd(emptySnapshot(), firstInput);
  assert.deepEqual(first.errors, []);
  const snapshot = { ...emptySnapshot(), ...first.changes };
  const secondInput = {
    ...input,
    name: 'second-skill',
    interface: { ...input.interface, prompt: 'Use $second-skill to inspect the evidence.' },
    cases: { ...input.cases, negative_expected: 'first-skill', collision_expected: 'first-skill' },
  };
  const second = planOriginalAdd(snapshot, secondInput);
  assert.deepEqual(second.errors, []);
  const cases = JSON.parse(second.changes['tests/trigger-cases.json']);
  assert.equal(cases.find(row => row.skill === 'first-skill').negative_expected, null);
  assert.equal(cases.find(row => row.skill === 'second-skill').negative_expected, 'first-skill');
  assert.ok(planOriginalAdd(snapshot, { ...secondInput, cases: { ...secondInput.cases, negative_expected: 'missing-skill' } }).errors.some(e => e.includes('existing source skills')));
  assert.ok(planOriginalAdd(snapshot, { ...secondInput, cases: { ...secondInput.cases, collision_expected: '' } }).errors.some(e => e.includes('null')));
});

test('ambiguous or malformed generator tables are rejected without partial changes', () => {
  const duplicated = {
    ...emptySnapshot(),
    'scripts/sync_openai_yaml.py': 'METADATA: dict[str, tuple[str, str, str]] = {}\nMETADATA: dict[str, tuple[str, str, str]] = {}\n',
    'scripts/build_upstream_sources.py': 'ORIGINAL: list[str] = []\nORIGINAL: list[str] = []\n',
  };
  const result = planOriginalAdd(duplicated, firstInput);
  assert.ok(result.errors.length);
  assert.deepEqual(result.changes, {});
});
