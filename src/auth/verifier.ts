import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import type { OAuthConfig } from '../config.js';
import { ALL_SCOPES } from '../constants.js';

/**
 * Reports a rejected token on stderr, once, before the error goes back to the caller.
 *
 * Without this a rejection is invisible to whoever runs the server: the SDK answers `401`
 * and the reason leaves with it. An operator watching the logs sees a healthy process
 * refusing every request and has nothing to go on — which is exactly how a misconfigured
 * `requestedAccessTokenVersion` costs an afternoon.
 *
 * `expected` carries configuration, never a credential. The token itself and every claim in
 * it stay out: a token in a log file is a token to rotate, and the claims carry personal
 * data that has no business being in an operational log.
 */
function reportRejection(reason: string, expected?: Record<string, string>): void {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      message: 'token rejected',
      reason,
      ...(expected ? { expected } : {}),
    })}\n`,
  );
}

/**
 * Reports a token that verified but carries no entitlements at all.
 *
 * Deliberately not `reportRejection`: nothing was rejected. The signature is valid, the
 * audience is right, and the caller will get a `403` from the scope gate rather than a
 * `401`. Saying "rejected" would send the operator hunting through issuer and audience
 * configuration for a problem that lives in the identity provider's assignments.
 */
function reportEmptyGrant(roleClaim: string): void {
  process.stderr.write(
    `${JSON.stringify({
      level: 'warn',
      message: 'token grants nothing',
      reason: `no "${roleClaim}" claim, so no permission survives the intersection`,
      expected: { roleClaim },
    })}\n`,
  );
}

/**
 * The claims an authorization server might put permissions in, tried in order. `scope` is
 * the RFC 9068 spelling; `scp` is Entra ID's delegated one; `roles` carries app-role
 * assignments — which Entra emits for a *user* as readily as for an application, so this is
 * a sensible last resort rather than an application-only case.
 */
const DEFAULT_SCOPE_CLAIMS = ['scope', 'scp', 'roles'];

/** Reads scopes from whichever claim the authorization server uses. */
export function scopesFrom(
  payload: JWTPayload,
  preferredClaim?: string,
  candidateClaims: readonly string[] = DEFAULT_SCOPE_CLAIMS,
): string[] {
  const candidates = preferredClaim ? [preferredClaim] : candidateClaims;

  for (const claim of candidates) {
    const value = payload[claim];
    if (typeof value === 'string') return value.split(' ').filter((s) => s !== '');
    if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string');
  }
  return [];
}

/**
 * What the caller may actually do — the scopes the rest of the server gates on.
 *
 * With no `roleClaim` configured this is `scopesFrom` and nothing more: whatever the token
 * says it was granted is what it was granted.
 *
 * With one, the two claims answer two different questions and both must say yes. The scope
 * claim carries what the *client* asked for and the authorization server agreed to issue —
 * under Entra ID that is a tenant-wide grant, identical for everybody. The role claim
 * carries what *this person* was assigned. Neither alone is the permission: a scope without
 * an assignment is a client asking for something its user may not have, and an assignment
 * without a scope is a permission the client never requested. The intersection is.
 */
export function effectiveScopes(payload: JWTPayload, config: OAuthConfig): string[] {
  const roleClaim = config.roleClaim;
  if (!roleClaim) return scopesFrom(payload, config.scopeClaim);

  // The role claim is removed from the fallback list first. Without this, a token carrying
  // `roles` but no `scp` would fall through to `roles` for *both* sides and intersect with
  // itself — a no-op that grants everything, silently, in exactly the deployment that asked
  // for the opposite. A test pins it.
  const granted = scopesFrom(
    payload,
    config.scopeClaim,
    DEFAULT_SCOPE_CLAIMS.filter((claim) => claim !== roleClaim),
  );

  if (payload[roleClaim] === undefined) {
    // Fail closed, and say so once. A token with no assignments at all is a configuration
    // symptom — roles never declared, or the caller left on the identity provider's default
    // access — and without this line the operator sees a healthy server refusing every tool
    // with nothing to go on. The claim's contents are never logged, only its absence.
    reportEmptyGrant(roleClaim);
    return [];
  }

  // Present but disjoint is not a misconfiguration, it is an authorization decision. No log.
  const entitled = entitledScopes(scopesFrom(payload, roleClaim), config.rolePrefix);
  return granted.filter((scope) => entitled.has(scope));
}

/**
 * Turns the raw values of the role claim into the scope names this server gates on.
 *
 * With no prefix configured a role value *is* a scope name, which is what an authorization
 * server that keeps roles and scopes apart allows.
 *
 * Microsoft Entra ID does not: app roles and delegated scopes share one namespace per
 * application, so a role cannot be called `eurodns.read` while a scope of that name is
 * already exposed — the portal answers "It contains duplicate value". The prefix is how a
 * role is named distinctly and still says which scope it stands for. Values that do not
 * carry it are dropped rather than kept: a directory hands out roles for its own purposes,
 * and none of them are permissions here.
 */
function entitledScopes(values: string[], prefix: string): Set<string> {
  if (prefix === '') return new Set(values);
  return new Set(
    values
      .filter((value) => value.startsWith(prefix))
      .map((value) => value.slice(prefix.length))
      .filter((scope) => scope !== ''),
  );
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
      // jose names the offending claim — `unexpected "aud" claim value`, `unexpected "iss"
      // claim value`, `"exp" claim timestamp check failed` — so the message is the diagnosis.
      const reason = cause instanceof Error ? cause.message : 'verification failed';
      reportRejection(reason, {
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
      throw new OAuthError(OAuthErrorCode.InvalidToken, `Token rejected: ${reason}`);
    }

    const subjectClaim = this.config.subjectClaim;
    const subject = payload[subjectClaim];

    return {
      token,
      clientId:
        typeof payload.client_id === 'string'
          ? payload.client_id
          : (payload.azp as string) || 'unknown',
      scopes: effectiveScopes(payload, this.config),
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

    if (!matches) {
      // No `expected` here: the only thing this verifier compares against is the secret.
      reportRejection('static token does not match EURODNS_MCP_TOKEN');
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token rejected');
    }

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
