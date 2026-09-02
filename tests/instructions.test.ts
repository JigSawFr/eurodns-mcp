import { describe, expect, it } from 'vitest';
import { connect, testConfig } from './harness.js';
import { buildInstructions } from '../src/instructions.js';
import { TTL_VALUES } from '../src/constants.js';

/**
 * The handshake is the only place a model is told anything it did not ask for, so these
 * assertions are about what actually reaches it — not about the string the builder returns.
 * Everything goes through a real client over the real transport for that reason.
 */
describe('what the server tells a model about itself', () => {
  it('reaches the client through the handshake', async () => {
    const { client, close } = await connect();
    try {
      const instructions = client.getInstructions();
      expect(instructions).toBeTruthy();
      // The trap that costs data rather than a retry: a partial zone save deletes the rest.
      expect(instructions).toContain('eurodns_dns_upsert_record');
      expect(instructions).toContain('rdata');
    } finally {
      await close();
    }
  });

  /**
   * A model told the default limit on a deployment that raised it would plan its pagination
   * around a number that is not true here. The point of deriving this from the config is that
   * it cannot say the wrong one.
   */
  it('announces the character limit this deployment actually enforces', async () => {
    const config = testConfig({ EURODNS_CHARACTER_LIMIT: '90000' });
    const { client, close } = await connect({ config });
    try {
      expect(client.getInstructions()).toContain('90,000 characters');
      // And not the default it would have carried if the text were a constant.
      expect(client.getInstructions()).not.toContain('25,000');
    } finally {
      await close();
    }
  });

  /**
   * Hidden tools are absent, not refused — so a model that offers one is promising something
   * the deployment cannot do. This is the discoverability the hiding costs, handed back.
   */
  it('names the variable behind a class it hides', async () => {
    const config = testConfig({ EURODNS_READ_ONLY: 'true' });
    const { client, close } = await connect({ config });
    try {
      expect(client.getInstructions()).toContain('EURODNS_READ_ONLY');
    } finally {
      await close();
    }
  });

  it('says nothing about hiding when nothing is hidden', () => {
    const permissive = testConfig({
      EURODNS_ALLOW_BILLING: 'true',
      EURODNS_ALLOW_DESTRUCTIVE: 'true',
    });
    expect(buildInstructions(permissive)).not.toContain('THIS DEPLOYMENT HIDES');

    // The default deployment does hide two classes, and has to say which.
    const guarded = buildInstructions(testConfig());
    expect(guarded).toContain('EURODNS_ALLOW_BILLING');
    expect(guarded).toContain('EURODNS_ALLOW_DESTRUCTIVE');
  });

  /**
   * The TTL list and the area list are read from the code that enforces them. Recopying either
   * would let the briefing drift from the validator, which is the failure this pins.
   */
  it('quotes the TTL values the validator accepts, not a copy of them', () => {
    const instructions = buildInstructions(testConfig());
    for (const ttl of TTL_VALUES) expect(instructions).toContain(String(ttl));
    expect(instructions).toContain('premium_dns');
    expect(instructions).toContain('https_redirect');
  });
});
