import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../src/generated/operations.js';
import { toolNameFor } from '../src/tools/naming.js';
import { evaluateGuardrails } from '../src/auth/scopes.js';
import { connect, isError, stubFetch, testConfig } from './harness.js';

describe('tool surface', () => {
  it('exposes every operation plus the DNS workflow tools, with unique names', async () => {
    const { client, toolCount, close } = await connect({
      config: testConfig({ EURODNS_ALLOW_BILLING: 'true', EURODNS_ALLOW_DESTRUCTIVE: 'true' }),
    });
    const { tools } = await client.listTools();

    // Four hand-written tools: three DNS workflow tools and the portfolio refresh. The audit
    // query is not among them — it is off on this configuration.
    expect(toolCount).toBe(OPERATIONS.length + 4);
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
      'eurodns_portfolio_refresh',
    ];
    for (const name of handWritten) {
      expect(generated, name).not.toContain(name);
    }
  });

  it('annotates reads as read-only and deletes as destructive', async () => {
    const { client, close } = await connect({
      config: testConfig({ EURODNS_ALLOW_DESTRUCTIVE: 'true' }),
    });
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

  /**
   * `-1` is the API's own spelling for "everything in one page". Rejecting it made this
   * server narrower than the API it wraps and pushed callers into paginating by hand for a
   * result the vendor returns whole.
   */
  it("passes -1 through as the API's own request for a single page", async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [] }));
    const { client, close } = await connect({ fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_invoice_list',
      arguments: { size: -1 },
    });

    expect(isError(result)).toBe(false);
    expect(requests[0]?.headers['pagination-size']).toBe('-1');
    await close();
  });

  it('still refuses a size that is neither in range nor -1, before dispatching', async () => {
    // Stubbed so that a *valid* call would succeed. Without that, the upstream failure
    // makes every call an error and the assertion proves nothing — which is exactly what
    // the first version of this test did.
    const { fetchImpl, requests } = stubFetch(() => ({ body: [] }));
    const { client, close } = await connect({ fetchImpl });

    // The 500 ceiling stays: -1 is a documented sentinel, not an invitation to any integer.
    for (const size of [0, -2, 501]) {
      const result = await client.callTool({
        name: 'eurodns_invoice_list',
        arguments: { size },
      });
      expect(isError(result), `size ${size} should be refused`).toBe(true);
    }

    // The real assertion: refused by the schema, so the API was never called.
    expect(requests).toHaveLength(0);
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

  it('does not advertise billing tools unless they are explicitly enabled', async () => {
    const { client, close } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).not.toContain('eurodns_premium_dns_renew_subscription');
    // Reads are unaffected: only the disabled class disappears.
    expect(names).toContain('eurodns_dns_get_zone');

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

  it('does not advertise irreversible non-DNS operations unless enabled', async () => {
    const { client, close } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).not.toContain('eurodns_ssl_revoke_certificate');
    expect(names).toContain('eurodns_dns_get_zone');

    await close();
  });

  // The switch is what enforces; hiding only decides what is advertised. A tool reached by
  // any other path still has to meet it, which is what keeps the two from drifting apart.
  it('still refuses a disabled class at the guardrail, not only by hiding it', () => {
    const guardrails = testConfig().guardrails;

    const billing = evaluateGuardrails('billing', guardrails);
    const destructive = evaluateGuardrails('destructive', guardrails);

    expect(billing.allowed).toBe(false);
    expect(destructive.allowed).toBe(false);
    if (!billing.allowed) expect(billing.reason).toContain('EURODNS_ALLOW_BILLING');
    expect(evaluateGuardrails('read', guardrails).allowed).toBe(true);
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

describe('confirmation before irreversible and billable operations', () => {
  const enabled = (extra: Record<string, string> = {}) =>
    testConfig({
      EURODNS_ALLOW_BILLING: 'true',
      EURODNS_ALLOW_DESTRUCTIVE: 'true',
      ...extra,
    });

  it('asks nothing when confirmation is off, which is the default', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({ config: enabled(), fetchImpl });

    const result = await client.callTool({
      name: 'eurodns_ssl_revoke_certificate',
      arguments: { subscriptionId: 1, certificateId: 2 },
    });

    expect(isError(result)).toBeFalsy();
    expect(requests).toHaveLength(1);

    await close();
  });

  it('runs the operation once the caller accepts', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({
      config: enabled({ EURODNS_CONFIRM: 'destructive' }),
      fetchImpl,
      onElicit: () => ({ action: 'accept', content: { confirm: true } }),
    });

    const result = await client.callTool({
      name: 'eurodns_ssl_revoke_certificate',
      arguments: { subscriptionId: 1, certificateId: 2 },
    });

    expect(isError(result)).toBeFalsy();
    expect(requests).toHaveLength(1);

    await close();
  });

  it('refuses when the caller accepts without saying yes', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({
      config: enabled({ EURODNS_CONFIRM: 'destructive' }),
      fetchImpl,
      // An accepted form that does not carry the flag is not a confirmation. The values come
      // from the client and are never re-validated by the SDK, so this is the shape a buggy
      // or hostile peer would send to slip past a looser check.
      onElicit: () => ({ action: 'accept', content: { confirm: false } }),
    });

    const result = await client.callTool({
      name: 'eurodns_ssl_revoke_certificate',
      arguments: { subscriptionId: 1, certificateId: 2 },
    });

    expect(isError(result)).toBe(true);
    expect(requests).toHaveLength(0);

    await close();
  });

  it('leaves billing alone on the destructive-only setting', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({
      config: enabled({ EURODNS_CONFIRM: 'destructive' }),
      fetchImpl,
      onElicit: () => ({ action: 'decline' }),
    });

    const result = await client.callTool({
      name: 'eurodns_premium_dns_renew_subscription',
      arguments: { subscriptionId: 1, body: { duration: 1 } },
    });

    expect(isError(result)).toBeFalsy();
    expect(requests).toHaveLength(1);

    await close();
  });
});
