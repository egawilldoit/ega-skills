import { createHash } from 'node:crypto';
import type { SourceChange } from './planner.ts';
import { MAX_FILE_BYTES, MAX_SKILL_BYTES, MAX_SKILL_FILES, validSkillName, validSkillPath } from './paths.ts';

const ROOT = 'https://api.github.com/repos/egawilldoit/skills';
const SHA = /^[0-9a-f]{40}$/;
const MAX_RESPONSE = 2_000_000;
const MAX_CHANGES = 110;
const MAX_BYTES = 2_000_000;
const GLOBAL_FILES = new Set(['scripts/sync_openai_yaml.py', 'scripts/build_upstream_sources.py', 'upstream-sources.json', 'tests/trigger-cases.json']);

type Transport = (input: string, init: RequestInit) => Promise<Response>;
export class SourceGithubError extends Error {
  readonly status: number;
  readonly code = 'E_SOURCE_GITHUB';
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface SourceSubmission {
  operation: 'add' | 'update' | 'remove';
  name: string;
  baseSha: string;
  changes: Readonly<Record<string, SourceChange>>;
  provenance: 'copied' | 'adapted' | 'original';
  validationSummary: string;
}
export interface SourcePullRequest { url: string; head: string; number: number }
export interface SourcePullRequestStatus extends SourcePullRequest {
  state: 'open' | 'draft' | 'closed' | 'merged';
  headChecks: 'pending' | 'passed' | 'failed';
  mergeSha: string | null;
  mergeChecks: 'pending' | 'passed' | 'failed';
  published: false;
}
export interface PinnedSourceSnapshot {
  sha: string;
  files: Readonly<Record<string, string>>;
  selectedFiles: readonly { path: string; mode: string; bytes: Uint8Array }[];
}


function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceGithubError(502, 'GitHub returned an invalid response.');
  return value as Record<string, unknown>;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value)) throw new SourceGithubError(502, 'GitHub returned an invalid object identity.');
  return value;
}
function assertChanges(input: SourceSubmission): [string, SourceChange][] {
  if (!validSkillName(input.name, 'ega-skills') || !SHA.test(input.baseSha) || !['add', 'update', 'remove'].includes(input.operation) || !['copied', 'adapted', 'original'].includes(input.provenance)) throw new SourceGithubError(400, 'Invalid proposal identity.');
  const entries = Object.entries(input.changes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!entries.length || entries.length > MAX_CHANGES) throw new SourceGithubError(400, 'Proposal has an invalid number of changed files.');
  let bytes = 0;
  for (const [path, content] of entries) {
    const prefix = `skills/${input.name}/`;
    if (!GLOBAL_FILES.has(path) && !(path.startsWith(prefix) && validSkillPath(path.slice(prefix.length)))) throw new SourceGithubError(400, 'Proposal contains an unsupported path.');
    if (content !== null && typeof content !== 'string') {
      const relative = path.slice(prefix.length);
      if (!path.startsWith(prefix) || !/^(?:references|scripts|assets)\//.test(relative) || !content || Object.keys(content).sort().join(',') !== 'contentBase64,mode' || typeof content.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.contentBase64) || Buffer.from(content.contentBase64, 'base64').toString('base64') !== content.contentBase64 || !['100644', '100755'].includes(content.mode) || (content.mode === '100755' && !relative.startsWith('scripts/'))) throw new SourceGithubError(400, 'Proposal contains invalid resource content.');
      bytes += Buffer.from(content.contentBase64, 'base64').length;
    } else bytes += Buffer.byteLength(content ?? '', 'utf8');
  }
  if (bytes > MAX_BYTES) throw new SourceGithubError(400, 'Proposal is too large.');
  return entries;
}

/** Fixed-target GitHub adapter. Call only after authorization and server-side replanning. */
export class SourceGithub {
  private readonly token: string;
  private readonly transport: Transport;
  private readonly signal: AbortSignal | undefined;
  constructor(token: string, transport: Transport = fetch, signal?: AbortSignal) {
    this.token = token;
    this.transport = transport;
    this.signal = signal;
    if (!token || /[\r\n]/.test(token)) throw new SourceGithubError(503, 'Source editor is not configured.');
  }
  private async request(path: string, method = 'GET', body?: unknown, allowNotFound = false, signal?: AbortSignal): Promise<unknown> {
    if (this.signal?.aborted || signal?.aborted) throw new SourceGithubError(503, 'GitHub request was cancelled.');
    let response: Response;
    try {
      response = await this.transport(ROOT + path, {
        method,
        redirect: 'error',
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.token}`, 'x-github-api-version': '2022-11-28', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([...(this.signal ? [this.signal] : []), ...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
      });
    } catch { throw new SourceGithubError(503, 'GitHub could not be reached.'); }
    if (response.status === 404 && allowNotFound) return null;
    if (!response.ok) {
      const status = response.status === 409 || response.status === 422 ? 409 : response.status === 401 || response.status === 403 ? 503 : response.status === 429 ? 503 : 502;
      throw new SourceGithubError(status, `GitHub request failed (${response.status}).`);
    }
    const length = response.headers.get('content-length');
    if (length && Number(length) > MAX_RESPONSE) throw new SourceGithubError(502, 'GitHub response exceeded the size limit.');
    const reader = response.body?.getReader();
    if (!reader) throw new SourceGithubError(502, 'GitHub returned an empty response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw new SourceGithubError(502, 'GitHub response exceeded the size limit.'); }
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof SourceGithubError) throw error;
      throw new SourceGithubError(502, 'GitHub response could not be read.');
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new SourceGithubError(502, 'GitHub returned invalid JSON.'); }
  }
  async mainSha(): Promise<string> {
    return sha(object(object(await this.request('/git/ref/heads/main')).object).sha);
  }
  /** Read only catalog metadata, Markdown and the selected skill, all from one commit. */
  async snapshot(baseSha: string, selectedName: string, indexOnly = false): Promise<PinnedSourceSnapshot> {
    if (!SHA.test(baseSha) || !validSkillName(selectedName, 'ega-skills')) throw new SourceGithubError(400, 'Invalid source snapshot identity.');
    const commit = await this.commit(baseSha);
    const response = object(await this.request(`/git/trees/${commit.tree}?recursive=1`));
    if (response.truncated !== false || !Array.isArray(response.tree) || response.tree.length > 10000) throw new SourceGithubError(502, 'Source tree is incomplete or too large.');
    const selectedPrefix = `skills/${selectedName}/`;
    const wanted: { path: string; mode: string; sha: string; size: number }[] = [];
    const seen = new Set<string>();
    for (const raw of response.tree) {
      const entry = object(raw);
      if (typeof entry.path !== 'string' || typeof entry.type !== 'string' || typeof entry.mode !== 'string') throw new SourceGithubError(502, 'GitHub returned an invalid source tree.');
      const path = entry.path;
      if (entry.type === 'tree') continue;
      const skillFile = path.startsWith('skills/') && /^skills\/[^/]+\/.+/.test(path);
      const catalogText = /^skills\/[^/]+\/SKILL\.md$/.test(path);
      const global = indexOnly ? path === 'upstream-sources.json' : GLOBAL_FILES.has(path);
      if (indexOnly ? !catalogText && !global : !skillFile && !global) continue;
      const relative = skillFile ? path.slice(path.indexOf('/', 'skills/'.length) + 1) : '';
      if (entry.type !== 'blob' || (entry.mode !== '100644' && !(entry.mode === '100755' && relative.startsWith('scripts/')))) throw new SourceGithubError(422, 'Source tree contains an unsupported file mode.');
      if (skillFile && !validSkillPath(relative)) throw new SourceGithubError(422, 'Source skill contains an unsupported path.');
      const key = path.normalize('NFC').toLowerCase();
      if (seen.has(key)) throw new SourceGithubError(422, 'Source tree contains colliding paths.');
      seen.add(key);
      if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) throw new SourceGithubError(422, 'Source file exceeds the size limit.');
      wanted.push({ path, mode: entry.mode, sha: sha(entry.sha), size: entry.size });
    }
    if (wanted.length > 500) throw new SourceGithubError(422, 'Source snapshot requires too many files.');
    const selected = wanted.filter(entry => entry.path.startsWith(selectedPrefix));
    if (selected.length > MAX_SKILL_FILES || selected.reduce((sum, entry) => sum + entry.size, 0) > MAX_SKILL_BYTES || wanted.reduce((sum, entry) => sum + entry.size, 0) > 6_000_000) throw new SourceGithubError(422, 'Source snapshot exceeds its size limit.');
    for (const path of indexOnly ? ['upstream-sources.json'] : GLOBAL_FILES) if (!wanted.some(entry => entry.path === path)) throw new SourceGithubError(502, 'Required source metadata is missing.');
    const files: Record<string, string> = Object.create(null) as Record<string, string>;
    const selectedFiles: { path: string; mode: string; bytes: Uint8Array }[] = [];
    const deadline = AbortSignal.timeout(30_000);
    const readEntry = async (entry: typeof wanted[number]): Promise<void> => {
      const blob = object(await this.request(`/git/blobs/${entry.sha}`, 'GET', undefined, false, deadline));
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > 400_000 || blob.content.replace(/[\r\n]/g, '').length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(blob.content.replace(/[\r\n]/g, ''))) throw new SourceGithubError(502, 'GitHub returned an invalid source blob.');
      const bytes = Buffer.from(blob.content.replace(/[\r\n]/g, ''), 'base64');
      const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (bytes.length !== entry.size || actual !== entry.sha) throw new SourceGithubError(502, 'Source blob does not match its tree identity.');
      if (entry.path.startsWith(selectedPrefix)) selectedFiles.push({ path: entry.path.slice(selectedPrefix.length), mode: entry.mode, bytes });
      const text = /\.(?:md|txt|ya?ml|json|py|sh|js|ts)$/i.test(entry.path);
      if (text || GLOBAL_FILES.has(entry.path)) {
        try {
          files[entry.path] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (files[entry.path]!.includes('\0')) throw new Error();
        } catch { throw new SourceGithubError(422, 'Source text contains invalid UTF-8 or NUL.'); }
      } else files[entry.path] = ''; // Retain binary file identity for deletion; bytes are returned separately.
    };
    for (let offset = 0; offset < wanted.length; offset += 8) {
      await Promise.all(wanted.slice(offset, offset + 8).map(readEntry));
    }
    selectedFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { sha: baseSha, files, selectedFiles };
  }
  private async ref(branch: string): Promise<string | null> {
    const value = await this.request(`/git/ref/heads/${branch}`, 'GET', undefined, true);
    return value === null ? null : sha(object(object(value).object).sha);
  }
  private async commit(commitSha: string): Promise<{ tree: string; parents: string[] }> {
    const value = object(await this.request(`/git/commits/${commitSha}`));
    if (!Array.isArray(value.parents)) throw new SourceGithubError(502, 'GitHub returned invalid commit parents.');
    return { tree: sha(object(value.tree).sha), parents: value.parents.map(parent => sha(object(parent).sha)) };
  }
  private async findPr(branch: string, expectedHead: string): Promise<SourcePullRequest | null> {
    const value = await this.request(`/pulls?state=open&head=egawilldoit%3A${encodeURIComponent(branch)}&base=main&per_page=10`);
    if (!Array.isArray(value) || value.length > 1) throw new SourceGithubError(409, 'Existing proposal branch is ambiguous.');
    if (!value.length) return null;
    const pr = object(value[0]);
    if (object(pr.head).sha !== expectedHead || object(pr.base).ref !== 'main' || !Number.isSafeInteger(pr.number) || typeof pr.html_url !== 'string' || pr.html_url !== `https://github.com/egawilldoit/skills/pull/${pr.number}`) throw new SourceGithubError(409, 'Existing proposal does not match this request.');
    return { url: pr.html_url, head: expectedHead, number: pr.number as number };
  }
  private async checks(commitSha: string): Promise<'pending' | 'passed' | 'failed'> {
    const [runsRaw, statusRaw] = await Promise.all([
      this.request(`/commits/${commitSha}/check-runs?per_page=100`),
      this.request(`/commits/${commitSha}/status?per_page=100`),
    ]);
    const runs = object(runsRaw), status = object(statusRaw);
    if (!Number.isSafeInteger(runs.total_count) || (runs.total_count as number) < 0 || (runs.total_count as number) > 100 || !Array.isArray(runs.check_runs) || runs.check_runs.length !== runs.total_count || !Number.isSafeInteger(status.total_count) || (status.total_count as number) < 0 || (status.total_count as number) > 100 || !['success', 'failure', 'pending', 'error'].includes(String(status.state))) throw new SourceGithubError(502, 'GitHub returned incomplete check status.');
    if (status.state === 'failure' || status.state === 'error') return 'failed';
    let pending = (status.total_count as number) > 0 && status.state === 'pending';
    for (const raw of runs.check_runs) {
      const run = object(raw);
      if (typeof run.status !== 'string') throw new SourceGithubError(502, 'GitHub returned invalid check status.');
      if (run.status !== 'completed') { pending = true; continue; }
      if (!['success', 'neutral', 'skipped'].includes(String(run.conclusion))) return 'failed';
    }
    if (pending || ((runs.total_count as number) === 0 && (status.total_count as number) === 0)) return 'pending';
    return 'passed';
  }
  async pullRequestStatus(number: number): Promise<SourcePullRequestStatus> {
    if (!Number.isSafeInteger(number) || number < 1 || number > 999_999_999) throw new SourceGithubError(400, 'Invalid proposal number.');
    const pr = object(await this.request(`/pulls/${number}`));
    const head = object(pr.head), base = object(pr.base), repo = object(head.repo);
    const url = `https://github.com/egawilldoit/skills/pull/${number}`;
    if (pr.number !== number || pr.html_url !== url || base.ref !== 'main' || repo.full_name !== 'egawilldoit/skills' || typeof head.ref !== 'string' || !/^skill-manager\/(?:add|update|remove)-[a-z0-9-]+-[0-9a-f]{20}$/.test(head.ref) || typeof pr.draft !== 'boolean' || !['open', 'closed'].includes(String(pr.state)) || typeof pr.merged !== 'boolean') throw new SourceGithubError(404, 'Source proposal was not found.');
    const headSha = sha(head.sha);
    // GitHub's merge_commit_sha stops identifying the test merge after merge.
    const mergeSha = !pr.merged && pr.mergeable === true && typeof pr.merge_commit_sha === 'string' ? sha(pr.merge_commit_sha) : null;
    const [headChecks, mergeChecks] = await Promise.all([this.checks(headSha), mergeSha ? this.checks(mergeSha) : Promise.resolve('pending' as const)]);
    return { number, url, head: headSha, state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open', headChecks, mergeSha, mergeChecks, published: false };
  }
  async submit(input: SourceSubmission): Promise<SourcePullRequest> {
    const entries = assertChanges(input);
    const digest = createHash('sha256').update(JSON.stringify([input.baseSha, input.operation, input.name, input.provenance, entries])).digest('hex');
    const branch = `skill-manager/${input.operation}-${input.name.slice(0, 40)}-${digest.slice(0, 20)}`;
    const base = await this.commit(input.baseSha);
    const treeEntries = await Promise.all(entries.map(async ([path, content]) => {
      if (content !== null && typeof content !== 'string') {
        const blob = sha(object(await this.request('/git/blobs', 'POST', { content: content.contentBase64, encoding: 'base64' })).sha);
        const bytes = Buffer.from(content.contentBase64, 'base64');
        const expected = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (blob !== expected) throw new SourceGithubError(502, 'GitHub returned an unexpected blob identity.');
        return { path, mode: content.mode, type: 'blob', sha: blob };
      }
      return { path, mode: '100644', type: 'blob', ...(content === null ? { sha: null } : { content }) };
    }));
    const tree = sha(object(await this.request('/git/trees', 'POST', { base_tree: base.tree, tree: treeEntries })).sha);
    let head = await this.ref(branch);
    if (head !== null) {
      const existing = await this.commit(head);
      if (existing.tree !== tree || existing.parents.length !== 1 || existing.parents[0] !== input.baseSha) throw new SourceGithubError(409, 'Existing proposal branch does not match this request.');
      const pr = await this.findPr(branch, head);
      if (pr) return pr;
    } else {
      if (await this.mainSha() !== input.baseSha) throw new SourceGithubError(409, 'Source main changed. Refresh and compare again.');
      head = sha(object(await this.request('/git/commits', 'POST', { message: `${input.operation}: ${input.name}`, tree, parents: [input.baseSha] })).sha);
      if (await this.mainSha() !== input.baseSha) throw new SourceGithubError(409, 'Source main changed. Refresh and compare again.');
      try { await this.request('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: head }); }
      catch (error) {
        if (!(error instanceof SourceGithubError) || error.status !== 409) throw error;
        const raced = await this.ref(branch);
        if (!raced) throw error;
        const existing = await this.commit(raced);
        if (existing.tree !== tree || existing.parents.length !== 1 || existing.parents[0] !== input.baseSha) throw new SourceGithubError(409, 'Existing proposal branch does not match this request.');
        head = raced;
      }
    }
    const existingPr = await this.findPr(branch, head);
    if (existingPr) return existingPr;
    const body = `Source proposal: ${input.operation} ${input.name}\n\nBase: ${input.baseSha}\nProvenance: ${input.provenance}\nValidation: ${input.validationSummary.slice(0, 500)}\nRisk: Catalog routing and any imported content require source CI and human review.\n\nChanged files:\n${entries.map(([path]) => `- ${path}`).join('\n')}\n\nThis proposal is not published. Source CI and review are required; published releases remain unchanged.`;
    try {
      await this.request('/pulls', 'POST', { title: `${input.operation}: ${input.name}`, head: branch, base: 'main', body });
    } catch (error) {
      if (!(error instanceof SourceGithubError) || error.status !== 409) throw error;
    }
    const pr = await this.findPr(branch, head);
    if (!pr) throw new SourceGithubError(502, 'GitHub did not confirm the source pull request.');
    return pr;
  }
}
