import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { evaluateGuardrails } from '../auth/scopes.js';
import { identityFrom } from './registry.js';
import { PORTFOLIO_REFRESH_TOOL_NAME } from './portfolioNames.js';
import type { ToolContext } from './context.js';

/**
 * Forces the domain list backing completion to be fetched again.
 *
 * The cache has a TTL, so this is never *required* — waiting works. It exists because the one
 * moment the TTL is wrong is the moment right after a change: someone registers or transfers
 * a domain, comes back here, and the name they just created is not in the suggestions. Being
 * told "wait up to ten minutes" is a worse answer than a command that takes a second.
 *
 * It is a read, and annotated as one: it fetches a list the caller could already fetch with
 * `eurodns_domain_search` and changes nothing upstream.
 */
export function registerPortfolioTools(server: McpServer, context: ToolContext): number {
  server.registerTool(
    PORTFOLIO_REFRESH_TOOL_NAME,
    {
      title: 'Refresh the cached domain list',
      description:
        'Re-reads the account’s domains, so a name registered or transferred moments ago ' +
        'appears in completion without waiting for the cache to expire. Changes nothing.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        domains: z.number().int(),
        /** Absent when nothing was cached yet, which is the normal first call. */
        replacedAgeSeconds: z.number().int().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (_args, ctx) => {
      const identity = identityFrom(context, ctx?.http?.authInfo);
      const span = context.audit.begin({
        actor: identity.actor,
        tool: PORTFOLIO_REFRESH_TOOL_NAME,
        risk: 'read',
        params: {},
      });

      const decision = evaluateGuardrails('read', context.config.guardrails, identity.scopes);
      if (!decision.allowed) {
        span.complete({ verdict: 'denied', reason: decision.reason });
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: decision.reason }],
        };
      }

      const { count, replacedAgeMs } = await context.portfolio.refresh(context.client);
      span.complete({ verdict: 'allowed' });

      const structured = {
        domains: count,
        ...(replacedAgeMs === undefined
          ? {}
          : { replacedAgeSeconds: Math.round(replacedAgeMs / 1000) }),
      };

      return {
        content: [
          {
            type: 'text' as const,
            text:
              replacedAgeMs === undefined
                ? `${count} domains cached.`
                : `${count} domains cached, replacing a list ${Math.round(replacedAgeMs / 1000)}s old.`,
          },
        ],
        structuredContent: structured,
      };
    },
  );

  return 1;
}
