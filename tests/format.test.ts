import { describe, expect, it } from 'vitest';
import { formatJson } from '../src/services/format.js';

/** A record shaped like the ones that made this matter: nested, repetitive, and plural. */
function domain(index: number) {
  const contact = {
    firstName: 'Given',
    lastName: 'Family',
    email: 'contact@example.com',
    city: 'Anytown',
    countryCode: 'LU',
  };
  return {
    domainName: `example-${index}.com`,
    tldName: 'com',
    expirationDate: '2027-01-01',
    renewalMethod: 'AUTORENEW',
    nameservers: ['ns1.example.net', 'ns2.example.net'],
    owner: contact,
    admin: contact,
    tech: contact,
    billing: contact,
  };
}

describe('rendering a tool result', () => {
  it('keeps the indentation while the payload is small enough to read', () => {
    const result = formatJson({ a: 1, b: [2, 3] }, 25_000);

    expect(result.truncated).toBe(false);
    expect(result.text).toContain('\n  ');
    expect(JSON.parse(result.text)).toEqual({ a: 1, b: [2, 3] });
  });

  /**
   * The point of the whole change. Indentation is not information, so it is the first thing
   * to go — before any data. A caller that would have received a truncated readable answer
   * receives a whole compact one instead.
   */
  it('drops the indentation rather than the data, when that is enough', () => {
    const payload = Array.from({ length: 40 }, (_, i) => domain(i));
    const pretty = JSON.stringify(payload, null, 2).length;
    const compact = JSON.stringify(payload).length;
    // The fixture has to actually sit between the two, or it proves nothing.
    expect(compact).toBeLessThan(pretty);

    const limit = Math.floor((pretty + compact) / 2);
    const result = formatJson(payload, limit);

    expect(result.truncated).toBe(false);
    expect(result.text).toBe(JSON.stringify(payload));
    // Whole, not merely shorter: every record survived.
    expect(JSON.parse(result.text)).toHaveLength(40);
  });

  it('truncates only once compacting is not enough, and says so', () => {
    const payload = Array.from({ length: 40 }, (_, i) => domain(i));
    const compact = JSON.stringify(payload).length;
    const result = formatJson(payload, compact - 500);

    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/\[truncated: 500 of \d+ characters omitted\./);
    // The count has to describe what was actually cut — the compact form, not the pretty
    // one it was never going to send.
    expect(result.text).toContain(`of ${compact} characters`);
  });

  it('renders undefined as null rather than the empty string', () => {
    // JSON.stringify(undefined) is undefined, not a string; without the fallback the tool
    // would answer with nothing at all.
    expect(formatJson(undefined, 100).text).toBe('null');
  });
});
