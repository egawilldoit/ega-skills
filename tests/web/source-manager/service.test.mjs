import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { previewProposal, submitProposal } from '../../../apps/web/server/source-manager/service.ts';
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { parse: parseYaml } = require('yaml');
const sourceImports = { read: async () => { throw new Error('unexpected import'); }, parseYaml: text => parseYaml(text, { uniqueKeys: true, maxAliasCount: 0 }) };
const base = 'a'.repeat(40);
const request = { baseSha: base, proposal: { operation: 'update', name: 'sample-skill', description: 'Review the sample change.', body: '# Sample\n\nReview the result.' } };
const files = { 'upstream-sources.json': JSON.stringify({ sources: [{ skill: 'sample-skill', mode: 'original' }] }), 'skills/sample-skill/SKILL.md': 'old' };
test('preview replans from the pinned source and returns before and after', async () => {
  const result = await previewProposal({ mainSha: async () => base, snapshot: async () => ({ sha: base, files, selectedFiles: [] }) }, request);
  assert.deepEqual(result.errors, []);
  assert.equal(result.changes[0].before, 'old');
  assert.match(result.changes[0].after, /Review the sample change/);
  assert.equal(result.provenance, 'original');
});
test('stale base is rejected before snapshot read', async () => {
  let read = false;
  await assert.rejects(previewProposal({ mainSha: async () => 'b'.repeat(40), snapshot: async () => { read = true; } }, request), e => e.status === 409);
  assert.equal(read, false);
});
test('submission recomputes the confirmed preview and never trusts client file changes', async () => {
  let submitted;
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files, selectedFiles: [] }), submit: async plan => { submitted = plan; return { number: 12, url: 'https://github.com/egawilldoit/skills/pull/12', head: 'b'.repeat(40) }; } };
  const preview = await previewProposal(source, request);
  const result = await submitProposal(source, { ...request, previewDigest: preview.digest });
  assert.equal(result.number, 12);
  assert.equal(submitted.changes['skills/sample-skill/SKILL.md'], preview.changes[0].after);
  submitted = undefined;
  await assert.rejects(submitProposal(source, { ...request, previewDigest: '0'.repeat(64) }), e => e.status === 409);
  await assert.rejects(submitProposal(source, { ...request, previewDigest: preview.digest, changes: { 'other/file': 'bad' } }), e => e.status === 400);
  assert.equal(submitted, undefined);
});

test('submission refuses an empty or invalid proposal before any write', async () => {
  let writes = 0;
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files, selectedFiles: [] }), submit: async () => { writes++; } };
  const bad = { ...request, proposal: { ...request.proposal, description: '' } };
  const preview = await previewProposal(source, bad);
  await assert.rejects(submitProposal(source, { ...bad, previewDigest: preview.digest }), e => e.status === 422);
  assert.equal(writes, 0);
});

test('resource preview binds bytes and modes to the submitted plan', { skip: !process.env.EGA_SOURCE_FIXTURE }, async () => {
  const { readFileSync } = await import('node:fs');
  const paths = ['scripts/sync_openai_yaml.py', 'scripts/build_upstream_sources.py', 'upstream-sources.json', 'tests/trigger-cases.json'];
  const sourceFiles = Object.fromEntries(paths.map(path => [path, readFileSync(`${process.env.EGA_SOURCE_FIXTURE}/${path}`, 'utf8')]));
  let submitted;
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files: sourceFiles, selectedFiles: [] }), submit: async plan => { submitted = plan; return { number: 12 }; } };
  const resource = { path: 'assets/icon.bin', mode: '100644', contentBase64: Buffer.from([0, 255, 1]).toString('base64') };
  const proposal = { operation: 'add', name: 'review-sample-change', description: 'Review sample changes.', body: '# Review\n\nInspect the change.', triggers: ['review sample change'], antiTriggers: ['ship release'], interface: { displayName: 'Review Sample Change', shortDescription: 'Review a sample change with clear evidence', prompt: 'Use $review-sample-change to inspect the sample change.' }, cases: { direct: 'Review sample change', indirect: 'Inspect the change', incomplete: 'review sample', negative: 'verify production target', negative_expected: 'certify-production-target', collision: 'certify release', collision_expected: 'certify-release', edge: 'Review existing evidence' }, resources: [resource] };
  const preview = await previewProposal(source, { baseSha: base, proposal });
  assert.deepEqual(preview.errors, []);
  const change = preview.changes.find(c => c.path.endsWith('icon.bin'));
  assert.match(change.after, /^\[binary file: 3 bytes, sha256 [0-9a-f]{64}\]$/);
  assert.equal(change.mode, '100644');
  await submitProposal(source, { baseSha: base, proposal, previewDigest: preview.digest });
  assert.deepEqual(submitted.changes['skills/review-sample-change/assets/icon.bin'], { contentBase64: resource.contentBase64, mode: resource.mode });
  submitted = undefined;
  await assert.rejects(submitProposal(source, { baseSha: base, proposal: { ...proposal, resources: [{ ...resource, contentBase64: 'AQID' }] }, previewDigest: preview.digest }), e => e.status === 409);
  assert.equal(submitted, undefined);
});

