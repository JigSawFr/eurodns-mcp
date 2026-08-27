import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/http.js';
import { loadConfig, ConfigError, type Config } from '../src/config.js';
import { MetricsRegistry } from '../src/metrics.js';
import { stubFetch } from './harness.js';
import { readFile } from 'node:fs/promises';
import { SERVER_VERSION } from '../src/server.js';
import { UNKNOWN_VERSION } from '../src/constants.js';

const METRICS_TOKEN = 'm'.repeat(48);
const MCP_TOKEN = 'k'.repeat(48);

function httpConfig(env: Record<string, string> = {}): Config {
  return loadConfig(
    {
      EURODNS_APP_ID: 'test-app-id',
      EURODNS_API_KEY: 'test-api-key',
      EURODNS_MAX_RETRIES: '0',
      EURODNS_AUDIT_DESTINATION: 'none',
      EURODNS_MCP_AUTH: 'token',
      EURODNS_MCP_TOKEN: MCP_TOKEN,
      ...env,
    } as NodeJS.ProcessEnv,
    'http',
  );
}

function callTool(name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } };
}

describe('metrics endpoint', () => {
  it('does not exist unless a token is configured', async () => {
    const app = await createApp(httpConfig());
    expect((await request(app).get('/metrics')).status).toBe(404);
  });

  it('refuses a poll with no token, and one with the wrong token', async () => {
    const app = await createApp(httpConfig({ EURODNS_METRICS_TOKEN: METRICS_TOKEN }));

    expect((await request(app).get('/metrics')).status).toBe(401);
    expect((await request(app).get('/metrics').set('Authorization', 'Bearer wrong')).status).toBe(
      401,
    );
  });

  it('will not accept the MCP token in its place', async () => {
    // The poller is a monitoring system. It should not hold a credential that also changes
    // DNS, and the reverse must not work either.
    const app = await createApp(httpConfig({ EURODNS_METRICS_TOKEN: METRICS_TOKEN }));
    const response = await request(app).get('/metrics').set('Authorization', `Bearer ${MCP_TOKEN}`);

    expect(response.status).toBe(401);
  });

  it('serves the Prometheus text format', async () => {
    const app = await createApp(httpConfig({ EURODNS_METRICS_TOKEN: METRICS_TOKEN }));
    const response = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('# TYPE eurodns_mcp_build_info gauge');
    expect(response.text).toMatch(/eurodns_mcp_tools_registered \d+/);
  });

  it('counts a call that reached the API and one that a guardrail refused', async () => {
    const metrics = new MetricsRegistry();
    const { fetchImpl } = stubFetch(() => ({ body: { name: 'example.com' } }));
    const app = await createApp(
      httpConfig({
        EURODNS_METRICS_TOKEN: METRICS_TOKEN,
        EURODNS_ALLOW_BILLING: 'true',
        EURODNS_CONFIRM: 'all',
      }),
      { fetchImpl, metrics },
    );

    const call = (body: object) =>
      request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${MCP_TOKEN}`)
        .set('Accept', 'application/json, text/event-stream')
        .send(body);

    await call(callTool('eurodns_dns_get_zone', { domainName: 'example.com' }));
    // 2025-era traffic on the stateless transport: there is no session for a confirmation
    // exchange to travel over, so the call is refused rather than quietly run unconfirmed.
    await call(
      callTool('eurodns_premium_dns_renew_subscription', {
        subscriptionId: 1,
        body: { duration: 1 },
      }),
    );

    const text = (
      await request(app).get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`)
    ).text;

    expect(text).toContain(
      'eurodns_mcp_tool_calls_total{tool="eurodns_dns_get_zone",risk="read",verdict="allowed"} 1',
    );
    // A refusal is a data point, not an absence of one: it is how a deployment notices an
    // agent repeatedly trying something the guardrails forbid.
    expect(text).toContain('verdict="denied"} 1');
    expect(text).toContain('eurodns_mcp_upstream_responses_total{status="200"} 1');
  });

  it('keeps counting across requests, which each build their own server', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: {} }));
    const app = await createApp(httpConfig({ EURODNS_METRICS_TOKEN: METRICS_TOKEN }), {
      fetchImpl,
    });

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${MCP_TOKEN}`)
        .set('Accept', 'application/json, text/event-stream')
        .send(callTool('eurodns_tld_list', {}));
    }

    const text = (
      await request(app).get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`)
    ).text;
    expect(text).toContain('tool="eurodns_tld_list",risk="read",verdict="allowed"} 3');
  });

  it('names no domain, actor or target in any label', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: {} }));
    const app = await createApp(httpConfig({ EURODNS_METRICS_TOKEN: METRICS_TOKEN }), {
      fetchImpl,
    });

    await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${MCP_TOKEN}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(callTool('eurodns_dns_get_zone', { domainName: 'confidential-client.example' }));

    const text = (
      await request(app).get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`)
    ).text;

    // Whoever polls this endpoint has no business learning which domains are managed here.
    expect(text).not.toContain('confidential-client.example');
    expect(text).not.toContain('static-token');
  });

  it('refuses a token too short to be worth having', () => {
    expect(() => httpConfig({ EURODNS_METRICS_TOKEN: 'short' })).toThrow(ConfigError);
  });

  it('escapes a label value rather than emitting a broken exposition', () => {
    const registry = new MetricsRegistry(() => 0);
    registry.recordCall({
      tool: 'weird"name\\here',
      risk: 'read',
      verdict: 'allowed',
      durationMs: 10,
    });

    const text = registry.render({ version: '1.0.0', toolCount: 1 });
    expect(text).toContain('tool="weird\\"name\\\\here"');
  });
});

describe('the version the server announces', () => {
  it('is the package version, not a literal that drifts', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };

    // This is the whole point of reading it at runtime, and the assertion that turns a broken
    // path into a failing build rather than a silent fallback.
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).not.toBe(UNKNOWN_VERSION);
  });

  it('labels build_info with that same version', async () => {
    const app = await createApp(httpConfig({ EURODNS_METRICS_TOKEN: METRICS_TOKEN }));
    const response = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`);

    // The metric an operator reads to know which version is deployed. It reported 0.1.0 for
    // two releases, which is worse than reporting nothing.
    expect(response.text).toContain(`eurodns_mcp_build_info{version="${SERVER_VERSION}"} 1`);
  });
});
