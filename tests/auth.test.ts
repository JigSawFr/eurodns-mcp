import { describe, expect, it, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createLocalJWKSet } from 'jose';
import { ConfigError, loadConfig, type Config } from '../src/config.js';
import { JwtTokenVerifier, StaticTokenVerifier, scopesFrom } from '../src/auth/verifier.js';
import { discoveryCandidates } from '../src/auth/discovery.js';
import { ALL_SCOPES, DEFAULT_JWT_ALGORITHMS, SCOPES } from '../src/constants.js';

const ISSUER = 'https://issuer.example.com';
const AUDIENCE = 'https://mcp.example.com/mcp';

// jose no longer exports a key type; take it from the generator so it tracks the library.
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
});

function localKeys() {
  return createLocalJWKSet({ keys: [publicJwk] });
}

async function mintToken(claims: Record<string, unknown> = {}, audience = AUDIENCE) {
  return new SignJWT({ scope: ALL_SCOPES.join(' '), client_id: 'test-client', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject('user@example.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function verifier(
  overrides: Partial<{ subjectClaim: string; scopeClaim: string; algorithms: string[] }> = {},
) {
  return new JwtTokenVerifier(
    {
      issuer: ISSUER,
      audience: AUDIENCE,
      subjectClaim: 'sub',
      algorithms: [...DEFAULT_JWT_ALGORITHMS],
      ...overrides,
    },
    'https://unused.example.com/jwks',
    localKeys(),
  );
}

describe('JWT verification', () => {
  it('accepts a token issued for this server', async () => {
    const info = await verifier().verifyAccessToken(await mintToken());
    expect(info.scopes).toEqual(ALL_SCOPES);
    expect(info.clientId).toBe('test-client');
    expect((info.extra as { subject: string }).subject).toBe('user@example.com');
  });

  it('rejects a token issued for a different resource', async () => {
    // The confused-deputy case: a valid token from the same authorization server, minted
    // for another audience, must not be usable here.
    const token = await mintToken({}, 'https://other-service.example.com');
    await expect(verifier().verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token from a different issuer', async () => {
    const token = await new SignJWT({ scope: SCOPES.read })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://attacker.example.com')
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verifier().verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ scope: SCOPES.read })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('-1m')
      .sign(privateKey);

    await expect(verifier().verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token signed by an unknown key', async () => {
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({ scope: SCOPES.read })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(other.privateKey);

    await expect(verifier().verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token signed with an algorithm the server does not accept', async () => {
    // The server pins ES256 only; the token is a genuine RS256 token from the right issuer
    // for the right audience, signed by a key the JWKS publishes. Only the algorithm is
    // wrong, and that alone must be enough to refuse it.
    await expect(
      verifier({ algorithms: ['ES256'] }).verifyAccessToken(await mintToken()),
    ).rejects.toThrow();

    await expect(
      verifier({ algorithms: ['RS256'] }).verifyAccessToken(await mintToken()),
    ).resolves.toBeTruthy();
  });

  it('accepts no symmetric algorithm by default', () => {
    // An HMAC algorithm in the accepted set is what lets a leaked public key be replayed as
    // a signing secret. The default list must contain none.
    expect([...DEFAULT_JWT_ALGORITHMS].some((alg) => alg.startsWith('HS'))).toBe(false);
    expect([...DEFAULT_JWT_ALGORITHMS]).toContain('RS256');
  });

  it('reads scopes from whichever claim the authorization server uses', () => {
    expect(scopesFrom({ scope: 'a b' })).toEqual(['a', 'b']);
    expect(scopesFrom({ scp: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(scopesFrom({ roles: ['a'] })).toEqual(['a']);
    expect(scopesFrom({ custom: 'a b' }, 'custom')).toEqual(['a', 'b']);
    expect(scopesFrom({})).toEqual([]);
  });

  it('can take identity from a non-standard claim', async () => {
    const token = await mintToken({ preferred_username: 'someone@example.net' });
    const info = await verifier({ subjectClaim: 'preferred_username' }).verifyAccessToken(token);
    expect((info.extra as { subject: string }).subject).toBe('someone@example.net');
  });
});

describe('static token verification', () => {
  it('accepts the configured secret and rejects anything else', async () => {
    const verify = new StaticTokenVerifier('s'.repeat(40), 'ci-runner');
    const info = await verify.verifyAccessToken('s'.repeat(40));
    expect((info.extra as { subject: string }).subject).toBe('ci-runner');
    // The middleware requires an expiry to be present.
    expect(typeof info.expiresAt).toBe('number');

    await expect(verify.verifyAccessToken('x'.repeat(40))).rejects.toThrow();
    await expect(verify.verifyAccessToken('short')).rejects.toThrow();
  });
});

describe('authorization server discovery', () => {
  it('tries both metadata layouts for a root issuer', () => {
    expect(discoveryCandidates('https://issuer.example.com')).toEqual([
      'https://issuer.example.com/.well-known/oauth-authorization-server',
      'https://issuer.example.com/.well-known/openid-configuration',
    ]);
  });

  it('tries the path-insertion forms when the issuer carries a path', () => {
    const candidates = discoveryCandidates('https://issuer.example.com/tenant1');
    expect(candidates).toContain(
      'https://issuer.example.com/.well-known/oauth-authorization-server/tenant1',
    );
    expect(candidates).toContain(
      'https://issuer.example.com/tenant1/.well-known/openid-configuration',
    );
  });
});

describe('HTTP configuration', () => {
  const base = { EURODNS_APP_ID: 'a', EURODNS_API_KEY: 'b' };

  function http(env: Record<string, string>): Config {
    return loadConfig({ ...base, ...env } as NodeJS.ProcessEnv, 'http');
  }

  it('refuses to listen on a public interface without authentication', () => {
    expect(() => http({ HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() =>
      http({ HOST: '0.0.0.0', EURODNS_MCP_AUTH: 'token', EURODNS_MCP_TOKEN: 't'.repeat(32) }),
    ).not.toThrow();
  });

  it('allows an unauthenticated server on loopback for local development', () => {
    expect(() => http({ HOST: '127.0.0.1' })).not.toThrow();
  });

  it('rejects a static token short enough to guess', () => {
    expect(() => http({ EURODNS_MCP_AUTH: 'token', EURODNS_MCP_TOKEN: 'short' })).toThrow(
      ConfigError,
    );
  });

  it('requires an audience in OAuth mode, so foreign tokens can be rejected', () => {
    expect(() => http({ EURODNS_MCP_AUTH: 'oauth', EURODNS_OAUTH_ISSUER: ISSUER })).toThrow(
      /EURODNS_OAUTH_AUDIENCE/,
    );
    expect(() =>
      http({
        EURODNS_MCP_AUTH: 'oauth',
        EURODNS_OAUTH_ISSUER: ISSUER,
        EURODNS_MCP_PUBLIC_URL: AUDIENCE,
      }),
    ).not.toThrow();
  });

  it('requires an issuer in OAuth mode', () => {
    expect(() => http({ EURODNS_MCP_AUTH: 'oauth', EURODNS_OAUTH_AUDIENCE: AUDIENCE })).toThrow(
      /EURODNS_OAUTH_ISSUER/,
    );
  });
});
