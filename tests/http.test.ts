import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from 'jose';
import { createApp, originGuard } from '../src/http.js';
import { loadConfig, type Config } from '../src/config.js';
import { ALL_SCOPES, SCOPES } from '../src/constants.js';
import { stubFetch } from './harness.js';

const ISSUER = 'https://issuer.example.com';
const PUBLIC_URL = 'https://mcp.example.com/mcp';

let privateKey: KeyLike;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as KeyLike;
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
});
