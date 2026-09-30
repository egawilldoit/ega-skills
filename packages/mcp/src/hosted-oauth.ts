/** OAuth 2.1 resource-server foundation for the hosted MCP.
 *
 * This module owns ONLY the serving side of OAuth discovery:
 * - canonical MCP resource URL validation (explicit trusted configuration)
 * - OAuth 2.0 Protected Resource Metadata (RFC 9728)
 * - `WWW-Authenticate: Bearer` challenge generation
 *
 * It deliberately contains no tool logic, no token verification, and no
 * authorization decisions. Authentication still ends at `HostedPrincipal`;
 * authorization still starts after it (`hosted.ts`).
 *
 * The canonical resource URL is NEVER derived from request headers (Host,
 * X-Forwarded-Host, forwarded proto, ...). It is configured once at startup
 * and normalized/validated there, so a hostile request cannot move the
 * advertised resource or the authorization server for a client.
 */

export interface HostedOAuthConfig {
  /** Canonical absolute resource identifier, e.g. `https://ega.example/mcp`. */
  readonly resource: string;
  /** Canonical protected-resource metadata URL for `WWW-Authenticate`. */
  readonly resourceMetadataUrl: string;
  /** Trusted authorization server issuer URLs (never wildcard, never a path probe). */
  readonly authorizationServers: readonly string[];
  /** Optional scopes to advertise; omitted from metadata when empty. */
  readonly scopesSupported: readonly string[];
}

export interface HostedProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly string[];
  readonly scopes_supported?: readonly string[];
}

/** Both discovery paths describe the same protected MCP resource. */
export const PROTECTED_RESOURCE_METADATA_PATHS: readonly string[] = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];

export const PROTECTED_RESOURCE_METADATA_ROOT_PATH = "/.well-known/oauth-protected-resource";

const SCOPE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return PROTECTED_RESOURCE_METADATA_PATHS.includes(pathname);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function parseTrustedUrl(value: string, name: string, requirePath: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${name} must use HTTPS`);
  }
  if (url.username !== "" || url.password !== "") throw new Error(`${name} must not contain credentials`);
  if (url.search !== "") throw new Error(`${name} must not contain a query`);
  if (url.hash !== "") throw new Error(`${name} must not contain a fragment`);
  if (requirePath && (url.pathname === "" || url.pathname === "/")) {
    throw new Error(`${name} must identify a protected resource path`);
  }
  return url;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export interface HostedOAuthConfigInput {
  readonly resourceUrl: string | undefined;
  readonly authorizationServers: string | undefined;
  readonly scopesSupported: string | undefined;
  /** Trusted issuer used when no explicit authorization server list is configured. */
  readonly defaultAuthorizationServer: string | undefined;
}

/** Validate and normalize the OAuth resource-server configuration once, at startup. */
export function parseHostedOAuthConfig(input: HostedOAuthConfigInput): HostedOAuthConfig {
  const resourceUrl = input.resourceUrl?.trim();
  if (!resourceUrl) throw new Error("EGA_HOSTED_RESOURCE_URL is required when hosted JWT authentication is configured");
  const resource = parseTrustedUrl(resourceUrl, "EGA_HOSTED_RESOURCE_URL", true);
  const resourceString = resource.toString();

  const authorizationServers: string[] = [];
  if (input.authorizationServers !== undefined && input.authorizationServers.trim() !== "") {
    for (const raw of input.authorizationServers.split(",")) {
      const value = raw.trim();
      if (!value) continue;
      authorizationServers.push(parseTrustedUrl(value, "EGA_HOSTED_AUTHORIZATION_SERVERS", false).toString());
    }
  } else if (input.defaultAuthorizationServer !== undefined && input.defaultAuthorizationServer.trim() !== "") {
    authorizationServers.push(parseTrustedUrl(input.defaultAuthorizationServer.trim(), "EGA_HOSTED_ISSUER", false).toString());
  }
  const servers = uniqueStrings(authorizationServers);
  if (servers.length === 0) {
    throw new Error("EGA_HOSTED_AUTHORIZATION_SERVERS or EGA_HOSTED_ISSUER is required when hosted JWT authentication is configured");
  }

  const scopes: string[] = [];
  if (input.scopesSupported !== undefined) {
    for (const raw of input.scopesSupported.split(/[\s,]+/)) {
      const value = raw.trim();
      if (!value) continue;
      if (!SCOPE_PATTERN.test(value)) throw new Error("EGA_HOSTED_OAUTH_SCOPES_SUPPORTED contains an invalid scope");
      scopes.push(value);
    }
  }

  return Object.freeze({
    resource: resourceString,
    resourceMetadataUrl: `${resource.origin}${PROTECTED_RESOURCE_METADATA_ROOT_PATH}`,
    authorizationServers: Object.freeze(servers),
    scopesSupported: Object.freeze(uniqueStrings(scopes)),
  });
}

/** Build the Protected Resource Metadata document for this resource. */
export function buildProtectedResourceMetadata(config: HostedOAuthConfig): HostedProtectedResourceMetadata {
  return {
    resource: config.resource,
    authorization_servers: [...config.authorizationServers],
    bearer_methods_supported: ["header"],
    ...(config.scopesSupported.length > 0 ? { scopes_supported: [...config.scopesSupported] } : {}),
  };
}

/** Build the `WWW-Authenticate` challenge advertising the metadata URL. */
export function buildWwwAuthenticate(config: HostedOAuthConfig, error?: "invalid_token"): string {
  const challenge = [
    ...(error ? [`error="${error}"`] : []),
    `resource_metadata="${config.resourceMetadataUrl}"`,
  ];
  return `Bearer ${challenge.join(", ")}`;
}
