import type { Config } from './config.js';
import { FORWARD_RECORD_TYPES, TTL_VALUES } from './constants.js';
import { TAG_PREFIXES } from './tools/naming.js';

/**
 * Names the risk classes a deployment is hiding.
 *
 * Hiding is the honest surface, but it costs discoverability: a disabled tool no longer
 * answers with the variable that would enable it, it simply is not there. Saying so — once at
 * startup for the operator, and once in the instructions for the model — is what they get
 * instead.
 */
export function hiddenClasses(config: Config): string[] {
  const { readOnly, allowBilling, allowDestructive } = config.guardrails;
  if (readOnly) return ['everything that changes state (EURODNS_READ_ONLY)'];
  const hidden: string[] = [];
  if (!allowBilling) hidden.push('billing (EURODNS_ALLOW_BILLING)');
  if (!allowDestructive) hidden.push('irreversible (EURODNS_ALLOW_DESTRUCTIVE)');
  return hidden;
}

/** The 16 areas the tool names are grouped into, derived rather than repeated. */
function areas(): string {
  return [...new Set(Object.values(TAG_PREFIXES))].sort().join(', ');
}

/**
 * What the server tells a model about itself, in the handshake.
 *
 * This is the one piece of text every client injects into the model's context, and the only
 * documentation it will ever read: `docs/tools.md` explains the same traps at length to a
 * human, and a model reaching for a tool has never seen it. Until this existed, the three
 * mistakes below were discovered the way they are cheapest to avoid and most expensive to
 * make — by making them against a live registrar account.
 *
 * Every word here is paid for on every single session, so it stays at the size of a briefing
 * rather than a manual: the traps that cost data, the shape of a listing call, and the one
 * error whose cause is never what it looks like. Everything else belongs in the tool
 * descriptions, which are only paid for when the tool is used.
 *
 * It deliberately carries no tool count. The count is only known after registration, which
 * happens after the constructor this text is passed to — and `tools/list` already gives the
 * client the exact number, so buying it back with a second pass over the guardrails would
 * duplicate `isAdvertised` to restate something the client is about to be told precisely.
 *
 * Config-derived on purpose. The character limit and the hidden classes are properties of
 * *this* deployment, and a model told the defaults instead would be told something false. The
 * HTTP transport rebuilds the server per request, so this text follows a configuration change
 * without any cache to invalidate.
 */
export function buildInstructions(config: Config): string {
  const hidden = hiddenClasses(config);

  const sections = [
    `Manage domains, DNS zones, contacts, subscriptions, SSL, invoices and orders through the ` +
      `EuroDNS User API. Every tool is named eurodns_<area>_<verb>, over these areas: ` +
      `${areas()}.`,

    `EDITING A ZONE. The API's zone save replaces the entire zone document, so saving a ` +
      `partial record set silently deletes everything left out. Use eurodns_dns_upsert_record, ` +
      `eurodns_dns_delete_record and eurodns_dns_diff_zone: they read the live zone first and ` +
      `change only what you named. Reach for eurodns_dns_save_zone only when replacing the ` +
      `whole zone is the actual intent.`,

    `RECORD FIELDS. The value field is "rdata", not "data" — sending "data" fails with an ` +
      `opaque technical error. TTL accepts only ${TTL_VALUES.join(', ')}. ` +
      `${FORWARD_RECORD_TYPES.join(' and ')} are not record types: they are the zone's mail ` +
      `and URL forwards, which carry different fields and are refused as records.`,

    `LISTING. List tools take page, size, sortField and sortOrder rather than pagination ` +
      `headers. size accepts -1 for every result in one page. Results are capped at ` +
      `${config.upstream.characterLimit.toLocaleString('en-US')} characters here — past that ` +
      `the server drops indentation first and truncates only if that is still not enough, ` +
      `saying how much it omitted. On a large portfolio prefer a filtered query over -1.`,

    `ERRORS. A 403 from the API is almost always the calling host's public IP missing from the ` +
      `account's allowlist, not a bad credential. Report that rather than retrying or asking ` +
      `for the credentials again.`,
  ];

  if (hidden.length > 0) {
    sections.push(
      `THIS DEPLOYMENT HIDES ${hidden.join(' and ')}. Those tools are absent from the list ` +
        `rather than refused, so do not offer them; the variable in parentheses is what an ` +
        `operator would change to restore each.`,
    );
  }

  return sections.join('\n\n');
}
