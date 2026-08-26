/**
 * Authorization-server discovery.
 *
 * The MCP specification requires clients to try both OAuth 2.0 Authorization Server
 * Metadata (RFC 8414) and OpenID Connect Discovery, including the path-insertion forms for
 * issuers that carry a path. This server needs the same document — for its `jwks_uri` and
 * to advertise the authorization server in its protected resource metadata — so it tries
 * the same candidates rather than assuming one layout.
 */

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  response_types_supported: string[];
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  [key: string]: unknown;
}

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/** The well-known URLs to try, in the order the specification lists them. */
export function discoveryCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  const origin = url.origin;

  if (path === '') {
    return [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/openid-configuration`,
    ];
  }

  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
}

export async function discoverAuthorizationServer(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthorizationServerMetadata> {
  const attempted: string[] = [];

  for (const candidate of discoveryCandidates(issuer)) {
    attempted.push(candidate);
    let response: Response;
    try {
      response = await fetchImpl(candidate, { headers: { Accept: 'application/json' } });
    } catch {
      continue;
    }
    if (!response.ok) continue;

    const metadata = (await response.json()) as AuthorizationServerMetadata;

    // A metadata document that names a different issuer must not be trusted.
    if (metadata.issuer !== issuer) {
      throw new DiscoveryError(
        `Authorization server metadata at ${candidate} declares issuer "${metadata.issuer}", ` +
          `which does not match the configured EURODNS_OAUTH_ISSUER "${issuer}".`,
      );
    }

    return metadata;
  }

  throw new DiscoveryError(
    `Could not discover authorization server metadata for "${issuer}". Tried: ${attempted.join(', ')}.`,
  );
}
