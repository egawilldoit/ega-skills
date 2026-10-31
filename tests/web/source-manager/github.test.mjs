import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SourceGithub } from '../../../apps/web/server/source-manager/github.ts';
const base = 'a'.repeat(40), baseTree = 'b'.repeat(40), tree = 'c'.repeat(40), head = 'd'.repeat(40);
const proposal = { operation: 'add', name: 'example-skill', baseSha: base, provenance: 'original', validationSummary: 'Provisional', changes: { 'skills/example-skill/SKILL.md': 'text' } };
function fake({ stale = false, fail = false } = {}) {
  let branch = null, pull = false, commits = 0, refs = 0, pulls = 0, blobRequest, treeRequest;
  const transport = async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/egawilldoit/skills/'));
    const path = url.slice('https://api.github.com/repos/egawilldoit/skills'.length);
    const data = options.body ? JSON.parse(options.body) : null;
    const ok = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (fail) return ok({ message: 'secret-token must never appear' }, 403);
    if (path === `/git/commits/${base}`) return ok({ tree: { sha: baseTree }, parents: [] });
    if (path === `/git/commits/${head}`) return ok({ tree: { sha: tree }, parents: [{ sha: base }] });
    if (path === '/git/blobs') { blobRequest = data; const bytes = Buffer.from(data.content, 'base64'); return ok({ sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }); }
    if (path === '/git/trees') { treeRequest = data; return ok({ sha: tree }); }
    if (path.startsWith('/git/ref/heads/skill-manager/')) return branch ? ok({ object: { sha: head } }) : ok({}, 404);
    if (path === '/git/ref/heads/main') return ok({ object: { sha: stale ? 'e'.repeat(40) : base } });
    if (path === '/git/commits') { commits++; return ok({ sha: head }); }
    if (path === '/git/refs') { refs++; branch = data.ref.slice('refs/heads/'.length); return ok({}); }
    if (path.startsWith('/pulls?')) return ok(pull ? [{ number: 42, html_url: 'https://github.com/egawilldoit/skills/pull/42', head: { sha: head }, base: { ref: 'main' } }] : []);
    if (path === '/pulls') { pulls++; pull = true; return ok({}); }
    throw new Error(`unexpected ${path}`);
  };
  return { transport, counts: () => ({ commits, refs, pulls }), blob: () => blobRequest, tree: () => treeRequest };
}
test('creates one atomic branch and returns the same PR on retry', async () => {
  const f = fake(); const github = new SourceGithub('secret-token', f.transport);
  const result = await github.submit(proposal);
  assert.deepEqual(result, { url: 'https://github.com/egawilldoit/skills/pull/42', head, number: 42 });
  assert.deepEqual(await github.submit(proposal), result);
  assert.deepEqual(f.counts(), { commits: 1, refs: 1, pulls: 1 });
});
test('stale source main is rejected before branch creation', async () => {
  const f = fake({ stale: true });
  await assert.rejects(new SourceGithub('secret-token', f.transport).submit(proposal), e => e.status === 409);
  assert.deepEqual(f.counts(), { commits: 0, refs: 0, pulls: 0 });
});
test('unsafe paths and upstream failures are controlled without leaking secrets', async () => {
  const f = fake({ fail: true }); const github = new SourceGithub('secret-token', f.transport);
  await assert.rejects(github.submit({ ...proposal, changes: { '../other': 'bad' } }), e => e.status === 400);
  await assert.rejects(github.submit(proposal), e => e.status === 503 && !e.message.includes('secret-token'));
});

test('pinned snapshot verifies blob identities and refuses unsafe selected paths', async () => {
  const { createHash } = await import('node:crypto');
  const content = 'hello';
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
  const globals = ['scripts/sync_openai_yaml.py', 'scripts/build_upstream_sources.py', 'upstream-sources.json', 'tests/trigger-cases.json'];
  let unsafe = false, corrupt = false;
  const transport = async url => {
    const path = url.slice('https://api.github.com/repos/egawilldoit/skills'.length);
    let data;
    if (path === `/git/commits/${base}`) data = { tree: { sha: baseTree }, parents: [] };
    else if (path === `/git/trees/${baseTree}?recursive=1`) data = { truncated: false, tree: [...globals, `skills/example-skill/${unsafe ? '../escape.md' : 'SKILL.md'}`].map(path => ({ path, type: 'blob', mode: '100644', sha: blob, size: 5 })) };
    else if (path === `/git/blobs/${blob}`) data = { encoding: 'base64', content: Buffer.from(corrupt ? 'wrong' : content).toString('base64') };
    else throw new Error(`unexpected ${path}`);
    return new Response(JSON.stringify(data));
  };
  const github = new SourceGithub('secret-token', transport);
  const result = await github.snapshot(base, 'example-skill');
  assert.equal(result.files['skills/example-skill/SKILL.md'], content);
  assert.equal(result.selectedFiles[0].path, 'SKILL.md');
  corrupt = true;
  await assert.rejects(github.snapshot(base, 'example-skill'), e => e.status === 502);
  corrupt = false; unsafe = true;
  await assert.rejects(github.snapshot(base, 'example-skill'), e => e.status === 422);
});

