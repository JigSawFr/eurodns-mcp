import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { evaluateGuardrails } from '../auth/scopes.js';
import { formatJson } from '../services/format.js';
import { identityFrom } from './registry.js';
import { COMPAT_FETCH_TOOL_NAME, COMPAT_SEARCH_TOOL_NAME } from './compatNames.js';
import type { ToolContext } from './context.js';

/**
 * The `search` / `fetch` pair some clients require before they will install a server at all.
 *
 * ChatGPT's connector, company-knowledge and deep-research paths look for exactly these two
 * names with exactly this shape, and refuse the install without them. Its developer mode
 * takes arbitrary tools and needs none of this — so the pair opens one class of client, not
 * the client.
 *
 * **Off by default, and the names are why.** Every other tool here is prefixed `eurodns_`
 * precisely so it cannot collide with another server's in a client that has several
 * connected. These two cannot be: the contract is the bare names. A deployment that turns
 * them on is accepting that `search` and `fetch` may now mean two things at once to a shared
 * client, which is a reasonable trade to make deliberately and a bad one to inherit.
 *
 * Both are reads over operations already exposed as `eurodns_domain_search` and
 * `eurodns_domain_get`. They add reach, not capability.
 */
export function registerCompatTools(server: McpServer, context: ToolContext): number {
  if (!context.config.compat.searchFetch) return 0;

  registerSearch(server, context);
  registerFetch(server, context);
  return 2;
}

/** One entry of the upstream search result, narrowed to what the contract renders. */
interface SearchedDomain {
  domainName?: string;
  tldName?: string;
  expirationDate?: string;
  renewalMethod?: string;
  active?: boolean;
}

/**
 * A domain's own name is its id.
 *
 * The contract wants an opaque identifier that `fetch` can resolve. Here the natural one is
 * the domain name itself: it is unique within the account, it is what the upstream read is
 * keyed on, and it is meaningful to a person reading a citation. Minting a synthetic id would
 * mean holding a mapping for no gain.
 */
function summarise(entry: SearchedDomain): string {
  const parts = [
    entry.expirationDate ? `expires ${entry.expirationDate}` : undefined,
    entry.renewalMethod ? `renewal ${entry.renewalMethod}` : undefined,
    entry.active === false ? 'expired' : undefined,
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join(', ') : 'domain in this account';
}

function registerSearch(server: McpServer, context: ToolContext): void {
  server.registerTool(
    COMPAT_SEARCH_TOOL_NAME,
    {
      title: 'Search domains in this account',
      description:
        'Finds domains in this account matching a search term. Returns one result per ' +
        'domain, whose id can be passed to fetch for the full record.',
      inputSchema: z.object({
        query: z.string().describe('Free text matched against the account’s domain names.'),
      }),
      outputSchema: z.object({
        results: z.array(z.object({ id: z.string(), title: z.string(), text: z.string() })),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      const gate = beginRead(context, ctx?.http?.authInfo, COMPAT_SEARCH_TOOL_NAME, args.query);
      if (gate.refusal) return gate.refusal;

      const response = await context.client.request<SearchedDomain[]>({
        method: 'POST',
        path: '/domains/search',
        body: { term: args.query },
        pagination: { size: -1 },
      });

      const results = (Array.isArray(response.data) ? response.data : [])
        .filter(
          (entry): entry is SearchedDomain & { domainName: string } =>
            typeof entry?.domainName === 'string' && entry.domainName.length > 0,
        )
        .map((entry) => ({
          id: entry.domainName,
          title: entry.domainName,
          text: summarise(entry),
        }));

      gate.span.complete({ verdict: 'allowed' });
      return render(context, { results });
    },
  );
}

function registerFetch(server: McpServer, context: ToolContext): void {
  server.registerTool(
    COMPAT_FETCH_TOOL_NAME,
    {
      title: 'Fetch one domain record',
      description:
        'Returns the full registry record for one domain, given the id a search result ' +
        'carried — which for this server is the domain name itself.',
      inputSchema: z.object({
        id: z.string().describe('The domain name, as returned by search.'),
      }),
      outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        text: z.string(),
        metadata: z.record(z.string(), z.string()).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      const gate = beginRead(context, ctx?.http?.authInfo, COMPAT_FETCH_TOOL_NAME, args.id);
      if (gate.refusal) return gate.refusal;

      const response = await context.client.request<Record<string, unknown>>({
        method: 'GET',
        path: `/domains/${encodeURIComponent(args.id)}`,
      });

      // No `url`. The contract makes it optional, and this account's domains have no public
      // address to cite — inventing one would put a link in a citation that resolves to
      // nothing, which is worse than a citation with no link.
      const record = {
        id: args.id,
        title: args.id,
        text: JSON.stringify(response.data, null, 2),
        metadata: { source: 'EuroDNS User API' },
      };

      gate.span.complete({ verdict: 'allowed' });
      return render(context, record);
    },
  );
}

/** Audit span plus the guardrail check both tools share, since both are plain reads. */
function beginRead(
  context: ToolContext,
  authInfo: Parameters<typeof identityFrom>[1],
  tool: string,
  target: string,
) {
  const identity = identityFrom(context, authInfo);
  const span = context.audit.begin({
    actor: identity.actor,
    tool,
    risk: 'read',
    target,
    params: {},
  });

  const decision = evaluateGuardrails('read', context.config.guardrails, identity.scopes);
  if (decision.allowed) return { span, refusal: undefined };

  span.complete({ verdict: 'denied', reason: decision.reason });
  return {
    span,
    refusal: {
      isError: true as const,
      content: [{ type: 'text' as const, text: decision.reason }],
    },
  };
}

function render(context: ToolContext, value: Record<string, unknown>) {
  const rendered = formatJson(value, context.config.upstream.characterLimit);
  return { content: [{ type: 'text' as const, text: rendered.text }], structuredContent: value };
}
