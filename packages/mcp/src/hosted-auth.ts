// Contract D OAuth resource-server primitives.
//
// The deployment owns the authorization server and supplies its issuer,
// resource, JWKS, and browser endpoints. This module validates bearer JWTs
// without logging or persisting token material; it does not implement an
// authorization-code exchange or hold client secrets.

import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

import type { AuthInfo } from "@modelcontextprotocol/server";

export interface HostedOAuthMetadata {
  readonly issuer: string;
  readonly resource: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly scopesSupported: readonly string[];
}

export interface HostedOAuthVerifierOptions {
  readonly issuer: string;
  readonly resource: string;
  readonly jwksUri: string;
  readonly requiredScopes: readonly string[];
  readonly clockSkewSeconds?: number;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly isRevoked?: (claims: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>;
}

interface JwtHeader {
  readonly alg?: unknown;
  readonly kid?: unknown;
  readonly typ?: unknown;
}

interface JwtClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
  readonly scope?: unknown;
  readonly sub?: unknown;
  readonly client_id?: unknown;
  readonly [key: string]: unknown;
}

interface JwksDocument {
  readonly keys?: readonly Record<string, unknown>[];
}

function oauthFailure(message: string): Error {
  return new Error(`OAuth token rejected: ${message}`);
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw oauthFailure("malformed JWT encoding");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
  } catch {
    throw oauthFailure(`malformed JWT ${label}`);
  }
}

function audienceIncludes(audience: unknown, expected: string): boolean {
  return typeof audience === "string"
    ? audience === expected
    : Array.isArray(audience) && audience.some((item) => item === expected);
}

function scopeSet(scope: unknown): Set<string> {
  if (typeof scope !== "string") return new Set();
  return new Set(scope.split(/\s+/u).filter((item) => item.length > 0));
}

function asPublicKey(jwk: Record<string, unknown>): KeyObject {
  try {
    return createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw oauthFailure("invalid JWKS key");
  }
}

export function oauthDiscoveryDocuments(metadata: HostedOAuthMetadata): {
  readonly protectedResource: Record<string, unknown>;
  readonly authorizationServer: Record<string, unknown>;
} {
  return {
    protectedResource: {
      resource: metadata.resource,
      authorization_servers: [metadata.issuer],
      scopes_supported: [...metadata.scopesSupported],
    },
    authorizationServer: {
      issuer: metadata.issuer,
      authorization_endpoint: metadata.authorizationEndpoint,
      token_endpoint: metadata.tokenEndpoint,
      jwks_uri: metadata.jwksUri,
      scopes_supported: [...metadata.scopesSupported],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    },
  };
}

export function createHostedOAuthVerifier(options: HostedOAuthVerifierOptions): {
  verifyAccessToken(token: string): Promise<AuthInfo>;
} {
  const fetcher = options.fetch ?? ((input, init) => globalThis["fetch"](input, init));
  const clockSkewSeconds = options.clockSkewSeconds ?? 30;
  if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0) {
    throw new Error("OAuth clock skew must be a non-negative integer");
  }
  if (options.issuer.length === 0 || options.resource.length === 0 || options.jwksUri.length === 0) {
    throw new Error("OAuth issuer, resource, and JWKS URI are required");
  }

  let jwksPromise: Promise<JwksDocument> | undefined;
  const loadJwks = async (): Promise<JwksDocument> => {
    if (jwksPromise !== undefined) return jwksPromise;
    jwksPromise = (async () => {
      const response = await fetcher(options.jwksUri, { headers: { accept: "application/json" } });
      if (!response.ok) throw oauthFailure("JWKS endpoint unavailable");
      const document = (await response.json()) as JwksDocument;
      if (!Array.isArray(document.keys)) throw oauthFailure("JWKS document is invalid");
      return document;
    })();
    try {
      return await jwksPromise;
    } catch (error) {
      jwksPromise = undefined;
      throw error;
    }
  };

  return {
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      if (typeof token !== "string" || token.length === 0) throw oauthFailure("missing bearer token");
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw oauthFailure("malformed bearer token");
      const header = decodeJson<JwtHeader>(parts[0]!, "header");
      if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) {
        throw oauthFailure("unsupported signing algorithm or missing key id");
      }
      if (header.typ !== undefined && header.typ !== "JWT") throw oauthFailure("invalid token type");
      const jwks = await loadJwks();
      const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.use !== "enc");
      if (jwk === undefined) {
        jwksPromise = undefined;
        throw oauthFailure("signing key is not published");
      }
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${parts[0]}.${parts[1]}`, "ascii");
      if (!verifier.verify(asPublicKey(jwk), decodeBase64Url(parts[2]!))) throw oauthFailure("signature mismatch");
      const claims = decodeJson<JwtClaims>(parts[1]!, "claims");
      if (claims.iss !== options.issuer) throw oauthFailure("issuer mismatch");
      if (!audienceIncludes(claims.aud, options.resource)) throw oauthFailure("audience/resource mismatch");
      const now = Math.floor(Date.now() / 1000);
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now - clockSkewSeconds) {
        throw oauthFailure("token is expired or has no expiry");
      }
      if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + clockSkewSeconds)) {
        throw oauthFailure("token is not active yet");
      }
      const scopes = scopeSet(claims.scope);
      if (options.requiredScopes.some((scope) => !scopes.has(scope))) throw oauthFailure("required scope is missing");
      if (options.isRevoked !== undefined && await options.isRevoked(claims)) throw oauthFailure("token is revoked");
      const subject = typeof claims.sub === "string" ? claims.sub : undefined;
      const clientId = typeof claims.client_id === "string" ? claims.client_id : subject;
      if (clientId === undefined) throw oauthFailure("subject is missing");
      return {
        token,
        clientId,
        scopes: [...scopes],
        expiresAt: claims.exp as number,
      };
    },
  };
}
