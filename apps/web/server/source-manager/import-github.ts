import { createHash } from 'node:crypto';
import { MAX_FILE_BYTES, MAX_SKILL_BYTES, MAX_SKILL_FILES, validateSourceFiles, type SourceFile } from './paths.ts';
import { SourceGuardError } from './guard.ts';

export interface ImportLocation { owner: string; repo: string; commit: string; directory: string }
export interface ImportedSource { location: ImportLocation; files: readonly SourceFile[]; license: { path: string; text: string; sha: string } }
type Transport = (url: string, init: RequestInit) => Promise<Response>;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub returned an invalid import response.');
  return value as Record<string, unknown>;
};

/** Caller input selects repository components, never a URL or a mutable revision. */
export function validateImportLocation(value: unknown): ImportLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceGuardError(400, 'E_IMPORT_LOCATION', 'Import location is invalid.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'commit,directory,owner,repo' || typeof input.owner !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(input.owner) || typeof input.repo !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}$/.test(input.repo) || input.repo.endsWith('.git') || typeof input.commit !== 'string' || !/^[0-9a-f]{40}$/.test(input.commit) || typeof input.directory !== 'string' || input.directory.length > 180 || !input.directory.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && part !== '.' && part !== '..')) throw new SourceGuardError(400, 'E_IMPORT_LOCATION', 'Use a GitHub owner, repository, full commit SHA, and safe skill directory.');
  return { owner: input.owner, repo: input.repo, commit: input.commit, directory: input.directory };
}

/** Read a pinned public repository through the GitHub API, without sending the source token. */
export async function readGithubImport(raw: unknown, transport: Transport = fetch, signal?: AbortSignal): Promise<ImportedSource> {
  const location = validateImportLocation(raw);
  const root = `https://api.github.com/repos/${location.owner}/${location.repo}`;
  const deadline = AbortSignal.timeout(30_000);
  const request = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await transport(root + path, { redirect: 'error', headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) });
    } catch { throw new SourceGuardError(503, 'E_IMPORT_UPSTREAM', 'GitHub import could not be reached.'); }
    if (!response.ok) throw new SourceGuardError(response.status === 404 ? 404 : 503, 'E_IMPORT_UPSTREAM', `GitHub import failed (${response.status}).`);
    const length = response.headers.get('content-length');
    if (length && Number(length) > 2_000_000) throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub import response is too large.');
    const reader = response.body?.getReader();
    if (!reader) throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub import response is empty.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) { await reader.cancel(); throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub import response is too large.'); }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) { if (error instanceof SourceGuardError) throw error; throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub import response is invalid.'); }
  };
  const commit = object(await request(`/git/commits/${location.commit}`));
  const treeSha = object(commit.tree).sha;
  if (commit.sha !== location.commit || typeof treeSha !== 'string' || !/^[0-9a-f]{40}$/.test(treeSha)) throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub import commit identity is invalid.');
  const tree = object(await request(`/git/trees/${treeSha}?recursive=1`));
  if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new SourceGuardError(422, 'E_IMPORT_TREE', 'GitHub import tree is incomplete or too large.');
  const prefix = `${location.directory}/`;
  const selected: { path: string; mode: string; sha: string; size: number }[] = [];
  const licenses: { path: string; mode: string; sha: string; size: number }[] = [];
  for (const rawEntry of tree.tree) {
    const entry = object(rawEntry);
    if (typeof entry.path !== 'string' || typeof entry.type !== 'string') throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub import tree is invalid.');
    if (entry.type === 'tree') continue;
    const selectedPath = entry.path.startsWith(prefix);
    const licensePath = /^(?:LICENSE|LICENCE)(?:\.md|\.txt)?$/i.test(entry.path);
    if (!selectedPath && !licensePath) continue;
    if (entry.type !== 'blob' || typeof entry.mode !== 'string' || typeof entry.sha !== 'string' || !/^[0-9a-f]{40}$/.test(entry.sha) || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) throw new SourceGuardError(422, 'E_IMPORT_TREE', 'Import contains an unsupported file, mode, or size.');
    const item = { path: selectedPath ? entry.path.slice(prefix.length) : entry.path, mode: entry.mode, sha: entry.sha, size: entry.size };
    if (selectedPath) selected.push(item); else licenses.push(item);
  }
  if (!selected.some(file => file.path === 'SKILL.md') || selected.length > MAX_SKILL_FILES || selected.reduce((n, file) => n + file.size, 0) > MAX_SKILL_BYTES || licenses.length !== 1 || licenses[0]!.mode !== '100644') throw new SourceGuardError(422, 'E_IMPORT_TREE', 'Import requires one skill and one unambiguous root license within the size limits.');
  const read = async (item: typeof selected[number]): Promise<SourceFile> => {
    const blob = object(await request(`/git/blobs/${item.sha}`));
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub import blob is invalid.');
    const content = blob.content.replace(/[\r\n]/g, '');
    if (content.length > 340_000 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub import blob is invalid.');
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length !== item.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== item.sha) throw new SourceGuardError(502, 'E_IMPORT_UPSTREAM', 'GitHub import blob identity does not match.');
    return { path: item.path, mode: item.mode, bytes };
  };
  const files: SourceFile[] = [];
  for (let offset = 0; offset < selected.length; offset += 8) files.push(...await Promise.all(selected.slice(offset, offset + 8).map(read)));
  const errors = validateSourceFiles(files);
  if (errors.length) throw new SourceGuardError(422, 'E_IMPORT_TREE', errors.join(' ').slice(0, 500));
  const licenseFile = await read(licenses[0]!);
  let license: string;
  try { license = new TextDecoder('utf-8', { fatal: true }).decode(licenseFile.bytes); if (!license.trim() || license.includes('\0')) throw new Error(); }
  catch { throw new SourceGuardError(422, 'E_IMPORT_LICENSE', 'The pinned license must be nonempty UTF-8 text.'); }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { location, files, license: { path: licenseFile.path, text: license, sha: licenses[0]!.sha } };
}
