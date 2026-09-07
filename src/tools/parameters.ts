import type { GeneratedOperation, GeneratedParameter } from '../generated/operations.js';
import { areaFor } from './naming.js';

/**
 * Hand-written descriptions for the arguments of the generated tools.
 *
 * The vendor's document leaves 110 of its 127 parameters undescribed — `id` on twenty-two
 * operations with no word on which object the id belongs to — and a model choosing between
 * `eurodns_ssl_get_certificate` and `eurodns_ssl_get_subscription` has to know that
 * `subscriptionId` on the former is the *parent's* id. The schema carries the type; these
 * carry the meaning, and above all where the value comes from.
 *
 * Three levels, most specific first, keyed by the **raw** parameter name (`cip-id`, not
 * `cipId`) so a test can check every key against the document without re-deriving the
 * camel-casing:
 *
 * - per operation, `${operationId}.${name}`, for a filter whose meaning is the listing's
 *   own (`getContactProfiles.is-org`, `getOrders.statuses`);
 * - per area, `${area}.${name}`, because `id` means a different object in each of seven
 *   areas and `subscription-id` in four;
 * - per name, for parameters that mean the same thing wherever they appear.
 *
 * Below these the document's own text is used where it has any, and the schema is left as
 * generated where it has not. The resolver never invents; the test in
 * `tests/descriptions.test.ts` is what decides whether the result is good enough.
 */
export const PARAMETER_DESCRIPTIONS_BY_OPERATION: Record<string, string> = {
  'listZoneProfiles.name': 'Filter on the profile name. Omit to list every profile.',
  'listTld.tld-name': 'Filter on the TLD name, e.g. "com" or "lu". Omit to page through every TLD.',
  'getEmailSubscriptions.user-name': 'Filter on the mailbox user name, the part before the @.',
  'getContactProfiles.type':
    'Filter on the contact type: PRIVATE_PERSON, COMPANY, ORGANISATION or PUBLIC_BODY.',
  'getContactProfiles.is-org': 'Keep only profiles usable as the registrant (owner) contact.',
  'getContactProfiles.is-admin': 'Keep only profiles usable as the administrative contact.',
  'getContactProfiles.is-tech': 'Keep only profiles usable as the technical contact.',
  'getContactProfiles.is-billing': 'Keep only profiles usable as the billing contact.',
  'getNameserverProfiles.default':
    'true keeps only the default profile, false keeps every other one. Omit for both.',
  'getNameserverProfiles.deletable':
    'true keeps only profiles no domain uses, which are the ones that can be deleted.',
  'getNameserverProfiles.include-nameservers':
    "Include each profile's nameserver list in the response, not just its name and id.",
  'getOrders.statuses':
    'Keep only orders in these payment statuses, e.g. PAID, PENDING_PAYMENT or REFUSED.',
  'getInvoices.invoice-type':
    'Keep only invoices of this type: INVOICE, CREDIT_NOTE, CORRECTIVE_INVOICE or ' +
    'EDITED_INVOICE.',
  'getInvoices.invoice-statuses':
    'Keep only invoices in these statuses, e.g. TO_PAY, PAID or CANCELLED.',
  'getSubscriptions.subscription-types':
    'Keep only these products: SSL, EMAIL, PREMIUM_DNS, MICROSOFT, HTTPS_REDIRECT, HOSTING ' +
    'or WHOIS_PRIVACY. Omit for every product.',
  'getSubscriptions.auto-renew-enabled':
    'true keeps only subscriptions that renew themselves, false only those that will lapse.',
};

export const PARAMETER_DESCRIPTIONS_BY_AREA: Record<string, string> = {
  'dns.domain-name': 'Name of the zone, e.g. example.com: a domain whose DNS is hosted here.',
  'dns.id':
    'Numeric id of the zone profile, from the list eurodns_dns_get_zone_profile returns ' +
    'when called without an id.',
  'domain.domain-name':
    'Fully qualified domain name, e.g. example.com, as listed by eurodns_domain_search.',
  'contact.id':
    'Numeric id of the contact profile, from the list eurodns_contact_get_profile returns ' +
    'when called without an id.',
  'nameserver.id':
    'Numeric id of the nameserver profile, from the list eurodns_nameserver_get_profile ' +
    'returns when called without an id.',
  'email.id':
    'Numeric id of the email subscription, from the list eurodns_email_get_subscription ' +
    'returns when called without an id.',
  'premium_dns.subscription-id':
    'Numeric id of the Premium DNS subscription, from the list ' +
    'eurodns_premium_dns_get_subscription returns when called without an id.',
  'ssl.subscription-id':
    'Numeric id of the SSL subscription, from the list eurodns_ssl_get_subscription returns ' +
    'when called without an id.',
  'https_redirect.subscription-id':
    'Numeric id of the HTTPS redirect subscription, as returned by ' +
    'eurodns_subscription_search filtered on HTTPS_REDIRECT.',
  'subscription.subscription-id':
    'Numeric id of the subscription, whatever its product, as returned by ' +
    'eurodns_subscription_search.',
};

export const PARAMETER_DESCRIPTIONS_BY_NAME: Record<string, string> = {
  'cip-id':
    'Numeric id of the customer invoice profile, from the list eurodns_invoice_profile_get ' +
    'returns when called without an id.',
  'certificate-id':
    'Numeric id of the certificate inside the subscription, from the certificates ' +
    'eurodns_ssl_get_subscription returns.',
  'san-name':
    'Subject Alternative Name exactly as it appears on the certificate, e.g. ' +
    'www.example.com, from eurodns_ssl_get_certificate.',
  alias: 'The alias address for the mailbox, e.g. sales@example.com.',
  lang: 'Two-letter language code for the messages the API returns, e.g. en. Optional.',
  'subscription-status':
    'Keep only subscriptions in this lifecycle status, e.g. ACTIVE, TO_RENEW or ' +
    'PROVISIONING. Omit for every status.',
};

