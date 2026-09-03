import { describe, expect, it } from 'vitest';
import { PortfolioCache } from '../src/services/portfolio.js';
import { EuroDnsClient, type FetchLike } from '../src/services/client.js';
import { loadConfig } from '../src/config.js';
import { connect, isError, stubFetch, testConfig } from './harness.js';
import { DOMAIN_RESOURCE_TEMPLATE } from '../src/resources.js';
import { MAX_PAGE_SIZE } from '../src/constants.js';

/** A client over a counting stub, so assertions can be about calls rather than results. */
function countingClient(names: string[]) {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify(names.map((domainName) => ({ domainName }))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new EuroDnsClient(testConfig().upstream, fetchImpl);
  return { client, calls: () => calls };
}

/**
 * A client over a stub that behaves like the live API on `pagination-size`.
 *
 * It rejects `-1` with the vendor's own message and status, and it pages: a request for page
 * N returns that slice, so a caller that never advances the page comes back short. Both
 * halves matter — the first catches the sentinel, the second catches a loop that does not
 * loop.
 */
function vendorFaithfulClient(names: string[]) {
  const sizes: string[] = [];
  const pages: string[] = [];

  const fetchImpl: FetchLike = async (_url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const size = headers['pagination-size'] ?? '';
    const page = headers['pagination-page'] ?? '1';
    sizes.push(size);
    pages.push(page);

    if (size === '-1') {
      return new Response(
        JSON.stringify({ message: '[-1] is not a valid pagination-size header value.' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    const perPage = Number(size) || names.length;
    const start = (Number(page) - 1) * perPage;
    const slice = names.slice(start, start + perPage);

    return new Response(JSON.stringify(slice.map((domainName) => ({ domainName }))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = new EuroDnsClient(testConfig({ EURODNS_MAX_RETRIES: '0' }).upstream, fetchImpl);
  return { client, sizes: () => sizes, pages: () => pages };
}

describe('the cached domain list', () => {
  /**
   * The property the whole feature rests on. Completion is typed into, so several requests
   * arrive together as a matter of course, not as an edge case — and an empty cache under
   * concurrent load would stampede the upstream API if the TTL were the only guard.
   *
   * Asserted by counting calls through an injected fetch, because reading the code cannot
   * tell you whether the single-flight slot is actually shared.
   */
  it('collapses concurrent lookups into one upstream call', async () => {
    const { client, calls } = countingClient(['a.com', 'b.com']);
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 100 });

    const results = await Promise.all([
      cache.complete(client, 'a'),
      cache.complete(client, 'b'),
      cache.complete(client, ''),
      cache.list(client),
    ]);

    expect(calls()).toBe(1);
    expect(results[0]).toEqual(['a.com']);
    expect(results[1]).toEqual(['b.com']);
    expect(results[2]).toEqual(['a.com', 'b.com']);
  });

  it('serves later lookups from memory until the TTL elapses', async () => {
    const { client, calls } = countingClient(['a.com']);
    let clock = 1_000;
    const cache = new PortfolioCache({ ttlMs: 10_000, maxEntries: 100, now: () => clock });

    await cache.list(client);
    clock += 9_999;
    await cache.list(client);
    expect(calls()).toBe(1);

    clock += 2;
    await cache.list(client);
    expect(calls()).toBe(2);
  });

  it('refreshes on demand and reports the age of what it replaced', async () => {
    const { client, calls } = countingClient(['a.com', 'b.com']);
    let clock = 0;
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 100, now: () => clock });

    const first = await cache.refresh(client);
    expect(first).toEqual({ count: 2 });

    clock += 30_000;
    expect(await cache.refresh(client)).toEqual({ count: 2, replacedAgeMs: 30_000 });
    expect(calls()).toBe(2);
  });

  /**
   * A completion that cannot be answered is a small inconvenience. Failing the request it was
   * attached to would be a bug, so the failure path is a value, not a throw.
   */
  it('answers with nothing rather than failing when the lookup breaks', async () => {
    const client = new EuroDnsClient(
      testConfig({ EURODNS_MAX_RETRIES: '0' }).upstream,
      async () => {
        throw new Error('network down');
      },
    );
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 100 });

    await expect(cache.complete(client, 'anything')).resolves.toEqual([]);
  });

  /** A failed refresh must not wedge every later caller onto the rejected promise. */
  it('recovers on the next call after a failure', async () => {
    let healthy = false;
    const fetchImpl = async () => {
      if (!healthy) throw new Error('network down');
      return new Response(JSON.stringify([{ domainName: 'a.com' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new EuroDnsClient(testConfig({ EURODNS_MAX_RETRIES: '0' }).upstream, fetchImpl);
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 100 });

    expect(await cache.list(client)).toEqual([]);
    healthy = true;
    expect(await cache.list(client)).toEqual(['a.com']);
  });

  /**
   * The vendor deviates from its own spec elsewhere in this API, which is why the result
   * shape is checked rather than trusted. An object where an array was promised must degrade
   * to "no suggestions", not to a crash inside a completion.
   */
  it('degrades to nothing when the API answers with something other than a list', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ message: 'not a list' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = new EuroDnsClient(testConfig().upstream, fetchImpl);
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 100 });

    await expect(cache.list(client)).resolves.toEqual([]);
  });

  it('reports a failure that was not thrown as an Error', async () => {
    const client = new EuroDnsClient(testConfig({ EURODNS_MAX_RETRIES: '0' }).upstream, () => {
      // Not every rejection in a Node process carries an Error; the log line has to say
      // something useful either way rather than printing "undefined".
      throw 'connection reset';
    });
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 100 });

    await expect(cache.list(client)).resolves.toEqual([]);
  });

  it('holds no more than the ceiling, whatever the account contains', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `d${String(i).padStart(3, '0')}.com`);
    const { client } = countingClient(many);
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 10 });

    expect(await cache.list(client)).toHaveLength(10);
  });

  it('matches case-insensitively, anywhere in the name', async () => {
    const { client } = countingClient(['Example.com', 'other.NET', 'sample.org']);
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 100 });

    expect(await cache.complete(client, 'EXAMPLE')).toEqual(['Example.com']);
    expect(await cache.complete(client, '.net')).toEqual(['other.NET']);
  });

  /**
   * The regression that shipped in 0.9.0, and the reason no test caught it.
   *
   * The cache asked for `pagination-size: -1`, which the vendor's document offers on this very
   * endpoint. The API refuses it, so every completion failed — silently, because the failure
   * path returns the previous list, which is empty until a call succeeds. Every stub in this
   * file accepted any header, so the code and the API disagreed with nothing to notice.
   *
   * This stub answers like the real thing. It fails if `-1` ever comes back.
   */
  it('never asks for the size the API rejects', async () => {
    const { client, sizes } = vendorFaithfulClient(['a.com', 'b.com']);
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 100 });

    expect(await cache.list(client)).toEqual(['a.com', 'b.com']);
    expect(sizes()).not.toContain('-1');
  });

  /**
   * With no sentinel for "everything", a portfolio larger than one page has to be walked.
   * The stub pages properly, so a cache that asked for page 1 only would come back short.
   */
  it('walks every page rather than assuming one holds the portfolio', async () => {
    const many = Array.from({ length: MAX_PAGE_SIZE + 7 }, (_, i) => `d${i}.com`);
    const { client, pages } = vendorFaithfulClient(many);
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: 5_000 });

    expect(await cache.list(client)).toHaveLength(MAX_PAGE_SIZE + 7);
    expect(pages()).toEqual(['1', '2']);
  });

  /**
   * An upstream that ignores `pagination-page` would hand back a full page forever. The
   * ceiling has to end the loop on its own, or a completion would never return.
   */
  it('stops at the ceiling when the API never returns a short page', async () => {
    const page = Array.from({ length: MAX_PAGE_SIZE }, (_, i) => `d${i}.com`);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify(page.map((domainName) => ({ domainName }))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new EuroDnsClient(testConfig().upstream, fetchImpl);
    const cache = new PortfolioCache({ ttlMs: 60_000, maxEntries: MAX_PAGE_SIZE * 2 });

    // Two calls, then the ceiling ends it: 500 collected, 1000 collected, loop condition
    // false. Not one call, and not forever.
    expect(await cache.list(client)).toHaveLength(MAX_PAGE_SIZE * 2);
    expect(calls).toBe(2);
  });
});

