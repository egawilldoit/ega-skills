import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewProposal, submitProposal } from '../../../apps/web/server/source-manager/service.ts';
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
