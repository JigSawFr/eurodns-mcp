/** Shared constants. Values that come from the OpenAPI document are cited in comments. */

/** Default EuroDNS User API base URL (`servers[0].url` in the OpenAPI document). */
export const DEFAULT_BASE_URL = 'https://rest-api.eurodns.com';

/** Characters beyond which a tool response is truncated, with an explicit notice. */
export const DEFAULT_CHARACTER_LIMIT = 25_000;

/** Default upstream request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Retries for 429 and 5xx responses only. */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Signature algorithms accepted for OAuth access tokens.
 *
 * Asymmetric only, and stated explicitly rather than left to the key set. A resource server
 * that accepts whatever the token declares is the classic algorithm-confusion target: the
 * library already refuses `none` and rejects an HMAC signature against an RSA key, but the
 * list is what makes the guarantee readable rather than inherited.
 */
export const DEFAULT_JWT_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

/**
 * Size at which the audit log is rotated to `<file>.1`, replacing any previous rotation.
 *
 * The log only grows, and it is the one file a deployment cannot afford to lose to a full
 * disk. Two generations bound the footprint at twice this value; the history query reads
 * across both, so rotating does not create a hole in what can be answered.
 */
export const DEFAULT_AUDIT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Largest JSON request body accepted over HTTP.
 *
 * Body parsing happens before authentication — an unauthenticated caller should not be able
 * to hand the process an arbitrarily large document to parse. A DNS zone with a thousand
 * records serialises well under this.
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * TTL values accepted by the API. The `DnsRecord.ttl` description enumerates these
 * exactly; anything else is rejected upstream with an opaque error, so we validate here.
 */
export const TTL_VALUES = [
  600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800, 432000, 604800,
] as const;

/**
 * Pseudo record types: they do not live in `DnsZonePage.records` but in the
 * `mailForwards` and `urlForwards` arrays of the same zone document.
 */
export const FORWARD_RECORD_TYPES = ['MAIL', 'URL'] as const;

/** How dangerous an operation is. Drives tool annotations and the runtime guardrails. */
export type RiskClass = 'read' | 'write' | 'destructive' | 'billing';

/**
 * Operations that are POST but carry no side effect. Classifying by HTTP method alone
 * would mark these as writes and hide them behind guardrails for no reason.
 */
export const READ_ONLY_OPERATION_IDS = new Set([
  'searchDomains',
  'getAvailabilities',
  'checkDnsZone',
  'checkZoneProfile',
]);

/**
 * Operations that create a charge, extend a paid term, or change what is billed.
 * Blocked unless `EURODNS_ALLOW_BILLING` is set.
 */
export const BILLING_OPERATION_IDS = new Set([
  'createPremiumDnsSubscription',
  'renewPremiumDnsSubscription',
  'upgradePremiumDnsSubscription',
  'downgradePremiumDnsSubscription',
  'reactivatePremiumDnsSubscription',
  'createSslSubscription',
  'renewSslSubscription',
  'upgradeSslSubscriptionQuantity',
  'createHttpsRedirectSubscription',
  'renewHttpsRedirectSubscription',
  'updateSubscriptionAutorenewSettings',
]);

/**
 * Irreversible operations outside DNS zone data. DNS record deletions stay available by
 * default because a zone can be restored from a snapshot; these cannot.
 * Blocked unless `EURODNS_ALLOW_DESTRUCTIVE` is set.
 */
export const DESTRUCTIVE_OPERATION_IDS = new Set([
  'deleteEmailSubscription',
  'deletePremiumDnsSubscription',
  'deleteHttpsRedirectSubscription',
  'deleteContactProfile',
  'deleteNameserverProfile',
  'revokeSslCertificate',
  'cancelSslCertificate',
  'cancelSslSan',
]);

/** OAuth scopes for the risk classes. */
export const SCOPES = {
  read: 'eurodns.read',
  write: 'eurodns.dns.write',
  destructive: 'eurodns.destructive',
  billing: 'eurodns.billing',
} as const satisfies Record<RiskClass, string>;

/**
 * Reading the audit log is a read, but not of EuroDNS data: it reveals who did what.
 * It gets its own scope so that `eurodns.read` does not grant it by accident.
 */
export const AUDIT_SCOPE = 'eurodns.audit';

export const ALL_SCOPES = [...Object.values(SCOPES), AUDIT_SCOPE];

/** Request headers the API uses for pagination, instead of the usual query parameters. */
export const PAGINATION_HEADERS = {
  page: 'pagination-page',
  size: 'pagination-size',
  sortField: 'pagination-sortfield',
  sortOrder: 'pagination-sortorder',
} as const;