/**
 * What goes in `body`, per operation registered on its own.
 *
 * The generated schema says what shape the body has; this says what it *is* — the complete
 * zone rather than the changed records, every field rather than the changed ones — because
 * that distinction is exactly what the vendor's API punishes getting wrong. The profile
 * create/update pairs are absent on purpose: their composite in `composites.ts` describes
 * the one body both members share.
 */
export const BODY_DESCRIPTIONS: Record<string, string> = {
  // --- DNS zones -----------------------------------------------------------------
  saveDnsZone:
    'The complete zone as returned by eurodns_dns_get_zone, with your changes applied: ' +
    'records, urlForwards and mailForwards. Anything left out is deleted; record values go ' +
    'in rdata.',
  checkDnsZone:
    'The candidate zone to validate: records, urlForwards and mailForwards in the shape ' +
    'eurodns_dns_get_zone returns. Nothing is saved.',
  addDnsRecords:
    'The records to append, each with type, host, rdata and optionally a ttl from the ' +
    'allowed list. Existing records are kept.',
  checkZoneProfile:
    'The candidate profile to validate: name, records, urlForwards and mailForwards. ' +
    'Nothing is saved.',

  // --- Domains --------------------------------------------------------------------
  searchDomains:
    'Search criteria: a free-text term with its termMatchingMode and termMatchFields, plus ' +
    'boolean filters such as active, renewable, dnssecActivated or premiumDns. An empty ' +
    'object lists every domain.',
  getAvailabilities:
    'domainNames: the fully qualified names to check, e.g. ["example.com", "example.lu"].',

  // --- Profiles ---------------------------------------------------------------------
  setAsDefaultContactProfile:
    'Which contact roles this profile becomes the default for: org (registrant), admin, ' +
    'tech and billing, each true or false.',
  resendContactValidationsEmails:
    'contactsDetails: the contacts to send a validation link to, identified as ' +
    'eurodns_domain_get returns them on the domain.',

  // --- Subscriptions ------------------------------------------------------------------
  updateSubscriptionAutorenewSettings:
    'autoRenewEnabled, and when enabling it autoRenewDurationInMonths: the term each ' +
    'automatic renewal buys.',
  createPremiumDnsSubscription:
    'The order: domainName to provision, subscriptionProduct, duration with its ' +
    'durationUnit, and optionally a zoneProfileId to apply as the initial zone.',
  renewPremiumDnsSubscription: 'The renewal term: duration and its durationUnit.',
  upgradePremiumDnsSubscription:
    'subscriptionProduct: the higher Premium DNS product to move the subscription to.',
  downgradePremiumDnsSubscription:
    'subscriptionProduct: the lower Premium DNS product to move the subscription to.',
  reactivatePremiumDnsSubscription:
    'The reactivation: domainName plus the new duration and its durationUnit.',
  createHttpsRedirectSubscription:
    'The order: domainName to provision, subscriptionProduct, duration with its durationUnit.',
  renewHttpsRedirectSubscription: 'The renewal term: duration and its durationUnit.',

  // --- SSL --------------------------------------------------------------------------
  createSslSubscription:
    'The order: subscriptionProduct, the encodedCsr (PEM certificate request), the ' +
    'certificate contact, verificationMethod and verificationEmailAddress for domain ' +
    'validation, sanEntries for a multi-domain product, and organizationInfo, businessInfo, ' +
    'requestor, approver and signer for organization or extended validation.',
  renewSslSubscription:
    'The renewal: optionally a new encodedCsr (the current one is reused when omitted), the ' +
    'verificationEmailAddress for email validation, and sanEntries for a multi-domain ' +
    'certificate.',
  upgradeSslSubscriptionQuantity:
    'additionalSanQuantity and additionalSanWildcardQuantity: how many names to add. At ' +
    'least one must be positive, and the total cannot exceed 250.',
  reissueSslCertificate:
    'encodedCsr: the new PEM certificate request the certificate is reissued against, plus ' +
    'sanEntries for a multi-domain certificate.',
  updateSslValidationApprover:
    'verificationMethod, and for email validation the approver address, chosen from the ' +
    'allowed approvers eurodns_ssl_get_validation lists.',

  // --- Email ---------------------------------------------------------------------------
  updateEmailPassword:
    'password and passwordConfirmation, identical. The value is sent to the provider and ' +
    'never stored or logged here.',
};

/** The description an argument carries, or `undefined` to leave the generated schema alone. */
export function describeParameter(
  operation: GeneratedOperation,
  param: GeneratedParameter,
): string | undefined {
  return (
    PARAMETER_DESCRIPTIONS_BY_OPERATION[`${operation.operationId}.${param.name}`] ??
    PARAMETER_DESCRIPTIONS_BY_AREA[`${areaFor(operation)}.${param.name}`] ??
    PARAMETER_DESCRIPTIONS_BY_NAME[param.name] ??
    (param.description === '' ? undefined : param.description)
  );
}

/** The description the request body carries, or `undefined` to keep the schema's own. */
export function describeBody(operation: GeneratedOperation): string | undefined {
  return BODY_DESCRIPTIONS[operation.operationId];
}
