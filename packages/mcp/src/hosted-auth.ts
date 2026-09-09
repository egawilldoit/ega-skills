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
interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}
interface JwksDocument { keys: Jwk[]; }
const DEFAULT_MAX_AGE = 5 * 60 * 1000;
const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_MAX_BODY = 512 * 1024;
const ALGORITHMS = {
  RS256: { verify: "RSA-SHA256", kty: "RSA" },
  RS384: { verify: "RSA-SHA384", kty: "RSA" },
  RS512: { verify: "RSA-SHA512", kty: "RSA" },
  ES256: { verify: "SHA256", kty: "EC", crv: "P-256" },
} as const;
type SupportedAlgorithm = keyof typeof ALGORITHMS;

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
function integer(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const normalized = bytes.slice(start);
  return der(0x02, (normalized[0] ?? 0) & 0x80 ? Uint8Array.of(0, ...normalized) : normalized);
}
function pem(spki: Uint8Array): string {
  let binary = "";
  for (const byte of spki) binary += String.fromCharCode(byte);
  return `-----BEGIN PUBLIC KEY-----\n${btoa(binary).match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END PUBLIC KEY-----`;
}
function rsaPem(jwk: Jwk): string {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("unsupported JWK");
  const rsa = der(0x30, Uint8Array.of(...integer(decodePart(jwk.n)), ...integer(decodePart(jwk.e))));
  const algorithm = der(0x30, Uint8Array.of(...der(0x06, Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01)), ...der(0x05, new Uint8Array())));
  return pem(der(0x30, Uint8Array.of(...algorithm, ...der(0x03, Uint8Array.of(0, ...rsa)))));
}
function ecPem(jwk: Jwk): string {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("unsupported JWK");
  const x = decodePart(jwk.x);
  const y = decodePart(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error("unsupported JWK");
  const idEcPublicKey = der(0x06, Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01));
  const prime256v1 = der(0x06, Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07));
  const algorithm = der(0x30, Uint8Array.of(...idEcPublicKey, ...prime256v1));
  const publicPoint = Uint8Array.of(0x04, ...x, ...y);
  return pem(der(0x30, Uint8Array.of(...algorithm, ...der(0x03, Uint8Array.of(0, ...publicPoint)))));
}
function es256Signature(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error("invalid ES256 signature");
  return der(0x30, Uint8Array.of(...integer(signature.slice(0, 32)), ...integer(signature.slice(32))));
}
function audience(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.every((item) => typeof item === "string") && value.includes(expected));
}
function supportedAlgorithm(value: string | undefined): value is SupportedAlgorithm {
  return value !== undefined && Object.prototype.hasOwnProperty.call(ALGORITHMS, value);
}
function keyMatches(jwk: Jwk, algorithm: SupportedAlgorithm): boolean {
  const expected = ALGORITHMS[algorithm];
  if (jwk.kty !== expected.kty || ("crv" in expected && jwk.crv !== expected.crv)) return false;
  if (jwk.alg !== undefined && jwk.alg !== algorithm) return false;
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify"))) return false;
  return true;
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
        const keys = document.keys.filter((key) => key && (key.kty === "RSA" || key.kty === "EC") && typeof key.kid === "string");
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
    const algorithm = header.alg;
    if (!supportedAlgorithm(algorithm) || !header.kid) throw new Error("unsupported token algorithm");
    const claims = decodeJson<Record<string, unknown>>(parts[1] as string);
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== options.issuer || !audience(claims.aud, options.audience) || typeof claims.sub !== "string") throw new Error("token claims rejected");
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now - skew) throw new Error("token expired");
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + skew)) throw new Error("token not active");
    if (options.requiredScope && (typeof claims.scope !== "string" || !claims.scope.split(/\s+/).includes(options.requiredScope))) throw new Error("token scope rejected");
    let keys = await load(signal);
    let key = keys.find((candidate) => candidate.kid === header.kid && keyMatches(candidate, algorithm));
    if (!key) { keys = await load(signal, true); key = keys.find((candidate) => candidate.kid === header.kid && keyMatches(candidate, algorithm)); }
    if (!key) throw new Error("token key unavailable");
    const verifier = createVerify(ALGORITHMS[algorithm].verify);
    verifier.update(`${parts[0]}.${parts[1]}`); verifier.end();
    const signature = decodePart(parts[2] as string);
    const publicKey = algorithm === "ES256" ? ecPem(key) : rsaPem(key);
    const verificationSignature = algorithm === "ES256" ? es256Signature(signature) : signature;
    if (!verifier.verify(publicKey, verificationSignature)) throw new Error("token signature rejected");
    const scopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [];
    return { subject: claims.sub, scopes };
  };
}
