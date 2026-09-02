import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, testConfig } from './harness.js';
import { DEPLOYMENT_RESOURCE_URI } from '../src/resources.js';
import { TTL_VALUES } from '../src/constants.js';
import { AUDIT_QUERY_TOOL_NAME } from '../src/tools/auditNames.js';

/** A configuration whose audit log is a real file, which is what makes the log queryable. */
function auditableConfig(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eurodns-prompts-'));
  return testConfig({
    EURODNS_AUDIT_DESTINATION: 'file',
    EURODNS_AUDIT_FILE: join(dir, 'audit.jsonl'),
    EURODNS_AUDIT_QUERY: 'own',
    ...overrides,
  });
}

async function promptNames(config?: ReturnType<typeof testConfig>) {
  const { client, close } = await connect(config ? { config } : {});
  try {
    const listed = await client.listPrompts();
    return listed.prompts.map((p) => p.name);
  } finally {
    await close();
  }
}

describe('the workflows a person can ask for by name', () => {
  it('offers the two that only read, on any deployment', async () => {
    const names = await promptNames();
    expect(names).toContain('eurodns_zone_review');
    expect(names).toContain('eurodns_expiry_review');
  });

  /**
   * The prompt tells the model to call eurodns_dns_upsert_record. Under a read-only
   * deployment that tool is not registered, so offering the prompt would be an instruction
   * to call something that is not there.
   */
  it('withholds the one that writes when the deployment writes nothing', async () => {
    expect(await promptNames()).toContain('eurodns_acme_challenge');
    expect(await promptNames(testConfig({ EURODNS_READ_ONLY: 'true' }))).not.toContain(
      'eurodns_acme_challenge',
    );
  });

  /**
   * Same argument for the audit tool, which most deployments leave off: the prompt exists
   * only where the tool it drives does.
   */
  it('withholds the history review unless the log can actually be queried', async () => {
    expect(await promptNames()).not.toContain('eurodns_change_review');
    expect(await promptNames(auditableConfig())).toContain('eurodns_change_review');
  });

  it('expands to a message naming the tools it wants called', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.getPrompt({
        name: 'eurodns_acme_challenge',
        arguments: { domainName: 'example.com', token: 'abc123' },
      });
      const text = result.messages.map((m) => (m.content as { text?: string }).text ?? '').join('');
      expect(text).toContain('example.com');
      expect(text).toContain('abc123');
      // Diff before write, which is the whole reason this workflow is worth naming.
      expect(text.indexOf('eurodns_dns_diff_zone')).toBeLessThan(
        text.indexOf('eurodns_dns_upsert_record'),
      );
      expect(text).toContain('rdata');
    } finally {
      await close();
    }
  });

  it('expands the zone review into checks a reader can follow', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.getPrompt({
        name: 'eurodns_zone_review',
        arguments: { domainName: 'example.com' },
      });
      const text = result.messages.map((m) => (m.content as { text?: string }).text ?? '').join('');

      expect(text).toContain('example.com');
      expect(text).toContain('eurodns_dns_get_zone');
      // The three checks that are errors rather than taste, and the one that is not.
      expect(text).toContain('v=spf1');
      expect(text).toContain('_dmarc');
      expect(text).toContain('Change nothing');
      // TTL bounds come from the validator, so a change there cannot leave this stale.
      expect(text).toContain(String(TTL_VALUES[0]));
      expect(text).toContain(String(TTL_VALUES[TTL_VALUES.length - 1]));
    } finally {
      await close();
    }
  });

  it('expands the history review against the tool that answers it', async () => {
    const { client, close } = await connect({ config: auditableConfig() });
    try {
      const result = await client.getPrompt({
        name: 'eurodns_change_review',
        arguments: { since: '2026-01-01T00:00:00Z' },
      });
      const text = result.messages.map((m) => (m.content as { text?: string }).text ?? '').join('');

      expect(text).toContain('2026-01-01T00:00:00Z');
      expect(text).toContain(AUDIT_QUERY_TOOL_NAME);
      expect(text).toContain('denied');
      // A broken hash chain invalidates the summary, so it has to be reported before it.
      expect(text).toContain('chain');
    } finally {
      await close();
    }
  });

  it('falls back to a sane window when the argument is missing or nonsense', async () => {
    const { client, close } = await connect();
    try {
      const read = async (withinDays?: string) => {
        const result = await client.getPrompt({
          name: 'eurodns_expiry_review',
          ...(withinDays === undefined ? {} : { arguments: { withinDays } }),
        });
        return result.messages.map((m) => (m.content as { text?: string }).text ?? '').join('');
      };

      expect(await read()).toContain('next 90 days');
      expect(await read('30')).toContain('next 30 days');
      // Prompt arguments arrive as strings, so these are reachable inputs, not paranoia.
      expect(await read('not-a-number')).toContain('next 90 days');
      expect(await read('-5')).toContain('next 90 days');
    } finally {
      await close();
    }
  });
});

describe('what this deployment says it allows', () => {
  it('names the hidden classes and the variable behind each', async () => {
    const { client, close } = await connect();
    try {
      const result = await client.readResource({ uri: DEPLOYMENT_RESOURCE_URI });
      const state = JSON.parse((result.contents[0] as { text: string }).text);

      expect(state.guardrails.hidden).toEqual([
        'billing (EURODNS_ALLOW_BILLING)',
        'irreversible (EURODNS_ALLOW_DESTRUCTIVE)',
      ]);
      expect(state.limits.characterLimit).toBe(25_000);
      expect(state.history.queryable).toBe(false);
    } finally {
      await close();
    }
  });

  it('follows the deployment rather than restating the defaults', async () => {
    const config = auditableConfig({
      EURODNS_ALLOW_DESTRUCTIVE: 'true',
      EURODNS_CHARACTER_LIMIT: '90000',
      EURODNS_CONFIRM: 'destructive',
    });
    const { client, close } = await connect({ config });
    try {
      const result = await client.readResource({ uri: DEPLOYMENT_RESOURCE_URI });
      const state = JSON.parse((result.contents[0] as { text: string }).text);

      expect(state.guardrails.hidden).toEqual(['billing (EURODNS_ALLOW_BILLING)']);
      expect(state.guardrails.confirm).toBe('destructive');
      expect(state.limits.characterLimit).toBe(90_000);
      expect(state.history).toEqual({ queryable: true, mode: 'own' });
    } finally {
      await close();
    }
  });

  /**
   * Asserted as an absence rather than a shape. A test that checks which fields are present
   * stays green when a field is added; this one goes red the moment a credential reaches the
   * serialised output, which is the failure actually worth catching.
   */
  it('carries no credential and no address', async () => {
    const config = testConfig({
      EURODNS_APP_ID: 'sentinel-app-id',
      EURODNS_API_KEY: 'sentinel-api-key',
      EURODNS_BASE_URL: 'https://sentinel-upstream.example.net',
    });
    const { client, close } = await connect({ config });
    try {
      const result = await client.readResource({ uri: DEPLOYMENT_RESOURCE_URI });
      const serialised = (result.contents[0] as { text: string }).text;

      for (const secret of [
        'sentinel-app-id',
        'sentinel-api-key',
        'sentinel-upstream.example.net',
      ]) {
        expect(serialised).not.toContain(secret);
      }
    } finally {
      await close();
    }
  });
});
