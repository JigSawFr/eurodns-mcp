import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { DEFAULT_JWT_ALGORITHMS } from '../src/constants.js';
import { startupLine } from '../src/server.js';
import { toolScopeIndex } from '../src/tools/registry.js';
import { connect } from './harness.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The two credentials every configuration needs, so a case can vary one thing. */
const base = { EURODNS_APP_ID: 'app', EURODNS_API_KEY: 'key' };

describe('what the configuration refuses', () => {
  // Each of these is a promise docs/configuration.md makes to a reader. A refusal that
  // stopped refusing would leave the page describing behaviour the code no longer has.

  it('needs both credentials, and names the one that is missing', () => {
    expect(() => loadConfig({ EURODNS_API_KEY: 'key' }, 'stdio')).toThrow(/EURODNS_APP_ID/);
    expect(() => loadConfig({ EURODNS_APP_ID: 'app' }, 'stdio')).toThrow(/EURODNS_API_KEY/);
  });

  it('rejects a boolean spelling it does not know, rather than reading it as false', () => {
    // The dangerous failure would be silence: a guardrail switch that reads as off because
    // of a spelling looks identical to one deliberately left off.
    expect(() => loadConfig({ ...base, EURODNS_READ_ONLY: 'yes' }, 'stdio')).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, EURODNS_ALLOW_BILLING: 'on' }, 'stdio')).toThrow(
      ConfigError,
    );
    expect(loadConfig({ ...base, EURODNS_READ_ONLY: 'true' }, 'stdio').guardrails.readOnly).toBe(
      true,
    );
    expect(loadConfig({ ...base, EURODNS_READ_ONLY: '1' }, 'stdio').guardrails.readOnly).toBe(true);
    expect(loadConfig({ ...base, EURODNS_READ_ONLY: '' }, 'stdio').guardrails.readOnly).toBe(false);
  });

  it('will not write the audit log to a file it was not given', () => {
    expect(() => loadConfig({ ...base, EURODNS_AUDIT_DESTINATION: 'file' }, 'stdio')).toThrow(
      /EURODNS_AUDIT_FILE/,
    );
  });

  it('refuses stdout under stdio, where it would corrupt the protocol stream', () => {
    expect(() => loadConfig({ ...base, EURODNS_AUDIT_DESTINATION: 'stdout' }, 'stdio')).toThrow(
      /JSON-RPC/,
    );
    // The same setting is legitimate over HTTP, where stdout carries nothing else.
    expect(
      loadConfig({ ...base, EURODNS_AUDIT_DESTINATION: 'stdout', EURODNS_MCP_AUTH: 'none' }, 'http')
        .audit.destination,
    ).toBe('stdout');
  });

  it('refuses to listen off loopback without authentication', () => {
    expect(() => loadConfig({ ...base, HOST: '0.0.0.0' }, 'http')).toThrow(/EURODNS_MCP_AUTH/);
    // Loopback is the one place it is allowed, because nothing off the host can reach it.
    expect(loadConfig({ ...base, HOST: '127.0.0.1' }, 'http').http.authMode).toBe('none');
  });

  it('insists on a token long enough to be worth having', () => {
    expect(() =>
      loadConfig({ ...base, EURODNS_MCP_AUTH: 'token', EURODNS_MCP_TOKEN: 'short' }, 'http'),
    ).toThrow(/32 characters/);
    expect(() =>
      loadConfig({ ...base, EURODNS_MCP_AUTH: 'none', EURODNS_METRICS_TOKEN: 'short' }, 'http'),
    ).toThrow(/32 characters/);
  });

  it('will not enable OAuth without an issuer or an audience to check against', () => {
    expect(() => loadConfig({ ...base, EURODNS_MCP_AUTH: 'oauth' }, 'http')).toThrow(
      /EURODNS_OAUTH_ISSUER/,
    );
    expect(() =>
      loadConfig(
        { ...base, EURODNS_MCP_AUTH: 'oauth', EURODNS_OAUTH_ISSUER: 'https://issuer.example' },
        'http',
      ),
    ).toThrow(/EURODNS_OAUTH_AUDIENCE/);
  });

  it('falls back to the public URL as the audience, since that is what a token names', () => {
    const config = loadConfig(
      {
        ...base,
        EURODNS_MCP_AUTH: 'oauth',
        EURODNS_OAUTH_ISSUER: 'https://issuer.example',
        EURODNS_MCP_PUBLIC_URL: 'https://mcp.example.com',
      },
      'http',
    );
    expect(config.http.oauth?.audience).toBe('https://mcp.example.com');
    expect(config.http.oauth?.algorithms).toEqual([...DEFAULT_JWT_ALGORITHMS]);
    expect(config.http.oauth?.subjectClaim).toBe('sub');
  });

  it('normalizes the scope prefix, and leaves it empty when unset', () => {
    const withPrefix = (prefix?: string) =>
      loadConfig(
        {
          ...base,
          EURODNS_MCP_AUTH: 'oauth',
          EURODNS_OAUTH_ISSUER: 'https://issuer.example',
          EURODNS_OAUTH_AUDIENCE: 'api://x',
          ...(prefix === undefined ? {} : { EURODNS_OAUTH_SCOPE_PREFIX: prefix }),
        },
        'http',
      ).http.oauth?.scopePrefix;

    // Unset is the whole of the previous behaviour: scopes advertised as they are named.
    expect(withPrefix()).toBe('');
    expect(withPrefix('   ')).toBe('');

    // Both forms are the same thing to whoever types it, and only one concatenates.
    expect(withPrefix('api://x')).toBe('api://x/');
    expect(withPrefix('api://x/')).toBe('api://x/');
    expect(withPrefix('  api://x  ')).toBe('api://x/');
  });

  it('reads the role claim, and treats blank as unset', () => {
    const withRoleClaim = (roleClaim?: string) =>
      loadConfig(
        {
          ...base,
          EURODNS_MCP_AUTH: 'oauth',
          EURODNS_OAUTH_ISSUER: 'https://issuer.example',
          EURODNS_OAUTH_AUDIENCE: 'api://x',
          ...(roleClaim === undefined ? {} : { EURODNS_OAUTH_ROLE_CLAIM: roleClaim }),
        },
        'http',
      ).http.oauth?.roleClaim;

    // Unset must stay undefined rather than become an empty string: `effectiveScopes`
    // branches on the value being falsy, and an empty claim name would read every token as
    // carrying no assignments and grant nothing at all.
    expect(withRoleClaim()).toBeUndefined();
    expect(withRoleClaim('   ')).toBeUndefined();
    expect(withRoleClaim('  roles  ')).toBe('roles');
  });

  it('refuses a role claim that is the scope claim, which would intersect nothing', () => {
    // The failure this prevents is silent and points the wrong way: both sides read the same
    // claim, every token intersects with itself, and the deployment that asked to grant less
    // grants everything.
    expect(() =>
      loadConfig(
        {
          ...base,
          EURODNS_MCP_AUTH: 'oauth',
          EURODNS_OAUTH_ISSUER: 'https://issuer.example',
          EURODNS_OAUTH_AUDIENCE: 'api://x',
          EURODNS_OAUTH_SCOPE_CLAIM: 'roles',
          EURODNS_OAUTH_ROLE_CLAIM: 'roles',
        },
        'http',
      ),
    ).toThrow(ConfigError);
  });

  it('refuses an algorithm list that names nothing, rather than accepting everything', () => {
    expect(() =>
      loadConfig(
        {
          ...base,
          EURODNS_MCP_AUTH: 'oauth',
          EURODNS_OAUTH_ISSUER: 'https://issuer.example',
          EURODNS_OAUTH_AUDIENCE: 'api://x',
          EURODNS_OAUTH_ALGORITHMS: ' , ',
        },
        'http',
      ),
    ).toThrow(/names no algorithm/);
  });

  it('rejects a non-numeric count where it wants an integer', () => {
    expect(() => loadConfig({ ...base, EURODNS_TIMEOUT_MS: 'soon' }, 'stdio')).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, EURODNS_TIMEOUT_MS: '0' }, 'stdio')).toThrow(ConfigError);
    // Zero is meaningful for the limiter — it turns it off — so it is accepted there.
    expect(
      loadConfig({ ...base, EURODNS_RATE_LIMIT: '0', EURODNS_MCP_AUTH: 'none' }, 'http').http
        .rateLimit,
    ).toBe(0);
    expect(() =>
      loadConfig({ ...base, EURODNS_RATE_LIMIT: '-1', EURODNS_MCP_AUTH: 'none' }, 'http'),
    ).toThrow(ConfigError);
  });

  it('trusts no proxy unless told how many there are', () => {
    expect(loadConfig({ ...base, EURODNS_MCP_AUTH: 'none' }, 'http').http.trustProxy).toBe(0);
    expect(
      loadConfig({ ...base, EURODNS_MCP_AUTH: 'none', EURODNS_TRUST_PROXY: '2' }, 'http').http
        .trustProxy,
    ).toBe(2);
  });

  it('ignores the HTTP settings entirely under stdio', () => {
    // Validating them there would complain about settings that do nothing, which is how a
    // stdio user ends up editing variables that were never read.
    const config = loadConfig({ ...base, HOST: '0.0.0.0', EURODNS_MCP_TOKEN: 'x' }, 'stdio');
    expect(config.http.authMode).toBe('none');
  });
});

