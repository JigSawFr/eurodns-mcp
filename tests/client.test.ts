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

  it('builds a query string, repeating an array and skipping what is empty', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: [] }));
    await new EuroDnsClient(upstream, fetchImpl).request({
      method: 'GET',
      path: '/domains',
      query: {
        status: ['active', 'pending'],
        name: 'example.com',
        // Each of these has to be dropped rather than sent as the string "undefined",
        // "null" or an empty parameter the API would reject.
        missing: undefined,
        cleared: null,
        blank: '',
      },
    });

    const url = new URL(requests[0]?.url as string);
    expect(url.searchParams.getAll('status')).toEqual(['active', 'pending']);
    expect(url.searchParams.get('name')).toBe('example.com');
    expect(url.searchParams.has('missing')).toBe(false);
    expect(url.searchParams.has('cleared')).toBe(false);
    expect(url.searchParams.has('blank')).toBe(false);
  });

  it('treats an empty body as no content, whatever the status says', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, text: '' }));
    const result = await new EuroDnsClient(upstream, fetchImpl).request({
      method: 'GET',
      path: '/tlds',
    });

    // A 200 with nothing in it is not a parse error; JSON.parse('') would make it one.
    expect(result.data).toBeNull();
  });

  it('gives up after the last retry and says what went wrong', async () => {
    let calls = 0;
    const { fetchImpl } = stubFetch(() => {
      calls += 1;
      throw new Error('socket hang up');
    });

    await expect(
      new EuroDnsClient({ ...upstream, maxRetries: 2 }, fetchImpl).request({
        method: 'GET',
        path: '/tlds',
      }),
    ).rejects.toThrow(/socket hang up/);

    // The first attempt plus two retries — not two attempts, and not an endless loop.
    expect(calls).toBe(3);
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
