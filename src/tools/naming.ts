import type { GeneratedOperation } from '../generated/operations.js';

/**
 * Maps OpenAPI tags to the prefix used in tool names.
 *
 * The raw tags (`DasService`, `DnsProvider`, `CustomerInvoiceProfileService`) describe the
 * vendor's internal services, not what an agent is looking for, so they are translated to
 * the noun a caller would actually search on.
 */
export const TAG_PREFIXES: Record<string, string> = {
  AccountService: 'account',
  ContactProfileService: 'contact',
  ContactValidationService: 'contact_validation',
  CustomerInvoiceProfileService: 'invoice_profile',
  DasService: 'domain',
  DnsProvider: 'dns',
  DomainService: 'domain',
  EmailSubscriptionService: 'email',
  HttpsRedirectService: 'https_redirect',
  InvoiceService: 'invoice',
  MicrosoftSubscriptionService: 'microsoft',
  NameserverProfileService: 'nameserver',
  OrderService: 'order',
  PremiumDnsSubscriptionService: 'premium_dns',
  SslSubscriptionService: 'ssl',
  SubscriptionService: 'subscription',
  TldService: 'tld',
};

/**
 * Tool names that derivation gets wrong or leaves ambiguous.
 *
 * Two agents picking between `..._get_subscriptions` and `..._get_subscription` will guess;
 * `list` versus `get` is unambiguous. Kept small on purpose — everything else is derived.
 */
export const NAME_OVERRIDES: Record<string, string> = {
  // Derivation yields `update_user_a_pi_zone_profile` from `updateUserAPiZoneProfile`.
  updateUserAPiZoneProfile: 'eurodns_dns_save_zone_profile',
  // "Availability check" is what callers look for, not "availabilities".
  getAvailabilities: 'eurodns_domain_check_availability',
  // Plural/singular pairs, made explicit.
  getSslSubscriptions: 'eurodns_ssl_list_subscriptions',
  getEmailSubscriptions: 'eurodns_email_list_subscriptions',
  getPremiumDnsSubscriptions: 'eurodns_premium_dns_list_subscriptions',
  getMicrosoftSubscriptions: 'eurodns_microsoft_list_subscriptions',
  getSubscriptions: 'eurodns_subscription_list',
  getContactProfiles: 'eurodns_contact_list_profiles',
  getNameserverProfiles: 'eurodns_nameserver_list_profiles',
  getInvoices: 'eurodns_invoice_list',
  getOrders: 'eurodns_order_list',
  getCustomerInvoiceProfiles: 'eurodns_invoice_profile_list',
  listTld: 'eurodns_tld_list',
  getTld: 'eurodns_tld_get',
  // Derivation leaves a stray plural or an unhelpful noun.
  searchDomains: 'eurodns_domain_search',
  getCustomerInvoiceProfile: 'eurodns_invoice_profile_get',
  resendContactValidationsEmails: 'eurodns_contact_resend_validation_email',
  // Superseded by the hand-written `eurodns_dns_delete_record`, which resolves the id from
  // the zone. This raw form stays available for callers that already hold a record id.
  deleteDnsRecord: 'eurodns_dns_delete_record_by_id',
  // `getProfile` and `getSnapShot` are zone-scoped despite their generic ids.
  getProfile: 'eurodns_dns_get_zone_profile',
  getSnapShot: 'eurodns_dns_get_zone_snapshot',
};

/** `getDnsZone` -> `get_dns_zone`, handling runs of capitals sensibly. */
export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Builds the MCP tool name for an operation.
 *
 * Every name is prefixed with `eurodns_` so it cannot collide with tools from another
 * server, then with the domain prefix. Domain words already carried by the operation id are
 * dropped, so `getSslSubscription` under the `ssl` prefix becomes `eurodns_ssl_get_subscription`
 * rather than `eurodns_ssl_get_ssl_subscription`.
 */
export function toolNameFor(operation: GeneratedOperation): string {
  const override = NAME_OVERRIDES[operation.operationId];
  if (override) return override;

  const prefix = TAG_PREFIXES[operation.tag] ?? toSnakeCase(operation.tag);
  const prefixWords = new Set(prefix.split('_'));
  const words = toSnakeCase(operation.operationId).split('_');

  const action = words.filter((word) => !prefixWords.has(word));
  const suffix = action.length > 0 ? action.join('_') : words.join('_');

  return `eurodns_${prefix}_${suffix}`;
}
