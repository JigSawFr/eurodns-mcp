import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { evaluateGuardrails } from '../auth/scopes.js';
import { EuroDnsApiError, EuroDnsTransportError } from '../services/errors.js';
import { formatJson } from '../services/format.js';
import {
  RecordInputSchema,
  RecordTypeSchema,
  TtlSchema,
  normalizeHost,
  rejectForwardPseudoType,
  sameRecordKey,
  type RecordInput,
  type ZoneDocument,
  type ZoneRecord,
} from '../schemas/dns.js';
import { identityFrom } from './registry.js';
import type { ToolContext } from './context.js';
import type { RiskClass } from '../constants.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/**
 * Workflow tools for DNS records.
 *
 * `PUT /dns-zones/{domain}` replaces the entire zone document, so a caller that sends a
 * partial zone silently deletes everything it left out. These tools always read the zone,
 * apply one change, run the API's own validator, and only then write — so a mistake is
 * caught before it reaches the zone rather than after.
 */

function textResult(text: string, isError = false) {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text' as const, text }],
  };
}

function jsonResult(context: ToolContext, value: Record<string, unknown>) {
  const rendered = formatJson(value, context.config.upstream.characterLimit);
  return { content: [{ type: 'text' as const, text: rendered.text }], structuredContent: value };
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof EuroDnsApiError || error instanceof EuroDnsTransportError
    ? error.message
    : fallback;
}

/** Shared preamble: audit span plus guardrail check. */
function beginCall(
  context: ToolContext,
  authInfo: AuthInfo | undefined,
  args: { tool: string; risk: RiskClass; target: string; params: Record<string, unknown> },
) {
  const identity = identityFrom(context, authInfo);
  const span = context.audit.begin({
    actor: identity.actor,
    tool: args.tool,
    risk: args.risk,
    target: args.target,
    params: args.params,
  });
  const decision = evaluateGuardrails(args.risk, context.config.guardrails, identity.scopes);
  return { span, decision };
}

async function readZone(context: ToolContext, domainName: string): Promise<ZoneDocument> {
  const response = await context.client.request<ZoneDocument>({
    method: 'GET',
    path: `/dns-zones/${encodeURIComponent(domainName)}`,
  });
  return response.data ?? {};
}

/**
 * Runs the API's validator on a candidate zone.
 * Returns the validation report so callers can surface per-record errors instead of the
 * generic 400 the save endpoint would produce.
 */
async function validateZone(
  context: ToolContext,
  domainName: string,
  zone: ZoneDocument,
): Promise<ZoneDocument> {
  const response = await context.client.request<ZoneDocument>({
    method: 'POST',
    path: `/dns-zones/${encodeURIComponent(domainName)}/check`,
    body: zone,
  });
  return response.data ?? {};
}

async function saveZone(context: ToolContext, domainName: string, zone: ZoneDocument) {
  return context.client.request({
    method: 'PUT',
    path: `/dns-zones/${encodeURIComponent(domainName)}`,
    body: zone,
  });
}

/** Strips the fields the API marks read-only before sending a zone back. */
function forWrite(zone: ZoneDocument, records: ZoneRecord[]): ZoneDocument {
  return {
    ...zone,
    records,
    report: null,
  };
}

export function registerDnsTools(server: McpServer, context: ToolContext): number {
  const readOnly = context.config.guardrails.readOnly;

  registerDiffZone(server, context);
  if (readOnly) return 1;

  registerUpsertRecord(server, context);
  registerDeleteRecord(server, context);
  return 3;
}

