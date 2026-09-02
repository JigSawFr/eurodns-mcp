import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { evaluateGuardrails } from '../auth/scopes.js';
import { AUDIT_SCOPE } from '../constants.js';
import { queryAuditLog, type AuditQuery } from '../auditReader.js';
import { formatJson } from '../services/format.js';
import { identityFrom } from './registry.js';
import { AUDIT_QUERY_TOOL_NAME } from './auditNames.js';
import type { Config } from '../config.js';
import type { ToolContext } from './context.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Reads the audit log back.
 *
 * The upstream API authenticates every caller with one shared key, so this log is the only
 * record of who did what. Exposing it through the server is what turns that record into
 * something answerable in conversation — and also why it is off by default, needs its own
 * scope, and shows a caller only their own history unless an operator opens it wider.
 */
/**
 * Whether the audit-query tool exists on this deployment.
 *
 * Only a file can be read back; the configuration layer already refuses other pairings. This
 * is a predicate rather than a line inside the registration because a prompt that tells a
 * model to call the tool has to be conditioned on exactly the same test — and a second copy
 * of it would be a second thing to keep in step.
 */
export function auditQueryAvailable(config: Config): boolean {
  const { destination, filePath, query } = config.audit;
  return query !== 'off' && destination === 'file' && Boolean(filePath);
}

export function registerAuditTools(server: McpServer, context: ToolContext): number {
  const { filePath, query } = context.config.audit;

  if (!auditQueryAvailable(context.config) || !filePath) return 0;

  const scopedToCaller = query === 'own';

  server.registerTool(
    AUDIT_QUERY_TOOL_NAME,
    {
      title: 'Search the action history',
      description:
        'Searches this server’s audit log: which tool ran, on what, for whom, and whether it ' +
        'was allowed, refused or failed. Use it to answer questions about what has been done ' +
        'recently. ' +
        (scopedToCaller
          ? 'Results are limited to the calling identity’s own actions.'
          : 'Results cover every caller.'),
      inputSchema: z.object({
        since: z.string().optional().describe('ISO 8601 lower bound, e.g. 2026-01-01T00:00:00Z.'),
        until: z.string().optional().describe('ISO 8601 upper bound.'),
        tool: z.string().optional().describe('Exact tool name, e.g. eurodns_dns_upsert_record.'),
        target: z.string().optional().describe('Domain or subscription id the action acted on.'),
        verdict: z
          .enum(['allowed', 'denied', 'failed'])
          .optional()
          .describe('Outcome. "denied" shows refusals, which are often the interesting ones.'),
        risk: z.enum(['read', 'write', 'destructive', 'billing']).optional(),
        actor: z
          .string()
          .optional()
          .describe(
            'Actor subject to filter on. Rejected when the server limits you to your own history.',
          ),
        includeStarted: z
          .boolean()
          .optional()
          .describe(
            'Include the "started" line written before each state-changing call. Off by ' +
              'default: the "completed" line carries the outcome.',
          ),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Default 50.'),
      }),
      outputSchema: z.object({
        entries: z.array(z.record(z.string(), z.unknown())),
        returned: z.number().int(),
        scanned: z.number().int(),
        truncated: z.boolean(),
        chain: z.object({
          intact: z.boolean(),
          verified: z.number().int(),
          brokenAt: z.number().int().optional(),
          segments: z.number().int(),
        }),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, ctx) => {
      const identity = identityFrom(context, ctx?.http?.authInfo);

      // Reading the history is itself an action, and is recorded like any other.
      const span = context.audit.begin({
        actor: identity.actor,
        tool: AUDIT_QUERY_TOOL_NAME,
        risk: 'read',
        params: { tool: args.tool, verdict: args.verdict, limit: args.limit ?? DEFAULT_LIMIT },
      });

      const decision = evaluateGuardrails(
        'read',
        context.config.guardrails,
        identity.scopes,
        AUDIT_SCOPE,
      );
      if (!decision.allowed) {
        span.complete({ verdict: 'denied', reason: decision.reason });
        return { isError: true, content: [{ type: 'text' as const, text: decision.reason }] };
      }

      if (scopedToCaller && args.actor !== undefined && args.actor !== identity.actor.subject) {
        span.complete({ verdict: 'denied', reason: 'actor filter refused' });
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                'This server limits the action history to your own actions, so filtering by ' +
                'another actor is not available. An operator can widen it with ' +
                'EURODNS_AUDIT_QUERY=all.',
            },
          ],
        };
      }

      const query: AuditQuery = {
        limit: args.limit ?? DEFAULT_LIMIT,
        ...(args.since === undefined ? {} : { since: args.since }),
        ...(args.until === undefined ? {} : { until: args.until }),
        ...(args.tool === undefined ? {} : { tool: args.tool }),
        ...(args.target === undefined ? {} : { target: args.target }),
        ...(args.verdict === undefined ? {} : { verdict: args.verdict }),
        ...(args.risk === undefined ? {} : { risk: args.risk }),
        ...(args.includeStarted === undefined ? {} : { includeStarted: args.includeStarted }),
        // Enforced here rather than trusted from the argument.
        ...(scopedToCaller
          ? { subject: identity.actor.subject }
          : args.actor === undefined
            ? {}
            : { subject: args.actor }),
      };

      const result = queryAuditLog(filePath, query);
      span.complete({ verdict: 'allowed' });

      const structured = {
        entries: result.entries as unknown as Record<string, unknown>[],
        returned: result.entries.length,
        scanned: result.scanned,
        truncated: result.truncated,
        chain: result.chain,
      };

      const rendered = formatJson(structured, context.config.upstream.characterLimit);
      const notes: string[] = [];
      if (result.truncated) {
        notes.push(
          'Older entries exist beyond the read window. Narrow the time range to reach them.',
        );
      }
      // Said in prose as well as in the structured result: an agent summarising this for a
      // person must not present a tampered log as an ordinary answer.
      if (!result.chain.intact) {
        notes.push(
          'WARNING: the audit log fails its integrity check. A line was altered or removed ' +
            `after it was written${
              result.chain.brokenAt === undefined ? '' : `, at sequence ${result.chain.brokenAt}`
            }. Treat this history as unreliable and investigate.`,
        );
      }
      const note = notes.length > 0 ? `\n\n${notes.join('\n\n')}` : '';

      return {
        content: [{ type: 'text' as const, text: rendered.text + note }],
        structuredContent: structured,
      };
    },
  );

  return 1;
}
