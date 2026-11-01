import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { sourceManagerRoutes } from '../../../apps/web/server/source-manager/routes.ts';
const subject = '12345678-1234-1234-1234-123456789abc';
const context = (method, headers = {}, body = '{}') => ({ method, pathname: '', query: new URLSearchParams(), params: { name: 'example-skill' }, request: Object.assign(Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]), { method, headers }) });
const makeZip = files => {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [path, content] of files) {
    const name = Buffer.from(path), bytes = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const size = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
};
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

test('authorized ZIP upload reaches the real archive validator and rejects unsafe requests', async () => {
  const old = { token: process.env.EGA_SOURCE_GITHUB_TOKEN, subjects: process.env.EGA_SOURCE_EDITOR_SUBJECTS, origin: process.env.EGA_SOURCE_EDITOR_ORIGIN };
  const oldFetch = globalThis.fetch; let githubCalls = 0;
  globalThis.fetch = async () => { githubCalls++; throw Error('unexpected'); };
  process.env.EGA_SOURCE_GITHUB_TOKEN = 'secret';
  process.env.EGA_SOURCE_EDITOR_SUBJECTS = subject;
  process.env.EGA_SOURCE_EDITOR_ORIGIN = 'https://console.example';
  const reader = { resolveCaller: async () => ({ subject, token: 'session' }) };
  const route = sourceManagerRoutes(reader, fn => fn).find(route => route.id === 'source-skill-upload');
  const headers = { origin: 'https://console.example', 'content-type': 'application/zip' };
  const archive = makeZip([
    ['sample/SKILL.md', '---\nname: sample\ndescription: A valid uploaded skill\n---\n\n# Sample\n'],
    ['sample/references/guide.md', 'Useful guidance.\n'],
  ]);
  try {
    const result = await route.handle(context('POST', headers, archive));
    assert.equal(result.name, 'sample');
    assert.equal(result.description, 'A valid uploaded skill');
    assert.equal(result.resources[0].path, 'references/guide.md');
    await assert.rejects(route.handle(context('POST', { ...headers, origin: 'https://evil.example' }, archive)), error => error.status === 403);
    await assert.rejects(route.handle(context('POST', { ...headers, 'content-type': 'application/json' }, archive)), error => error.status === 415);
    await assert.rejects(route.handle(context('POST', headers, Buffer.from('not a zip'))), error => error.code === 'E_UPLOAD_ARCHIVE');
    await assert.rejects(route.handle(context('POST', { ...headers, 'content-length': '2500001' }, archive)), error => error.status === 413);
    assert.equal(githubCalls, 0);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries({ EGA_SOURCE_GITHUB_TOKEN: old.token, EGA_SOURCE_EDITOR_SUBJECTS: old.subjects, EGA_SOURCE_EDITOR_ORIGIN: old.origin })) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
