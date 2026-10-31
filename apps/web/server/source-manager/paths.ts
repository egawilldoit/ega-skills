/** Bounds shared by source snapshots, imports, and proposal planning. */
export const MAX_SKILL_FILES = 100;
export const MAX_SKILL_BYTES = 1_000_000;
export const MAX_FILE_BYTES = 250_000;

/** The plugin prefix is part of the source repository's 64-character identity. */
export function validSkillName(name: string, pluginName: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
    && name.length <= 64
    && `${pluginName}:${name}`.length <= 64;
}

/** Validate a relative file name before it is used in a source tree. */
export function validSkillPath(path: string): boolean {
  if (path.length === 0 || path.length > 240 || path.normalize('NFC') !== path) return false;
  if (path.includes('\\') || path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) return false;
  const segments = path.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return false;
  if (path === 'SKILL.md' || path === 'ega.yaml' || path === 'agents/openai.yaml') return true;
  return segments.length >= 2 && ['references', 'scripts', 'assets'].includes(segments[0]!)
    && segments.every((part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part));
}

export interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Git tree mode; executable scripts are packaged but never executed. */
  readonly mode: string;
}

/** Refuse unsafe snapshots rather than silently dropping files from a proposal. */
export function validateSourceFiles(files: readonly SourceFile[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  if (files.length > MAX_SKILL_FILES) errors.push('Too many skill files.');
  for (const file of files) {
    if (!validSkillPath(file.path)) errors.push(`Unsupported skill path: ${file.path}`);
    const key = file.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) errors.push(`Duplicate or case-colliding path: ${file.path}`);
    seen.add(key);
    if (file.mode !== '100644' && !(file.mode === '100755' && file.path.startsWith('scripts/'))) {
      errors.push(`Unsupported file mode: ${file.path}`);
    }
    total += file.bytes.byteLength;
    if (file.bytes.byteLength > MAX_FILE_BYTES) errors.push(`File too large: ${file.path}`);
    if (/\.(?:md|txt|yaml|yml|json|py|sh|js|ts)$/i.test(file.path)) {
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
        if (decoded.includes('\0')) errors.push(`Text contains NUL: ${file.path}`);
      } catch {
        errors.push(`Invalid UTF-8 text: ${file.path}`);
      }
    }
  }
  if (total > MAX_SKILL_BYTES) errors.push('Skill exceeds total size limit.');
  return errors;
}
