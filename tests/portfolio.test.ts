import { describe, expect, it } from 'vitest';
import { PortfolioCache } from '../src/services/portfolio.js';
import { EuroDnsClient } from '../src/services/client.js';
import { connect, isError, stubFetch, testConfig } from './harness.js';
import { DOMAIN_RESOURCE_TEMPLATE } from '../src/resources.js';

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
