import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createLocalJWKSet } from 'jose';
import { ConfigError, loadConfig, type Config } from '../src/config.js';
import {
  JwtTokenVerifier,
  StaticTokenVerifier,
  effectiveScopes,
  scopesFrom,
} from '../src/auth/verifier.js';
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
  overrides: Partial<{
    subjectClaim: string;
    scopeClaim: string;
    roleClaim: string;
    rolePrefix: string;
    algorithms: string[];
  }> = {},
) {
  return new JwtTokenVerifier(
    {
      issuer: ISSUER,
      audience: AUDIENCE,
      subjectClaim: 'sub',
      algorithms: [...DEFAULT_JWT_ALGORITHMS],
      scopePrefix: '',
      rolePrefix: '',
      ...overrides,
    },
    'https://unused.example.com/jwks',
    localKeys(),
  );
}

/**
 * Collects what the process writes to stderr, so a test can read the operational log the way
 * whoever runs the server would.
 */
function captureStderr(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  return { lines: () => written, restore: () => spy.mockRestore() };
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

describe('what a rejection tells the operator', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the claim that failed, and what was expected instead', async () => {
    const capture = captureStderr();
    // A token minted for somebody else: the audience check is the one that must catch it.
    await expect(
      verifier().verifyAccessToken(await mintToken({}, 'https://elsewhere.example.com')),
    ).rejects.toThrow();
    capture.restore();

    const entry = JSON.parse(capture.lines().join('').trim()) as {
      level: string;
      message: string;
      reason: string;
      expected: { issuer: string; audience: string };
    };
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('token rejected');
    expect(entry.reason).toContain('aud');
    // Without this half the line says something failed but not what would have passed.
    expect(entry.expected.audience).toBe(AUDIENCE);
    expect(entry.expected.issuer).toBe(ISSUER);
  });

  it('says so when the static secret does not match', async () => {
    const capture = captureStderr();
    await expect(
      new StaticTokenVerifier('s'.repeat(40), 'ci-runner').verifyAccessToken('x'.repeat(40)),
    ).rejects.toThrow();
    capture.restore();

    expect(capture.lines().join('')).toContain('EURODNS_MCP_TOKEN');
  });

  /**
   * The guard. A log line is written to be read by people and shipped to collectors, so
   * anything in it outlives the request by a long way. A token there is a token to rotate,
   * and the claims around it carry personal data.
   *
   * This is the assertion that stops a future "let's make the diagnosis richer" from
   * quietly putting the credential in the log.
   */
  it('never writes the token, or anything out of it, into the log', async () => {
    const token = await mintToken({}, 'https://elsewhere.example.com');
    const capture = captureStderr();
    await expect(verifier().verifyAccessToken(token)).rejects.toThrow();
    await expect(
      new StaticTokenVerifier('s'.repeat(40), 'ci-runner').verifyAccessToken('x'.repeat(40)),
    ).rejects.toThrow();
    capture.restore();

    const logged = capture.lines().join('');
    expect(logged).not.toContain(token);
    // Nor any of its three segments on their own, nor the claims they decode to.
    for (const segment of token.split('.')) expect(logged).not.toContain(segment);
    expect(logged).not.toContain('user@example.com');
    expect(logged).not.toContain('test-client');
    expect(logged).not.toContain('x'.repeat(40));
  });
});

