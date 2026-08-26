import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../src/generated/operations.js';
import { toolNameFor } from '../src/tools/naming.js';
import { connect, isError, stubFetch, testConfig, textOf } from './harness.js';

describe('tool surface', () => {
  it('exposes every operation plus the DNS workflow tools, with unique names', async () => {
    const { client, toolCount, close } = await connect();
    const { tools } = await client.listTools();

    expect(toolCount).toBe(OPERATIONS.length + 3);
    expect(tools).toHaveLength(toolCount);

    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^eurodns_[a-z0-9_]+$/);

    await close();
  });

  it('never lets a generated name collide with a hand-written one', () => {
    const generated = OPERATIONS.map(toolNameFor);
    const handWritten = [
      'eurodns_dns_upsert_record',
      'eurodns_dns_delete_record',
      'eurodns_dns_diff_zone',
    ];
    for (const name of handWritten) {
      expect(generated, name).not.toContain(name);
    }
  });

  it('annotates reads as read-only and deletes as destructive', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get('eurodns_dns_get_zone')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('eurodns_ssl_revoke_certificate')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('eurodns_dns_diff_zone')?.annotations?.readOnlyHint).toBe(true);

    await close();
  });

  it('exposes pagination as ordinary arguments', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const invoices = tools.find((t) => t.name === 'eurodns_invoice_list');

    const properties = (invoices?.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(['page', 'size', 'sortField', 'sortOrder']),
    );
    // Hyphenated API parameter names become ordinary camelCase arguments.
    expect(properties).not.toHaveProperty('pagination-page');

    await close();
  });

  it('renames hyphenated path parameters to camelCase', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const zone = tools.find((t) => t.name === 'eurodns_dns_get_zone');
    const properties = (zone?.inputSchema as { properties?: Record<string, unknown> }).properties;

    expect(properties).toHaveProperty('domainName');
    expect(properties).not.toHaveProperty('domain-name');

    await close();
  });

  it('substitutes path parameters and forwards the call', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: { name: 'example.com' } }));
    const { client, close } = await connect({ fetchImpl });

    await client.callTool({
      name: 'eurodns_dns_get_zone',
      arguments: { domainName: 'example.com' },
    });

    expect(requests[0]?.url).toBe('https://rest-api.eurodns.com/dns-zones/example.com');
    await close();
  });
});

describe('deployment guardrails', () => {
  it('does not advertise state-changing tools in read-only mode', async () => {
    const { client, close } = await connect({
      config: testConfig({ EURODNS_READ_ONLY: 'true' }),
    });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('eurodns_dns_get_zone');
    expect(names).toContain('eurodns_dns_diff_zone');
    expect(names).not.toContain('eurodns_dns_save_zone');
    expect(names).not.toContain('eurodns_dns_upsert_record');

    await close();
  });

  it('refuses billing operations unless they are explicitly enabled', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_premium_dns_renew_subscription',
      arguments: { subscriptionId: 1, body: { duration: 1 } },
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('EURODNS_ALLOW_BILLING');
    // Refused before anything reached the API.
    expect(requests).toHaveLength(0);

    await close();
  });

  it('allows billing operations once enabled', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: { id: 'sub-1' } }));
    const { client, close } = await connect({
      config: testConfig({ EURODNS_ALLOW_BILLING: 'true' }),
      fetchImpl,
    });

    const result = await client.callTool({
      name: 'eurodns_premium_dns_renew_subscription',
      arguments: { subscriptionId: 1, body: { duration: 1 } },
    });

    expect(isError(result)).toBeFalsy();
    expect(requests).toHaveLength(1);

    await close();
  });

  it('refuses irreversible non-DNS operations unless enabled', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_ssl_revoke_certificate',
      arguments: { subscriptionId: 1, certificateId: 2 },
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('EURODNS_ALLOW_DESTRUCTIVE');
    expect(requests).toHaveLength(0);

    await close();
  });

  it('keeps DNS record deletion available by default', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({ fetchImpl });

    await client.callTool({
      name: 'eurodns_dns_delete_record_by_id',
      arguments: { domainName: 'example.com', recordId: 42 },
    });

    expect(requests[0]?.method).toBe('DELETE');
    await close();
  });
});

describe('tool descriptions', () => {
  it('names every overridden operation, so a rename cannot orphan a description', async () => {
    const { DESCRIPTION_OVERRIDES } = await import('../src/tools/overrides.js');
    const known = new Set(OPERATIONS.map((o) => o.operationId));
    for (const operationId of Object.keys(DESCRIPTION_OVERRIDES)) {
      expect(known.has(operationId), operationId).toBe(true);
    }
  });

  it('warns that saving a zone replaces it, and points at the safe alternative', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const save = tools.find((t) => t.name === 'eurodns_dns_save_zone');

    expect(save?.description).toContain('deleted');
    expect(save?.description).toContain('eurodns_dns_upsert_record');
    await close();
  });

  it('strips the HTML the document embeds in its descriptions', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description ?? '', tool.name).not.toContain('<br');
    }
    await close();
  });
});
