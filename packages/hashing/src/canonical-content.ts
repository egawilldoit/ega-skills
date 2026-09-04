export type ContentKind = "TEXT" | "BINARY";

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const utf8Encoder = new TextEncoder();

export function classifyContent(source: Uint8Array): ContentKind {
  if (source.includes(0)) {
    return "BINARY";
  }

  try {
    utf8Decoder.decode(source);
    return "TEXT";
  } catch {
    return "BINARY";
  }
}

export function canonicalizeText(source: Uint8Array): string {
  if (classifyContent(source) !== "TEXT") {
    throw new TypeError(
      "canonicalizeText requires valid UTF-8 text without NUL bytes",
    );
  }

  const textBytes = hasLeadingUtf8Bom(source) ? source.subarray(UTF8_BOM.length) : source;
  const text = utf8Decoder.decode(textBytes);

  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function canonicalBytes(source: Uint8Array): Uint8Array {
  if (classifyContent(source) === "BINARY") {
    return Uint8Array.from(source);
  }

  return utf8Encoder.encode(canonicalizeText(source));
}

export function canonicalByteSize(source: Uint8Array): number {
  if (classifyContent(source) === "BINARY") {
    return source.byteLength;
  }

  return canonicalBytes(source).byteLength;
}

function hasLeadingUtf8Bom(source: Uint8Array): boolean {
  return (
    source.byteLength >= UTF8_BOM.length &&
    source[0] === UTF8_BOM[0] &&
    source[1] === UTF8_BOM[1] &&
    source[2] === UTF8_BOM[2]
  );
}