describe('the domain resource template', () => {
  it('lists the portfolio as resources a client can open', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: [{ domainName: 'example.com' }, { domainName: 'example.net' }],
    }));
    const { client, close } = await connect({ fetchImpl });
    try {
      const listed = await client.listResources();
      const uris = listed.resources.map((r) => r.uri);

      expect(uris).toContain('eurodns://domain/example.com');
      expect(uris).toContain('eurodns://domain/example.net');
    } finally {
      await close();
    }
  });

  it('advertises the template itself', async () => {
    const { client, close } = await connect();
    try {
      const listed = await client.listResourceTemplates();
      expect(listed.resourceTemplates.map((t) => t.uriTemplate)).toContain(
        DOMAIN_RESOURCE_TEMPLATE,
      );
    } finally {
      await close();
    }
  });

  it('reads one domain through the API', async () => {
    const { fetchImpl, requests } = stubFetch((req) =>
      req.url.endsWith('/domains/search')
        ? { body: [{ domainName: 'example.com' }] }
        : { body: { domainName: 'example.com', expirationDate: '2027-01-01' } },
    );
    const { client, close } = await connect({ fetchImpl });
    try {
      const result = await client.readResource({ uri: 'eurodns://domain/example.com' });
      const body = JSON.parse((result.contents[0] as { text: string }).text);

      expect(body.expirationDate).toBe('2027-01-01');
      expect(requests.some((r) => r.url.endsWith('/domains/example.com'))).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('completing a domain name as it is typed', () => {
  /**
   * MCP completes prompt arguments and resource-template variables, never tool arguments —
   * so these two paths are the whole reach of the cache, and both go through it.
   */
  it('suggests the account’s own domains for a prompt argument', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: [
        { domainName: 'example.com' },
        { domainName: 'example.net' },
        { domainName: 'other.org' },
      ],
    }));
    const { client, close } = await connect({ fetchImpl });
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'eurodns_zone_review' },
        argument: { name: 'domainName', value: 'exam' },
      });

      expect(result.completion.values).toEqual(['example.com', 'example.net']);
    } finally {
      await close();
    }
  });

  it('suggests them for the resource template variable too', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: [{ domainName: 'example.com' }, { domainName: 'other.org' }],
    }));
    const { client, close } = await connect({ fetchImpl });
    try {
      const result = await client.complete({
        ref: { type: 'ref/resource', uri: DOMAIN_RESOURCE_TEMPLATE },
        argument: { name: 'domainName', value: 'other' },
      });

      expect(result.completion.values).toEqual(['other.org']);
    } finally {
      await close();
    }
  });

  it('offers everything when nothing has been typed yet', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: [{ domainName: 'example.com' }, { domainName: 'other.org' }],
    }));
    const { client, close } = await connect({ fetchImpl });
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'eurodns_acme_challenge' },
        argument: { name: 'domainName', value: '' },
      });

      expect(result.completion.values).toEqual(['example.com', 'other.org']);
    } finally {
      await close();
    }
  });
});

