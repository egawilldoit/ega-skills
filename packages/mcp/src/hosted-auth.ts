import { createVerify } from "node:crypto";

export interface JwksBearerVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly requiredScope?: string;
  readonly clockSkewSeconds?: number;
  readonly jwksMaxAgeMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly fetchImpl?: (input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
}
interface Jwk { kty: string; kid?: string; n?: string; e?: string; }
interface JwksDocument { keys: Jwk[]; }
const DEFAULT_MAX_AGE = 5 * 60 * 1000;
const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_MAX_BODY = 512 * 1024;
const SHA_ALGORITHMS: Record<string, string> = { RS256: "RSA-SHA256", RS384: "RSA-SHA384", RS512: "RSA-SHA512" };

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be a positive safe integer`);
  return result;
}
function decodePart(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid token encoding");
  const text = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodePart(value))) as T;
}
function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
function der(tag: number, body: Uint8Array): Uint8Array { return Uint8Array.of(tag, ...derLength(body.length), ...body); }
function integer(bytes: Uint8Array): Uint8Array { return der(0x02, bytes[0] === 0 ? bytes : Uint8Array.of(0, ...bytes)); }
function rsaPem(jwk: Jwk): string {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("unsupported JWK");
  const rsa = der(0x30, Uint8Array.of(...integer(decodePart(jwk.n)), ...integer(decodePart(jwk.e))));
  const algorithm = der(0x30, Uint8Array.of(...der(0x06, Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01)), ...der(0x05, new Uint8Array())));
  const spki = der(0x30, Uint8Array.of(...algorithm, ...der(0x03, Uint8Array.of(0, ...rsa))));
  let binary = "";
  for (const byte of spki) binary += String.fromCharCode(byte);
  return `-----BEGIN PUBLIC KEY-----\n${btoa(binary).match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END PUBLIC KEY-----`;
}
function audience(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.every((item) => typeof item === "string") && value.includes(expected));
}

export function createJwksBearerVerifier(options: JwksBearerVerifierOptions): (token: string, signal: AbortSignal) => Promise<{ subject: string; scopes: readonly string[] }> {
  const maxAge = positive(options.jwksMaxAgeMs, DEFAULT_MAX_AGE, "jwksMaxAgeMs");
  const timeoutMs = positive(options.requestTimeoutMs, DEFAULT_TIMEOUT, "requestTimeoutMs");
  const maxBody = positive(options.maxBodyBytes, DEFAULT_MAX_BODY, "maxBodyBytes");
  const skew = positive(options.clockSkewSeconds, 30, "clockSkewSeconds");
  const fetcher = options.fetchImpl ?? (globalThis["fetch"] as unknown as JwksBearerVerifierOptions["fetchImpl"]);
  if (!fetcher) throw new Error("fetch is unavailable");
  let cached: { loadedAt: number; keys: Jwk[] } | undefined;
  let loading: Promise<Jwk[]> | undefined;
  const load = async (signal: AbortSignal, force = false): Promise<Jwk[]> => {
    if (!force && cached && Date.now() - cached.loadedAt < maxAge) return cached.keys;
    if (loading) return loading;
    loading = (async () => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("JWKS request timeout")), timeoutMs);
      try {
        const response = await fetcher(options.jwksUrl, { signal: controller.signal });
        if (!response.ok) throw new Error("JWKS request failed");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > maxBody) throw new Error("JWKS response too large");
        const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as JwksDocument;
        if (!Array.isArray(document.keys)) throw new Error("invalid JWKS document");
        const keys = document.keys.filter((key) => key && key.kty === "RSA" && typeof key.kid === "string");
        cached = { loadedAt: Date.now(), keys };
        return keys;
      } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); loading = undefined; }
    })();
    return loading;
  };
  return async (token, signal) => {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error("invalid bearer token");
    const header = decodeJson<{ alg?: string; kid?: string }>(parts[0] as string);
    if (!header.alg || !SHA_ALGORITHMS[header.alg] || !header.kid) throw new Error("unsupported token algorithm");
    const claims = decodeJson<Record<string, unknown>>(parts[1] as string);
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== options.issuer || !audience(claims.aud, options.audience) || typeof claims.sub !== "string") throw new Error("token claims rejected");
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now - skew) throw new Error("token expired");
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + skew)) throw new Error("token not active");
    if (options.requiredScope && (typeof claims.scope !== "string" || !claims.scope.split(/\s+/).includes(options.requiredScope))) throw new Error("token scope rejected");
    let keys = await load(signal);
    let key = keys.find((candidate) => candidate.kid === header.kid);
    if (!key) { keys = await load(signal, true); key = keys.find((candidate) => candidate.kid === header.kid); }
    if (!key) throw new Error("token key unavailable");
    const verifier = createVerify(SHA_ALGORITHMS[header.alg] as string);
    verifier.update(`${parts[0]}.${parts[1]}`); verifier.end();
    if (!verifier.verify(rsaPem(key), decodePart(parts[2] as string))) throw new Error("token signature rejected");
    const scopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [];
    return { subject: claims.sub, scopes };
  };
}
