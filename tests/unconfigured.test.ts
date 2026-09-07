import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, isError, stubFetch, textOf, unconfiguredConfig } from './harness.js';
import { DEPLOYMENT_RESOURCE_URI, DOMAIN_RESOURCE_TEMPLATE } from '../src/resources.js';
import { NO_CREDENTIALS_REASON } from '../src/tools/failure.js';

/**
 * A server started with no credentials at all — the way a marketplace or validator starts it,
 * to see what it offers rather than to use it.
 *
 * Every case stubs an upstream that would *succeed*. That is what makes the empty request log
 * mean something: a call that reached the API here would come back 200, so `requests` staying
 * empty proves the refusal happened before the network, not that the network refused.
 */
describe('a server started without credentials', () => {
  it('advertises the same surface as a configured one', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [] }));
    const configured = await connect();
    const listing = await connect({ config: unconfiguredConfig(), fetchImpl });
    try {
      const names = async (session: typeof configured) =>
        (await session.client.listTools()).tools.map((t) => t.name).sort();
      const prompts = async (session: typeof configured) =>
        (await session.client.listPrompts()).prompts.map((p) => p.name).sort();

      expect(listing.toolCount).toBe(configured.toolCount);
      expect(await names(listing)).toEqual(await names(configured));
      expect(await prompts(listing)).toEqual(await prompts(configured));

      const templates = await listing.client.listResourceTemplates();
      expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain(
        DOMAIN_RESOURCE_TEMPLATE,
      );
      const resources = await listing.client.listResources();
      expect(resources.resources.map((r) => r.uri)).toContain(DEPLOYMENT_RESOURCE_URI);

      expect(requests).toHaveLength(0);
    } finally {
      await configured.close();
      await listing.close();
    }
  });

  it('refuses a generated tool, naming both variables, and sends nothing', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: { name: 'example.com' } }));
    const { client, close } = await connect({ config: unconfiguredConfig(), fetchImpl });
    try {
      const result = await client.callTool({
        name: 'eurodns_dns_get_zone',
        arguments: { domainName: 'example.com' },
      });

      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('EURODNS_APP_ID');
      expect(textOf(result)).toContain('EURODNS_API_KEY');
      expect(requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  /**
   * The DNS tools have their own failure path. Were it not to know this error, the caller
   * would get the tool's generic fallback — which names neither variable.
   */
  it('refuses the DNS workflow tools the same way', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: { records: [] } }));
    const { client, close } = await connect({ config: unconfiguredConfig(), fetchImpl });
    try {
      const diff = await client.callTool({
        name: 'eurodns_dns_diff_zone',
        arguments: {
          domainName: 'example.com',
          records: [{ type: 'TXT', host: '_acme-challenge', rdata: 'token' }],
        },
      });
      const upsert = await client.callTool({
        name: 'eurodns_dns_upsert_record',
        arguments: { domainName: 'example.com', type: 'TXT', host: '@', rdata: 'v=spf1 -all' },
      });

      for (const result of [diff, upsert]) {
        expect(isError(result)).toBe(true);
        expect(textOf(result)).toContain('EURODNS_API_KEY');
      }
      expect(requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('refuses search and fetch, naming the variables', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [{ domainName: 'example.com' }] }));
    const { client, close } = await connect({
      config: unconfiguredConfig({ EURODNS_COMPAT_TOOLS: 'true' }),
      fetchImpl,
    });
    try {
      const search = await client.callTool({ name: 'search', arguments: { query: 'example' } });
      const fetched = await client.callTool({ name: 'fetch', arguments: { id: 'example.com' } });

      for (const result of [search, fetched]) {
        expect(isError(result)).toBe(true);
        expect(textOf(result)).toContain('EURODNS_APP_ID');
      }
      expect(requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  /**
   * The cache swallows upstream failures by design, so this tool is the one that has to check
   * for itself. Without that it would answer "0 domains cached", which reads as an empty
   * account rather than a server that cannot ask.
   */
  it('refuses the portfolio refresh rather than reporting zero domains', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [{ domainName: 'example.com' }] }));
    const { client, close } = await connect({ config: unconfiguredConfig(), fetchImpl });
    try {
      const result = await client.callTool({ name: 'eurodns_portfolio_refresh', arguments: {} });

      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('EURODNS_APP_ID');
      expect(textOf(result)).not.toContain('domains cached');
      expect(requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  /**
   * Completion is typed into. Left to the ordinary failure path, each keystroke would produce
   * one warning on stderr — on a process whose whole purpose is to be listed quietly.
   */
  it('completes nothing and lists no domains, silently', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [{ domainName: 'example.com' }] }));
    const { client, close } = await connect({ config: unconfiguredConfig(), fetchImpl });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const completion = await client.complete({
        ref: { type: 'ref/prompt', name: 'eurodns_zone_review' },
        argument: { name: 'domainName', value: 'exam' },
      });
      expect(completion.completion.values).toEqual([]);

      const listed = await client.listResources();
      expect(listed.resources.map((r) => r.uri)).toEqual([DEPLOYMENT_RESOURCE_URI]);

      expect(requests).toHaveLength(0);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      await close();
    }
  });

  it('reads a domain resource with an error naming the variables', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: { domainName: 'example.com' } }));
    const { client, close } = await connect({ config: unconfiguredConfig(), fetchImpl });
    try {
      // Resources have no `isError`; a refusal there is a protocol error carrying the message.
      await expect(client.readResource({ uri: 'eurodns://domain/example.com' })).rejects.toThrow(
        /EURODNS_APP_ID/,
      );
      expect(requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  /**
   * Recorded as a denial, not a failure: nothing was attempted, and the cause is the
   * deployment's configuration, the same category as a guardrail refusal. The reason keeps it
   * apart from those in the log.
   *
   * `search` is in the list on purpose. Its handler used to let a rejected request propagate —
   * the SDK still answered the client with `isError`, so nothing looked wrong from outside —
   * and the span was never completed. A verdict for it here is what proves that path closed.
   */
  it('records each refusal as a denial with its own reason', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'eurodns-unconfigured-')), 'audit.jsonl');
    const { fetchImpl } = stubFetch(() => ({ body: [] }));
    const { client, close } = await connect({
      config: unconfiguredConfig({
        EURODNS_AUDIT_DESTINATION: 'file',
        EURODNS_AUDIT_FILE: file,
        EURODNS_COMPAT_TOOLS: 'true',
      }),
      fetchImpl,
    });
    try {
      await client.callTool({ name: 'eurodns_tld_get', arguments: {} });
      await client.callTool({ name: 'search', arguments: { query: 'example' } });
    } finally {
      await close();
    }

    expect(existsSync(file)).toBe(true);
    const completed = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.verdict !== undefined);

    expect(completed.map((line) => line.tool)).toEqual(['eurodns_tld_get', 'search']);
    for (const line of completed) {
      expect(line).toMatchObject({ verdict: 'denied', reason: NO_CREDENTIALS_REASON });
      expect(line).not.toHaveProperty('upstreamStatus');
    }
  });
});
