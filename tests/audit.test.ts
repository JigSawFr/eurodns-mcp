import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { AuditLogger, ROTATED_SUFFIX } from '../src/audit.js';
import { queryAuditLog } from '../src/auditReader.js';
import { connect, stubFetch, testConfig } from './harness.js';

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
    const { fetchImpl } = stubFetch(() => ({ body: {} }));
    const { client, close } = await connect({
      config: testConfig({ EURODNS_AUDIT_DESTINATION: 'file', EURODNS_AUDIT_FILE: file }),
      fetchImpl,
    });

    await client.callTool({
      name: 'eurodns_premium_dns_renew_subscription',
      arguments: { subscriptionId: 1, body: { duration: 1 } },
    });
    await close();

    const lines = readLines(file);
    const completed = lines.find((l) => l.phase === 'completed');
    expect(completed?.verdict).toBe('denied');
    expect(completed?.reason).toContain('EURODNS_ALLOW_BILLING');
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
    const logger = new AuditLogger(
      { destination: 'file', filePath: file, query: 'all', maxBytes: 400 },
      () => Date.parse('2026-01-01T00:00:00Z'),
    );

    for (let i = 0; i < 20; i += 1) {
      logger
        .begin({ actor: { mode: 'stdio', subject: 'tester' }, tool: `t${i}`, risk: 'read' })
        .complete({ verdict: 'allowed' });
    }

    expect(existsSync(`${file}${ROTATED_SUFFIX}`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(400);
    // Two generations, so the footprint is bounded rather than merely slowed down.
    expect(existsSync(`${file}${ROTATED_SUFFIX}${ROTATED_SUFFIX}`)).toBe(false);
  });

  it('answers the history query across a rotation', () => {
    const file = auditFile();
    const logger = new AuditLogger(
      { destination: 'file', filePath: file, query: 'all', maxBytes: 400 },
      () => Date.parse('2026-01-01T00:00:00Z'),
    );

    for (let i = 0; i < 20; i += 1) {
      logger
        .begin({ actor: { mode: 'stdio', subject: 'tester' }, tool: `t${i}`, risk: 'read' })
        .complete({ verdict: 'allowed' });
    }

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