describe('the line an operator sees at startup', () => {
  const config = (env: Record<string, string> = {}) => loadConfig({ ...base, ...env }, 'stdio');

  it('names each hidden class and the variable that reveals it', () => {
    // Hiding a tool costs discoverability: it no longer answers with the variable that
    // would enable it. This line is the only thing the operator gets instead.
    const line = startupLine({ config: config(), toolCount: 63 });
    expect(line).toContain('63 tools');
    expect(line).toContain('billing (EURODNS_ALLOW_BILLING)');
    expect(line).toContain('irreversible (EURODNS_ALLOW_DESTRUCTIVE)');
  });

  it('collapses to one statement in read-only mode', () => {
    const line = startupLine({ config: config({ EURODNS_READ_ONLY: 'true' }), toolCount: 37 });
    expect(line).toContain('everything that changes state (EURODNS_READ_ONLY)');
    expect(line).not.toContain('EURODNS_ALLOW_BILLING');
  });

  it('mentions nothing hidden when nothing is', () => {
    const line = startupLine({
      config: config({ EURODNS_ALLOW_BILLING: 'true', EURODNS_ALLOW_DESTRUCTIVE: 'true' }),
      toolCount: 82,
    });
    expect(line).toContain('82 tools');
    expect(line).not.toContain('hidden');
  });

  it('says where it listens on HTTP, and only there', () => {
    const listening = startupLine({
      config: config(),
      toolCount: 63,
      endpoint: { url: 'http://0.0.0.0:3000/mcp', authMode: 'token' },
    });
    expect(listening).toContain('listening on http://0.0.0.0:3000/mcp');
    expect(listening).toContain('auth: token');

    expect(startupLine({ config: config(), toolCount: 63 })).toContain('ready on stdio');
  });
});

describe('the scope gate and the handler agree on what exists', () => {
  it('has a scope requirement registered for every advertised tool', async () => {
    // The two gates are deliberate: the HTTP middleware refuses before dispatch, and the
    // handler refuses again. But the middleware can only refuse what it knows about — a
    // tool missing from toolScopeIndex is waved straight through it. That failure is
    // silent, and this is what makes it loud.
    const config = loadConfig(
      {
        ...base,
        EURODNS_ALLOW_BILLING: 'true',
        EURODNS_ALLOW_DESTRUCTIVE: 'true',
        EURODNS_AUDIT_DESTINATION: 'file',
        EURODNS_AUDIT_FILE: join(mkdtempSync(join(tmpdir(), 'eurodns-scope-')), 'audit.jsonl'),
        EURODNS_AUDIT_QUERY: 'all',
      },
      'stdio',
    );

    const { client, close } = await connect({ config });
    const { tools } = await client.listTools();
    const index = toolScopeIndex();

    const missing = tools.map((t) => t.name).filter((name) => !index.has(name));
    expect(missing, `no scope requirement registered for: ${missing.join(', ')}`).toEqual([]);
    expect(tools.length).toBeGreaterThan(60);
    await close();
  });
});
