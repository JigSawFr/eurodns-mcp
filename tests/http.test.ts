import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createApp, originGuard } from '../src/http.js';
import { scopeGate } from '../src/auth/scopeGate.js';
import { identityFrom, toolScopeIndex } from '../src/tools/registry.js';
import { loadConfig, type Config } from '../src/config.js';
import { ALL_SCOPES, AUDIT_SCOPE, SCOPES } from '../src/constants.js';
import { stubFetch } from './harness.js';

const ISSUER = 'https://issuer.example.com';
const PUBLIC_URL = 'https://mcp.example.com/mcp';

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

/** Serves the authorization-server metadata document discovery would fetch. */
function discoveryFetch(): typeof fetch {
  return (async (url: string | URL) =>
    String(url).includes('.well-known')
      ? new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            response_types_supported: ['code'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      : new Response('not found', { status: 404 })) as unknown as typeof fetch;
}

function httpConfig(env: Record<string, string> = {}): Config {
  return loadConfig(
    {
      EURODNS_APP_ID: 'test-app-id',
      EURODNS_API_KEY: 'test-api-key',
      EURODNS_MAX_RETRIES: '0',
      EURODNS_AUDIT_DESTINATION: 'none',
      ...env,
    } as NodeJS.ProcessEnv,
    'http',
  );
}

function oauthConfig(env: Record<string, string> = {}): Config {
  return httpConfig({
    EURODNS_MCP_AUTH: 'oauth',
    EURODNS_OAUTH_ISSUER: ISSUER,
    EURODNS_MCP_PUBLIC_URL: PUBLIC_URL,
    ...env,
  });
}

async function token(scopes: string[], audience = PUBLIC_URL) {
  return new SignJWT({ scope: scopes.join(' '), client_id: 'test-client' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject('alice@example.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** Builds the app with a local key set, so no JWKS is fetched over the network. */
async function oauthApp(config: Config, fetchImpl?: ReturnType<typeof stubFetch>['fetchImpl']) {
  return createApp(config, {
    discoveryFetch: discoveryFetch(),
    jwtKeyResolver: createLocalJWKSet({ keys: [publicJwk] }),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

const listToolsBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

function callTool(name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } };
}

describe('origin guard', () => {
  it('lets through requests with no Origin, which browsers always send', () => {
    const guard = originGuard([]);
    let called = false;
    guard({ headers: {} } as never, {} as never, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('rejects an origin that was not allowed', async () => {
    const app = await createApp(httpConfig());
    const response = await request(app)
      .post('/mcp')
      .set('Origin', 'https://evil.example.com')
      .send(listToolsBody);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden_origin');
  });

  it('accepts an allowed origin', async () => {
    const app = await createApp(httpConfig({ EURODNS_ALLOWED_ORIGINS: 'https://app.example.com' }));
    const response = await request(app)
      .post('/mcp')
      .set('Origin', 'https://app.example.com')
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsBody);

    expect(response.status).toBe(200);
  });
});

describe('OAuth protected resource', () => {
  it('answers an unauthenticated call with 401 and points at its metadata', async () => {
    const app = await oauthApp(oauthConfig());
    const response = await request(app).post('/mcp').send(listToolsBody);

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('publishes RFC 9728 protected resource metadata', async () => {
    const app = await oauthApp(oauthConfig());
    const response = await request(app).get('/.well-known/oauth-protected-resource/mcp');

    expect(response.status).toBe(200);
    expect(response.body.resource).toBe(PUBLIC_URL);
    expect(response.body.authorization_servers).toEqual([ISSUER]);
    expect(response.body.scopes_supported).toEqual(ALL_SCOPES);
  });

  it('accepts a token issued for this server', async () => {
    const app = await oauthApp(oauthConfig());
    const response = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${await token(ALL_SCOPES)}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsBody);

    expect(response.status).toBe(200);
  });

  it('rejects a token minted for another resource', async () => {
    const app = await oauthApp(oauthConfig());
    const response = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${await token(ALL_SCOPES, 'https://other.example.com')}`)
      .send(listToolsBody);

    expect(response.status).toBe(401);
  });

  it('asks for a step-up when the token lacks the scope for the call', async () => {
    const app = await oauthApp(oauthConfig());
    const response = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${await token([SCOPES.read])}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(
        callTool('eurodns_dns_upsert_record', {
          domainName: 'example.com',
          type: 'A',
          host: 'www',
          rdata: '203.0.113.1',
        }),
      );

    expect(response.status).toBe(403);
    expect(response.headers['www-authenticate']).toContain('error="insufficient_scope"');
    expect(response.headers['www-authenticate']).toContain(`scope="${SCOPES.write}"`);
  });

  it('lets a read call through on the read scope alone', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: { name: 'example.com', records: [] } }));
    const app = await oauthApp(oauthConfig(), fetchImpl);
    const response = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${await token([SCOPES.read])}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(callTool('eurodns_dns_get_zone', { domainName: 'example.com' }));

    expect(response.status).toBe(200);
  });

  it('never forwards the caller’s token to the upstream API', async () => {
    const clientToken = await token(ALL_SCOPES);
    const { fetchImpl, requests } = stubFetch(() => ({ body: { name: 'example.com' } }));
    const app = await oauthApp(oauthConfig(), fetchImpl);

    await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${clientToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(callTool('eurodns_dns_get_zone', { domainName: 'example.com' }));

    expect(requests).toHaveLength(1);
    const upstream = requests[0];
    // The specification forbids passing the client's token upstream. The API gets the
    // server's own credentials and nothing else.
    expect(upstream?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(upstream?.headers)).not.toContain(clientToken);
    expect(upstream?.headers['x-api-key']).toBe('test-api-key');
  });
});

describe('static token mode', () => {
  const secret = 'k'.repeat(48);

  it('rejects a wrong secret and accepts the right one', async () => {
    const config = httpConfig({
      EURODNS_MCP_AUTH: 'token',
      EURODNS_MCP_TOKEN: secret,
      EURODNS_MCP_TOKEN_LABEL: 'ci-runner',
    });
    const app = await createApp(config);

    const denied = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer wrong')
      .send(listToolsBody);
    expect(denied.status).toBe(401);

    const allowed = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${secret}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsBody);
    expect(allowed.status).toBe(200);
  });
});

describe('health endpoint', () => {
  it('reports readiness without authentication', async () => {
    const app = await createApp(httpConfig());
    const response = await request(app).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('tells an unauthenticated caller nothing about the build', async () => {
    // The endpoint has to stay open for platform health checks, so it must not double as a
    // free version banner — that is the first thing an attacker looks up.
    const app = await createApp(httpConfig());
    const response = await request(app).get('/healthz');

    expect(response.body.version).toBeUndefined();
    expect(response.body.server).toBeUndefined();
    expect(Object.keys(response.body as object)).toEqual(['status']);
  });
});

describe('exposure of the server itself', () => {
  it('does not announce the framework', async () => {
    const app = await createApp(httpConfig());
    const response = await request(app).get('/healthz');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('refuses a body larger than the configured limit', async () => {
    const app = await createApp(
      httpConfig({ EURODNS_MCP_AUTH: 'token', EURODNS_MCP_TOKEN: 'k'.repeat(48) }),
    );

    const response = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...listToolsBody, padding: 'x'.repeat(2 * 1024 * 1024) }));

    expect(response.status).toBe(413);
  });

  it('rejects a foreign origin before parsing the body it carries', async () => {
    // The order matters: a cross-origin caller should not get the parser to chew through a
    // megabyte of JSON before being told no.
    const app = await createApp(httpConfig());
    const response = await request(app)
      .post('/mcp')
      .set('Origin', 'https://evil.example.com')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden_origin');
  });
});

describe('the scope gate fails closed', () => {
  it('refuses a request that reaches it with no verified identity', () => {
    // Only reachable if the middleware chain is reordered or the bearer check is removed.
    // The point of the test is that such a mistake denies rather than opens everything.
    const gate = scopeGate(toolScopeIndex());
    let passed = false;
    const captured: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
      },
      set() {
        return this;
      },
    };

    gate(
      { auth: undefined, body: callTool('eurodns_dns_get_zone', {}) } as never,
      res as never,
      () => {
        passed = true;
      },
    );

    expect(passed).toBe(false);
    expect(captured.status).toBe(403);
  });

  it('grants nothing when OAuth is on and no identity reached the handler', () => {
    const context = {
      fallbackActor: { mode: 'none' as const, subject: 'anonymous' },
      requireScopes: true,
    } as never;
    // An empty grant, not an absent one: absent means "this transport has no identities",
    // which under OAuth would skip the scope check entirely.
    expect(identityFrom(context, undefined).scopes).toEqual([]);

    const stdio = {
      fallbackActor: { mode: 'stdio' as const, subject: 'someone' },
      requireScopes: false,
    } as never;
    expect(identityFrom(stdio, undefined).scopes).toBeUndefined();
  });
});

describe('audit scope', () => {
  const auditLog = () => {
    const dir = mkdtempSync(join(tmpdir(), 'eurodns-http-audit-'));
    const path = join(dir, 'audit.jsonl');
    writeFileSync(path, '', 'utf8');
    return path;
  };

  it('is not granted by the read scope', async () => {
    const app = await oauthApp(
      oauthConfig({
        EURODNS_AUDIT_DESTINATION: 'file',
        EURODNS_AUDIT_FILE: auditLog(),
        EURODNS_AUDIT_QUERY: 'all',
      }),
    );

    const response = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${await token([SCOPES.read])}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(callTool('eurodns_audit_query', {}));

    expect(response.status).toBe(403);
    expect(response.headers['www-authenticate']).toContain(`scope="${AUDIT_SCOPE}"`);
  });

  it('lets the audit scope through', async () => {
    const app = await oauthApp(
      oauthConfig({
        EURODNS_AUDIT_DESTINATION: 'file',
        EURODNS_AUDIT_FILE: auditLog(),
        EURODNS_AUDIT_QUERY: 'all',
      }),
    );

    const response = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${await token([AUDIT_SCOPE])}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(callTool('eurodns_audit_query', {}));

    expect(response.status).toBe(200);
  });
});

describe('both protocol eras on one endpoint', () => {
  // The 2026-07-28 revision removed `initialize` and routes on headers instead. A modern
  // request is one carrying the `_meta` envelope claim *and* the matching headers; anything
  // without the claim is classified 2025-era and served by the legacy fallback. Both paths
  // matter: the new spec is what this server now speaks, and 2025 is what most clients
  // still are.
  const modern = (app: Awaited<ReturnType<typeof createApp>>, method: string) =>
    request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${'k'.repeat(48)}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', method)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      });

  const tokenApp = () =>
    createApp(
      loadConfig(
        {
          EURODNS_APP_ID: 'a',
          EURODNS_API_KEY: 'b',
          EURODNS_MAX_RETRIES: '0',
          EURODNS_AUDIT_DESTINATION: 'none',
          EURODNS_MCP_AUTH: 'token',
          EURODNS_MCP_TOKEN: 'k'.repeat(48),
        } as NodeJS.ProcessEnv,
        'http',
      ),
    );

  /** The transport answers either as one JSON body or as a single SSE frame. */
  const payload = (res: { text: string; body: unknown }): Record<string, unknown> => {
    const frame = res.text.split('\n').find((l) => l.startsWith('data: '));
    return (frame ? JSON.parse(frame.slice(6)) : res.body) as Record<string, unknown>;
  };

  it('answers server/discover, which replaced the initialize handshake', async () => {
    const response = await modern(await tokenApp(), 'server/discover');
    const result = payload(response).result as Record<string, unknown>;

    expect(response.status).toBe(200);
    // Fields the 2026-07-28 revision introduced: a typed result and cacheable list metadata.
    expect(result).toHaveProperty('resultType');
    expect(result).toHaveProperty('supportedVersions');
  });

  it('serves the full tool surface over the modern path', async () => {
    const response = await modern(await tokenApp(), 'tools/list');
    const result = payload(response).result as { tools: unknown[] };

    expect(response.status).toBe(200);
    expect(result.tools.length).toBeGreaterThanOrEqual(80);
  });

  it('still serves a 2025-era client on the same endpoint', async () => {
    // No envelope claim, and an `initialize` handshake: the legacy classification, which
    // `legacy: 'stateless'` answers rather than rejects.
    const response = await request(await tokenApp())
      .post('/mcp')
      .set('Authorization', `Bearer ${'k'.repeat(48)}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy', version: '0' },
        },
      });

    const result = payload(response).result as { protocolVersion: string };
    expect(response.status).toBe(200);
    expect(result.protocolVersion).toBe('2025-11-25');
  });

  it('refuses an unauthenticated modern request like any other', async () => {
    const response = await request(await tokenApp())
      .post('/mcp')
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', 'tools/list')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(response.status).toBe(401);
  });
});