test('preview warns about exact trigger overlap without claiming a semantic verdict', { skip: !process.env.EGA_SOURCE_FIXTURE }, async () => {
  const { readFileSync } = await import('node:fs');
  const paths = ['scripts/sync_openai_yaml.py', 'scripts/build_upstream_sources.py', 'upstream-sources.json', 'tests/trigger-cases.json'];
  const sourceFiles = Object.fromEntries(paths.map(path => [path, readFileSync(`${process.env.EGA_SOURCE_FIXTURE}/${path}`, 'utf8')]));
  sourceFiles['skills/existing/ega.yaml'] = 'existing';
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files: sourceFiles, selectedFiles: [] }) };
  const proposal = { operation: 'add', name: 'review-sample-change', description: 'Review sample changes.', body: '# Review\n\nInspect the change.', triggers: [' Review SAMPLE change '], antiTriggers: ['ship release'], interface: { displayName: 'Review Sample Change', shortDescription: 'Review a sample change with clear evidence', prompt: 'Use $review-sample-change to inspect the sample change.' }, cases: { direct: 'Review sample change', indirect: 'Inspect the change', incomplete: 'review sample', negative: 'verify production target', negative_expected: 'certify-production-target', collision: 'certify release', collision_expected: 'certify-release', edge: 'Review existing evidence' } };
  const result = await previewProposal(source, { baseSha: base, proposal }, { read: async () => { throw new Error('unexpected'); }, parseYaml: () => ({ triggers: ['review sample change'] }) });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some(warning => warning.includes('overlaps with: existing')));
});

test('routing overlap check accepts actual source routing metadata', { skip: !process.env.EGA_SOURCE_FIXTURE }, async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
  const { parse } = require(process.env.EGA_YAML_MODULE ?? 'yaml');
  const paths = ['scripts/sync_openai_yaml.py', 'scripts/build_upstream_sources.py', 'upstream-sources.json', 'tests/trigger-cases.json'];
  const sourceFiles = Object.fromEntries(paths.map(path => [path, readFileSync(`${process.env.EGA_SOURCE_FIXTURE}/${path}`, 'utf8')]));
  for (const name of readdirSync(`${process.env.EGA_SOURCE_FIXTURE}/skills`)) {
    const path = `skills/${name}/ega.yaml`;
    sourceFiles[path] = readFileSync(`${process.env.EGA_SOURCE_FIXTURE}/${path}`, 'utf8');
  }
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files: sourceFiles, selectedFiles: [] }) };
  const proposal = { operation: 'add', name: 'review-sample-change', description: 'Review sample changes.', body: '# Review\n\nInspect the change.', triggers: ['review sample change'], antiTriggers: ['ship release'], interface: { displayName: 'Review Sample Change', shortDescription: 'Review a sample change with clear evidence', prompt: 'Use $review-sample-change to inspect the sample change.' }, cases: { direct: 'Review sample change', indirect: 'Inspect the change', incomplete: 'review sample', negative: 'verify production target', negative_expected: 'certify-production-target', collision: 'certify release', collision_expected: 'certify-release', edge: 'Review existing evidence' } };
  const result = await previewProposal(source, { baseSha: base, proposal }, { read: async () => { throw new Error('unexpected'); }, parseYaml: text => parse(text, { uniqueKeys: true, maxAliasCount: 0 }) });
  assert.deepEqual(result.errors, []);
});

