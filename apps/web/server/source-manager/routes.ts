import type { ApiRoute, ApiRouteContext } from '../../server.mts';
import type { ControlPlaneReader } from '../supabase-read.ts';
import { authorizeEditor, loadEditorConfig, MAX_UPLOAD_BYTES, readEditorBody, readEditorJson, SourceGuardError } from './guard.ts';
import type { EditorRequestPolicy } from './guard.ts';
import { SourceGithub } from './github.ts';
import { validSkillName } from './paths.ts';
import { previewProposal, submitProposal } from './service.ts';
import { buildSourceIndex } from './index.ts';
import { readGithubImport } from './import-github.ts';
import { prepareSkillArchive } from './archive.ts';
import { readZipEntries } from './zip.ts';

export function sourceManagerRoutes(reader: ControlPlaneReader, bound: (handler: (context: ApiRouteContext) => Promise<unknown>) => (context: ApiRouteContext) => Promise<unknown>): ApiRoute[] {
  const authenticated = async (context: ApiRouteContext, method: 'GET' | 'POST', policy?: EditorRequestPolicy) => {
    const config = loadEditorConfig(process.env);
    await authorizeEditor(context.request, method, config, reader, context.signal, policy);
    return new SourceGithub(config.token, fetch, context.signal);
  };
  return [
    {
      id: 'source-editor-capability', path: '/source-editor', methods: ['GET'],
      handle: bound(async context => {
        await authenticated(context, 'GET');
        return { enabled: true };
      }),
    },
    {
      id: 'source-skill-index', path: '/source-skills', methods: ['GET'],
      handle: bound(async context => {
        const github = await authenticated(context, 'GET');
        const offsetValue = context.query.get('offset') ?? '0';
        const limitValue = context.query.get('limit') ?? '30';
        if (!/^\d{1,4}$/.test(offsetValue) || !/^\d{1,3}$/.test(limitValue)) throw new SourceGuardError(400, 'E_SOURCE_INPUT_INVALID', 'Invalid page bounds.');
        const offset = Number(offsetValue), limit = Number(limitValue);
        if (limit < 1 || limit > 100) throw new SourceGuardError(400, 'E_SOURCE_INPUT_INVALID', 'Invalid page bounds.');
        const sha = await github.mainSha();
        const snapshot = await github.snapshot(sha, 'source-index-sentinel', true);
        const yaml = await import('yaml');
        const all = buildSourceIndex(snapshot, text => yaml.parse(text, { uniqueKeys: true, maxAliasCount: 0 }) as unknown);
        return { source: 'egawilldoit/skills', published: false, sha, offset, limit, total: all.length, items: all.slice(offset, offset + limit) };
      }),
    },
    {
      id: 'source-skill-detail', path: '/source-skills/:name', methods: ['GET'],
      handle: bound(async context => {
        const github = await authenticated(context, 'GET');
        const name = context.params['name'];
        if (!name || !validSkillName(name, 'ega-skills')) throw new SourceGuardError(400, 'E_SOURCE_INPUT_INVALID', 'Invalid skill name.');
        const sha = await github.mainSha();
        const snapshot = await github.snapshot(sha, name);
        if (!snapshot.files[`skills/${name}/SKILL.md`]) throw new SourceGuardError(404, 'E_SOURCE_NOT_FOUND', 'Source skill was not found.');
        const registry: unknown = JSON.parse(snapshot.files['upstream-sources.json'] ?? 'null');
        return { source: 'egawilldoit/skills', published: false, sha, name, registry, files: snapshot.selectedFiles.map(file => ({ path: file.path, mode: file.mode, contentBase64: Buffer.from(file.bytes).toString('base64') })) };
      }),
    },
    {
      id: 'source-proposal-preview', path: '/skill-proposals/preview', methods: ['POST'],
      handle: bound(async context => {
        const github = await authenticated(context, 'POST');
        const yaml = await import('yaml');
        return await previewProposal(github, await readEditorJson(context.request), { read: location => readGithubImport(location, fetch, context.signal), parseYaml: text => yaml.parse(text, { uniqueKeys: true, maxAliasCount: 0 }) as unknown });
      }),
    },
    {
      id: 'source-github-import', path: '/skill-imports/github', methods: ['POST'],
      handle: bound(async context => {
        await authenticated(context, 'POST');
        const imported = await readGithubImport(await readEditorJson(context.request), fetch, context.signal);
        return { location: imported.location, license: imported.license, files: imported.files.map(file => ({ path: file.path, mode: file.mode, contentBase64: Buffer.from(file.bytes).toString('base64') })) };
      }),
    },
    {
      id: 'source-skill-upload', path: '/skill-uploads/zip', methods: ['POST'],
      handle: bound(async context => {
        await authenticated(context, 'POST', { contentTypes: ['application/zip', 'application/x-zip-compressed'], maxBodyBytes: MAX_UPLOAD_BYTES });
        const archive = await readEditorBody(context.request, MAX_UPLOAD_BYTES);
        const yaml = await import('yaml');
        return await prepareSkillArchive(readZipEntries(archive), text => yaml.parse(text, { uniqueKeys: true, maxAliasCount: 0 }) as unknown);
      }),
    },
    {
      id: 'source-proposal-submit', path: '/skill-proposals', methods: ['POST'],
      handle: bound(async context => {
        const github = await authenticated(context, 'POST');
        const yaml = await import('yaml');
        return await submitProposal(github, await readEditorJson(context.request), { read: location => readGithubImport(location, fetch, context.signal), parseYaml: text => yaml.parse(text, { uniqueKeys: true, maxAliasCount: 0 }) as unknown });
      }),
    },
    {
      id: 'source-proposal-status', path: '/skill-proposals/:id', methods: ['GET'],
      handle: bound(async context => {
        const github = await authenticated(context, 'GET');
        const id = context.params['id'];
        if (!id || !/^[1-9][0-9]{0,8}$/.test(id)) throw new SourceGuardError(400, 'E_SOURCE_INPUT_INVALID', 'Invalid proposal number.');
        return await github.pullRequestStatus(Number(id));
      }),
    },
  ];
}
