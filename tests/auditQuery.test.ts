import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { queryAuditLog } from '../src/auditReader.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { connect, isError, stubFetch, testConfig, textOf } from './harness.js';

function logFile(lines: object[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'eurodns-query-')), 'audit.jsonl');
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return path;
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    ts: '2026-01-02T10:00:00.000Z',
    correlationId: 'c1',
    phase: 'completed',
    actor: { mode: 'oauth', subject: 'alice@example.com' },
    tool: 'eurodns_dns_get_zone',
    risk: 'read',
    target: 'example.com',
    verdict: 'allowed',
    ...overrides,
  };
}

describe('audit log reader', () => {
  it('returns newest first and honours the limit', () => {
    const path = logFile([
      entry({ ts: '2026-01-01T10:00:00.000Z', correlationId: 'oldest' }),
      entry({ ts: '2026-01-02T10:00:00.000Z', correlationId: 'middle' }),
      entry({ ts: '2026-01-03T10:00:00.000Z', correlationId: 'newest' }),
    ]);

    const result = queryAuditLog(path, { limit: 2 });
    expect(result.entries.map((e) => e.correlationId)).toEqual(['newest', 'middle']);
    expect(result.truncated).toBe(false);
  });

  it('hides the started lines unless asked', () => {
    const path = logFile([entry({ phase: 'started', verdict: undefined }), entry()]);

    expect(queryAuditLog(path, { limit: 10 }).entries).toHaveLength(1);
    expect(queryAuditLog(path, { limit: 10, includeStarted: true }).entries).toHaveLength(2);
  });

  it('filters by tool, verdict, target and time range', () => {
    const path = logFile([
      entry({ tool: 'eurodns_dns_get_zone', verdict: 'allowed', ts: '2026-01-01T00:00:00.000Z' }),
      entry({
        tool: 'eurodns_ssl_revoke_certificate',
        verdict: 'denied',
        ts: '2026-01-05T00:00:00.000Z',
      }),
      entry({ tool: 'eurodns_dns_get_zone', verdict: 'failed', target: 'other.example' }),
    ]);

    expect(queryAuditLog(path, { limit: 10, verdict: 'denied' }).entries).toHaveLength(1);
    expect(queryAuditLog(path, { limit: 10, tool: 'eurodns_dns_get_zone' }).entries).toHaveLength(
      2,
    );
    expect(queryAuditLog(path, { limit: 10, target: 'other.example' }).entries).toHaveLength(1);
    expect(
      queryAuditLog(path, { limit: 10, since: '2026-01-03T00:00:00.000Z' }).entries,
    ).toHaveLength(1);
    // Two entries predate this bound: the 01-01 one and the 01-02 default.
    expect(
      queryAuditLog(path, { limit: 10, until: '2026-01-03T00:00:00.000Z' }).entries,
    ).toHaveLength(2);
  });

  it('reports truncation and drops the fragment the window cuts in half', () => {
    const path = logFile(Array.from({ length: 50 }, (_, i) => entry({ correlationId: `c${i}` })));
    const size = readFileSync(path, 'utf8').length;

    const result = queryAuditLog(path, { limit: 100 }, Math.floor(size / 2));
    expect(result.truncated).toBe(true);
    // Every returned entry parsed cleanly despite the window starting mid-line.
    expect(result.entries.every((e) => typeof e.correlationId === 'string')).toBe(true);
  });

  it('survives a corrupt line instead of failing the whole query', () => {
    const path = logFile([entry({ correlationId: 'good' })]);
    writeFileSync(
      path,
      `{"broken": \n${JSON.stringify(entry({ correlationId: 'good' }))}\n`,
      'utf8',
    );

    expect(queryAuditLog(path, { limit: 10 }).entries).toHaveLength(1);
  });

  it('treats a missing log file as an empty history', () => {
    expect(queryAuditLog('/nonexistent/audit.jsonl', { limit: 10 })).toEqual({
      entries: [],
      scanned: 0,
      truncated: false,
      // Nothing to verify is not the same as a failed verification.
      chain: { intact: true, verified: 0, segments: 0 },
    });
  });
});

describe('audit query configuration', () => {
  const base = { EURODNS_APP_ID: 'a', EURODNS_API_KEY: 'b' };

  it('refuses a query mode without a readable destination', () => {
    expect(() =>
      loadConfig({ ...base, EURODNS_AUDIT_QUERY: 'own' } as NodeJS.ProcessEnv, 'stdio'),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        {
          ...base,
          EURODNS_AUDIT_QUERY: 'own',
          EURODNS_AUDIT_DESTINATION: 'file',
          EURODNS_AUDIT_FILE: '/tmp/a.jsonl',
        } as NodeJS.ProcessEnv,
        'stdio',
      ),
    ).not.toThrow();
  });

  it('defaults to off', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv, 'stdio').audit.query).toBe('off');
  });
});

