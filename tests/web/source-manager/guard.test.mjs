import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { loadEditorConfig, authorizeEditor, readEditorJson } from '../../../apps/web/server/source-manager/guard.ts';
const subject = '12345678-1234-1234-1234-123456789abc';
const env = { EGA_SOURCE_GITHUB_TOKEN: 'token', EGA_SOURCE_EDITOR_SUBJECTS: subject, EGA_SOURCE_EDITOR_ORIGIN: 'https://console.example' };
const req = (headers = {}, method = 'POST', body = '{}') => Object.assign(Readable.from([Buffer.from(body)]), { method, headers });
const headers = { origin: 'https://console.example', 'content-type': 'application/json' };
test('editor configuration fails closed', () => {
  assert.throws(() => loadEditorConfig({}), e => e.status === 503);
  assert.throws(() => loadEditorConfig({ ...env, EGA_SOURCE_EDITOR_ORIGIN: 'https://console.example/path' }), e => e.status === 503);
  assert.throws(() => loadEditorConfig({ ...env, EGA_SOURCE_EDITOR_SUBJECTS: 'owner' }), e => e.status === 503);
});
test('requires verified allowlisted subject and rejects origin and content-type before session lookup', async () => {
  const config = loadEditorConfig(env); let calls = 0;
  const reader = { resolveCaller: async request => { calls++; assert.equal(request.method, 'GET'); return { subject, token: 'session' }; } };
  assert.equal(await authorizeEditor(req(headers), 'POST', config, reader), subject);
  await assert.rejects(authorizeEditor(req({ ...headers, origin: 'https://evil.example' }), 'POST', config, reader), e => e.status === 403);
  await assert.rejects(authorizeEditor(req({ ...headers, 'content-type': 'text/plain' }), 'POST', config, reader), e => e.status === 415);
  assert.equal(calls, 1);
  await assert.rejects(authorizeEditor(req(headers), 'POST', config, { resolveCaller: async () => ({ subject: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', token: 'session' }) }), e => e.status === 403);
  await assert.rejects(authorizeEditor(req(headers), 'POST', config, { resolveCaller: async () => { throw new Error('rejected'); } }), /rejected/);
});
test('JSON body parser enforces streaming byte limit and valid UTF-8 JSON', async () => {
  assert.deepEqual(await readEditorJson(req(headers, 'POST', '{"ok":true}')), { ok: true });
  await assert.rejects(readEditorJson(req(headers, 'POST', '{')), e => e.status === 400);
  const encodedResource = Buffer.alloc(900_000).toString('base64');
  assert.equal((await readEditorJson(req(headers, 'POST', JSON.stringify({ encodedResource })))).encodedResource, encodedResource);
  await assert.rejects(readEditorJson(req(headers, 'POST', 'x'.repeat(2_500_001))), e => e.status === 413);
});
