import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthConfig } from '../config.js';
import { ALL_SCOPES } from '../constants.js';

/** Reads scopes from whichever claim the authorization server uses. */
export function scopesFrom(payload: JWTPayload, preferredClaim?: string): string[] {
  const candidates = preferredClaim ? [preferredClaim] : ['scope', 'scp', 'roles'];

  for (const claim of candidates) {
    const value = payload[claim];
    if (typeof value === 'string') return value.split(' ').filter((s) => s !== '');
    if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string');
  }
  return [];
}

/**
 * Validates a JWT access token issued by an external authorization server.
 *
 * The audience check is the important one: the specification requires a server to accept
 * only tokens issued for itself. Without it, a token minted for any other resource behind
 * the same authorization server would be accepted here — the confused-deputy problem.
 */
export class JwtTokenVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthConfig;
  private readonly getKey: JWTVerifyGetKey;

  constructor(config: OAuthConfig, jwksUri: string, getKey?: JWTVerifyGetKey) {
    this.config = config;
    this.getKey = getKey ?? createRemoteJWKSet(new URL(jwksUri));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.getKey, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        // Stated rather than inherited from the key set: a resource server that accepts
        // whatever the token declares is how algorithm confusion gets in.
        algorithms: this.config.algorithms,
      }));
    } catch (cause) {
      throw new InvalidTokenError(
        `Token rejected: ${cause instanceof Error ? cause.message : 'verification failed'}`,
      );
    }

    const subjectClaim = this.config.subjectClaim;
    const subject = payload[subjectClaim];

    return {
      token,
      clientId:
        typeof payload.client_id === 'string'
          ? payload.client_id
          : (payload.azp as string) || 'unknown',
      scopes: scopesFrom(payload, this.config.scopeClaim),
      expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
      extra: {
        mode: 'oauth',
        subject: typeof subject === 'string' ? subject : String(payload.sub ?? 'unknown'),
      },
    };
  }
}

/**
 * Validates a single shared secret, for service-to-service callers that have no user
 * identity of their own. Such a caller is not scope-checked: the deployment guardrails are
 * the only limit that applies to it.
 */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class StaticTokenVerifier implements OAuthTokenVerifier {
  private readonly expected: Buffer;
  private readonly label: string;

  constructor(token: string, label: string) {
    this.expected = digest(token);
    this.label = label;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Compared as digests rather than raw bytes: timingSafeEqual requires equal lengths, so
    // comparing directly would leak the expected length through an early return.
    const matches = timingSafeEqual(digest(token), this.expected);

    if (!matches) throw new InvalidTokenError('Token rejected');

    return {
      token,
      clientId: this.label,
      scopes: [...ALL_SCOPES],
      // The middleware requires an expiry; a shared secret is revoked by rotating it.
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { mode: 'token', subject: this.label },
    };
  }
}
