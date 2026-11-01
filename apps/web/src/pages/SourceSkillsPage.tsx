import { useEffect, useState, type ReactNode } from 'react';
import { parse } from 'yaml';
import { useApiClient } from '../api/useApiClient';
import { toApiError } from '../api/client';
import type { CatalogPage } from '../api/contracts';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { sourcePublishedLinks } from './sourcePublishedLinks';
import { sourceInterfaceDefaults, sourceSkillSlug } from './sourceInterfaceDefaults';

type Item = { name: string; description: string; provenance: 'copied' | 'adapted' | 'original' };
type Index = { sha: string; total: number; items: Item[] };
type Detail = { sha: string; files: { path: string; contentBase64: string }[] };
type Preview = { baseSha: string; operation: string; name: string; provenance: string; digest: string; changes: { path: string; before: string | null; after: string | null; binary?: boolean; mode?: string }[]; errors: string[]; warnings: string[] };
type Proposal = { number: number; url: string; head: string };
type Status = Proposal & { state: string; headChecks: string; mergeSha: string | null; mergeChecks: string; published: false };
type ImportResult = { location: { owner: string; repo: string; commit: string; directory: string }; license: { path: string; text: string; sha: string }; files: { path: string; mode: string; contentBase64: string }[] };
type UploadResult = { name: string; description: string; body: string; resources: { path: string; mode: string; contentBase64: string }[] };
type Mode = 'list' | 'add' | 'update' | 'remove';
type CaseField = 'direct' | 'indirect' | 'incomplete' | 'negative' | 'collision' | 'edge';
type TagField = 'domains' | 'platforms' | 'frameworks' | 'aliases';
const tagFields: TagField[] = ['domains', 'platforms', 'frameworks', 'aliases'];
const emptyTags = (): Record<TagField, string> => ({ domains: '', platforms: '', frameworks: '', aliases: '' });
const caseLabels: Record<CaseField, string> = { direct: 'Direct request', indirect: 'Indirect request', incomplete: 'Incomplete request', negative: 'Request for another skill', collision: 'Similar request for another skill', edge: 'Edge case request' };
const emptyCases = (): Record<CaseField, string> => ({ direct: '', indirect: '', incomplete: '', negative: '', collision: '', edge: '' });

const message = (cause: unknown): string => cause instanceof Error ? cause.message : toApiError(cause).message;
const decodeIndex = (value: unknown): Index => {
  const v = value as Index;
  if (!v || !/^[0-9a-f]{40}$/.test(v.sha) || !Number.isSafeInteger(v.total) || !Array.isArray(v.items) || v.items.some(item => typeof item.name !== 'string' || typeof item.description !== 'string' || !['original', 'adapted', 'copied'].includes(item.provenance))) throw new Error('Invalid source index');
  return v;
};
const decodeDetail = (value: unknown): Detail => {
  const v = value as Detail;
  if (!v || !/^[0-9a-f]{40}$/.test(v.sha) || !Array.isArray(v.files) || v.files.some(file => !file || typeof file.path !== 'string' || typeof file.contentBase64 !== 'string')) throw new Error('Invalid source detail');
  return v;
};
const decodePreview = (value: unknown): Preview => {
  const v = value as Preview;
  if (!v || !/^[0-9a-f]{40}$/.test(v.baseSha) || !/^[0-9a-f]{64}$/.test(v.digest) || typeof v.operation !== 'string' || typeof v.name !== 'string' || typeof v.provenance !== 'string' || !Array.isArray(v.errors) || v.errors.some(x => typeof x !== 'string') || !Array.isArray(v.warnings) || v.warnings.some(x => typeof x !== 'string') || !Array.isArray(v.changes) || v.changes.some(c => !c || typeof c.path !== 'string' || (c.before !== null && typeof c.before !== 'string') || (c.after !== null && typeof c.after !== 'string') || (c.mode !== undefined && !['100644', '100755'].includes(c.mode)))) throw new Error('Invalid source preview');
  return v;
};
const decodeProposal = (value: unknown): Proposal => {
  const v = value as Proposal;
  if (!v || !Number.isSafeInteger(v.number) || v.number < 1 || v.url !== `https://github.com/egawilldoit/skills/pull/${v.number}` || !/^[0-9a-f]{40}$/.test(v.head)) throw new Error('Invalid source proposal');
  return v;
};
const decodeStatus = (value: unknown): Status => {
  decodeProposal(value);
  const v = value as Status;
  if (!['open', 'draft', 'closed', 'merged'].includes(v.state) || !['pending', 'passed', 'failed'].includes(v.headChecks) || !['pending', 'passed', 'failed'].includes(v.mergeChecks) || (v.mergeSha !== null && !/^[0-9a-f]{40}$/.test(v.mergeSha)) || v.published !== false) throw new Error('Invalid source proposal status');
  return v;
};
const decodeUpload = (value: unknown): UploadResult => {
  const v = value as UploadResult;
  if (!v || typeof v.name !== 'string' || typeof v.description !== 'string' || typeof v.body !== 'string' || !Array.isArray(v.resources) || v.resources.some(file => !file || typeof file.path !== 'string' || !['100644', '100755'].includes(file.mode) || typeof file.contentBase64 !== 'string')) throw new Error('Invalid source archive response');
  return v;
};
const textFile = (base64: string): string => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));

