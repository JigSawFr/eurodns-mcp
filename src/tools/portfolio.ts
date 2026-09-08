import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { evaluateGuardrails } from '../auth/scopes.js';
import { UNCONFIGURED_MESSAGE } from '../services/errors.js';
import { identityFrom } from './registry.js';
import { NO_CREDENTIALS_REASON } from './failure.js';
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
 * `eurodns_domain_get` and changes nothing upstream.
 */
export function registerPortfolioTools(server: McpServer, context: ToolContext): number {
  server.registerTool(
    PORTFOLIO_REFRESH_TOOL_NAME,
    {
      title: 'Refresh the cached domain list',
      description:
        'Re-reads the account’s domain list that backs name completion, so a domain registered or ' +
        'transferred moments ago appears in suggestions without waiting for the cache to expire, ' +
        'and returns how many domains were loaded. Use it right after such a change, not as a way ' +
        'to list domains: that is eurodns_domain_get called without a domainName. It alters ' +
        'nothing upstream.',
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

      // The one handler that checks this itself. Every other tool learns it from the client's
      // refusal, but the cache swallows upstream failures on purpose, so without this the
      // answer would be "0 domains cached" — which reads as an empty account, not as a server
      // that cannot ask.
      if (!context.client.hasCredentials()) {
        span.complete({ verdict: 'denied', reason: NO_CREDENTIALS_REASON });
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: UNCONFIGURED_MESSAGE }],
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
