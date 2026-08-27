import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, hashLine } from '../src/audit.js';
import { loadConfig, ConfigError, type AuditForwardConfig } from '../src/config.js';
import { MetricsRegistry } from '../src/metrics.js';

const COLLECTOR = 'https://collector.example/ingest';

function forwardConfig(overrides: Partial<AuditForwardConfig> = {}): AuditForwardConfig {
  return {
    url: COLLECTOR,
    batch: 100,
    intervalMs: 5,
    queue: 10_000,
    maxRetries: 0,
    backoffMs: 1,
    ...overrides,
  };
}

function auditFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'eurodns-forward-')), 'audit.jsonl');
}

/** A collector that accepts everything and keeps the bodies it was sent. */
function acceptingFetch(): {
  impl: typeof fetch;
  bodies: string[];
  headers: Record<string, string>[];
} {
  const bodies: string[] = [];
  const headers: Record<string, string>[] = [];
  const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''));
    headers.push({ ...(init?.headers as Record<string, string> | undefined) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { impl, bodies, headers };
}

function record(logger: AuditLogger, tool: string): void {
  logger
    .begin({ actor: { mode: 'stdio', subject: 'tester' }, tool, risk: 'read' })
    .complete({ verdict: 'allowed' });
}

describe('shipping the audit log to a collector', () => {
  it('sends what the local destination recorded, byte for byte', async () => {
    const file = auditFile();
    const { impl, bodies } = acceptingFetch();
    const logger = new AuditLogger(
      { destination: 'file', filePath: file, query: 'off', maxBytes: 0, forward: forwardConfig() },
      () => Date.parse('2026-01-01T00:00:00Z'),
      undefined,
      impl,
    );

    record(logger, 'read_one');
    record(logger, 'read_two');
    await logger.close(1_000);

    // The whole point of shipping the serialized line rather than re-rendering the record:
    // a collector that holds the same bytes can re-verify the same hash chain.
    expect(bodies.join('')).toBe(readFileSync(file, 'utf8'));
  });

  it('ships a chain the collector can verify on its own', async () => {
    const { impl, bodies } = acceptingFetch();
    const logger = new AuditLogger(
      { destination: 'none', query: 'off', maxBytes: 0, forward: forwardConfig() },
      () => Date.parse('2026-01-01T00:00:00Z'),
      undefined,
      impl,
    );

    record(logger, 'first');
    record(logger, 'second');
    record(logger, 'third');
    await logger.close(1_000);

    const lines = bodies.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);

    // `destination: 'none'` used to short-circuit before the chain advanced. It must not,
    // or every shipped line would claim to follow nothing.
    expect((JSON.parse(lines[0] as string) as { prev: unknown }).prev).toBeNull();
    for (let i = 1; i < lines.length; i += 1) {
      const previous = lines[i - 1] as string;
      const current = JSON.parse(lines[i] as string) as { prev: string; seq: number };
      expect(current.prev).toBe(hashLine(previous));
      expect(current.seq).toBe(i + 1);
    }
  });

  it('carries the token as a bearer credential and NDJSON as the type', async () => {
    const { impl, headers } = acceptingFetch();
    const logger = new AuditLogger(
      {
        destination: 'none',
        query: 'off',
        maxBytes: 0,
        forward: forwardConfig({ token: 'shhh' }),
      },
      () => Date.parse('2026-01-01T00:00:00Z'),
      undefined,
      impl,
    );

    record(logger, 'read_one');
    await logger.close(1_000);

    expect(headers[0]?.Authorization).toBe('Bearer shhh');
    expect(headers[0]?.['Content-Type']).toBe('application/x-ndjson');
  });

  it('sends early once a batch is full, without waiting for the interval', async () => {
    const { impl, bodies } = acceptingFetch();
    const logger = new AuditLogger(
      {
        destination: 'none',
        query: 'off',
        maxBytes: 0,
        // An interval far longer than this test: anything that arrives did so on the cap.
        forward: forwardConfig({ batch: 2, intervalMs: 600_000 }),
      },
      () => Date.parse('2026-01-01T00:00:00Z'),
      undefined,
      impl,
    );

    record(logger, 'a');
    record(logger, 'b');
    await vi.waitUntil(() => bodies.length > 0, { timeout: 1_000 });

    expect(bodies.join('').split('\n').filter(Boolean)).toHaveLength(2);
    await logger.close(1_000);
  });

  it('bounds the queue and counts what it drops when the collector is unreachable', async () => {
    const failures: string[] = [];
    const impl = vi.fn(async () => {
      failures.push('called');
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    // The real registry, not a stub: what matters to an operator is the number that comes
    // out of /metrics, and a stub would assert the call rather than the reading.
    const metrics = new MetricsRegistry(() => 0);

    const logger = new AuditLogger(
      {
        destination: 'none',
        query: 'off',
        maxBytes: 0,
        forward: forwardConfig({ batch: 1_000, queue: 5, intervalMs: 600_000 }),
      },
      () => Date.parse('2026-01-01T00:00:00Z'),
      metrics,
      impl,
    );

    // Twenty lines into a queue of five. A tool call must not slow down or fail for it.
    for (let i = 0; i < 20; i += 1) record(logger, `t${i}`);

    // 20 calls, each writing one completed line, 5 kept: 15 dropped.
    const rendered = () => metrics.render({ version: '0.0.0', toolCount: 0 });
    expect(rendered()).toContain('eurodns_mcp_audit_forward_dropped_total 15');

    await logger.close(50);

    // The five that survived the queue then failed to send, and are counted separately:
    // a full queue and an unreachable collector are different problems.
    expect(failures.length).toBeGreaterThan(0);
    expect(rendered()).toContain('eurodns_mcp_audit_forward_failures_total 5');
  });

  it('retries a 5xx and gives up on a 4xx, which will not fix itself', async () => {
    const seen: number[] = [];
    const responses = [500, 503, 204];
    const impl = vi.fn(async () => {
      const status = responses[seen.length] ?? 204;
      seen.push(status);
      return new Response(null, { status });
    }) as unknown as typeof fetch;

    const retrying = new AuditLogger(
      {
        destination: 'none',
        query: 'off',
        maxBytes: 0,
        forward: forwardConfig({ maxRetries: 3, backoffMs: 1 }),
      },
      () => Date.parse('2026-01-01T00:00:00Z'),
      undefined,
      impl,
    );
    record(retrying, 'flaky_collector');
    await retrying.close(2_000);

    expect(seen).toEqual([500, 503, 204]);

    // A 400 is a misconfiguration. Sending it again only delays the report.
    const rejected: number[] = [];
    const refusing = vi.fn(async () => {
      rejected.push(400);
      return new Response(null, { status: 400 });
    }) as unknown as typeof fetch;

    const metrics = new MetricsRegistry(() => 0);
    const giving = new AuditLogger(
      {
        destination: 'none',
        query: 'off',
        maxBytes: 0,
        forward: forwardConfig({ maxRetries: 5, backoffMs: 1 }),
      },
      () => Date.parse('2026-01-01T00:00:00Z'),
      metrics,
      refusing,
    );
    record(giving, 'misconfigured');
    await giving.close(2_000);

    expect(rejected).toHaveLength(1);
    expect(metrics.render({ version: '0.0.0', toolCount: 0 })).toContain(
      'eurodns_mcp_audit_forward_failures_total 1',
    );
  });

  it('gives up on the deadline rather than hanging on a collector that never answers', async () => {
    // Never resolves. Without the deadline in close(), shutdown would wait for SIGKILL.
    const impl = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const logger = new AuditLogger(
      { destination: 'none', query: 'off', maxBytes: 0, forward: forwardConfig() },
      () => Date.parse('2026-01-01T00:00:00Z'),
      undefined,
      impl,
    );

    record(logger, 'into_the_void');
    const startedAt = Date.now();
    await logger.close(60);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('does nothing at all when no collector is configured', async () => {
    const { impl, bodies } = acceptingFetch();
    const file = auditFile();
    const logger = new AuditLogger(
      { destination: 'file', filePath: file, query: 'off', maxBytes: 0 },
      () => Date.parse('2026-01-01T00:00:00Z'),
      undefined,
      impl,
    );

    record(logger, 'read_one');
    await logger.close(50);

    expect(bodies).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('read_one');
  });
});

describe('collector configuration', () => {
  const base = {
    EURODNS_APP_ID: 'app',
    EURODNS_API_KEY: 'key',
    EURODNS_MCP_AUTH: 'none',
  };

  it('refuses a plain-http collector that is not on loopback', () => {
    expect(() =>
      loadConfig({ ...base, EURODNS_AUDIT_FORWARD_URL: 'http://siem.example/in' }, 'stdio'),
    ).toThrow(ConfigError);
  });

  it('accepts plain http on loopback, where a sidecar usually lives', () => {
    const config = loadConfig(
      { ...base, EURODNS_AUDIT_FORWARD_URL: 'http://127.0.0.1:9000/in' },
      'stdio',
    );
    expect(config.audit.forward?.url).toBe('http://127.0.0.1:9000/in');
  });

  it('refuses a token with no URL, rather than quietly shipping nothing', () => {
    expect(() => loadConfig({ ...base, EURODNS_AUDIT_FORWARD_TOKEN: 'shhh' }, 'stdio')).toThrow(
      /EURODNS_AUDIT_FORWARD_URL is not/,
    );
  });

  it('leaves the forwarder unconfigured when no URL is set', () => {
    expect(loadConfig(base, 'stdio').audit.forward).toBeUndefined();
  });
});

describe('against a real collector', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('delivers over the network and drains on close', async () => {
    const received: string[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        received.push(body);
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    const logger = new AuditLogger(
      {
        destination: 'none',
        query: 'off',
        maxBytes: 0,
        forward: forwardConfig({ url: `http://127.0.0.1:${port}/ingest`, intervalMs: 600_000 }),
      },
      () => Date.parse('2026-01-01T00:00:00Z'),
    );

    record(logger, 'over_the_wire');

    // Nothing has been sent yet: the batch is not full and the interval is far away. Only
    // the drain on close gets it out, which is the case a SIGTERM has to survive.
    expect(received).toEqual([]);
    await logger.close(2_000);

    const lines = received.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as { tool: string; seq: number; prev: null };
    expect(parsed.tool).toBe('over_the_wire');
    expect(
      createHash('sha256')
        .update(lines[0] as string, 'utf8')
        .digest('hex'),
    ).toHaveLength(64);
  });
});
