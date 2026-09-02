import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { TTL_VALUES } from './constants.js';
import { auditQueryAvailable } from './tools/audit.js';
import { AUDIT_QUERY_TOOL_NAME } from './tools/auditNames.js';
import { isAdvertised } from './tools/registry.js';
import type { ToolContext } from './tools/context.js';

/**
 * Workflows a person asks for by name, rather than tools a model reaches for.
 *
 * Prompts cost nothing until they are used — they are not injected into context the way the
 * handshake instructions are — so the bar here is only whether a workflow is worth naming.
 * Each of these is several tool calls in a fixed order with a judgement at the end, which is
 * exactly the shape that is tedious to re-derive and easy to get subtly wrong.
 *
 * MCP prompt arguments arrive as strings, so every argument is declared as one and parsed in
 * the body rather than typed as a number the transport cannot carry.
 */
export function registerPrompts(server: McpServer, context: ToolContext): number {
  const { guardrails } = context.config;
  let registered = 0;

  server.registerPrompt(
    'eurodns_zone_review',
    {
      title: 'Review a DNS zone',
      description:
        'Read a zone and report what looks wrong: missing mail authentication, dangling ' +
        'CNAMEs, inconsistent nameservers, TTLs that will hurt during a migration.',
      argsSchema: z.object({
        domainName: z.string().describe('The zone to review, e.g. example.com.'),
      }),
    },
    ({ domainName }) =>
      text(
        `Review the DNS zone for ${domainName} and report what you find. Change nothing.`,
        '',
        `1. Read the zone with eurodns_dns_get_zone.`,
        `2. Check mail authentication: an SPF record (TXT starting "v=spf1"), a DMARC record at`,
        `   _dmarc, and whether either is missing, duplicated, or ends in "+all".`,
        `3. Check the records against each other: CNAMEs that point at a name with no record,`,
        `   a CNAME sharing a host with any other record, and MX or NS targets that are`,
        `   themselves CNAMEs. All three are configuration errors rather than style.`,
        `4. Check the nameservers the zone declares against what the registry has for the`,
        `   domain (eurodns_domain_get). A mismatch means edits here are not what resolves.`,
        `5. Note TTLs at the extremes. The accepted values are ${TTL_VALUES.join(', ')};`,
        `   a record at 604800 cannot be changed quickly, and one at 600 costs on every lookup.`,
        '',
        `Report findings grouped by severity, each with the record it concerns. Say plainly`,
        `when something is a deliberate choice you cannot distinguish from a mistake, rather`,
        `than reporting it as broken.`,
      ),
  );
  registered += 1;

  server.registerPrompt(
    'eurodns_expiry_review',
    {
      title: 'Review what is about to expire',
      description:
        'List domains, certificates and subscriptions expiring inside a window, with their ' +
        'renewal method, so the ones that will not renew themselves are visible.',
      // `.default({})` rather than a bare object: when every argument is optional, a client
      // may legitimately send `prompts/get` with no `arguments` member at all, and a bare
      // object schema rejects the resulting `undefined` before the body is ever reached.
      argsSchema: z
        .object({
          withinDays: z
            .string()
            .describe('Size of the window in days, e.g. 90. Defaults to 90 when omitted.')
            .optional(),
        })
        .default({}),
    },
    ({ withinDays }) => {
      const days = parsePositiveInt(withinDays) ?? 90;
      return text(
        `List everything expiring in the next ${days} days, and say what will not renew itself.`,
        '',
        `1. eurodns_subscription_list covers domains, SSL, email and premium DNS in one call,`,
        `   with the auto-renewal setting. Start there rather than with one call per product.`,
        `2. Where it is not enough, fall back to eurodns_domain_search,`,
        `   eurodns_ssl_list_subscriptions, eurodns_email_list_subscriptions and`,
        `   eurodns_premium_dns_list_subscriptions.`,
        `3. Keep only what expires within ${days} days of today.`,
        '',
        `Report a single table sorted by expiry date: what it is, the date, days remaining,`,
        `and the renewal method. Then call out separately the entries that are NOT set to`,
        `renew automatically — those are the only ones that need a decision. If nothing`,
        `expires in the window, say so in one line rather than showing an empty table.`,
      );
    },
  );
  registered += 1;

  // Writes a record. Under a read-only deployment the tool it depends on is not registered,
  // so the prompt would be an instruction to call something that is not there.
  if (isAdvertised('write', guardrails)) {
    server.registerPrompt(
      'eurodns_acme_challenge',
      {
        title: 'Publish an ACME DNS-01 challenge',
        description:
          'Publish the _acme-challenge TXT record a certificate authority asked for, at a ' +
          'TTL short enough that a mistake is cheap to correct.',
        argsSchema: z.object({
          domainName: z.string().describe('The domain being validated, e.g. example.com.'),
          token: z.string().describe('The exact token value the ACME client printed.'),
        }),
      },
      ({ domainName, token }) =>
        text(
          `Publish the ACME DNS-01 challenge for ${domainName}.`,
          '',
          `1. Preview first with eurodns_dns_diff_zone: host "_acme-challenge", type TXT,`,
          `   rdata "${token}", ttl 600. Confirm the diff shows exactly one addition, or one`,
          `   replacement of a previous challenge, and nothing else.`,
          `2. Apply it with eurodns_dns_upsert_record, same values. The value field is rdata.`,
          `   TTL 600 is the shortest the API accepts and the right choice here: the record is`,
          `   temporary and a wrong value should expire quickly.`,
          `3. Read the zone back and confirm the record is present as written.`,
          '',
          `Then tell the user to let their ACME client proceed, and remind them the record can`,
          `be removed with eurodns_dns_delete_record once the certificate is issued. If step 1`,
          `shows the diff touching anything else, stop and report it instead of applying.`,
        ),
    );
    registered += 1;
  }

  // Points at the audit-query tool, which most deployments do not enable.
  if (auditQueryAvailable(context.config)) {
    server.registerPrompt(
      'eurodns_change_review',
      {
        title: 'Review what changed, and who changed it',
        description:
          'Read the audit log over a period and summarise it by actor, with refusals and ' +
          'failures called out.',
        argsSchema: z.object({
          since: z
            .string()
            .describe('ISO 8601 lower bound, e.g. 2026-01-01T00:00:00Z, or "7 days ago".'),
        }),
      },
      ({ since }) =>
        text(
          `Summarise what this server did since ${since}.`,
          '',
          `1. Query ${AUDIT_QUERY_TOOL_NAME} for the period. Convert "since" to ISO 8601 first`,
          `   if it is not already; ask rather than guess if it is ambiguous.`,
          `2. Run it a second time with verdict "denied", and a third with verdict "failed".`,
          `   Refusals are usually the interesting entries — they are where someone tried`,
          `   something the deployment does not allow.`,
          `3. Check the chain report the tool returns. If it is not intact, say so first and`,
          `   prominently: it means the log has been truncated or edited, and everything below`,
          `   is only as trustworthy as that.`,
          '',
          `Report state-changing actions grouped by actor, then refusals with what was refused`,
          `and why, then failures. Leave reads out of the summary unless nothing else happened.`,
        ),
    );
    registered += 1;
  }

  return registered;
}

/** Wraps prose as the single user message a prompt expands to. */
function text(...lines: string[]) {
  return {
    messages: [
      { role: 'user' as const, content: { type: 'text' as const, text: lines.join('\n') } },
    ],
  };
}

/** Prompt arguments arrive as strings; anything that is not a positive integer is ignored. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
