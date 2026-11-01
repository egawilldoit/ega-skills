import { inflateRawSync } from 'node:zlib';
import type { ArchiveEntry } from './archive.ts';
import { SourceGuardError } from './guard.ts';

/**
 * Minimal bounded ZIP reader for the source-skill upload route.
 *
 * Only the subset needed by the archive validator is supported: one central
 * directory, no multi-disk or ZIP64 archives, no encryption, stored or DEFLATE
 * entries, and UTF-8 names. Every offset and size is checked against the
 * received buffer before any entry is decompressed. Decompression is capped by
 * the entry's declared size, so a lying size cannot allocate an archive bomb.
 */
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 1000;
const MAX_EOCD_SEARCH = 65_557;

function invalid(message: string): never {
  throw new SourceGuardError(422, 'E_UPLOAD_ARCHIVE', message);
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function nameAt(view: DataView, offset: number, length: number): string {
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(view.buffer, view.byteOffset + offset, length));
  } catch {
    invalid('Archive entry names must be UTF-8.');
  }
  if (!name || name.includes('\0')) invalid('Archive contains an invalid entry name.');
  return name;
}

/** Parse a received ZIP buffer into bounded entry streams. */
export function readZipEntries(buffer: Uint8Array): ArchiveEntry[] {
  if (!(buffer instanceof Uint8Array) || buffer.byteLength < 22) invalid('Archive is empty or truncated.');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const lower = Math.max(0, buffer.byteLength - MAX_EOCD_SEARCH);
  let eocd = -1;
  for (let offset = buffer.byteLength - 22; offset >= lower; offset -= 1) {
    if (u32(view, offset) === EOCD) { eocd = offset; break; }
  }
  if (eocd < 0) invalid('Archive has no end-of-central-directory record.');
  const disk = u16(view, eocd + 4);
  const centralDisk = u16(view, eocd + 6);
  const diskEntries = u16(view, eocd + 8);
  const totalEntries = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  const commentLength = u16(view, eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) invalid('Multi-disk archives are not supported.');
  if (totalEntries === 0 || totalEntries > MAX_ENTRIES) invalid('Archive has an invalid number of entries.');
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) invalid('ZIP64 archives are not supported.');
  if (eocd + 22 + commentLength !== buffer.byteLength || centralOffset + centralSize > buffer.byteLength) invalid('Archive central directory is invalid.');

  const entries: ArchiveEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || u32(view, cursor) !== CENTRAL) invalid('Archive central directory is invalid.');
    const madeBy = u16(view, cursor + 4);
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const entryCommentLength = u16(view, cursor + 32);
    const externalAttributes = u32(view, cursor + 38);
    const localOffset = u32(view, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > centralOffset + centralSize) invalid('Archive central directory is invalid.');
    const path = nameAt(view, cursor + 46, nameLength);
    cursor = end;

    // Bit 0 is encryption; bit 3 is a data descriptor (sizes remain in the
    // central directory); bit 11 marks UTF-8 names. Anything else is refused
    // rather than guessed at.
    if ((flags & 0x0001) !== 0) invalid('Encrypted archives are not supported.');
    if ((flags & ~(0x0008 | 0x0800)) !== 0) invalid('Archive uses unsupported entry flags.');
    if (method !== 0 && method !== 8) invalid('Archive uses an unsupported compression method.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) invalid('ZIP64 archives are not supported.');

    if (localOffset + 30 > buffer.byteLength || u32(view, localOffset) !== LOCAL) invalid('Archive local entry is invalid.');
    const localFlags = u16(view, localOffset + 6);
    const localMethod = u16(view, localOffset + 8);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    if (localFlags !== flags || localMethod !== method) invalid('Archive local entry does not match its central directory entry.');
    const localName = nameAt(view, localOffset + 30, localNameLength);
    if (localName !== path) invalid('Archive local entry name does not match its central directory entry.');
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.byteLength || dataEnd > centralOffset) invalid('Archive entry data is out of bounds.');
    if (method === 0 && compressedSize !== uncompressedSize) invalid('Stored archive entry sizes do not match.');

    const host = madeBy >>> 8;
    const unixMode = host === 3 ? (externalAttributes >>> 16) : null;
    const directory = path.endsWith('/') || (externalAttributes & 0x10) !== 0;
    if (directory && !path.endsWith('/')) invalid('Archive directory entries must end with a slash.');
    entries.push({
      path,
      compressedSize,
      uncompressedSize,
      unixMode,
      encrypted: false,
      directory,
      async *read() {
        const compressed = buffer.subarray(dataStart, dataEnd);
        if (method === 0) {
          yield compressed;
          return;
        }
        let output: Buffer;
        try {
          // One extra byte is deliberate: the validator sees that the entry
          // exceeded its declaration instead of silently accepting a short read.
          output = inflateRawSync(compressed, { maxOutputLength: uncompressedSize + 1 });
        } catch {
          invalid('Archive entry could not be decompressed within its declared size.');
        }
        yield output;
      },
    });
  }
  if (cursor !== centralOffset + centralSize) invalid('Archive central directory has trailing data.');
  return entries;
}