describe('refreshing the cache on demand', () => {
  it('re-reads the portfolio and says what it replaced', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [{ domainName: 'example.com' }] }));
    const { client, close } = await connect({ fetchImpl });
    try {
      const result = await client.callTool({ name: 'eurodns_portfolio_refresh', arguments: {} });

      expect(isError(result)).toBe(false);
      expect((result.structuredContent as { domains: number }).domains).toBe(1);
      expect(requests.some((r) => r.url.endsWith('/domains/search'))).toBe(true);
    } finally {
      await close();
    }
  });

  it('reports the age of the list it replaced on a second call', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: [{ domainName: 'example.com' }] }));
    const { client, close } = await connect({ fetchImpl });
    try {
      const first = await client.callTool({ name: 'eurodns_portfolio_refresh', arguments: {} });
      // Nothing was cached, so there is no age to report and the field is absent.
      expect(first.structuredContent).not.toHaveProperty('replacedAgeSeconds');

      const second = await client.callTool({ name: 'eurodns_portfolio_refresh', arguments: {} });
      expect(second.structuredContent).toHaveProperty('replacedAgeSeconds');
      expect((second.structuredContent as { domains: number }).domains).toBe(1);
    } finally {
      await close();
    }
  });

  /**
   * The tool checks the guardrail itself, although the HTTP scope gate refuses this before
   * dispatch — the same two-gate arrangement the DNS tools use, for the same reason.
   */
  it('refuses a caller whose grant is empty, before reaching the API', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [] }));
    const config = loadConfig(
      {
        EURODNS_APP_ID: 'test-app-id',
        EURODNS_API_KEY: 'test-api-key',
        EURODNS_AUDIT_DESTINATION: 'none',
        EURODNS_MCP_AUTH: 'oauth',
        EURODNS_OAUTH_ISSUER: 'https://issuer.example.com',
        EURODNS_MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
      } as NodeJS.ProcessEnv,
      'http',
    );
    const { client, close } = await connect({ config, transport: 'http', fetchImpl });
    try {
      const result = await client.callTool({ name: 'eurodns_portfolio_refresh', arguments: {} });

      expect(isError(result)).toBe(true);
      // Stubbed to succeed, so an empty request list means it was refused, not that it failed.
      expect(requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  /** A read, so it survives the strictest guardrail a deployment can set. */
  it('stays available on a read-only deployment', async () => {
    const { client, close } = await connect({
      config: testConfig({ EURODNS_READ_ONLY: 'true' }),
    });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('eurodns_portfolio_refresh');
    } finally {
      await close();
    }
  });
});
