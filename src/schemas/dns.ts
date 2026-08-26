import { z } from 'zod';
import { FORWARD_RECORD_TYPES, TTL_VALUES } from '../constants.js';
import { DnsRecordTypeSchema } from '../generated/schemas.js';

/**
 * TTL as an explicit set of literals rather than a range.
 *
 * The API accepts only these twelve values and rejects anything else with an opaque
 * technical error, so the constraint is enforced here where the message can be useful.
 */
export const TtlSchema = z
  .union(
    TTL_VALUES.map((value) => z.literal(value)) as unknown as [
      z.ZodLiteral<number>,
      z.ZodLiteral<number>,
      ...z.ZodLiteral<number>[],
    ],
  )
  .describe(`Record TTL in seconds. Allowed values: ${TTL_VALUES.join(', ')}.`);

export const RecordTypeSchema = DnsRecordTypeSchema;

/** A record as these tools accept it. `rdata` is the value field — the API rejects `data`. */
export const RecordInputSchema = z.object({
  type: RecordTypeSchema.describe('Record type, e.g. A, AAAA, CNAME, MX, TXT.'),
  host: z
    .string()
    .describe('Node this record applies to, relative to the zone. Use "" or "@" for the apex.'),
  rdata: z
    .string()
    .describe(
      'Record value in RFC 1035 presentation format. Note the field is "rdata", not "data".',
    ),
  ttl: TtlSchema.optional(),
});

export type RecordInput = z.infer<typeof RecordInputSchema>;

/** A record as it comes back from the API. */
export interface ZoneRecord {
  id?: number | null;
  type?: string | null;
  host?: string | null;
  ttl?: number | null;
  rdata?: string | null;
  locked?: boolean | null;
}

export interface ZoneDocument {
  name?: string | null;
  records?: ZoneRecord[] | null;
  urlForwards?: unknown[] | null;
  mailForwards?: unknown[] | null;
  report?: {
    isValid?: boolean | null;
    recordErrors?: unknown[] | null;
    urlForwardErrors?: unknown[] | null;
    mailForwardErrors?: unknown[] | null;
  } | null;
}

const FORWARD_TYPES = new Set<string>(FORWARD_RECORD_TYPES);

/**
 * `MAIL` and `URL` are pseudo record types: they live in the zone's `mailForwards` and
 * `urlForwards` arrays and carry entirely different fields (source/destination, or
 * url/forwardType), not `rdata`. Accepting them here would silently write a meaningless
 * record, so the record-level tools refuse them and point at the zone-level tools instead.
 */
export function rejectForwardPseudoType(type: string): string | null {
  if (!FORWARD_TYPES.has(type)) return null;
  return (
    `"${type}" is not a DNS record: it is a pseudo type for the zone's ` +
    `${type === 'MAIL' ? 'mail' : 'URL'} forwards, which use different fields. ` +
    'Read the zone, edit its ' +
    `${type === 'MAIL' ? 'mailForwards' : 'urlForwards'} array, and save the zone instead.`
  );
}

/** Zone hosts compare equal whether written as "", "@", or with a trailing dot. */
export function normalizeHost(host: string | null | undefined): string {
  const value = (host ?? '').trim().replace(/\.$/, '');
  return value === '@' ? '' : value.toLowerCase();
}

export function sameRecordKey(a: ZoneRecord, b: { type: string; host: string }): boolean {
  return (
    (a.type ?? '').toUpperCase() === b.type.toUpperCase() &&
    normalizeHost(a.host) === normalizeHost(b.host)
  );
}
