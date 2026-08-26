import type { UpstreamConfig } from '../config.js';
import { PAGINATION_HEADERS } from '../constants.js';
import {
  EuroDnsApiError,
  EuroDnsTransportError,
  describeUpstreamError,
  extractErrors,
} from './errors.js';

/**
 * Pagination as the API expects it: request *headers*, not query parameters.
 * Tools expose these as ordinary arguments and the client does the translation, so an
 * agent never has to know about this quirk.
 */
export interface Pagination {
  page?: number;
  size?: number;
  sortField?: string;
  sortOrder?: string;
}

export interface RequestOptions {
  method: string;
  /** Path with placeholders already substituted, e.g. `/dns-zones/example.com`. */
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  pagination?: Pagination;
  /** Extra upstream headers declared by the operation (rare, outside pagination). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface UpstreamResponse<T = unknown> {
  status: number;
  data: T;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Minimal fetch surface, so tests can inject a stub without a global override. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class EuroDnsClient {
  private readonly config: UpstreamConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: UpstreamConfig, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async request<T = unknown>(options: RequestOptions): Promise<UpstreamResponse<T>> {
    const url = this.buildUrl(options.path, options.query);
    const headers = this.buildHeaders(options);
    const init: RequestInit = { method: options.method, headers };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (attempt > 0) await delay(backoffMs(attempt));

      let response: Response;
      try {
        response = await this.fetchOnce(url, init, options.signal);
      } catch (cause) {
        lastError = cause;
        // Transport failures are retried on the same terms as 5xx responses.
        if (attempt === this.config.maxRetries) {
          throw new EuroDnsTransportError(
            `EuroDNS API ${options.method} ${options.path} could not be reached: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            options.method,
            options.path,
            { cause },
          );
        }
        continue;
      }

      const data = await readBody(response);

      if (response.ok) {
        return { status: response.status, data: data as T };
      }

      if (RETRYABLE_STATUSES.has(response.status) && attempt < this.config.maxRetries) {
        lastError = data;
        continue;
      }

      const { codes, titles } = extractErrors(data);
      throw new EuroDnsApiError({
        status: response.status,
        codes,
        titles,
        method: options.method,
        path: options.path,
        message: describeUpstreamError({
          status: response.status,
          codes,
          titles,
          method: options.method,
          path: options.path,
        }),
      });
    }

    /* c8 ignore next 7 -- the loop always returns or throws; this guards a future edit. */
    throw new EuroDnsTransportError(
      `EuroDNS API ${options.method} ${options.path} exhausted retries`,
      options.method,
      options.path,
      { cause: lastError },
    );
  }

  private async fetchOnce(url: string, init: RequestInit, external?: AbortSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onAbort = () => controller.abort();
    external?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = new URL(path, this.config.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private buildHeaders(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      // The API authenticates with two apiKey headers; there is no OAuth upstream.
      'X-APP-ID': this.config.appId,
      'X-API-KEY': this.config.apiKey,
      Accept: 'application/json',
      ...options.headers,
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const pagination = options.pagination;
    if (pagination) {
      if (pagination.page !== undefined) {
        headers[PAGINATION_HEADERS.page] = String(pagination.page);
      }
      if (pagination.size !== undefined) {
        headers[PAGINATION_HEADERS.size] = String(pagination.size);
      }
      if (pagination.sortField !== undefined) {
        headers[PAGINATION_HEADERS.sortField] = pagination.sortField;
      }
      if (pagination.sortOrder !== undefined) {
        headers[PAGINATION_HEADERS.sortOrder] = pagination.sortOrder;
      }
    }

    return headers;
  }
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 250, 4_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