test('routing updates warn about matching other skills', async () => {
  const snapshot = { ...files, 'skills/sample-skill/SKILL.md': '---\nname: sample-skill\ndescription: Review the sample change.\n---\n\n# Sample\n\nReview the result.\n', 'skills/sample-skill/ega.yaml': JSON.stringify({ schema_version: 1, triggers: ['old'], anti_triggers: [] }), 'skills/other/ega.yaml': JSON.stringify({ schema_version: 1, triggers: ['shared wording'], anti_triggers: [] }) };
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files: snapshot, selectedFiles: [] }) };
  const proposal = { ...request.proposal, routing: { triggers: [' Shared wording '], antiTriggers: [] } };
  const imports = { read: async () => { throw new Error('unexpected'); }, parseYaml: text => text.startsWith('{') ? JSON.parse(text) : { name: 'sample-skill', description: 'Review the sample change.' } };
  const result = await previewProposal(source, { baseSha: base, proposal }, imports);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some(warning => warning.includes('overlaps with: other')));
});

test('description overlap is a warning with shared wording', async () => {
  const snapshot = { ...files, 'skills/sample-skill/SKILL.md': '---\nname: sample-skill\ndescription: Review deployment readiness and release evidence.\n---\n\n# Sample\n', 'skills/other/SKILL.md': '---\nname: other\ndescription: Check release evidence for deployment readiness.\n---\n\n# Other\n' };
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files: snapshot, selectedFiles: [] }) };
  const proposal = { ...request.proposal, description: 'Review deployment readiness and release evidence.' };
  const imports = { read: async () => { throw new Error('unexpected'); }, parseYaml: text => ({ description: text.includes('other') ? 'Check release evidence for deployment readiness.' : proposal.description }) };
  const result = await previewProposal(source, { baseSha: base, proposal }, imports);
  assert.ok(result.warnings.some(warning => warning.includes('other (deployment, evidence, readiness, release)')));
  assert.ok(!result.errors.some(error => error.includes('overlap')));
});

test('alias conflicts block a routing update before any write', async () => {
  let writes = 0;
  const snapshot = { ...files, 'skills/sample-skill/SKILL.md': '---\nname: sample-skill\ndescription: Review the sample change.\n---\n\n# Sample\n\nReview the result.\n', 'skills/sample-skill/ega.yaml': JSON.stringify({ schema_version: 1, triggers: ['old'], anti_triggers: [] }), 'skills/other/ega.yaml': JSON.stringify({ schema_version: 1, aliases: ['shared-alias'] }) };
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files: snapshot, selectedFiles: [] }), submit: async () => { writes++; } };
  const proposal = { ...request.proposal, routing: { triggers: ['old'], antiTriggers: [], tags: { domains: [], platforms: [], frameworks: [], aliases: ['SHARED-alias'] } } };
  const imports = { read: async () => { throw new Error('unexpected'); }, parseYaml: text => text.startsWith('{') ? JSON.parse(text) : { name: 'sample-skill', description: 'Review the sample change.' } };
  const preview = await previewProposal(source, { baseSha: base, proposal }, imports);
  assert.ok(preview.errors.some(error => error.includes('already owned by other')));
  await assert.rejects(submitProposal(source, { baseSha: base, proposal, previewDigest: preview.digest }, imports), e => e.status === 422);
  assert.equal(writes, 0);
});

