import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
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
