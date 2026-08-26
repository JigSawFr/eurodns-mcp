import type { GeneratedOperation } from '../generated/operations.js';

/**
 * Hand-written descriptions for the operations agents reach for most.
 *
 * The document's own summaries ("Get domain", "Search domains") say what an endpoint is
 * called, not what it is for or when to prefer it over its neighbour — which is exactly
 * the decision a tool description has to support. Everything not listed here falls back to
 * the document's own text.
 */
export const DESCRIPTION_OVERRIDES: Record<string, string> = {
  // --- DNS zones -----------------------------------------------------------------
  getDnsZone:
    'Returns a zone in full: its DNS records, URL forwards and mail forwards. Start here ' +
    'before changing anything, and use the record ids it returns to target a specific entry.',
  saveDnsZone:
    'Replaces a zone in its entirety. Anything absent from the submitted document is ' +
    'deleted, so this is only safe with a complete zone you have just read. To change one ' +
    'record, prefer eurodns_dns_upsert_record, which reads, validates and saves for you.',
  checkDnsZone:
    'Validates a candidate zone and returns a per-record report, without changing anything. ' +
    'Use it before saving: a rejected save returns only a generic error, while this returns ' +
    'the reason for each offending record.',
  addDnsRecords:
    'Appends records to a zone and saves immediately, without the validation step. Use ' +
    'eurodns_dns_upsert_record instead when you want the change validated first, or when ' +
    'the record may already exist and should be updated rather than duplicated.',
  deleteDnsRecord:
    'Deletes one record by its numeric id, which you must already have from reading the ' +
    'zone. If you know the record by type and host instead, use eurodns_dns_delete_record.',
  listDnsZoneSnapshots:
    'Lists previous states of a zone. Use this to find the snapshot to inspect after an ' +
    'unintended change.',
  getSnapShot: 'Returns one previous state of a zone, for comparison against the live zone.',

  // --- DNSSEC ---------------------------------------------------------------------
  getDnssecStatus:
    'Reports whether DNSSEC is active on a zone and returns its keys. Check this before ' +
    'signing or unsigning, and after nameserver changes.',
  signZone: 'Enables DNSSEC signing on a zone hosted here.',
  unsignZone:
    'Disables DNSSEC signing on a zone. Removing signing from a validated zone can make it ' +
    'unresolvable until the DS record clears the parent, so confirm the intent first.',
  signDomain: 'Publishes DNSSEC DS records for a domain at its registry.',
  unsignDomain:
    'Removes the DNSSEC DS records for a domain at its registry. Doing this while the zone ' +
    'is still signed breaks validation for resolvers that cached the DS record.',

  // --- Domains --------------------------------------------------------------------
  getDomain:
    'Returns one domain already registered in this account: its status, expiry, contacts and ' +
    'nameservers. For domains not in the account, use the availability check instead.',
  searchDomains:
    'Searches the domains held in this account, with filters for expiry, renewability and ' +
    'DNSSEC. This is the inventory query — it never reports on domains held elsewhere.',
  getAvailabilities:
    'Checks whether domain names are available to register. This queries the registries, so ' +
    'it works for any name, registered here or not.',

  // --- TLDs and pricing ------------------------------------------------------------
  listTld:
    'Lists the TLDs this account can order, with their terms and requirements. The response ' +
    'is large — page through it rather than requesting everything at once.',
  getTld:
    'Returns one TLD with its registration terms, duration limits and any registry-specific ' +
    'requirements. Check this before ordering an unfamiliar extension.',

  // --- Account and billing ----------------------------------------------------------
  getPrepaidAccountBalance:
    'Returns the prepaid balance. Check it before any operation that spends credit: an ' +
    'insufficient balance is a common cause of a rejected order.',
  getInvoices: 'Searches invoices by date, type, status or related order.',
  getOrders:
    'Searches orders and their per-line delivery status. Use this to find out what happened ' +
    'to a subscription that was created but never became active.',

  // --- Profiles ---------------------------------------------------------------------
  getContactProfiles:
    'Lists the reusable contact profiles used as registrant, admin, technical and billing ' +
    'contacts on domains.',
  setAsDefaultContactProfile:
    'Makes a contact profile the default for the given contact types. This affects future ' +
    'orders, not domains already registered.',
  deleteContactProfile:
    'Deletes a contact profile permanently. Domains already using it keep their registered ' +
    'contact data, but the profile can no longer be reused.',
  getNameserverProfiles:
    'Lists reusable nameserver sets that can be applied to domains as a group.',

  // --- Subscriptions ------------------------------------------------------------------
  getSubscriptions:
    'Searches every subscription on the account regardless of product. Use a product-specific ' +
    'list when you already know whether you are after SSL, email, Premium DNS or Microsoft.',
  updateSubscriptionAutorenewSettings:
    'Turns automatic renewal on or off for a subscription and sets its renewal term. This ' +
    'changes what will be charged in future.',

  // --- SSL --------------------------------------------------------------------------
  getSslSubscriptions: 'Searches SSL subscriptions, with their certificates and expiry dates.',
  createSslSubscription:
    'Orders a new SSL certificate. This spends credit and starts a validation process that ' +
    'has to be completed before the certificate is issued.',
  reissueSslCertificate:
    'Reissues an existing certificate against a new CSR, for example after a key rotation. ' +
    'The subscription term is unchanged and no new charge is made.',
  getSslValidation:
    'Returns how a certificate name is being validated and where it currently stands. Check ' +
    'this when an ordered certificate has not been issued.',
  revokeSslCertificate:
    'Revokes an issued certificate permanently. It cannot be un-revoked, and any service ' +
    'still presenting it will fail for clients that check revocation.',
  cancelSslCertificate:
    'Abandons a certificate order that is still being validated. The order will not complete ' +
    'and the certificate will never be issued.',

  // --- Email ---------------------------------------------------------------------------
  createCatchall:
    'Routes every address at the domain that has no mailbox of its own to a chosen ' +
    'destination. Expect a marked increase in unsolicited mail.',
  updateEmailPassword:
    'Sets a mailbox password. The new value is written straight through to the provider and ' +
    'is never recorded here.',
};

/** Strips the light HTML the document uses inside descriptions. */
function stripMarkup(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function describeOperation(operation: GeneratedOperation): string {
  const override = DESCRIPTION_OVERRIDES[operation.operationId];
  if (override) return override;

  const summary = stripMarkup(operation.summary);
  const description = stripMarkup(operation.description);

  if (summary && description) {
    return description.startsWith(summary) ? description : `${summary}. ${description}`;
  }
  return description || summary || operation.operationId;
}
