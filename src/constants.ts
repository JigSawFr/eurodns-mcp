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
 * Permissions for the audit file, and the suffix a rotated generation takes.
 *
 * The log is the only record attributing a DNS change to a person, so it should not be
 * readable by every account on the host.
 */
export const AUDIT_FILE_MODE = 0o600;
export const ROTATED_SUFFIX = '.1';

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

/**
 * Default rate limit on the MCP endpoint: requests per window, and the window.
 *
 * Generous on purpose. An agent working through a zone makes a burst of calls, and a limiter
 * that trips on ordinary use gets turned off — which leaves nothing. This absorbs a flood
 * without being felt by anyone doing real work.
 */
export const DEFAULT_RATE_LIMIT = 300;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * How long a client may reuse a `tools/list` or `server/discover` result.
 *
 * The surface is generated from a document vendored in the image, so it cannot change while
 * the process lives. Five minutes bounds how long a client keeps a stale list after a
 * deployment without making the cache pointless.
 */
export const TOOL_LIST_CACHE_MS = 5 * 60_000;

/**
 * Reported when the package version cannot be read.
 *
 * Deliberately not a plausible number. Falling back to a credible-looking version would
 * reproduce the defect this replaces: a monitoring system that sees `0.0.0-unknown` knows
 * something is wrong, one that sees a stale `0.1.0` does not.
 */
export const UNKNOWN_VERSION = '0.0.0-unknown';