export function SourceSkillsPage(): ReactNode {
  const client = useApiClient();
  const { role } = useWorkspace();
  const [index, setIndex] = useState<Index | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<Mode>('list');
  const [name, setName] = useState('');
  const [nameLabel, setNameLabel] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [triggers, setTriggers] = useState('');
  const [antiTriggers, setAntiTriggers] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [editProvenance, setEditProvenance] = useState<Item['provenance']>('original');
  const [references, setReferences] = useState<{ path: string; content: string }[]>([]);
  const [neighbor, setNeighbor] = useState('');
  const [collisionNeighbor, setCollisionNeighbor] = useState('');
  const [cases, setCases] = useState<Record<CaseField, string>>(emptyCases);
  const [tags, setTags] = useState<Record<TagField, string>>(emptyTags);
  const [importOwner, setImportOwner] = useState('');
  const [importRepo, setImportRepo] = useState('');
  const [importCommit, setImportCommit] = useState('');
  const [importDirectory, setImportDirectory] = useState('');
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [acceptNormalization, setAcceptNormalization] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [uploadKind, setUploadKind] = useState<'skill' | 'zip' | null>(null);
  const [uploadResources, setUploadResources] = useState<UploadResult['resources']>([]);
  const [acceptUpload, setAcceptUpload] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [request, setRequest] = useState<unknown>(null);
  const [pr, setPr] = useState<Proposal | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [published, setPublished] = useState<Set<string> | null>(null);
  const [publishedUnavailable, setPublishedUnavailable] = useState(false);

  const load = async (signal?: AbortSignal): Promise<void> => {
    setLoading(true); setError('');
    try {
      const data = await client.get<Index>('/source-skills', { query: { limit: 100 }, ...(signal ? { signal } : {}), timeoutMs: 30_000, decode: decodeIndex });
      while (data.items.length < data.total) {
        const page = await client.get<Index>('/source-skills', { query: { limit: 100, offset: data.items.length }, ...(signal ? { signal } : {}), timeoutMs: 30_000, decode: decodeIndex });
        if (page.sha !== data.sha || page.total !== data.total || !page.items.length) throw new Error('Source main changed while loading. Refresh and compare again.');
        data.items.push(...page.items);
      }
      if (!signal?.aborted) { setIndex(data); setNeighbor(data.items[0]?.name ?? ''); setCollisionNeighbor(data.items[0]?.name ?? ''); }
    } catch (cause) { if (!signal?.aborted) setError(message(cause)); }
    finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => { if (role !== 'owner') return; const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [client, role]);
  useEffect(() => {
    if (role !== 'owner') return;
    const controller = new AbortController();
    setPublished(null); setPublishedUnavailable(false);
    void sourcePublishedLinks(offset => client.get<CatalogPage>('/skills', { query: { namespace: 'egawilldoit', limit: 200, offset }, signal: controller.signal, timeoutMs: 15_000 }))
      .then(ids => { if (!controller.signal.aborted) setPublished(ids); })
      .catch(() => { if (!controller.signal.aborted) setPublishedUnavailable(true); });
    return () => controller.abort();
  }, [client, role]);
  if (role !== 'owner') return <p role="alert">Source management is available to workspace owners with editor access.</p>;
  const clear = (): void => { setPreview(null); setRequest(null); setPr(null); setStatus(null); setError(''); };
  const reset = (): void => { clear(); setMode('list'); setConfirmation(''); };
  const startAdd = (): void => { clear(); setName(''); setNameLabel(''); setDescription(''); setBody(''); setTriggers(''); setAntiTriggers(''); setDisplayName(''); setShortDescription(''); setPrompt(''); setCases(emptyCases()); setTags(emptyTags()); setImported(null); setAcceptNormalization(false); setUploaded(false); setUploadKind(null); setUploadResources([]); setAcceptUpload(false); setMode('add'); };
  const startEdit = async (item: Item): Promise<void> => {
    clear(); setLoading(true);
    try {
      const detail = await client.get<Detail>(`/source-skills/${encodeURIComponent(item.name)}`, { timeoutMs: 30_000, decode: decodeDetail });
      if (!index || detail.sha !== index.sha) throw new Error('Source main changed. Refresh the list and compare again.');
      const skill = detail.files.find(file => file.path === 'SKILL.md');
      if (!skill) throw new Error('Source skill is missing SKILL.md.');
      const match = textFile(skill.contentBase64).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) throw new Error('Source skill frontmatter is invalid.');
      const meta = parse(match[1]!) as { description?: unknown };
      if (typeof meta.description !== 'string') throw new Error('Source description is invalid.');
      const routingFile = detail.files.find(file => file.path === 'ega.yaml');
      if (!routingFile) throw new Error('Source skill is missing routing metadata.');
      const routing = parse(textFile(routingFile.contentBase64), { uniqueKeys: true, maxAliasCount: 0 }) as Record<string, unknown>;
      const routingList = (key: string): string[] => { const value = routing?.[key] ?? []; if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error('Source routing metadata is invalid.'); return value as string[]; };
      const editable = detail.files.filter(file => /^references\//.test(file.path) && /\.(?:md|txt)$/i.test(file.path)).map(file => ({ path: file.path, content: textFile(file.contentBase64) }));
      setName(item.name); setDescription(meta.description); setBody(match[2]!.trim()); setTriggers(routingList('triggers').join('\n')); setAntiTriggers(routingList('anti_triggers').join('\n')); setTags({ domains: routingList('domains').join('\n'), platforms: routingList('platforms').join('\n'), frameworks: routingList('frameworks').join('\n'), aliases: routingList('aliases').join('\n') }); setReferences(editable); setEditProvenance(item.provenance); setMode('update');
    } catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  };
  const loadImport = async (): Promise<void> => {
    setError(''); setLoading(true); setImported(null); setAcceptNormalization(false); setUploaded(false); setUploadKind(null); setUploadResources([]); setAcceptUpload(false); setPreview(null); setName(''); setNameLabel(''); setDescription(''); setBody('');
    try {
      const location = { owner: importOwner, repo: importRepo, commit: importCommit, directory: importDirectory };
      const result = await client.post<ImportResult>('/skill-imports/github', location, { timeoutMs: 35_000, decode: value => {
        const v = value as ImportResult;
        if (!v || !v.location || JSON.stringify(v.location) !== JSON.stringify(location) || !v.license || typeof v.license.path !== 'string' || typeof v.license.text !== 'string' || !/^[0-9a-f]{40}$/.test(v.license.sha) || !Array.isArray(v.files) || v.files.some(file => !file || typeof file.path !== 'string' || typeof file.contentBase64 !== 'string' || !['100644', '100755'].includes(file.mode))) throw new Error('Invalid GitHub import response');
        return v;
      } });
      const skill = result.files.find(file => file.path === 'SKILL.md');
      if (!skill) throw new Error('Imported SKILL.md is missing.');
      const match = textFile(skill.contentBase64).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!match) throw new Error('Imported frontmatter is invalid.');
      const meta = parse(match[1]!, { uniqueKeys: true, maxAliasCount: 0 }) as Record<string, unknown>;
      if (!meta || typeof meta.name !== 'string' || typeof meta.description !== 'string' || Object.keys(meta).sort().join(',') !== 'description,name' || meta.name !== location.directory.split('/').at(-1)) throw new Error('Imported frontmatter must contain only name and description, and the name must match the directory.');
      setName(meta.name); setNameLabel(meta.name); setDescription(meta.description); setBody(match[2]!.trim()); setImported(result);
    } catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  };
  const loadSkillFile = async (file: File | undefined): Promise<void> => {
    setError(''); setUploaded(false); setUploadKind(null); setUploadResources([]); setAcceptUpload(false); setImported(null); setPreview(null); setName(''); setNameLabel(''); setDescription(''); setBody('');
    if (!file) return;
    try {
      if (file.name !== 'SKILL.md' || file.size > 200_000) throw new Error('Upload a SKILL.md file no larger than 200 KB.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (text.includes('\0')) throw new Error('SKILL.md cannot contain NUL characters.');
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!match) throw new Error('SKILL.md must have YAML frontmatter.');
      const meta = parse(match[1]!, { uniqueKeys: true, maxAliasCount: 0 }) as Record<string, unknown>;
      if (!meta || typeof meta.name !== 'string' || typeof meta.description !== 'string' || Object.keys(meta).sort().join(',') !== 'description,name') throw new Error('Frontmatter must contain only name and description.');
      setName(meta.name); setNameLabel(meta.name); setDescription(meta.description); setBody(match[2]!.trim()); setUploaded(true); setUploadKind('skill');
    } catch (cause) { setError(message(cause)); }
  };
  const loadSkillArchive = async (file: File | undefined): Promise<void> => {
    setError(''); setUploaded(false); setUploadKind(null); setUploadResources([]); setAcceptUpload(false); setImported(null); setPreview(null); setName(''); setNameLabel(''); setDescription(''); setBody('');
    if (!file) return;
    setLoading(true);
    try {
      if (file.size > 2_500_000) throw new Error('Upload a ZIP archive no larger than 2.5 MB.');
      const result = await client.upload<UploadResult>('/skill-uploads/zip', file, { contentType: 'application/zip', timeoutMs: 35_000, decode: decodeUpload });
      setName(result.name); setNameLabel(result.name); setDescription(result.description); setBody(result.body); setUploadResources(result.resources); setUploaded(true); setUploadKind('zip');
    } catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  };
  const makePreview = async (): Promise<void> => {
    if (!index) return;
    setError(''); setLoading(true); setPreview(null); setPr(null);
    const routingTags = Object.fromEntries(tagFields.map(field => [field, tags[field].split('\n').map(value => value.trim()).filter(Boolean)]));
    const defaults = sourceInterfaceDefaults(name, description);
    const proposal = mode === 'remove' ? { operation: 'remove', name, confirmation } : mode === 'update' ? { operation: 'update', name, description, body, routing: { triggers: triggers.split('\n').map(x => x.trim()).filter(Boolean), antiTriggers: antiTriggers.split('\n').map(x => x.trim()).filter(Boolean), tags: routingTags }, references } : {
      operation: 'add', name, description, body, triggers: triggers.split('\n').map(x => x.trim()).filter(Boolean), antiTriggers: antiTriggers.split('\n').map(x => x.trim()).filter(Boolean),
      interface: { displayName: displayName || defaults.displayName, shortDescription: shortDescription || defaults.shortDescription, prompt: prompt || defaults.prompt },
      routingTags,
      ...(imported && acceptNormalization ? { importSource: { location: imported.location, acceptOriginalNormalization: true } } : {}),
      ...(uploadResources.length ? { resources: uploadResources } : {}),
      cases: { ...cases, negative_expected: neighbor, collision_expected: collisionNeighbor },
    };
    const next = { baseSha: index.sha, proposal };
    try { const result = await client.post<Preview>('/skill-proposals/preview', next, { timeoutMs: 30_000, decode: decodePreview }); setRequest(next); setPreview(result); }
    catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  };
  const submit = async (): Promise<void> => {
    if (!preview || !request || preview.errors.length) return;
    setLoading(true); setError('');
    try { setPr(await client.post<Proposal>('/skill-proposals', { ...(request as object), previewDigest: preview.digest }, { timeoutMs: 30_000, decode: decodeProposal })); }
    catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  };
  const refreshStatus = async (): Promise<void> => {
    if (!pr) return;
    setLoading(true); setError('');
    try { setStatus(await client.get<Status>(`/skill-proposals/${pr.number}`, { decode: decodeStatus })); }
    catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  };
  return <section>
    <h2>Manage source skills</h2><p>Source: egawilldoit/skills main. Source changes are not necessarily published.</p>
    {index ? <p>Source commit: <code>{index.sha}</code></p> : null}
    {error ? <p role="alert">{error} <button type="button" onClick={() => void load()}>Refresh source</button></p> : null}
    {loading ? <p role="status">Loading source…</p> : null}
    {mode === 'list' && index ? <>
      <button className="button button--primary" onClick={startAdd}>Add skill</button>
      {publishedUnavailable ? <p>Published skill links are unavailable; source management remains available.</p> : null}
      <p><label>Search <input value={search} onChange={event => setSearch(event.target.value)} /></label>{' '}<label>Provenance <select value={filter} onChange={event => setFilter(event.target.value)}><option value="">All</option><option>original</option><option>adapted</option><option>copied</option></select></label></p>
      <ul>{index.items.filter(item => (!filter || item.provenance === filter) && `${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase())).map(item => <li key={item.name}>
        <strong>{item.name}</strong> ({item.provenance}) — {item.description}{' '}
        {published?.has(`egawilldoit/${item.name}`) ? <><a href={`/skills/${encodeURIComponent(`egawilldoit/${item.name}`)}`}>View published skill</a>{' '}</> : null}
        <button disabled={loading} onClick={() => void startEdit(item)}>Edit skill</button>{' '}
        <button disabled={loading} onClick={() => { clear(); setName(item.name); setConfirmation(''); setMode('remove'); }}>Remove from next catalog</button>
      </li>)}</ul>
    </> : null}
    {mode !== 'list' ? <fieldset disabled={loading} onChange={() => { setPreview(null); setRequest(null); setPr(null); }}>
      <h3>{mode === 'add' ? 'Add skill' : mode === 'update' ? `Edit ${name}` : `Remove ${name} from next catalog`}</h3>
      {mode === 'add' ? <details><summary>Upload SKILL.md or ZIP</summary><p>The uploaded skill will be classified as original. Review its contents and retain any required attribution.</p><p><label>SKILL.md <input aria-label="Upload SKILL.md" type="file" accept=".md,text/markdown" onChange={event => void loadSkillFile(event.target.files?.[0])} /></label></p><p><label>Skill ZIP <input aria-label="Upload skill ZIP" type="file" accept=".zip,application/zip" onChange={event => void loadSkillArchive(event.target.files?.[0])} /></label> A ZIP must contain one valid skill directory with SKILL.md and optional references, scripts, or assets within the size limits.</p>{uploaded ? <label><input type="checkbox" checked={acceptUpload} onChange={event => setAcceptUpload(event.target.checked)} /> I am authorized to use this content and classify it as original.</label> : null}{uploadKind === 'zip' ? <p>Archive validated: {name} with {uploadResources.length} resource file(s).</p> : null}</details> : null}
      {mode === 'add' ? <details><summary>Import from pinned GitHub source</summary><p>Use a full commit SHA and skill directory. Only supported skill files can be imported.</p>
        <label>Owner <input value={importOwner} readOnly={!!imported} onChange={event => { setImportOwner(event.target.value); setImported(null); }} /></label>{' '}
        <label>Repository <input value={importRepo} readOnly={!!imported} onChange={event => { setImportRepo(event.target.value); setImported(null); }} /></label>{' '}
        <label>Commit SHA <input value={importCommit} readOnly={!!imported} onChange={event => { setImportCommit(event.target.value); setImported(null); }} /></label>{' '}
        <label>Skill directory <input value={importDirectory} readOnly={!!imported} onChange={event => { setImportDirectory(event.target.value); setImported(null); }} /></label>{' '}
        <button type="button" onClick={() => void loadImport()}>Load import</button>
        {imported ? <><p>License: {imported.license.path}, blob {imported.license.sha}. Source attribution and the full license will be included in the proposal.</p><button type="button" onClick={() => { setImported(null); setAcceptNormalization(false); setName(''); setNameLabel(''); setDescription(''); setBody(''); }}>Clear import</button><details><summary>Read license</summary><pre>{imported.license.text}</pre></details><label><input type="checkbox" checked={acceptNormalization} onChange={event => setAcceptNormalization(event.target.checked)} /> I accept classifying this import as original in the catalog and am authorized to use it under its license. This does not claim authorship.</label></> : null}
      </details> : null}
      {mode === 'remove' ? <><p>This proposes deleting the source directory; Git history and published immutable releases remain intact.</p><label>Type {name} to confirm <input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label></> : <>
        {mode === 'add' ? <><p><label>Skill name <input value={nameLabel} readOnly={!!imported} onChange={event => { const label = event.target.value; setNameLabel(label); setName(sourceSkillSlug(label)); }} /></label></p><p>Source slug: <code>{name || '(enter a name with letters or numbers)'}</code></p></> : null}
        <p><label>Description <input value={description} readOnly={!!imported || (mode === 'update' && editProvenance === 'copied')} onChange={event => setDescription(event.target.value)} /></label></p>
        <p><label>Markdown instructions<br /><textarea rows={12} cols={70} readOnly={!!imported || (mode === 'update' && editProvenance === 'copied')} value={body} onChange={event => setBody(event.target.value)} /></label></p>
        {mode === 'update' && editProvenance === 'copied' ? <p>Copied source instructions and references are read-only; routing can be edited.</p> : null}
        <p><label>Triggers, one per line<br /><textarea value={triggers} onChange={event => setTriggers(event.target.value)} /></label></p>
        <p><label>Anti-triggers, one per line<br /><textarea value={antiTriggers} onChange={event => setAntiTriggers(event.target.value)} /></label></p>
        <details><summary>Optional routing identifiers</summary><p>Enter one identifier per line. Aliases must be unique across the catalog.</p>{tagFields.map(field => <p key={field}><label>{field}<br /><textarea value={tags[field]} onChange={event => { const value = event.target.value; setTags(current => ({ ...current, [field]: value })); }} /></label></p>)}</details>
        {mode === 'update' ? references.map((reference, i) => <p key={reference.path}><label>{reference.path}<br /><textarea rows={8} cols={70} readOnly={editProvenance === 'copied'} value={reference.content} onChange={event => { const content = event.target.value; setReferences(current => current.map((entry, index) => index === i ? { ...entry, content } : entry)); }} /></label></p>) : null}
        {mode === 'add' ? <>
          <details><summary>Interface metadata (optional)</summary><p>Leave these blank to use the suggestions shown. Review them in the proposed changes.</p>
          <p><label>Display title <input value={displayName} placeholder={sourceInterfaceDefaults(name, description).displayName} onChange={event => setDisplayName(event.target.value)} /></label></p>
          <p><label>Short description (25–64 characters) <input value={shortDescription} placeholder={sourceInterfaceDefaults(name, description).shortDescription} onChange={event => setShortDescription(event.target.value)} /></label></p>
          <p><label>Example prompt (include ${name || 'skill-name'}) <input value={prompt} placeholder={sourceInterfaceDefaults(name, description).prompt} onChange={event => setPrompt(event.target.value)} /></label></p></details>
          <h4>Routing examples</h4><p>Give realistic requests for this skill and for nearby skills. The source catalog checks these examples when the PR runs.</p>
          {(Object.keys(caseLabels) as CaseField[]).map(field => <p key={field}><label>{caseLabels[field]}<br /><textarea value={cases[field]} onChange={event => { const value = event.target.value; setCases(current => ({ ...current, [field]: value })); }} /></label></p>)}
          <p><label>Expected skill for the other request <select value={neighbor} onChange={event => setNeighbor(event.target.value)}>{index?.items.map(item => <option key={item.name}>{item.name}</option>)}</select></label></p>
          <p><label>Expected skill for the similar request <select value={collisionNeighbor} onChange={event => setCollisionNeighbor(event.target.value)}>{index?.items.map(item => <option key={item.name}>{item.name}</option>)}</select></label></p>
        </> : null}
      </>}
      <p><button disabled={loading || (!!imported && !acceptNormalization) || (uploaded && !acceptUpload)} onClick={() => void makePreview()}>Review changes</button>{' '}<button onClick={reset}>Cancel</button></p>
    </fieldset> : null}
    {preview ? <section><h3>Review source proposal</h3><p>{preview.operation} {preview.name} · {preview.provenance} · base <code>{preview.baseSha}</code> · target egawilldoit/skills</p>
      {preview.errors.map((item, i) => <p role="alert" key={i}>Error: {item}</p>)}{preview.warnings.map((item, i) => <p key={i}>Warning: {item}</p>)}
      {preview.changes.map(change => <details key={change.path}><summary>{change.path}{change.binary ? ' (binary)' : ''}{change.mode ? ` · mode ${change.mode}` : ''}</summary><p>Before</p><pre>{change.before ?? '(absent)'}</pre><p>After</p><pre>{change.after ?? '(deleted)'}</pre></details>)}
      <p>No release is published by creating this source PR. Full source CI and review are still required.</p>
      {preview.operation === 'remove' ? <p>A removal can be submitted only when the complete candidate catalog passes local validation. Source PR CI and human review remain authoritative.</p> : null}
      <button disabled={loading || !!preview.errors.length || !preview.changes.length} onClick={() => void submit()}>Create source PR</button>
    </section> : null}
    {pr ? <section><h3>Source PR</h3><p><a href={pr.url} target="_blank" rel="noreferrer">Open source pull request #{pr.number}</a> · head <code>{pr.head}</code> · not published</p><button disabled={loading} onClick={() => void refreshStatus()}>Refresh GitHub CI status</button>{status ? <p>PR {status.state}; observed head checks {status.headChecks}; test merge {status.mergeSha ?? 'not available'}, observed checks {status.mergeChecks}. Observed checks do not verify that all required checks ran or passed; inspect the GitHub PR for its required gates.</p> : <p>GitHub CI status not yet checked.</p>}</section> : null}
  </section>;
}
