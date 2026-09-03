import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { connect, isError, stubFetch, testConfig } from './harness.js';

const enabled = () => testConfig({ EURODNS_COMPAT_TOOLS: 'true' });

/** OAuth over HTTP: the one mode where an unidentified call is a failure, not a mode of use. */
const oauthEnabled = () =>
  loadConfig(
    {
      EURODNS_APP_ID: 'test-app-id',
      EURODNS_API_KEY: 'test-api-key',
      EURODNS_AUDIT_DESTINATION: 'none',
      EURODNS_COMPAT_TOOLS: 'true',
      EURODNS_MCP_AUTH: 'oauth',
      EURODNS_OAUTH_ISSUER: 'https://issuer.example.com',
      EURODNS_MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    } as NodeJS.ProcessEnv,
    'http',
  );

async function toolNames(config?: ReturnType<typeof testConfig>) {
  const { client, toolCount, close } = await connect(config ? { config } : {});
  try {
    return { names: (await client.listTools()).tools.map((t) => t.name), toolCount };
  } finally {
    await close();
  }
}

describe('the search/fetch compatibility pair', () => {
  /**
   * The whole point of the switch. A deployment that never asked for these must not discover
   * two unprefixed names in its tool list after an upgrade — so the assertion is about the
   * surface being *identical*, not merely about the two names being absent.
   */
  it('changes nothing at all when it is not asked for', async () => {
    const off = await toolNames();
    const on = await toolNames(enabled());

    expect(off.names).not.toContain('search');
    expect(off.names).not.toContain('fetch');
    expect(on.toolCount).toBe(off.toolCount + 2);
    // Every tool the default deployment had, it still has.
    expect(on.names).toEqual(expect.arrayContaining(off.names));
    expect(on.names.filter((name) => !off.names.includes(name)).sort()).toEqual([
      'fetch',
      'search',
    ]);
  });

  /**
   * These are the only two names in the server without the `eurodns_` prefix, which is the
   * cost being accepted — not an oversight. Pinned so that turning the switch on is the only
   * way it can ever happen.
   */
  it('is the only thing that may introduce an unprefixed name', async () => {
    const { names } = await toolNames();
    for (const name of names) expect(name).toMatch(/^eurodns_/);

    const withCompat = await toolNames(enabled());
    expect(withCompat.names.filter((name) => !name.startsWith('eurodns_')).sort()).toEqual([
      'fetch',
      'search',
    ]);
  });

  it('returns results in the shape the contract requires', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({
      body: [
        {
          domainName: 'example.com',
          expirationDate: '2027-01-01',
          renewalMethod: 'AUTORENEW',
          active: true,
        },
        { domainName: 'lapsed.net', expirationDate: '2025-01-01', active: false },
        // No domainName: not addressable by fetch, so it must not be offered as a result.
        { tldName: 'org' },
      ],
    }));
    const { client, close } = await connect({ config: enabled(), fetchImpl });
    try {
      const result = await client.callTool({ name: 'search', arguments: { query: 'example' } });
      const { results } = result.structuredContent as {
        results: { id: string; title: string; text: string }[];
      };

      expect(isError(result)).toBe(false);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        id: 'example.com',
        title: 'example.com',
        text: 'expires 2027-01-01, renewal AUTORENEW',
      });
      expect(results[1]?.text).toContain('expired');
      // The term reaches the API rather than being filtered here.
      expect(requests[0]?.body).toEqual({ term: 'example' });
    } finally {
      await close();
    }
  });

  it('describes a domain the search knows nothing else about', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: [{ domainName: 'bare.com' }] }));
    const { client, close } = await connect({ config: enabled(), fetchImpl });
    try {
      const result = await client.callTool({ name: 'search', arguments: { query: 'bare' } });
      const { results } = result.structuredContent as { results: { text: string }[] };

      expect(results[0]?.text).toBe('domain in this account');
    } finally {
      await close();
    }
  });

  it('degrades to no results when the API answers with something other than a list', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: { message: 'not a list' } }));
    const { client, close } = await connect({ config: enabled(), fetchImpl });
    try {
      const result = await client.callTool({ name: 'search', arguments: { query: 'anything' } });
      expect((result.structuredContent as { results: unknown[] }).results).toEqual([]);
    } finally {
      await close();
    }
  });

  /**
   * The same defect the portfolio cache carried, in the other place it was hardcoded.
   *
   * `search` asked for `pagination-size: -1`. The vendor's document offers that on this exact
   * endpoint; the API answers `400`. So the one tool a ChatGPT connector requires failed on
   * every call, and no test saw it because every stub here accepts any header.
   */
  it('never asks for the size the API rejects', async () => {
    const { fetchImpl, requests } = stubFetch((req) =>
      req.headers['pagination-size'] === '-1'
        ? {
            status: 400,
            body: { message: '[-1] is not a valid pagination-size header value.' },
          }
        : { body: [{ domainName: 'example.com' }] },
    );
    const { client, close } = await connect({ config: enabled(), fetchImpl });
    try {
      const result = await client.callTool({ name: 'search', arguments: { query: 'example' } });

      expect(isError(result)).toBe(false);
      expect(requests[0]?.headers['pagination-size']).not.toBe('-1');
    } finally {
      await close();
    }
  });

  it('fetches one record by the id a search result carried', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({
      body: { domainName: 'example.com', expirationDate: '2027-01-01' },
    }));
    const { client, close } = await connect({ config: enabled(), fetchImpl });
    try {
      const result = await client.callTool({ name: 'fetch', arguments: { id: 'example.com' } });
      const record = result.structuredContent as {
        id: string;
        title: string;
        text: string;
        metadata?: Record<string, string>;
      };

      expect(record.id).toBe('example.com');
      expect(JSON.parse(record.text).expirationDate).toBe('2027-01-01');
      expect(record.metadata).toEqual({ source: 'EuroDNS User API' });
      expect(requests[0]?.url).toBe('https://rest-api.eurodns.com/domains/example.com');
    } finally {
      await close();
    }
  });

  /**
   * Both tools check the guardrail themselves, although the HTTP scope gate refuses this
   * before dispatch. Two gates, deliberately: the gate is driven by a name-to-requirement
   * index, and a tool missing from it would be waved straight through with nothing to check.
   */
  it('refuses a caller whose grant is empty, before reaching the API', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [] }));
    const { client, close } = await connect({
      config: oauthEnabled(),
      transport: 'http',
      fetchImpl,
    });
    try {
      for (const [name, args] of [
        ['search', { query: 'example' }],
        ['fetch', { id: 'example.com' }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(isError(result), name).toBe(true);
      }

      // The real assertion: refused, so nothing was asked of the API on the caller's behalf.
      expect(requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  /** Both are reads, so the strictest guardrail a deployment can set leaves them standing. */
  it('survives a read-only deployment', async () => {
    const config = testConfig({ EURODNS_COMPAT_TOOLS: 'true', EURODNS_READ_ONLY: 'true' });
    const { names } = await toolNames(config);

    expect(names).toContain('search');
    expect(names).toContain('fetch');
  });
});