describe('eurodns_audit_query tool', () => {
  function withLog(path: string, query: string) {
    return testConfig({
      EURODNS_AUDIT_DESTINATION: 'file',
      EURODNS_AUDIT_FILE: path,
      EURODNS_AUDIT_QUERY: query,
    });
  }

  it('is not registered when the history is not exposed', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('eurodns_audit_query');
    await close();
  });

  it('appears once a query mode is set', async () => {
    const path = logFile([entry()]);
    const { client, close } = await connect({ config: withLog(path, 'all') });
    const { tools } = await client.listTools();

    const tool = tools.find((t) => t.name === 'eurodns_audit_query');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    await close();
  });

  it('returns the history, newest first', async () => {
    const path = logFile([
      entry({ ts: '2026-01-01T00:00:00.000Z', tool: 'eurodns_tld_list' }),
      entry({ ts: '2026-01-02T00:00:00.000Z', tool: 'eurodns_dns_get_zone' }),
    ]);
    const { client, close } = await connect({ config: withLog(path, 'all') });

    const result = await client.callTool({ name: 'eurodns_audit_query', arguments: {} });
    const structured = (result as unknown as { structuredContent: { entries: { tool: string }[] } })
      .structuredContent;

    expect(structured.entries[0]?.tool).toBe('eurodns_dns_get_zone');
    await close();
  });

  it('shows a caller only their own actions in own mode', async () => {
    const path = logFile([
      entry({ actor: { mode: 'oauth', subject: 'alice@example.com' }, correlationId: 'alice' }),
      entry({ actor: { mode: 'oauth', subject: 'bob@example.com' }, correlationId: 'bob' }),
    ]);
    // Over stdio the actor is the OS user, so nothing in the file matches it.
    const { client, close } = await connect({ config: withLog(path, 'own') });

    const result = await client.callTool({ name: 'eurodns_audit_query', arguments: {} });
    const structured = (result as unknown as { structuredContent: { entries: unknown[] } })
      .structuredContent;

    expect(structured.entries).toHaveLength(0);
    await close();
  });

  it('refuses an actor filter rather than silently ignoring it', async () => {
    const path = logFile([entry()]);
    const { client, close } = await connect({ config: withLog(path, 'own') });

    const result = await client.callTool({
      name: 'eurodns_audit_query',
      arguments: { actor: 'bob@example.com' },
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('EURODNS_AUDIT_QUERY=all');
    await close();
  });

  it('passes every filter through to the reader, not just the ones with a shortcut', async () => {
    // Each filter is spread conditionally into the reader's options. A test that passes
    // none of them leaves every one of those branches on its default side, which is how
    // they were all uncovered at once.
    const path = logFile([
      entry({ ts: '2026-01-01T00:00:00.000Z', tool: 'eurodns_tld_list', risk: 'read' }),
      entry({
        ts: '2026-01-02T00:00:00.000Z',
        tool: 'eurodns_dns_save_zone',
        risk: 'write',
        target: 'example.com',
        verdict: 'denied',
      }),
    ]);
    const { client, close } = await connect({ config: withLog(path, 'all') });

    const result = await client.callTool({
      name: 'eurodns_audit_query',
      arguments: {
        since: '2026-01-01T12:00:00.000Z',
        until: '2026-01-03T00:00:00.000Z',
        tool: 'eurodns_dns_save_zone',
        target: 'example.com',
        verdict: 'denied',
        risk: 'write',
        includeStarted: false,
      },
    });

    const structured = (
      result as unknown as { structuredContent: { entries: { tool: string; verdict: string }[] } }
    ).structuredContent;

    expect(structured.entries).toHaveLength(1);
    expect(structured.entries[0]?.tool).toBe('eurodns_dns_save_zone');
    expect(structured.entries[0]?.verdict).toBe('denied');
    await close();
  });

  it('says the window was truncated rather than presenting a partial answer as whole', async () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      entry({
        ts: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
        correlationId: `c${i}`,
      }),
    );
    const path = logFile(many);
    const { client, close } = await connect({ config: withLog(path, 'all') });

    const result = await client.callTool({
      name: 'eurodns_audit_query',
      arguments: { limit: 5 },
    });

    expect(textOf(result)).toMatch(/truncat/i);
    await close();
  });

  it('reports a broken hash chain, and where it broke', async () => {
    // A log whose chain does not verify is the case the chain exists for. Saying nothing
    // would make a tampered log look exactly like an intact one.
    const path = logFile([
      { ...entry({ correlationId: 'a' }), seq: 1, prev: null },
      { ...entry({ correlationId: 'b' }), seq: 2, prev: 'not-the-previous-hash' },
    ]);
    const { client, close } = await connect({ config: withLog(path, 'all') });

    const result = await client.callTool({ name: 'eurodns_audit_query', arguments: {} });

    expect(textOf(result)).toMatch(/chain|sequence/i);
    await close();
  });

  it('records its own use, because reading the history is an action', async () => {
    const path = logFile([entry()]);
    const { fetchImpl } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({ config: withLog(path, 'all'), fetchImpl });

    await client.callTool({ name: 'eurodns_audit_query', arguments: {} });
    await close();

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('"tool":"eurodns_audit_query"');
  });
});
