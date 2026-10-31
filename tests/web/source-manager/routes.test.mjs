import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { sourceManagerRoutes } from '../../../apps/web/server/source-manager/routes.ts';
const subject = '12345678-1234-1234-1234-123456789abc';
const context = (method, headers = {}, body = '{}') => ({ method, pathname: '', query: new URLSearchParams(), params: { name: 'example-skill' }, request: Object.assign(Readable.from([Buffer.from(body)]), { method, headers }) });
test('registered source routes fail closed before GitHub access', async () => {
  const old = { token: process.env.EGA_SOURCE_GITHUB_TOKEN, subjects: process.env.EGA_SOURCE_EDITOR_SUBJECTS, origin: process.env.EGA_SOURCE_EDITOR_ORIGIN };
  const oldFetch = globalThis.fetch; let githubCalls = 0, identityCalls = 0;
  globalThis.fetch = async () => { githubCalls++; throw Error('unexpected'); };
  const reader = { resolveCaller: async () => { identityCalls++; return { subject, token: 'session' }; } };
  const routes = sourceManagerRoutes(reader, fn => fn);
  try {
    delete process.env.EGA_SOURCE_GITHUB_TOKEN;
    await assert.rejects(routes.find(route => route.id === 'source-skill-detail').handle(context('GET')), e => e.status === 503);
    process.env.EGA_SOURCE_GITHUB_TOKEN = 'secret';
    process.env.EGA_SOURCE_EDITOR_SUBJECTS = subject;
    process.env.EGA_SOURCE_EDITOR_ORIGIN = 'https://console.example';
    await assert.rejects(routes.find(route => route.id === 'source-proposal-preview').handle(context('POST', { origin: 'https://evil.example', 'content-type': 'application/json' })), e => e.status === 403);
    await assert.rejects(routes.find(route => route.id === 'source-proposal-submit').handle(context('POST', { origin: 'https://evil.example', 'content-type': 'application/json' })), e => e.status === 403);
    await assert.rejects(routes.find(route => route.id === 'source-github-import').handle(context('POST', { origin: 'https://evil.example', 'content-type': 'application/json' })), e => e.status === 403);
    assert.equal(identityCalls, 0);
    assert.equal(githubCalls, 0);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries({ EGA_SOURCE_GITHUB_TOKEN: old.token, EGA_SOURCE_EDITOR_SUBJECTS: old.subjects, EGA_SOURCE_EDITOR_ORIGIN: old.origin })) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