function catalogSnapshot() {
  const cases = (skill, other) => ({ skill, direct: `Use ${skill} directly`, indirect: `Ask for ${skill} work`, incomplete: `${skill} work`, negative: `different ${skill} request`, negative_expected: other, collision: `similar ${skill} request`, collision_expected: other, edge: `edge ${skill} request` });
  const files = {
    'upstream-sources.json': JSON.stringify({ sources: [{ skill: 'keep-skill', mode: 'original' }, { skill: 'remove-skill', mode: 'original' }] }),
    'scripts/sync_openai_yaml.py': 'METADATA: dict[str, tuple[str, str, str]] = {\n    "keep-skill": (\n        "Keep Skill",\n        "Keep something useful for this test",\n        "Use $keep-skill to keep the thing.",\n    ),\n    "remove-skill": (\n        "Remove Skill",\n        "Remove something useful for this test",\n        "Use $remove-skill to remove the thing.",\n    ),\n}\n',
    'scripts/build_upstream_sources.py': 'ORIGINAL = [\n    "keep-skill",\n    "remove-skill",\n]\n',
    'tests/trigger-cases.json': JSON.stringify([cases('keep-skill', 'keep-skill'), cases('remove-skill', 'keep-skill')]),
  };
  for (const skill of ['keep-skill', 'remove-skill']) {
    files[`skills/${skill}/SKILL.md`] = `---\nname: ${skill}\ndescription: ${skill} handles its own bounded task.\n---\n\n# ${skill}\n\nDo the ${skill} work.\n`;
    files[`skills/${skill}/ega.yaml`] = JSON.stringify({ schema_version: 1, triggers: [`use ${skill}`], anti_triggers: [] });
    files[`skills/${skill}/agents/openai.yaml`] = `interface:\n  display_name: "${skill}"\n  short_description: "A clear description for ${skill} work"\n  default_prompt: "Use $${skill} to do the task."\n`;
  }
  return files;
}

const removal = { operation: 'remove', name: 'remove-skill', confirmation: 'remove-skill' };

test('a valid removal passes full candidate catalog validation and reaches the proposal adapter', async () => {
  let submitted;
  const snapshot = catalogSnapshot();
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files: snapshot, selectedFiles: [] }), submit: async plan => { submitted = plan; return { number: 21, url: 'https://github.com/egawilldoit/skills/pull/21', head: 'b'.repeat(40) }; } };
  const preview = await previewProposal(source, { baseSha: base, proposal: removal }, sourceImports);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.changes.find(change => change.path === 'skills/remove-skill/SKILL.md').after, null);
  await submitProposal(source, { baseSha: base, proposal: removal, previewDigest: preview.digest }, sourceImports);
  assert.equal(submitted.operation, 'remove');
  assert.equal(submitted.validationSummary.includes('Full candidate catalog validation'), true);
});

test('a removal is blocked when the remaining candidate catalog is invalid', async () => {
  let writes = 0;
  const snapshot = catalogSnapshot();
  delete snapshot['skills/keep-skill/agents/openai.yaml'];
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files: snapshot, selectedFiles: [] }), submit: async () => { writes++; } };
  const preview = await previewProposal(source, { baseSha: base, proposal: removal }, sourceImports);
  assert.ok(preview.errors.some(error => error.includes('agents/openai.yaml')));
  await assert.rejects(submitProposal(source, { baseSha: base, proposal: removal, previewDigest: preview.digest }, sourceImports), e => e.status === 422);
  assert.equal(writes, 0);
});

test('a referenced removal stays blocked before full validation runs', async () => {
  let writes = 0;
  const snapshot = catalogSnapshot();
  snapshot['skills/keep-skill/SKILL.md'] += '\nSee ../remove-skill/SKILL.md for the other workflow.\n';
  const source = { mainSha: async () => base, snapshot: async () => ({ sha: base, files: snapshot, selectedFiles: [] }), submit: async () => { writes++; } };
  const preview = await previewProposal(source, { baseSha: base, proposal: removal }, sourceImports);
  assert.ok(preview.errors.some(error => error.includes('Other skills reference this skill')));
  await assert.rejects(submitProposal(source, { baseSha: base, proposal: removal, previewDigest: preview.digest }, sourceImports), e => e.status === 422);
  assert.equal(writes, 0);
});

test('the pinned real catalog passes full validation for a removable skill', { skip: !process.env.EGA_SOURCE_FIXTURE }, async () => {
  const { readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const source = process.env.EGA_SOURCE_FIXTURE;
  const names = execFileSync('git', ['-C', source, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');
  const snapshot = Object.fromEntries(names.map(path => [path, readFileSync(`${source}/${path}`, 'utf8')]));
  const preview = await previewProposal({ mainSha: async () => base, snapshot: async () => ({ sha: base, files: snapshot, selectedFiles: [] }) }, { baseSha: base, proposal: { operation: 'remove', name: 'ship-one-outcome', confirmation: 'ship-one-outcome' } }, sourceImports);
  assert.deepEqual(preview.errors, []);
  assert.ok(preview.changes.some(change => change.path === 'skills/ship-one-outcome/SKILL.md' && change.after === null));
});
