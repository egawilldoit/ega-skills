import { SourceGuardError } from './guard.ts';
import { MAX_FILE_BYTES, MAX_SKILL_BYTES, MAX_SKILL_FILES, validSkillName, validSkillPath, validateSourceFiles } from './paths.ts';
import type { SourceFile } from './paths.ts';

/** Metadata and bounded entry streams supplied by a maintained ZIP reader. */
export interface ArchiveEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  unixMode: number | null;
  encrypted: boolean;
  directory: boolean;
  read(): AsyncIterable<Uint8Array>;
}

function invalid(message: string): never { throw new SourceGuardError(422, 'E_UPLOAD_ARCHIVE', message); }

/** Validate metadata before decompressing, then verify actual streamed byte counts. */
export async function validateSkillArchive(entries: readonly ArchiveEntry[]): Promise<{ name: string; files: SourceFile[] }> {
  if (!entries.length || entries.length > MAX_SKILL_FILES * 2) return invalid('Archive has an invalid number of entries.');
  let root = '';
  let total = 0;
  let compressed = 0;
  const seen = new Set<string>();
  const files: Array<{ entry: ArchiveEntry; path: string; mode: string }> = [];
  for (const entry of entries) {
    const path = entry.path;
    if (!path || path.normalize('NFC') !== path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)) return invalid('Archive contains an unsafe path.');
    const parts = path.replace(/\/$/, '').split('/');
    if (parts.some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) || part === '.' || part === '..')) return invalid('Archive contains an unsafe path.');
    if (!root) root = parts[0]!;
    if (parts[0] !== root || !validSkillName(root, 'ega-skills')) return invalid('Archive must contain one skill directory with a valid name.');
    const key = parts.join('/').toLowerCase();
    if (seen.has(key)) return invalid('Archive contains duplicate or case-colliding paths.');
    seen.add(key);
    if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize) || entry.compressedSize < 0 || entry.uncompressedSize < 0 || entry.encrypted) return invalid('Archive entry metadata is invalid or encrypted.');
    if (entry.unixMode !== null && (!Number.isSafeInteger(entry.unixMode) || entry.unixMode < 0 || ((entry.unixMode & 0o170000) !== 0 && (entry.unixMode & 0o170000) !== (entry.directory ? 0o040000 : 0o100000)))) return invalid('Archive contains an unsupported file type.');
    if (entry.directory) {
      if (!path.endsWith('/') || entry.uncompressedSize !== 0 || (parts.length > 1 && !['references', 'scripts', 'assets'].includes(parts[1]!))) return invalid('Archive contains an unsupported directory.');
      continue;
    }
    if (path.endsWith('/') || parts.length < 2) return invalid('Archive contains an invalid file.');
    const relative = parts.slice(1).join('/');
    if (!validSkillPath(relative) || (relative !== 'SKILL.md' && !/^(?:references|scripts|assets)\//.test(relative))) return invalid('Archive contains an unsupported skill file.');
    if (entry.uncompressedSize > MAX_FILE_BYTES || (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize > entry.compressedSize * 100))) return invalid('Archive entry exceeds its size or compression ratio limit.');
    total += entry.uncompressedSize;
    compressed += entry.compressedSize;
    if (total > MAX_SKILL_BYTES || compressed > MAX_SKILL_BYTES || files.length >= MAX_SKILL_FILES) return invalid('Archive exceeds its total size or file count limit.');
    const executable = entry.unixMode !== null && (entry.unixMode & 0o111) !== 0;
    if (executable && !relative.startsWith('scripts/')) return invalid('Only script resources may be executable.');
    files.push({ entry, path: relative, mode: executable ? '100755' : '100644' });
  }
  if (!files.some(file => file.path === 'SKILL.md')) return invalid('Archive must contain SKILL.md.');
  const filePaths = files.map(file => `${root}/${file.path}`.toLowerCase());
  if (filePaths.some(file => [...seen].some(path => path.startsWith(`${file}/`)))) return invalid('Archive contains a file and directory collision.');
  const output: SourceFile[] = [];
  for (const file of files) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let count = 0;
    try {
      for await (const chunk of file.entry.read()) {
        if (!(chunk instanceof Uint8Array) || ++count > 4096) return invalid('Archive entry content is invalid.');
        size += chunk.byteLength;
        if (size > file.entry.uncompressedSize || size > MAX_FILE_BYTES) return invalid('Archive entry exceeded its declared size.');
        chunks.push(Uint8Array.from(chunk));
      }
    } catch (error) { if (error instanceof SourceGuardError) throw error; return invalid('Archive entry could not be read.'); }
    if (size !== file.entry.uncompressedSize) return invalid('Archive entry size does not match its declaration.');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    output.push({ path: file.path, mode: file.mode, bytes });
  }
  if (validateSourceFiles(output).length) return invalid('Archive contains invalid skill files.');
  return { name: root, files: output };
}

/** Prepare validated archive contents for the existing add-proposal flow. */
export async function prepareSkillArchive(entries: readonly ArchiveEntry[], parseYaml: (text: string) => unknown): Promise<{
  name: string;
  description: string;
  body: string;
  resources: Array<{ path: string; mode: string; contentBase64: string }>;
}> {
  const { name, files } = await validateSkillArchive(entries);
  const skill = files.find(file => file.path === 'SKILL.md')!;
  if (skill.bytes.byteLength > 200_000) return invalid('SKILL.md exceeds 200 KB.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(skill.bytes);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  let metadata: unknown;
  try { if (!match) throw new Error(); metadata = parseYaml(match[1]!); }
  catch { return invalid('SKILL.md must have valid YAML frontmatter.'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).sort().join(',') !== 'description,name') return invalid('Frontmatter must contain only name and description.');
  const value = metadata as Record<string, unknown>;
  if (value.name !== name || typeof value.description !== 'string' || !value.description.trim() || !match?.[2]?.trim()) return invalid('Skill name must match the directory and description and body must be nonempty.');
  return { name, description: value.description, body: match[2].trim(), resources: files.filter(file => file.path !== 'SKILL.md').map(file => ({ path: file.path, mode: file.mode, contentBase64: Buffer.from(file.bytes).toString('base64') })) };
}
