import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/http.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { AuditLogger, ROTATED_SUFFIX, hashLine } from '../src/audit.js';
import { queryAuditLog, verifyChain } from '../src/auditReader.js';
import { connect, stubFetch, testConfig } from './harness.js';

/** Writes `count` completed lines to `file` through a fresh logger. */
function write(file: string, count: number, maxBytes = 0): void {
  const logger = new AuditLogger(
    { destination: 'file', filePath: file, query: 'all', maxBytes },
    () => Date.parse('2026-01-01T00:00:00Z'),
  );
  for (let i = 0; i < count; i += 1) {
    logger
      .begin({ actor: { mode: 'stdio', subject: 'tester' }, tool: `t${i}`, risk: 'read' })
      .complete({ verdict: 'allowed' });
  }
}

interface AuditLine {
  phase: string;
  tool: string;
  risk: string;
  verdict?: string;
  target?: string;
  reason?: string;
  upstreamStatus?: number;
  actor: { mode: string; subject: string };
  params?: Record<string, unknown>;
}

function auditFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'eurodns-audit-')), 'audit.jsonl');
}

function readLines(path: string): AuditLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as AuditLine);
}

describe('audit log', () => {
  it('records one completed line per read, attributed to the caller', async () => {
    const file = auditFile();
    const { fetchImpl } = stubFetch(() => ({ body: { name: 'example.com' } }));
    const { client, close } = await connect({
      config: testConfig({ EURODNS_AUDIT_DESTINATION: 'file', EURODNS_AUDIT_FILE: file }),
      fetchImpl,
    });

    await client.callTool({
      name: 'eurodns_dns_get_zone',
      arguments: { domainName: 'example.com' },
    });
    await close();

    const lines = readLines(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      phase: 'completed',
      tool: 'eurodns_dns_get_zone',
      risk: 'read',
      verdict: 'allowed',
      target: 'example.com',
      upstreamStatus: 200,
    });
    // stdio has no token, so the OS account is the identity.
    expect(lines[0]?.actor.mode).toBe('stdio');
    expect(lines[0]?.actor.subject).toBeTruthy();
  });

  it('opens a line before a mutation reaches the API, so a crash still leaves a trace', async () => {
    const file = auditFile();
    const { fetchImpl } = stubFetch((request) =>
      request.method === 'GET'
        ? { body: { name: 'example.com', records: [] } }
        : request.url.endsWith('/check')
          ? { body: { name: 'example.com', records: [], report: { isValid: true } } }
          : { status: 204 },
    );
    const { client, close } = await connect({
      config: testConfig({ EURODNS_AUDIT_DESTINATION: 'file', EURODNS_AUDIT_FILE: file }),
      fetchImpl,
    });

    await client.callTool({
      name: 'eurodns_dns_upsert_record',
      arguments: { domainName: 'example.com', type: 'A', host: 'www', rdata: '203.0.113.20' },
    });
    await close();

    const lines = readLines(file);
    expect(lines.map((l) => l.phase)).toEqual(['started', 'completed']);
    expect(lines[1]?.verdict).toBe('allowed');
  });

  it('records refusals, which are the lines an audit cares about most', async () => {
    const file = auditFile();
    const { fetchImpl, requests } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({
      config: testConfig({
        EURODNS_AUDIT_DESTINATION: 'file',
        EURODNS_AUDIT_FILE: file,
        EURODNS_ALLOW_BILLING: 'true',
        EURODNS_CONFIRM: 'all',
      }),
      fetchImpl,
      onElicit: () => ({ action: 'decline' }),
    });

    await client.callTool({
      name: 'eurodns_premium_dns_renew_subscription',
      arguments: { subscriptionId: 1, body: { duration: 1 } },
    });
    await close();

    const lines = readLines(file);
    const completed = lines.find((l) => l.phase === 'completed');
    expect(completed?.verdict).toBe('denied');
    expect(completed?.reason).toContain('declined');
    // A declined confirmation stops the call before it reaches the API.
    expect(requests).toHaveLength(0);
  });

  it('writes no line at all for a confirmation that was merely asked for', async () => {
    const file = auditFile();
    const { fetchImpl } = stubFetch(() => ({ body: { id: 'sub-1' } }));
    const { client, close } = await connect({
      config: testConfig({
        EURODNS_AUDIT_DESTINATION: 'file',
        EURODNS_AUDIT_FILE: file,
        EURODNS_ALLOW_BILLING: 'true',
        EURODNS_CONFIRM: 'all',
      }),
      fetchImpl,
      onElicit: () => ({ action: 'accept', content: { confirm: true } }),
    });

    await client.callTool({
      name: 'eurodns_premium_dns_renew_subscription',
      arguments: { subscriptionId: 1, body: { duration: 1 } },
    });
    await close();

    // The asking round is not an attempt and must not inflate the log: one call, one pair of
    // lines, with the verdict of what actually happened.
    const completed = readLines(file).filter((l) => l.phase === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.verdict).toBe('allowed');
  });

  it('still records a line when the upstream call fails', async () => {
    const file = auditFile();
    const { fetchImpl } = stubFetch(() => ({ status: 500, body: { errors: [] } }));
    const { client, close } = await connect({
      config: testConfig({ EURODNS_AUDIT_DESTINATION: 'file', EURODNS_AUDIT_FILE: file }),
      fetchImpl,
    });

    await client.callTool({ name: 'eurodns_tld_list', arguments: {} });
    await close();

    const lines = readLines(file);
    expect(lines.at(-1)?.verdict).toBe('failed');
    expect(lines.at(-1)?.upstreamStatus).toBe(500);
  });

  it('never writes payload content — no request bodies, no record values', async () => {
    const file = auditFile();
    const secret = 'acme-validation-token-that-must-not-be-logged';
    const { fetchImpl } = stubFetch((request) =>
      request.method === 'GET'
        ? { body: { name: 'example.com', records: [] } }
        : request.url.endsWith('/check')
          ? { body: { name: 'example.com', records: [], report: { isValid: true } } }
          : { status: 204 },
    );
    const { client, close } = await connect({
      config: testConfig({ EURODNS_AUDIT_DESTINATION: 'file', EURODNS_AUDIT_FILE: file }),
      fetchImpl,
    });

    await client.callTool({
      name: 'eurodns_dns_upsert_record',
      arguments: { domainName: 'example.com', type: 'TXT', host: '_acme-challenge', rdata: secret },
    });
    await close();

    const raw = readFileSync(file, 'utf8');
    // A TXT value is a short-lived secret; it must never reach the log.
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('test-api-key');
    expect(raw).toContain('example.com');
  });

  it('creates the log readable only by its owner', async () => {
    const file = auditFile();
    const { fetchImpl } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({
      config: testConfig({ EURODNS_AUDIT_DESTINATION: 'file', EURODNS_AUDIT_FILE: file }),
      fetchImpl,
    });

    await client.callTool({ name: 'eurodns_tld_list', arguments: {} });
    await close();

    // This file attributes DNS changes to people; other accounts on the host have no
    // business reading it.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rotates at its size ceiling instead of growing without bound', () => {
    const file = auditFile();
    write(file, 20, 400);

    expect(existsSync(`${file}${ROTATED_SUFFIX}`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(400);
    // Two generations, so the footprint is bounded rather than merely slowed down.
    expect(existsSync(`${file}${ROTATED_SUFFIX}${ROTATED_SUFFIX}`)).toBe(false);
  });

  it('answers the history query across a rotation', () => {
    const file = auditFile();
    write(file, 20, 400);

    // Only the two live generations survive — that is the point of a bounded log. What the
    // query must not do is stop at the current file and report the rest as absent, which
    // would answer "nothing happened before this" with a straight face.
    const onDisk = readLines(file).length + readLines(`${file}${ROTATED_SUFFIX}`).length;
    expect(readLines(`${file}${ROTATED_SUFFIX}`).length).toBeGreaterThan(0);

    const result = queryAuditLog(file, { limit: 100 });
    expect(result.entries).toHaveLength(onDisk);
    // The newest entry is always reachable; the oldest one still on disk must be too.
    expect(result.entries.map((e) => e.tool)).toContain('t19');
    expect(result.entries.map((e) => e.tool)).toContain(
      readLines(`${file}${ROTATED_SUFFIX}`)[0]?.tool,
    );
  });

  it('chains each line to the one before it', () => {
    const file = auditFile();
    write(file, 5);

    const raw = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    const lines = raw.map((l) => JSON.parse(l) as { seq: number; prev: string | null });

    expect(lines[0]?.prev).toBeNull();
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < raw.length; i += 1) {
      expect(lines[i]?.prev).toBe(hashLine(raw[i - 1] as string));
    }
  });

  it('detects a line edited after it was written', () => {
    const file = auditFile();
    write(file, 6);

    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    // Change the recorded target of one call — the whole point of tampering with an audit
    // log is to make a change look like it happened to something else.
    const forged = (lines[2] as string).replace('"tool":"t2"', '"tool":"innocent"');
    expect(forged).not.toBe(lines[2]);
    lines[2] = forged;
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const result = queryAuditLog(file, { limit: 100 });
    expect(result.chain.intact).toBe(false);
    // The break surfaces at the line after the forgery, whose recorded hash no longer matches.
    expect(result.chain.brokenAt).toBe(4);
  });

  it('detects a line removed from the middle', () => {
    const file = auditFile();
    write(file, 6);

    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    lines.splice(3, 1);
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    expect(queryAuditLog(file, { limit: 100 }).chain.intact).toBe(false);
  });

  it('reports an untouched log as intact, across a restart and a rotation', () => {
    const file = auditFile();
    // Two loggers over the same file stand in for a restart: the second has to pick the
    // chain back up from disk rather than starting a fresh segment.
    write(file, 4);
    write(file, 4);

    const result = queryAuditLog(file, { limit: 100 });
    expect(result.chain.intact).toBe(true);
    expect(result.chain.verified).toBe(7);
    expect(result.chain.segments).toBe(0);
  });

  it('does not accuse a log of tampering when the process simply restarted on a stream', () => {
    // On stderr or stdout the process cannot see what a previous run wrote, so each start
    // opens a segment. A verifier must read that as a restart, not as a break.
    const lines = [
      JSON.stringify({ tool: 'a', seq: 1, prev: null }),
      JSON.stringify({ tool: 'b', seq: 2, prev: null }),
    ];
    const status = verifyChain(lines);
    expect(status.intact).toBe(true);
    expect(status.segments).toBe(1);
  });

  it('keeps one chain across HTTP requests, which each build their own server', async () => {
    // The HTTP transport rebuilds the server per call. A logger rebuilt with it would open
    // a fresh segment every time — on a stream there is no file to resume from, so the
    // chain would never link and every line would carry prev: null.
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const token = 'k'.repeat(48);
      const { fetchImpl } = stubFetch(() => ({ body: {} }));
      const app = await createApp(
        loadConfig(
          {
            EURODNS_APP_ID: 'a',
            EURODNS_API_KEY: 'b',
            EURODNS_MAX_RETRIES: '0',
            EURODNS_MCP_AUTH: 'token',
            EURODNS_MCP_TOKEN: token,
            EURODNS_AUDIT_DESTINATION: 'stdout',
          } as NodeJS.ProcessEnv,
          'http',
        ),
        { fetchImpl },
      );

      for (let i = 0; i < 3; i += 1) {
        await request(app)
          .post('/mcp')
          .set('Authorization', `Bearer ${token}`)
          .set('Accept', 'application/json, text/event-stream')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'eurodns_tld_list', arguments: {} },
          });
      }

      const lines = written
        .join('')
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as { seq: number; prev: string | null });

      expect(lines).toHaveLength(3);
      expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
      expect(lines.filter((l) => l.prev === null)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses to write the audit log to stdout under stdio, where JSON-RPC lives', () => {
    expect(() =>
      loadConfig(
        {
          EURODNS_APP_ID: 'a',
          EURODNS_API_KEY: 'b',
          EURODNS_AUDIT_DESTINATION: 'stdout',
        } as NodeJS.ProcessEnv,
        'stdio',
      ),
    ).toThrow(ConfigError);

    // Over HTTP the same setting is fine.
    expect(() =>
      loadConfig(
        {
          EURODNS_APP_ID: 'a',
          EURODNS_API_KEY: 'b',
          EURODNS_AUDIT_DESTINATION: 'stdout',
        } as NodeJS.ProcessEnv,
        'http',
      ),
    ).not.toThrow();
  });
});
