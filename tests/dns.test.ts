import { describe, expect, it } from 'vitest';
import { connect, isError, stubFetch, testConfig, textOf } from './harness.js';
import type { RecordedRequest, StubResponse } from './harness.js';

const ZONE = {
  name: 'example.com',
  records: [
    { id: 1, type: 'A', host: '', ttl: 3600, rdata: '203.0.113.10' },
    { id: 2, type: 'TXT', host: '_acme-challenge', ttl: 600, rdata: 'first' },
    { id: 3, type: 'TXT', host: '_acme-challenge', ttl: 600, rdata: 'second' },
    { id: 4, type: 'NS', host: '', ttl: 86400, rdata: 'ns1.example.net', locked: true },
  ],
  urlForwards: [],
  mailForwards: [],
};

/** Serves the zone, a validator whose verdict the test chooses, and the save endpoint. */
function zoneRoutes(options: { valid?: boolean } = {}) {
  const valid = options.valid ?? true;
  return (request: RecordedRequest): StubResponse => {
    if (request.method === 'GET') return { body: ZONE };
    if (request.url.endsWith('/check')) {
      const submitted = request.body as { records?: unknown[] };
      return {
        body: {
          ...ZONE,
          records: submitted.records ?? [],
          report: valid
            ? { isValid: true, recordErrors: [] }
            : {
                isValid: false,
                recordErrors: [{ messages: ['CNAME conflicts with an existing record'] }],
              },
        },
      };
    }
    if (request.method === 'PUT') return { status: 204 };
    if (request.method === 'DELETE') return { status: 204 };
    return { body: {} };
  };
}

describe('eurodns_dns_upsert_record', () => {
  it('reads, validates, then saves — in that order', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_dns_upsert_record',
      arguments: { domainName: 'example.com', type: 'A', host: 'www', rdata: '203.0.113.20' },
    });

    expect(isError(result)).toBeFalsy();
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /dns-zones/example.com',
      'POST /dns-zones/example.com/check',
      'PUT /dns-zones/example.com',
    ]);
    await close();
  });

  it('preserves the records it is not changing', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    await client.callTool({
      name: 'eurodns_dns_upsert_record',
      arguments: { domainName: 'example.com', type: 'A', host: 'www', rdata: '203.0.113.20' },
    });

    // Saving replaces the whole zone, so every pre-existing record must still be there.
    const saved = requests.at(-1)?.body as { records: Array<{ rdata: string }> };
    expect(saved.records).toHaveLength(ZONE.records.length + 1);
    expect(saved.records.map((r) => r.rdata)).toContain('203.0.113.10');
    await close();
  });

  it('writes nothing when the validator rejects the change', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes({ valid: false }));
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_dns_upsert_record',
      arguments: { domainName: 'example.com', type: 'CNAME', host: 'www', rdata: 'other.example.' },
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('CNAME conflicts');
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    await close();
  });

  it('updates in place rather than appending a duplicate', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    await client.callTool({
      name: 'eurodns_dns_upsert_record',
      arguments: { domainName: 'example.com', type: 'A', host: '@', rdata: '203.0.113.99' },
    });

    const saved = requests.at(-1)?.body as { records: Array<{ type: string; rdata: string }> };
    const aRecords = saved.records.filter((r) => r.type === 'A');
    expect(aRecords).toHaveLength(1);
    expect(aRecords[0]?.rdata).toBe('203.0.113.99');
    await close();
  });

  it('refuses to modify a record the provider locked', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_dns_upsert_record',
      arguments: { domainName: 'example.com', type: 'NS', host: '', rdata: 'ns9.example.net' },
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('locked');
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    await close();
  });

  it('rejects TTLs the API does not accept, before calling it', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    const result = await client
      .callTool({
        name: 'eurodns_dns_upsert_record',
        arguments: {
          domainName: 'example.com',
          type: 'A',
          host: 'www',
          rdata: '203.0.113.20',
          ttl: 300,
        },
      })
      .catch((error: unknown) => ({
        isError: true,
        content: [{ type: 'text', text: String(error) }],
      }));

    expect(isError(result)).toBe(true);
    expect(requests).toHaveLength(0);
    await close();
  });

  it('refuses the MAIL and URL pseudo types instead of writing a meaningless record', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_dns_upsert_record',
      arguments: {
        domainName: 'example.com',
        type: 'MAIL',
        host: '',
        rdata: 'someone@example.net',
      },
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('mailForwards');
    expect(requests).toHaveLength(0);
    await close();
  });
});

describe('eurodns_dns_delete_record', () => {
  it('resolves the record id from the zone', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_dns_delete_record',
      arguments: { domainName: 'example.com', type: 'A', host: '@' },
    });

    expect(isError(result)).toBeFalsy();
    expect(requests.at(-1)?.url).toContain('/dns-records/1');
    await close();
  });

  it('refuses to guess when several records share a type and host', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_dns_delete_record',
      arguments: { domainName: 'example.com', type: 'TXT', host: '_acme-challenge' },
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('first');
    expect(textOf(result)).toContain('second');
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    await close();
  });

  it('deletes the right one when rdata disambiguates', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    await client.callTool({
      name: 'eurodns_dns_delete_record',
      arguments: {
        domainName: 'example.com',
        type: 'TXT',
        host: '_acme-challenge',
        rdata: 'second',
      },
    });

    expect(requests.at(-1)?.url).toContain('/dns-records/3');
    await close();
  });

  it('says so plainly when nothing matches', async () => {
    const { fetchImpl } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_dns_delete_record',
      arguments: { domainName: 'example.com', type: 'MX', host: '' },
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('No MX record');
    await close();
  });
});

describe('eurodns_dns_diff_zone', () => {
  it('reports changes without writing anything', async () => {
    const { fetchImpl, requests } = stubFetch(zoneRoutes());
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_dns_diff_zone',
      arguments: {
        domainName: 'example.com',
        records: [
          { type: 'A', host: '@', rdata: '203.0.113.10' },
          { type: 'A', host: 'www', rdata: '203.0.113.20' },
          { type: 'TXT', host: '_acme-challenge', rdata: 'first', ttl: 3600 },
        ],
      },
    });

    const structured = (
      result as { structuredContent: { added: unknown[]; updated: unknown[]; unchanged: number } }
    ).structuredContent;
    expect(structured.unchanged).toBe(1);
    expect(structured.added).toHaveLength(1);
    expect(structured.updated).toHaveLength(1);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    await close();
  });

  it('stays available in read-only mode', async () => {
    const { fetchImpl } = stubFetch(zoneRoutes());
    const { client, close } = await connect({
      config: testConfig({ EURODNS_READ_ONLY: 'true' }),
      fetchImpl,
    });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('eurodns_dns_diff_zone');
    await close();
  });
});
