import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGithubImport } from '../../../apps/web/server/source-manager/normalize-import.ts';
import { parseProposalRequest } from '../../../apps/web/server/source-manager/input.ts';
import { previewProposal, submitProposal } from '../../../apps/web/server/source-manager/service.ts';
import { readFileSync } from 'node:fs';

const location = { owner: 'example', repo: 'tools', commit: 'b'.repeat(40), directory: 'skills/sample' };
const imported = { location, files: [{ path: 'SKILL.md', mode: '100644', bytes: Buffer.from('---\nname: sample\ndescription: Imported skill\n---\n# Skill\n\nBody') }, { path: 'scripts/check.sh', mode: '100755', bytes: Buffer.from('#!/bin/sh\n') }], license: { path: 'LICENSE', sha: 'c'.repeat(40), text: 'A license\n' } };
const proposal = { operation: 'add', name: 'sample', description: '', body: '', triggers: ['sample'], antiTriggers: ['other'], interface: { displayName: 'Sample', shortDescription: 'Review a sample change with clear evidence', prompt: 'Use $sample for the sample.' }, cases: { direct: 'sample', indirect: 'sample', incomplete: 'sample', negative: 'other', negative_expected: 'certify-production-target', collision: 'other', collision_expected: 'certify-release', edge: 'sample' }, importSource: { location, acceptOriginalNormalization: true } };
const parseYaml = () => ({ name: 'sample', description: 'Imported skill' });

test('import preserves pinned source, license, script mode, and attribution', () => {
  const result = normalizeGithubImport(proposal, imported, parseYaml);
  assert.match(result.body, new RegExp(location.commit));
  assert.match(result.body, /does not claim authorship/);
  assert.equal(result.description, 'Imported skill');
  assert.equal(result.resources.find(file => file.path === 'scripts/check.sh').mode, '100755');
  assert.equal(Buffer.from(result.resources.find(file => file.path === 'references/upstream-license.txt').contentBase64, 'base64').toString(), imported.license.text);
});
test('import refuses ambiguous normalization, extra frontmatter, unsupported metadata and path mismatch', () => {
  const request = { baseSha: 'a'.repeat(40), proposal };
  assert.throws(() => parseProposalRequest({ ...request, proposal: { ...proposal, importSource: { location, acceptOriginalNormalization: false } } }));
  assert.throws(() => parseProposalRequest({ ...request, proposal: { ...proposal, resources: [], importSource: proposal.importSource } }));
  assert.throws(() => normalizeGithubImport(proposal, imported, () => ({ ...parseYaml(), license: 'MIT' })));
  assert.throws(() => normalizeGithubImport({ ...proposal, name: 'different' }, imported, parseYaml));
  assert.throws(() => normalizeGithubImport(proposal, { ...imported, files: [...imported.files, { path: 'ega.yaml', mode: '100644', bytes: Buffer.from('x') }] }, parseYaml));
});
test('submission re-reads pinned import and rejects changes to previewed license', { skip: !process.env.EGA_SOURCE_FIXTURE }, async () => {
  const paths = ['scripts/sync_openai_yaml.py', 'scripts/build_upstream_sources.py', 'upstream-sources.json', 'tests/trigger-cases.json'];
  const files = Object.fromEntries(paths.map(path => [path, readFileSync(`${process.env.EGA_SOURCE_FIXTURE}/${path}`, 'utf8')]));
  const baseSha = 'a'.repeat(40); let writes = 0; let current = imported;
  const source = { mainSha: async () => baseSha, snapshot: async () => ({ sha: baseSha, files, selectedFiles: [] }), submit: async () => { writes++; } };
  const imports = { read: async () => current, parseYaml };
  const preview = await previewProposal(source, { baseSha, proposal }, imports);
  assert.deepEqual(preview.errors, []);
  current = { ...imported, license: { ...imported.license, text: 'different' } };
  await assert.rejects(submitProposal(source, { baseSha, proposal, previewDigest: preview.digest }, imports), e => e.status === 409);
  assert.equal(writes, 0);
});
