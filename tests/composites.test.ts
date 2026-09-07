import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../src/generated/operations.js';
import { ABSORBED_OPERATION_IDS, COMPOSITES, memberOperation } from '../src/tools/composites.js';
import { toolNameFor } from '../src/tools/naming.js';
import { connect, isError, stubFetch, testConfig, textOf } from './harness.js';

const BASE = 'https://rest-api.eurodns.com';

/** Everything advertised: billing and destructive on, so every composite and member is in play. */
const everything = () =>
  testConfig({ EURODNS_ALLOW_BILLING: 'true', EURODNS_ALLOW_DESTRUCTIVE: 'true' });

/** One call through a composite, returning what reached the upstream. */
async function call(name: string, args: Record<string, unknown>, body: unknown = {}) {
  const { fetchImpl, requests } = stubFetch(() => ({ body }));
  const { client, close } = await connect({ config: everything(), fetchImpl });
  try {
    const result = await client.callTool({ name, arguments: args });
    return { result, requests };
  } finally {
    await close();
  }
}

describe('the composite tools', () => {
  it('each stand in for two operations of one risk class', () => {
    for (const composite of COMPOSITES) {
      expect(composite.members).toHaveLength(2);
      for (const id of composite.members) {
        expect(memberOperation(id).risk, `${composite.name} <- ${id}`).toBe(composite.risk);
        expect(ABSORBED_OPERATION_IDS.has(id), id).toBe(true);
      }
    }
  });

  it('replace their members in the surface, so no operation is reachable twice', async () => {
    const { client, toolCount, close } = await connect({ config: everything() });
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    await close();

    for (const composite of COMPOSITES)
      expect(names.has(composite.name), composite.name).toBe(true);

    // The composite may keep its `get` member's canonical name; what must not survive is the
    // twin — the `list`, the `create`, the `unsign` — under a name of its own.
    for (const gone of [
      'eurodns_invoice_list',
      'eurodns_ssl_list_subscriptions',
      'eurodns_subscription_list',
      'eurodns_dns_list_zone_profiles',
      'eurodns_dns_create_zone_profile',
      'eurodns_contact_create_profile',
      'eurodns_contact_update_profile',
      'eurodns_dns_sign_zone',
      'eurodns_dns_unsign_zone',
      'eurodns_domain_sign',
      'eurodns_email_create_alias',
      'eurodns_email_delete_catchall',
      'eurodns_dns_delete_record_by_id',
    ]) {
      expect(names.has(gone), gone).toBe(false);
    }
    expect(names.has('eurodns_subscription_search')).toBe(true);

    expect(names.size).toBe(toolCount);
    expect(toolCount).toBe(OPERATIONS.length - ABSORBED_OPERATION_IDS.size + COMPOSITES.length + 4);
  });

  it('name only operations the document defines, and say which one when not', () => {
    for (const composite of COMPOSITES) {
      for (const id of composite.members) expect(() => memberOperation(id)).not.toThrow();
    }
    expect(() => memberOperation('renameDomainToSomethingElse')).toThrow(
      /renameDomainToSomethingElse/,
    );
  });

  it('merge a create with a replace only where both take one body and the replace one id', () => {
    for (const composite of COMPOSITES.filter((c) => c.name.includes('_save_'))) {
      const [create, update] = composite.members.map(memberOperation);
      expect(create?.method).toBe('POST');
      expect(update?.method).toBe('PUT');
      expect(create?.body?.schema, composite.name).toBe(update?.body?.schema);
      expect(update?.pathParams).toHaveLength(1);
    }
  });

  it('never reuse a name that a standalone generated tool still carries', () => {
    const standalone = new Set(
      OPERATIONS.filter((o) => !ABSORBED_OPERATION_IDS.has(o.operationId)).map(toolNameFor),
    );
    for (const composite of COMPOSITES) {
      expect(standalone.has(composite.name), composite.name).toBe(false);
    }
  });

  it('hide their write members under a read-only deployment, and keep the reads', async () => {
    const { client, close } = await connect({ config: testConfig({ EURODNS_READ_ONLY: 'true' }) });
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    await close();

    expect(names.has('eurodns_contact_get_profile')).toBe(true);
    expect(names.has('eurodns_contact_save_profile')).toBe(false);
    expect(names.has('eurodns_dns_set_dnssec')).toBe(false);
  });
});