describe('when the identity provider decides per person', () => {
  const base = {
    issuer: ISSUER,
    audience: AUDIENCE,
    subjectClaim: 'sub',
    algorithms: [...DEFAULT_JWT_ALGORITHMS],
    scopePrefix: '',
    rolePrefix: '',
  };

  afterEach(() => vi.restoreAllMocks());

  it("leaves the token's own scopes alone when no role claim is configured", () => {
    // The regression guard. Every deployment that has not asked for this must be untouched.
    expect(effectiveScopes({ scp: ['a', 'b'] }, base)).toEqual(['a', 'b']);
    expect(effectiveScopes({ scp: ['a'], roles: ['b'] }, base)).toEqual(['a']);
  });

  it('grants only what the client asked for and the person was assigned', () => {
    const config = { ...base, roleClaim: 'roles' };
    // The client requests everything — under Entra ID consent is tenant-wide, so it always
    // will. The assignment is what narrows it.
    const payload = { scp: [...ALL_SCOPES], roles: [SCOPES.read, SCOPES.write] };
    expect(effectiveScopes(payload, config)).toEqual([SCOPES.read, SCOPES.write]);
  });

  it('grants nothing for a scope the client never requested, however assigned', () => {
    const config = { ...base, roleClaim: 'roles' };
    const payload = { scp: [SCOPES.read], roles: [SCOPES.read, SCOPES.destructive] };
    expect(effectiveScopes(payload, config)).toEqual([SCOPES.read]);
  });

  /**
   * The trap this whole design walks past.
   *
   * `scopesFrom` falls back through `scope`, `scp`, `roles`. A token with `roles` but no
   * `scp` would therefore read `roles` for *both* sides of the intersection and match itself
   * — granting everything, in exactly the deployment that configured this to grant less.
   * Removing the filter in `effectiveScopes` turns this test, and only this test, red.
   */
  it('never intersects the role claim with itself', () => {
    const config = { ...base, roleClaim: 'roles' };
    expect(effectiveScopes({ roles: [...ALL_SCOPES] }, config)).toEqual([]);
  });

  it('grants nothing, and says so once, when the token carries no roles at all', () => {
    const capture = captureStderr();
    const granted = effectiveScopes({ scp: [...ALL_SCOPES] }, { ...base, roleClaim: 'roles' });
    capture.restore();

    expect(granted).toEqual([]);
    const entry = JSON.parse(capture.lines().join('').trim()) as {
      level: string;
      message: string;
      expected: { roleClaim: string };
    };
    // Not "token rejected": the token verified. Calling it a rejection sends the operator
    // looking at issuer and audience for a problem that lives in the assignments.
    expect(entry.level).toBe('warn');
    expect(entry.message).toBe('token grants nothing');
    expect(entry.expected.roleClaim).toBe('roles');
  });

  it('stays quiet when the roles are present but simply do not match', () => {
    const capture = captureStderr();
    const granted = effectiveScopes(
      { scp: [SCOPES.destructive], roles: [SCOPES.read] },
      { ...base, roleClaim: 'roles' },
    );
    capture.restore();

    // An authorization decision, not a misconfiguration. Logging it would bury the line
    // above under noise from every under-privileged caller.
    expect(granted).toEqual([]);
    expect(capture.lines()).toEqual([]);
  });

  it('reads roles as a list or as a space-separated string', () => {
    const config = { ...base, roleClaim: 'roles' };
    const scp = [SCOPES.read, SCOPES.write];
    expect(effectiveScopes({ scp, roles: [SCOPES.read] }, config)).toEqual([SCOPES.read]);
    expect(effectiveScopes({ scp, roles: SCOPES.read }, config)).toEqual([SCOPES.read]);
  });

  /**
   * Entra ID keeps app roles and delegated scopes in one namespace per application, so a
   * role cannot be named `eurodns.read` while a scope of that name is exposed — the portal
   * answers "It contains duplicate value". The prefix is how a role is named distinctly and
   * still says which scope it stands for.
   */
  it('strips the prefix the identity provider forces onto role names', () => {
    const config = { ...base, roleClaim: 'roles', rolePrefix: 'role.' };
    const payload = {
      scp: [...ALL_SCOPES],
      roles: [`role.${SCOPES.read}`, `role.${SCOPES.write}`],
    };
    expect(effectiveScopes(payload, config)).toEqual([SCOPES.read, SCOPES.write]);
  });

  it('ignores role values that do not carry the prefix', () => {
    // A directory hands out roles for its own purposes. None of them are permissions here,
    // and an unprefixed value that happens to read like a scope must not become one.
    const config = { ...base, roleClaim: 'roles', rolePrefix: 'role.' };
    const payload = { scp: [...ALL_SCOPES], roles: [SCOPES.destructive, 'Directory.Reader'] };
    expect(effectiveScopes(payload, config)).toEqual([]);
  });

  it('treats the prefix on its own as naming no scope', () => {
    const config = { ...base, roleClaim: 'roles', rolePrefix: 'role.' };
    expect(effectiveScopes({ scp: [...ALL_SCOPES], roles: ['role.'] }, config)).toEqual([]);
  });

  it('applies the intersection to a real token, end to end', async () => {
    const token = await mintToken({ scope: undefined, scp: [...ALL_SCOPES], roles: [SCOPES.read] });
    const info = await verifier({ roleClaim: 'roles' }).verifyAccessToken(token);
    expect(info.scopes).toEqual([SCOPES.read]);
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
