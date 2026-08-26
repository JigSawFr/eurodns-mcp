import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { FetchLike } from '../src/services/client.js';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  /** Raw text, when the point of the test is a non-JSON body. */
  text?: string;
}

/**
 * A fetch stand-in that records what the client actually sent.
 *
 * The client takes its fetch by injection, so tests can assert on the exact request —
 * headers included — without an HTTP interception layer.
 */
export function stubFetch(
  handler: (req: RecordedRequest) => StubResponse | Promise<StubResponse>,
): {
  fetchImpl: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const request: RecordedRequest = {
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);

    const result = await handler(request);
    const status = result.status ?? 200;
    const payload = result.text ?? (result.body === undefined ? '' : JSON.stringify(result.body));

    return new Response(status === 204 || payload === '' ? null : payload, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetchImpl, requests };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig(
    {
      EURODNS_APP_ID: 'test-app-id',
      EURODNS_API_KEY: 'test-api-key',
      EURODNS_MAX_RETRIES: '0',
      EURODNS_AUDIT_DESTINATION: 'none',
      ...overrides,
    } as NodeJS.ProcessEnv,
    'stdio',
  );
}

/** Connects a real MCP client to a real server over an in-memory transport pair. */
export async function connect(options: { config?: Config; fetchImpl?: FetchLike } = {}) {
  const config = options.config ?? testConfig();
  const { server, toolCount } = buildServer({
    config,
    transport: 'stdio',
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    toolCount,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Extracts the first text block of a tool result. */
export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((c) => c.type === 'text')?.text ?? '';
}

export function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}