describe('a get-or-list composite', () => {
  it('fetches one item when given an id', async () => {
    const { requests } = await call('eurodns_invoice_get', { id: 7 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe(`${BASE}/invoices/7`);
  });

  it('lists with the filters and pagination when the id is omitted', async () => {
    const { requests } = await call('eurodns_invoice_get', {
      page: 2,
      size: 10,
      invoiceType: 'INVOICE',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${BASE}/invoices?invoice-type=INVOICE`);
    expect(requests[0]?.headers['pagination-page']).toBe('2');
    expect(requests[0]?.headers['pagination-size']).toBe('10');
  });

  it('maps the shared id onto the member’s own parameter name', async () => {
    const { requests } = await call('eurodns_invoice_profile_get', { id: 3 });
    expect(requests[0]?.url).toBe(`${BASE}/customer-invoice-profiles/3`);

    const ssl = await call('eurodns_ssl_get_subscription', { id: 9 });
    expect(ssl.requests[0]?.url).toBe(`${BASE}/ssl-subscriptions/9`);
  });

  it('passes a path parameter both members share', async () => {
    const one = await call('eurodns_dns_get_zone_snapshot', { domainName: 'example.com', id: 5 });
    expect(one.requests[0]?.url).toBe(`${BASE}/dns-zones/example.com/snapshots/5`);

    const all = await call('eurodns_dns_get_zone_snapshot', { domainName: 'example.com' });
    expect(all.requests[0]?.url).toBe(`${BASE}/dns-zones/example.com/snapshots`);
  });

  it('exposes the listing’s own filters', async () => {
    const { requests } = await call('eurodns_ssl_get_subscription', {
      commonName: 'www.example.com',
    });
    expect(requests[0]?.url).toBe(`${BASE}/ssl-subscriptions?common-name=www.example.com`);
  });
});

describe('a create-or-update composite', () => {
  const body = { profileName: 'Ops', contactType: 'COMPANY' };

  it('creates when the id is omitted', async () => {
    const { requests } = await call('eurodns_contact_save_profile', { body, lang: 'en' });
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(`${BASE}/contact-profiles?lang=en`);
    expect(requests[0]?.body).toEqual(body);
  });

  it('replaces when the id is given', async () => {
    const { requests } = await call('eurodns_contact_save_profile', { id: 4, body });
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.url).toBe(`${BASE}/contact-profiles/4`);
    expect(requests[0]?.body).toEqual(body);
  });

  it('does the same for zone and nameserver profiles', async () => {
    const zone = await call('eurodns_dns_save_zone_profile', { id: 2, body: { name: 'web' } });
    expect(zone.requests[0]?.method).toBe('PUT');
    expect(zone.requests[0]?.url).toBe(`${BASE}/zone-profiles/2`);

    const ns = await call('eurodns_nameserver_save_profile', { body: { name: 'default' } });
    expect(ns.requests[0]?.method).toBe('POST');
    expect(ns.requests[0]?.url).toBe(`${BASE}/nameserver-profiles`);
  });
});

describe('a switch composite', () => {
  it('signs or unsigns a zone on the flag', async () => {
    const on = await call('eurodns_dns_set_dnssec', { domainName: 'example.com', enabled: true });
    expect(on.requests[0]?.method).toBe('POST');
    expect(on.requests[0]?.url).toBe(`${BASE}/dns-zones/example.com/sign`);

    const off = await call('eurodns_dns_set_dnssec', { domainName: 'example.com', enabled: false });
    expect(off.requests[0]?.url).toBe(`${BASE}/dns-zones/example.com/unsign`);
  });

  it('publishes or withdraws a domain’s DS records on the flag', async () => {
    const on = await call('eurodns_domain_set_dnssec', {
      domainName: 'example.com',
      enabled: true,
    });
    expect(on.requests[0]?.url).toBe(`${BASE}/domains/example.com/sign`);

    const off = await call('eurodns_domain_set_dnssec', {
      domainName: 'example.com',
      enabled: false,
    });
    expect(off.requests[0]?.url).toBe(`${BASE}/domains/example.com/unsign`);
  });

  it('adds or removes an alias on the action', async () => {
    const add = await call('eurodns_email_set_alias', {
      id: 1,
      alias: 'sales@example.com',
      action: 'add',
    });
    expect(add.requests[0]?.method).toBe('POST');
    expect(add.requests[0]?.url).toBe(`${BASE}/email-subscriptions/1/aliases/sales%40example.com`);

    const remove = await call('eurodns_email_set_alias', {
      id: 1,
      alias: 'sales@example.com',
      action: 'remove',
    });
    expect(remove.requests[0]?.method).toBe('DELETE');
    expect(remove.requests[0]?.url).toBe(
      `${BASE}/email-subscriptions/1/aliases/sales%40example.com`,
    );
  });

  it('turns the catch-all on or off on the flag', async () => {
    const on = await call('eurodns_email_set_catchall', { id: 1, enabled: true });
    expect(on.requests[0]?.method).toBe('POST');
    expect(on.requests[0]?.url).toBe(`${BASE}/email-subscriptions/1/catch-all`);

    const off = await call('eurodns_email_set_catchall', { id: 1, enabled: false });
    expect(off.requests[0]?.method).toBe('DELETE');
  });

  it('refuses a call without the choosing argument before anything is sent', async () => {
    const { result, requests } = await call('eurodns_email_set_alias', {
      id: 1,
      alias: 'a@example.com',
    });
    expect(isError(result)).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe('what a composite leaves in the audit log', () => {
  it('names the composite, not the member it resolved to', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'eurodns-composite-')), 'audit.jsonl');
    const { fetchImpl } = stubFetch(() => ({ body: [] }));
    const { client, close } = await connect({
      config: testConfig({ EURODNS_AUDIT_DESTINATION: 'file', EURODNS_AUDIT_FILE: file }),
      fetchImpl,
    });
    await client.callTool({ name: 'eurodns_order_get', arguments: { id: 12 } });
    await client.callTool({ name: 'eurodns_order_get', arguments: {} });
    await close();

    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { tool: string; target?: string; verdict?: string });
    const completed = lines.filter((line) => line.verdict === 'allowed');
    expect(completed).toHaveLength(2);
    expect(completed.map((line) => line.tool)).toEqual(['eurodns_order_get', 'eurodns_order_get']);
    // The member's own argument is what identifies the target, mapped or not.
    expect(completed[0]?.target).toBe('12');
  });
});

describe('eurodns_dns_delete_record by id', () => {
  it('deletes directly, without reading the zone first', async () => {
    const { result, requests } = await call('eurodns_dns_delete_record', {
      domainName: 'example.com',
      recordId: 42,
    });
    expect(isError(result)).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url).toBe(`${BASE}/dns-zones/example.com/dns-records/42`);
  });

  it('reports the upstream status when the delete by id fails', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ status: 404, body: { errors: [] } }));
    const { client, close } = await connect({ fetchImpl });
    try {
      const result = await client.callTool({
        name: 'eurodns_dns_delete_record',
        arguments: { domainName: 'example.com', recordId: 42 },
      });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('404');
      expect(requests).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('refuses a call that names the record neither by id nor by type and host', async () => {
    const { result, requests } = await call('eurodns_dns_delete_record', {
      domainName: 'example.com',
      type: 'TXT',
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/recordId|type and host/);
    expect(requests).toHaveLength(0);
  });
});
