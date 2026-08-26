import { describe, expect, it } from 'vitest';
import { OPERATIONS, OPERATION_COUNT } from '../src/generated/operations.js';
import {
  BILLING_OPERATION_IDS,
  DESTRUCTIVE_OPERATION_IDS,
  READ_ONLY_OPERATION_IDS,
} from '../src/constants.js';

/**
 * These assertions pin the generated surface to the OpenAPI document. If the document
 * changes, they fail loudly rather than letting tools silently appear or vanish.
 */
describe('generated operations', () => {
  it('covers every operation in the document', () => {
    expect(OPERATIONS).toHaveLength(OPERATION_COUNT);
    expect(OPERATION_COUNT).toBe(79);
    expect(new Set(OPERATIONS.map((o) => o.tag)).size).toBe(17);
  });

  it('gives every operation a unique id', () => {
    const ids = OPERATIONS.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('classifies risk by intent, not by HTTP method', () => {
    const byId = new Map(OPERATIONS.map((o) => [o.operationId, o]));

    // POST endpoints that only read; classifying by method would hide them behind guardrails.
    for (const id of READ_ONLY_OPERATION_IDS) {
      expect(byId.get(id)?.risk, id).toBe('read');
    }
    for (const id of BILLING_OPERATION_IDS) {
      expect(byId.get(id)?.risk, id).toBe('billing');
    }
    for (const id of DESTRUCTIVE_OPERATION_IDS) {
      expect(byId.get(id)?.risk, id).toBe('destructive');
    }
  });

  it('counts the risk classes the guardrails are sized for', () => {
    const tally = OPERATIONS.reduce<Record<string, number>>((acc, o) => {
      acc[o.risk] = (acc[o.risk] ?? 0) + 1;
      return acc;
    }, {});
    expect(tally.billing).toBe(11);
    expect(tally.destructive).toBe(8);
    // 32 GETs plus the four side-effect-free POSTs.
    expect(tally.read).toBe(36);
  });

  it('separates pagination headers from ordinary header parameters', () => {
    const paginated = OPERATIONS.filter((o) => o.paginated);
    expect(paginated.length).toBe(13);
    for (const operation of OPERATIONS) {
      for (const header of operation.headerParams) {
        expect(header.name.toLowerCase().startsWith('pagination-')).toBe(false);
      }
    }
  });

  it('keeps the DNS zone write cycle intact', () => {
    const byId = new Map(OPERATIONS.map((o) => [o.operationId, o]));
    // Saving a zone replaces the whole document, which is why tools must read-modify-write.
    expect(byId.get('saveDnsZone')?.method).toBe('PUT');
    expect(byId.get('saveDnsZone')?.body?.required).toBe(true);
    expect(byId.get('checkDnsZone')?.risk).toBe('read');
  });
});
