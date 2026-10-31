import type { IncomingMessage } from 'node:http';

interface SessionReader {
  resolveCaller(request: { method?: string | undefined; headers: Readonly<Record<string, string | readonly string[] | undefined>>; signal?: AbortSignal | undefined }): Promise<{ subject: string }>;
}

const MAX_BODY_BYTES = 1_000_000;
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class SourceGuardError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
export interface EditorConfig { token: string; subjects: ReadonlySet<string>; origin: string }
export function loadEditorConfig(env: Readonly<Record<string, string | undefined>>): EditorConfig {
  const token = env['EGA_SOURCE_GITHUB_TOKEN'];
  const list = env['EGA_SOURCE_EDITOR_SUBJECTS'];
  const configuredOrigin = env['EGA_SOURCE_EDITOR_ORIGIN'];
  if (!token || /[\r\n]/.test(token) || !list || !configuredOrigin) throw new SourceGuardError(503, 'E_SOURCE_DISABLED', 'Source editing is not configured.');
  const subjects = list.split(',').map(value => value.trim().toLowerCase());
  if (!subjects.length || subjects.length > 100 || subjects.some(subject => !SUBJECT.test(subject))) throw new SourceGuardError(503, 'E_SOURCE_DISABLED', 'Source editing is not configured.');
  let url: URL;
  try { url = new URL(configuredOrigin); } catch { throw new SourceGuardError(503, 'E_SOURCE_DISABLED', 'Source editing is not configured.'); }
  if (url.origin !== configuredOrigin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new SourceGuardError(503, 'E_SOURCE_DISABLED', 'Source editing is not configured.');
  return { token, subjects: new Set(subjects), origin: url.origin };
}

/** Verify the Supabase session server-side and require a separately configured subject. */
export async function authorizeEditor(request: IncomingMessage, method: 'GET' | 'POST', config: EditorConfig, reader: SessionReader, signal?: AbortSignal): Promise<string> {
  if (request.method !== method) throw new SourceGuardError(405, 'E_METHOD_NOT_ALLOWED', 'Method not allowed.');
  const origin = request.headers.origin;
  if (method === 'POST' && (typeof origin !== 'string' || origin !== config.origin)) throw new SourceGuardError(403, 'E_SOURCE_ORIGIN', 'Request origin is not allowed.');
  if (origin !== undefined && origin !== config.origin) throw new SourceGuardError(403, 'E_SOURCE_ORIGIN', 'Request origin is not allowed.');
  if (method === 'POST') {
    const type = request.headers['content-type'];
    if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type.trim())) throw new SourceGuardError(415, 'E_SOURCE_CONTENT_TYPE', 'Expected JSON content.');
    const length = request.headers['content-length'];
    if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new SourceGuardError(413, 'E_SOURCE_BODY_TOO_LARGE', 'Request body is too large.');
  }
  // resolveCaller probes Supabase's verified /auth/v1/user endpoint. The probe is
  // a read even when the guarded manager operation is POST.
  const caller = await reader.resolveCaller({ method: 'GET', headers: request.headers, signal });
  if (!config.subjects.has(caller.subject.toLowerCase())) throw new SourceGuardError(403, 'E_SOURCE_FORBIDDEN', 'This account cannot manage source skills.');
  return caller.subject;
}

/** Consume a bounded JSON request only after origin and caller authorization. */
export async function readEditorJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) throw new SourceGuardError(413, 'E_SOURCE_BODY_TOO_LARGE', 'Request body is too large.');
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof SourceGuardError) throw error;
    throw new SourceGuardError(400, 'E_SOURCE_BODY_INVALID', 'Request body could not be read.');
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch { throw new SourceGuardError(400, 'E_SOURCE_BODY_INVALID', 'Request body must be valid UTF-8 JSON.'); }
}