function registerUpsertRecord(server: McpServer, context: ToolContext): void {
  const name = 'eurodns_dns_upsert_record';

  server.registerTool(
    name,
    {
      title: 'Create or update a DNS record',
      description:
        'Adds a DNS record to a zone, or updates the existing record with the same type and ' +
        'host. Reads the zone, applies the change, validates it with the API, and saves only ' +
        'if validation passes. Prefer this over saving a zone directly: saving replaces the ' +
        'whole zone and drops anything not included.',
      inputSchema: {
        domainName: z.string().describe('Zone to modify, e.g. example.com.'),
        type: RecordTypeSchema.describe('Record type, e.g. A, AAAA, CNAME, MX, TXT.'),
        host: z.string().describe('Node the record applies to. Use "" or "@" for the apex.'),
        rdata: z.string().describe('Record value. The API field is "rdata", not "data".'),
        ttl: TtlSchema.optional(),
        matchRdata: z
          .string()
          .optional()
          .describe(
            'Update only the record whose current value matches this. Use when several ' +
              'records share a type and host, such as multiple TXT entries.',
          ),
      },
      outputSchema: {
        action: z.enum(['created', 'updated']),
        zone: z.string(),
        record: z.object({
          type: z.string(),
          host: z.string(),
          rdata: z.string(),
          ttl: z.number().optional(),
        }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const { span, decision } = beginCall(context, extra?.authInfo, {
        tool: name,
        risk: 'write',
        target: args.domainName,
        params: { type: args.type, host: args.host, ttl: args.ttl },
      });

      if (!decision.allowed) {
        span.complete({ verdict: 'denied', reason: decision.reason });
        return textResult(decision.reason, true);
      }

      const pseudo = rejectForwardPseudoType(args.type);
      if (pseudo) {
        span.complete({ verdict: 'denied', reason: 'forward pseudo type' });
        return textResult(pseudo, true);
      }

      try {
        const zone = await readZone(context, args.domainName);
        const records = [...(zone.records ?? [])];

        const index = records.findIndex(
          (record) =>
            sameRecordKey(record, { type: args.type, host: args.host }) &&
            (args.matchRdata === undefined || record.rdata === args.matchRdata),
        );

        const action = index >= 0 ? 'updated' : 'created';
        const next: ZoneRecord = {
          ...(index >= 0 ? records[index] : {}),
          type: args.type,
          host: normalizeHost(args.host),
          rdata: args.rdata,
          ...(args.ttl === undefined ? {} : { ttl: args.ttl }),
        };

        if (index >= 0) {
          if (records[index]?.locked === true) {
            span.complete({ verdict: 'denied', reason: 'record locked' });
            return textResult(
              `The ${args.type} record for "${args.host}" in ${args.domainName} is locked by the ` +
                'provider and cannot be modified.',
              true,
            );
          }
          records[index] = next;
        } else {
          records.push(next);
        }

        const candidate = forWrite(zone, records);
        const checked = await validateZone(context, args.domainName, candidate);

        if (checked.report?.isValid !== true) {
          span.complete({ verdict: 'denied', reason: 'zone validation failed' });
          const report = formatJson(checked.report ?? {}, context.config.upstream.characterLimit);
          return textResult(
            `The change was rejected by the zone validator and nothing was written. ` +
              `Validation report:\n${report.text}`,
            true,
          );
        }

        const saved = await saveZone(
          context,
          args.domainName,
          forWrite(zone, checked.records ?? records),
        );
        span.complete({ verdict: 'allowed', upstreamStatus: saved.status });

        return jsonResult(context, {
          action,
          zone: args.domainName,
          record: {
            type: args.type,
            host: normalizeHost(args.host),
            rdata: args.rdata,
            ...(args.ttl === undefined ? {} : { ttl: args.ttl }),
          },
        });
      } catch (error) {
        const status = error instanceof EuroDnsApiError ? error.status : undefined;
        span.complete({
          verdict: 'failed',
          ...(status === undefined ? {} : { upstreamStatus: status }),
          reason: 'upstream error',
        });
        return textResult(
          failureMessage(error, `Could not upsert the record in ${args.domainName}.`),
          true,
        );
      }
    },
  );
}

function registerDeleteRecord(server: McpServer, context: ToolContext): void {
  const name = 'eurodns_dns_delete_record';

  server.registerTool(
    name,
    {
      title: 'Delete a DNS record',
      description:
        'Deletes a DNS record identified by type and host, resolving its internal id from the ' +
        'zone first. Give rdata as well when several records share a type and host. Refuses ' +
        'to act when the selection is ambiguous rather than guessing.',
      inputSchema: {
        domainName: z.string().describe('Zone to modify, e.g. example.com.'),
        type: RecordTypeSchema.describe('Record type of the record to delete.'),
        host: z.string().describe('Node the record applies to. Use "" or "@" for the apex.'),
        rdata: z.string().optional().describe('Exact current value, to disambiguate.'),
      },
      outputSchema: {
        deleted: z.object({
          id: z.number(),
          type: z.string(),
          host: z.string(),
          rdata: z.string(),
        }),
        zone: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const { span, decision } = beginCall(context, extra?.authInfo, {
        tool: name,
        risk: 'write',
        target: args.domainName,
        params: { type: args.type, host: args.host },
      });

      if (!decision.allowed) {
        span.complete({ verdict: 'denied', reason: decision.reason });
        return textResult(decision.reason, true);
      }

      const pseudo = rejectForwardPseudoType(args.type);
      if (pseudo) {
        span.complete({ verdict: 'denied', reason: 'forward pseudo type' });
        return textResult(pseudo, true);
      }

      try {
        const zone = await readZone(context, args.domainName);
        const matches = (zone.records ?? []).filter(
          (record) =>
            sameRecordKey(record, { type: args.type, host: args.host }) &&
            (args.rdata === undefined || record.rdata === args.rdata),
        );

        if (matches.length === 0) {
          span.complete({ verdict: 'denied', reason: 'no match' });
          return textResult(
            `No ${args.type} record for "${args.host}" in ${args.domainName}. Read the zone to ` +
              'see what it currently holds.',
            true,
          );
        }

        if (matches.length > 1) {
          span.complete({ verdict: 'denied', reason: 'ambiguous match' });
          const values = matches.map((record) => record.rdata ?? '');
          return textResult(
            `${matches.length} ${args.type} records share host "${args.host}" in ` +
              `${args.domainName}. Pass rdata to choose one of: ${values.join(', ')}.`,
            true,
          );
        }

        const target = matches[0] as ZoneRecord;
        if (target.locked === true) {
          span.complete({ verdict: 'denied', reason: 'record locked' });
          return textResult(`That record is locked by the provider and cannot be removed.`, true);
        }
        if (typeof target.id !== 'number') {
          span.complete({ verdict: 'failed', reason: 'record has no id' });
          return textResult(
            'The matching record has no id, so it cannot be deleted individually. Edit the zone ' +
              'document and save it instead.',
            true,
          );
        }

        const response = await context.client.request({
          method: 'DELETE',
          path: `/dns-zones/${encodeURIComponent(args.domainName)}/dns-records/${target.id}`,
        });
        span.complete({ verdict: 'allowed', upstreamStatus: response.status });

        return jsonResult(context, {
          deleted: {
            id: target.id,
            type: target.type ?? args.type,
            host: normalizeHost(target.host),
            rdata: target.rdata ?? '',
          },
          zone: args.domainName,
        });
      } catch (error) {
        const status = error instanceof EuroDnsApiError ? error.status : undefined;
        span.complete({
          verdict: 'failed',
          ...(status === undefined ? {} : { upstreamStatus: status }),
          reason: 'upstream error',
        });
        return textResult(
          failureMessage(error, `Could not delete the record in ${args.domainName}.`),
          true,
        );
      }
    },
  );
}

function registerDiffZone(server: McpServer, context: ToolContext): void {
  const name = 'eurodns_dns_diff_zone';

  server.registerTool(
    name,
    {
      title: 'Compare a proposed record set against the live zone',
      description:
        'Reports what would change if the given records were applied to a zone, without ' +
        'writing anything. Use this to review a change before making it.',
      inputSchema: {
        domainName: z.string().describe('Zone to compare against, e.g. example.com.'),
        records: z.array(RecordInputSchema).describe('Records the caller intends to end up with.'),
      },
      outputSchema: {
        zone: z.string(),
        added: z.array(z.record(z.unknown())),
        updated: z.array(z.record(z.unknown())),
        unchanged: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const { span, decision } = beginCall(context, extra?.authInfo, {
        tool: name,
        risk: 'read',
        target: args.domainName,
        params: { records: args.records.length },
      });

      if (!decision.allowed) {
        span.complete({ verdict: 'denied', reason: decision.reason });
        return textResult(decision.reason, true);
      }

      try {
        const zone = await readZone(context, args.domainName);
        const current = zone.records ?? [];

        const added: Record<string, unknown>[] = [];
        const updated: Record<string, unknown>[] = [];
        let unchanged = 0;

        for (const proposed of args.records as RecordInput[]) {
          const match = current.find(
            (record) =>
              sameRecordKey(record, { type: proposed.type, host: proposed.host }) &&
              record.rdata === proposed.rdata,
          );

          if (match) {
            if (proposed.ttl !== undefined && match.ttl !== proposed.ttl) {
              updated.push({
                type: proposed.type,
                host: normalizeHost(proposed.host),
                rdata: proposed.rdata,
                ttl: { from: match.ttl ?? null, to: proposed.ttl },
              });
            } else {
              unchanged += 1;
            }
            continue;
          }

          const sameKey = current.find((record) =>
            sameRecordKey(record, { type: proposed.type, host: proposed.host }),
          );
          if (sameKey) {
            updated.push({
              type: proposed.type,
              host: normalizeHost(proposed.host),
              rdata: { from: sameKey.rdata ?? null, to: proposed.rdata },
              ...(proposed.ttl === undefined
                ? {}
                : { ttl: { from: sameKey.ttl ?? null, to: proposed.ttl } }),
            });
          } else {
            added.push({
              type: proposed.type,
              host: normalizeHost(proposed.host),
              rdata: proposed.rdata,
              ...(proposed.ttl === undefined ? {} : { ttl: proposed.ttl }),
            });
          }
        }

        span.complete({ verdict: 'allowed', upstreamStatus: 200 });
        return jsonResult(context, { zone: args.domainName, added, updated, unchanged });
      } catch (error) {
        const status = error instanceof EuroDnsApiError ? error.status : undefined;
        span.complete({
          verdict: 'failed',
          ...(status === undefined ? {} : { upstreamStatus: status }),
          reason: 'upstream error',
        });
        return textResult(
          failureMessage(error, `Could not read the zone ${args.domainName}.`),
          true,
        );
      }
    },
  );
}
