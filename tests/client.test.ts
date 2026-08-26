import { describe, expect, it } from 'vitest';
import { EuroDnsClient } from '../src/services/client.js';
import { EuroDnsApiError } from '../src/services/errors.js';
import { stubFetch, testConfig } from './harness.js';

const upstream = testConfig().upstream;

describe('EuroDNS client', () => {
  it('authenticates with the two apiKey headers the API expects', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: { ok: true } }));
    await new EuroDnsClient(upstream, fetchImpl).request({ method: 'GET', path: '/tlds' });

    expect(requests[0]?.headers['x-app-id']).toBe('test-app-id');
    expect(requests[0]?.headers['x-api-key']).toBe('test-api-key');
  });

  it('sends pagination as request headers, not query parameters', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [] }));
    await new EuroDnsClient(upstream, fetchImpl).request({
      method: 'GET',
      path: '/invoices',
      pagination: { page: 3, size: 50, sortField: 'created', sortOrder: 'DESC' },
    });

    const request = requests[0];
    expect(request?.headers['pagination-page']).toBe('3');
    expect(request?.headers['pagination-size']).toBe('50');
    expect(request?.headers['pagination-sortfield']).toBe('created');
    expect(request?.headers['pagination-sortorder']).toBe('DESC');
    // The quirk must not leak into the URL.
    expect(request?.url).not.toContain('pagination');
  });

  it('turns the API error envelope into an actionable message', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 401,
      body: { errors: [{ code: 'API_KEY_REQUIRED', title: 'API Key required' }] },
    }));

    await expect(
      new EuroDnsClient(upstream, fetchImpl).request({ method: 'GET', path: '/tlds' }),
    ).rejects.toMatchObject({
      name: 'EuroDnsApiError',
      status: 401,
      codes: ['API_KEY_REQUIRED'],
    });
  });

  it('points at the IP allowlist on 403, the usual cause', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 403, body: { errors: [] } }));
    const error = (await new EuroDnsClient(upstream, fetchImpl)
      .request({ method: 'GET', path: '/tlds' })
      .catch((e: unknown) => e)) as EuroDnsApiError;

    expect(error.message).toContain('whitelisted');
  });

  it('directs a rejected zone save to the validator instead of the generic 400', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 400, body: { errors: [] } }));
    const error = (await new EuroDnsClient(upstream, fetchImpl)
      .request({ method: 'PUT', path: '/dns-zones/example.com', body: {} })
      .catch((e: unknown) => e)) as EuroDnsApiError;

    expect(error.message).toContain('Validate it first');
  });

  it('names the balance as the cause of an insufficient-funds failure', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 400,
      body: { errors: [{ code: 'INSUFFICIENT_PREPAID_BALANCE', title: 'Not enough credit' }] },
    }));
    const error = (await new EuroDnsClient(upstream, fetchImpl)
      .request({ method: 'POST', path: '/ssl-subscriptions/create', body: {} })
      .catch((e: unknown) => e)) as EuroDnsApiError;

    expect(error.message).toContain('prepaid account has insufficient funds');
  });

  it('retries 5xx but not 4xx', async () => {
    let calls = 0;
    const { fetchImpl } = stubFetch(() => {
      calls += 1;
      return calls === 1 ? { status: 503, body: { errors: [] } } : { body: { ok: true } };
    });

    const client = new EuroDnsClient({ ...upstream, maxRetries: 1 }, fetchImpl);
    const response = await client.request({ method: 'GET', path: '/tlds' });
    expect(response.data).toEqual({ ok: true });
    expect(calls).toBe(2);

    let notFoundCalls = 0;
    const notFound = stubFetch(() => {
      notFoundCalls += 1;
      return { status: 404, body: { errors: [] } };
    });
    await new EuroDnsClient({ ...upstream, maxRetries: 2 }, notFound.fetchImpl)
      .request({ method: 'GET', path: '/domains/example.com' })
      .catch(() => undefined);
    expect(notFoundCalls).toBe(1);
  });

  it('treats 204 as an empty success rather than a parse failure', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 204 }));
    const response = await new EuroDnsClient(upstream, fetchImpl).request({
      method: 'PUT',
      path: '/dns-zones/example.com',
      body: {},
    });
    expect(response.status).toBe(204);
    expect(response.data).toBeNull();
  });
});