test('an already cancelled request cannot reach GitHub', async () => {
  let calls = 0;
  const abort = new AbortController(); abort.abort();
  const github = new SourceGithub('secret-token', async () => { calls++; throw new Error('unexpected'); }, abort.signal);
  await assert.rejects(github.mainSha(), e => e.status === 503);
  assert.equal(calls, 0);
});

test('index snapshot reads only skill frontmatter files and provenance', async () => {
  const { createHash } = await import('node:crypto');
  const content = 'hello';
  const blob = createHash('sha1').update(`blob 5\0`).update(content).digest('hex');
  const paths = ['upstream-sources.json', 'scripts/sync_openai_yaml.py', 'skills/one/SKILL.md', 'skills/one/references/guide.md', 'skills/two/SKILL.md'];
  let blobReads = 0;
  const transport = async url => {
    const path = url.slice('https://api.github.com/repos/egawilldoit/skills'.length);
    if (path === `/git/commits/${base}`) return new Response(JSON.stringify({ tree: { sha: baseTree }, parents: [] }));
    if (path === `/git/trees/${baseTree}?recursive=1`) return new Response(JSON.stringify({ truncated: false, tree: paths.map(path => ({ path, type: 'blob', mode: '100644', sha: blob, size: 5 })) }));
    if (path === `/git/blobs/${blob}`) { blobReads++; return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(content).toString('base64') })); }
    throw new Error('Unexpected request');
  };
  const result = await new SourceGithub('secret-token', transport).snapshot(base, 'source-index-sentinel', true);
  assert.deepEqual(Object.keys(result.files).sort(), ['skills/one/SKILL.md', 'skills/two/SKILL.md', 'upstream-sources.json']);
  assert.equal(blobReads, 3);
});

test('proposal status reports head and test merge separately and never claims publication', async () => {
  const merge = 'e'.repeat(40);
  let merged = false;
  const transport = async url => {
    const path = url.slice('https://api.github.com/repos/egawilldoit/skills'.length);
    if (path === '/pulls/42') return new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/egawilldoit/skills/pull/42', state: merged ? 'closed' : 'open', merged, draft: false, mergeable: true, merge_commit_sha: merge, head: { sha: base, ref: `skill-manager/add-sample-${'c'.repeat(20)}`, repo: { full_name: 'egawilldoit/skills' } }, base: { ref: 'main' } }));
    if (path === `/commits/${base}/check-runs?per_page=100`) return new Response(JSON.stringify({ total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] }));
    if (path === `/commits/${merge}/check-runs?per_page=100`) return new Response(JSON.stringify({ total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] }));
    if (path.endsWith('/status?per_page=100')) return new Response(JSON.stringify({ total_count: 0, state: 'pending' }));
    throw new Error('Unexpected request');
  };
  const github = new SourceGithub('token', transport);
  const open = await github.pullRequestStatus(42);
  assert.equal(open.state, 'open');
  assert.equal(open.headChecks, 'passed');
  assert.equal(open.mergeSha, merge);
  assert.equal(open.mergeChecks, 'pending');
  assert.equal(open.published, false);
  merged = true;
  const done = await github.pullRequestStatus(42);
  assert.equal(done.state, 'merged');
  assert.equal(done.mergeSha, null);
  assert.equal(done.published, false);
});

test('writes resource bytes as blobs and preserves executable modes', async () => {
  const f = fake(); const github = new SourceGithub('secret-token', f.transport);
  const contentBase64 = Buffer.from('#!/bin/sh\ntrue\n').toString('base64');
  await github.submit({ ...proposal, changes: { ...proposal.changes, 'skills/example-skill/scripts/check.sh': { contentBase64, mode: '100755' } } });
  assert.deepEqual(f.blob(), { content: contentBase64, encoding: 'base64' });
  assert.deepEqual(f.tree().tree.find(item => item.path.endsWith('check.sh')), { path: 'skills/example-skill/scripts/check.sh', mode: '100755', type: 'blob', sha: createHash('sha1').update(`blob ${Buffer.from(contentBase64, 'base64').length}\0`).update(Buffer.from(contentBase64, 'base64')).digest('hex') });
  await assert.rejects(github.submit({ ...proposal, changes: { 'skills/example-skill/assets/a': { contentBase64, mode: '100755' } } }), e => e.status === 400);
});
