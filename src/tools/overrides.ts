import type { GeneratedOperation } from '../generated/operations.js';

/**
 * Hand-written descriptions for every operation registered as a tool of its own.
 *
 * The document's own summaries ("Get domain", "Search domains") say what an endpoint is
 * called, not what it is for or when to prefer it over its neighbour — which is exactly
 * the decision a tool description has to support. Each entry follows one shape: what the
 * tool does and returns, front-loaded; then when to reach for it, naming the neighbouring
 * tool by its exact name, and any consequence the annotations cannot carry — a charge, an
 * email sent, a document replaced whole.
 *
 * Operations a composite absorbs (`composites.ts`) are not here: the composite carries the
 * description. `tests/descriptions.test.ts` holds this map to exactly the remaining
 * operations, in both directions, so a spec refresh that adds an operation turns the build
 * red rather than shipping the vendor's summary as a description.
 */
export const DESCRIPTION_OVERRIDES: Record<string, string> = {
  // --- Account ----------------------------------------------------------------------
  getPrepaidAccountBalance:
    'Returns the prepaid balance. Check it before any operation that spends credit: an ' +
    'insufficient balance is a common cause of a rejected order.',

  // --- DNS zones ----------------------------------------------------------------------
  getDnsZone:
    'Returns a zone in full: its DNS records, URL forwards and mail forwards, each record ' +
    'with the id other tools target. Start here before changing anything; to edit one ' +
    'record use eurodns_dns_upsert_record or eurodns_dns_delete_record rather than saving ' +
    'the whole zone.',
  saveDnsZone:
    'Replaces a zone in its entirety. Anything absent from the submitted document is ' +
    'deleted, so this is only safe with a complete zone you have just read. To change one ' +
    'record, prefer eurodns_dns_upsert_record, which reads, validates and saves for you.',
  checkDnsZone:
    'Validates a candidate zone and returns a per-record report, without changing anything. ' +
    'Use it before eurodns_dns_save_zone: a rejected save returns only a generic error, ' +
    'while this returns the reason for each offending record.',
  addDnsRecords:
    'Appends records to a zone and saves immediately, without the validation step, ' +
    'returning the saved zone. Use eurodns_dns_upsert_record instead when you want the ' +
    'change validated first, or when the record may already exist and should be updated ' +
    'rather than duplicated.',
  getDnssecStatus:
    'Reports whether the zone is DNSSEC-signed and returns its keys and DS data. Check it ' +
    'before eurodns_dns_set_dnssec or eurodns_domain_set_dnssec, and again after changing ' +
    'nameservers.',
  deleteZoneProfile:
    'Deletes a zone profile permanently and returns nothing on success. There is no ' +
    'snapshot to restore a template from, so confirm the id and contents with ' +
    'eurodns_dns_get_zone_profile first; to change a profile rather than remove it, use ' +
    'eurodns_dns_save_zone_profile.',
  checkZoneProfile:
    'Validates a candidate zone profile and returns a per-record report, without saving ' +
    'anything. Use it before eurodns_dns_save_zone_profile, whose rejections carry only a ' +
    'generic error; it checks a template, where eurodns_dns_check_zone checks a live zone.',

  // --- Domains --------------------------------------------------------------------
  getDomain:
    'Returns one domain already registered in this account: its status, expiry, renewal ' +
    'method, contacts and nameservers. Use it for a domain you hold; to learn whether a ' +
    'name can be registered use eurodns_domain_check_availability, and to find domains by ' +
    'criteria eurodns_domain_search.',
  searchDomains:
    'Searches the domains held in this account, with filters for expiry, renewability and ' +
    'DNSSEC, and returns one summary per domain. This is the inventory query — it never ' +
    'reports on domains held elsewhere; eurodns_domain_get returns one domain in full.',
  getAvailabilities:
    'Checks whether domain names are available to register and returns the availability of ' +
    'each. This queries the registries, so it works for any name, registered here or not; ' +
    'for a domain already in the account, eurodns_domain_get has the details.',

  // --- Profiles ---------------------------------------------------------------------
  deleteContactProfile:
    'Deletes a contact profile permanently and returns nothing on success. Domains already ' +
    'using it keep their registered contact data, but the profile can no longer be reused; ' +
    'confirm which one with eurodns_contact_get_profile first.',
  setAsDefaultContactProfile:
    'Makes a contact profile the default for the given contact roles — registrant, admin, ' +
    'technical or billing — and returns the roles now applied. This affects future orders, ' +
    'not domains already registered; find the profile with eurodns_contact_get_profile.',
  resendContactValidationsEmails:
    'Sends the contacts of a domain a new email carrying their validation link, and returns ' +
    'the validation state of each. Use it when a contact validation is pending or expiring ' +
    'soon, which eurodns_domain_search can filter on.',
  deleteNameserverProfile:
    'Deletes a nameserver profile permanently and returns nothing on success. Only a ' +
    'profile no domain uses can be deleted: eurodns_nameserver_get_profile marks those as ' +
    'deletable, so check it first.',

  // --- Email ---------------------------------------------------------------------------
  deleteEmailSubscription:
    'Requests the deletion of an email subscription and the mailbox behind it, which cannot ' +
    'be undone from here. Confirm the subscription with eurodns_email_get_subscription ' +
    'first; to keep it until term but stop it renewing, use ' +
    'eurodns_subscription_update_autorenew_settings instead.',
  updateEmailPassword:
    'Sets a new password on the mailbox of an email subscription and returns the updated ' +
    'subscription. The value is written straight through to the provider and never recorded ' +
    'here; find the subscription with eurodns_email_get_subscription.',

  // --- Subscriptions ------------------------------------------------------------------
  getSubscriptions:
    'Searches every subscription on the account regardless of product — SSL, email, Premium ' +
    'DNS, Microsoft, HTTPS redirect — with its status, expiry and auto-renewal setting. ' +
    'Start here for an expiry review; once you know the product, ' +
    'eurodns_ssl_get_subscription and its siblings return the full record.',
  updateSubscriptionAutorenewSettings:
    'Turns automatic renewal on or off for any subscription and sets the term each renewal ' +
    'buys. This changes what will be charged in future, not the current term; find the ' +
    'subscription id with eurodns_subscription_search.',

  // --- Premium DNS ----------------------------------------------------------------------
  deletePremiumDnsSubscription:
    'Schedules a Premium DNS subscription for deletion and returns it with its new status. ' +
    'Check it with eurodns_premium_dns_get_subscription first; to keep the service until ' +
    'term but stop renewals, use eurodns_subscription_update_autorenew_settings instead.',
  createPremiumDnsSubscription:
    'Orders a Premium DNS subscription for a domain, optionally applying a zone profile as ' +
    'its initial zone, and returns the new subscription. This creates an order and debits ' +
    'prepaid credit: check eurodns_account_get_prepaid_balance first, and pick the profile ' +
    'with eurodns_dns_get_zone_profile.',
  renewPremiumDnsSubscription:
    'Orders the renewal of a Premium DNS subscription for a further term and returns the ' +
    'updated subscription. This debits prepaid credit; to renew automatically instead, set ' +
    'it up with eurodns_subscription_update_autorenew_settings.',
  upgradePremiumDnsSubscription:
    'Moves a Premium DNS subscription to a higher product and returns the updated ' +
    'subscription. This creates an order for the difference; the reverse is ' +
    'eurodns_premium_dns_downgrade_subscription, and the current product is in ' +
    'eurodns_premium_dns_get_subscription.',
  downgradePremiumDnsSubscription:
    'Moves a Premium DNS subscription to a lower product and returns the updated ' +
    'subscription, which reads PENDING_DOWNGRADE_PRODUCT until the change applies. The ' +
    'reverse is eurodns_premium_dns_upgrade_subscription; check the current product with ' +
    'eurodns_premium_dns_get_subscription first.',
  reactivatePremiumDnsSubscription:
    'Orders the reactivation of a lapsed Premium DNS subscription for a new term and returns ' +
    'it. This debits prepaid credit; use it for a subscription ' +
    'eurodns_premium_dns_get_subscription shows as TO_RESTORE, and ' +
    'eurodns_premium_dns_create_subscription for a domain that never had one.',

  // --- SSL --------------------------------------------------------------------------
  getSslCertificate:
    'Returns one certificate of an SSL subscription: its common name, SANs, validity dates ' +
    'and issuance status. Both ids come from eurodns_ssl_get_subscription; to see how a ' +
    'name is being validated, use eurodns_ssl_get_validation.',
  createSslSubscription:
    'Orders a new SSL certificate and returns the subscription created for it. This spends ' +
    'prepaid credit and starts a domain validation the approver must complete before ' +
    'issuance: check eurodns_account_get_prepaid_balance first, then follow the validation ' +
    'with eurodns_ssl_get_validation.',
  renewSslSubscription:
    'Orders the renewal of an SSL subscription for a further term and returns the updated ' +
    'subscription. This debits prepaid credit and starts a fresh validation; to replace the ' +
    'certificate without extending the term, eurodns_ssl_reissue_certificate makes no charge.',
  upgradeSslSubscriptionQuantity:
    'Adds SAN slots to a multi-domain SSL subscription and returns the updated subscription. ' +
    'This creates an order for the extra names, up to 250 in total, and only applies to ' +
    'multi-domain products; eurodns_ssl_get_subscription shows which product you hold.',
  reissueSslCertificate:
    'Reissues an existing certificate against a new CSR, for example after a key rotation, ' +
    'and returns the new certificate. The subscription term is unchanged and no charge is ' +
    'made; to extend the term instead, use eurodns_ssl_renew_subscription.',
  getSslValidation:
    'Returns how one certificate name is being validated — method, approver, token — and ' +
    'where it currently stands. Check it when an ordered certificate has not been issued; ' +
    'change the method or approver with eurodns_ssl_update_validation_approver, or resend ' +
    'the email with eurodns_ssl_resend_approver_email.',
  updateSslValidationApprover:
    'Changes the validation method or approver address for one certificate name and returns ' +
    'the updated validation. Use it when the current approver cannot receive the email; the ' +
    'allowed approvers are listed by eurodns_ssl_get_validation.',
  resendSslApproverEmail:
    'Sends the validation email for one certificate name to its approver again, and returns ' +
    'nothing on success. Use it when the approver did not receive it; if the address itself ' +
    'is wrong, change it first with eurodns_ssl_update_validation_approver.',
  cancelSslCertificate:
    'Abandons a certificate order that is still being validated. The order will not ' +
    'complete and the certificate will never be issued; for a certificate already issued, ' +
    'use eurodns_ssl_revoke_certificate instead.',
  cancelSslSan:
    'Removes one name from a certificate whose validation is pending, and returns the ' +
    'certificate without it. Use it when a single name cannot be validated and the rest ' +
    'should proceed; to abandon the whole order, use eurodns_ssl_cancel_certificate.',
  revokeSslCertificate:
    'Revokes an issued certificate permanently. It cannot be un-revoked, and any service ' +
    'still presenting it will fail for clients that check revocation; for an order not yet ' +
    'issued, use eurodns_ssl_cancel_certificate instead.',

  // --- HTTPS redirect ---------------------------------------------------------------
  createHttpsRedirectSubscription:
    'Orders an HTTPS redirect subscription for a domain and returns the new subscription. ' +
    'This creates an order and debits prepaid credit: check ' +
    'eurodns_account_get_prepaid_balance first, and read the result back with ' +
    'eurodns_https_redirect_get_subscription.',
  getHttpsRedirectSubscription:
    'Returns one HTTPS redirect subscription by id: its status, domain and term. There is ' +
    'no listing of these on their own; find the id with eurodns_subscription_search ' +
    'filtered on HTTPS_REDIRECT.',
  deleteHttpsRedirectSubscription:
    'Schedules an HTTPS redirect subscription for deletion. Check it with ' +
    'eurodns_https_redirect_get_subscription first; to keep the redirect until term but ' +
    'stop renewals, use eurodns_subscription_update_autorenew_settings instead.',
  renewHttpsRedirectSubscription:
    'Orders the renewal of an HTTPS redirect subscription for a further term. This debits ' +
    'prepaid credit; to renew automatically instead, set it up with ' +
    'eurodns_subscription_update_autorenew_settings.',
};

/**
 * Titles the document words badly.
 *
 * The summary is a fine title for most operations ("Search domains", "Revoke an SSL
 * certificate"). These are the ones a reader trips on: a gerund, a trailing period, a
 * lower-case brand, "a HTTPS". Everything else keeps the document's summary.
 */
export const TITLE_OVERRIDES: Record<string, string> = {
  getPrepaidAccountBalance: 'Get the prepaid account balance',
  getDnsZone: 'Get a DNS zone',
  saveDnsZone: 'Save a DNS zone',
  checkDnsZone: 'Validate a DNS zone',
  getDnssecStatus: 'Get the DNSSEC status of a zone',
  deleteZoneProfile: 'Delete a DNS zone profile',
  checkZoneProfile: 'Validate a DNS zone profile',
  getDomain: 'Get a domain',
  getAvailabilities: 'Check domain availability',
  setAsDefaultContactProfile: 'Set a contact profile as default',
  getSubscriptions: 'Search subscriptions across products',
  getSslValidation: 'Get the validation of a certificate name',
  updateSslValidationApprover: 'Update the validation approver of a certificate name',
  createHttpsRedirectSubscription: 'Create an HTTPS redirect subscription',
  getHttpsRedirectSubscription: 'Get an HTTPS redirect subscription',
  deleteHttpsRedirectSubscription: 'Delete an HTTPS redirect subscription',
  renewHttpsRedirectSubscription: 'Renew an HTTPS redirect subscription',
};

/** The title a generated tool carries: curated where the summary reads badly, else the summary. */
export function titleFor(operation: GeneratedOperation): string {
  return TITLE_OVERRIDES[operation.operationId] ?? (operation.summary || operation.operationId);
}

/**
 * Strips the light HTML the document uses inside descriptions.
 *
 * Two things changed from the catch-all `<[^>]+>` this replaces, and both were verified
 * against the vendored document rather than assumed.
 *
 * **A tag must start with a letter.** The catch-all treated any span between two angle
 * brackets as a tag, so "values < 500 and count > 0" came out as "values 0" — silently. The
 * document contains no such text today (checked: all 762 summary and description fields, and
 * `<br>` is the only markup in any of them), but the failure mode is invisible and the guard
 * costs one character class.
 *
 * **The strip repeats until the text stops changing.** `[^<>]*` cannot cross a `<`, so on
 * `<scr<a>ipt>` the inner `<a>` matches, and removing it joins the halves either side into a
 * real `<script>` that a single pass would hand back intact. The loop ends when a pass
 * changes nothing, which is at most once more than the nesting depth.
 *
 * This is still not a sanitizer and must not be reused as one: the input is
 * `spec/openapi.json`, vendored here and read at build time, and the output is plain text in
 * a tool description, never markup rendered anywhere. Against genuinely hostile input the
 * answer is a parser.
 */
export function stripMarkup(value: string): string {
  let text = value.replace(/<br\s*\/?>/gi, ' ');

  let previous: string;
  do {
    previous = text;
    text = text.replace(/<\/?[a-zA-Z][^<>]*>/g, '');
  } while (text !== previous);

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The document's own text for an operation, as a description of last resort.
 *
 * Every registered operation has an override, and a test holds it to that, so at runtime
 * this branch is only reached after a spec refresh added an operation nobody has described
 * yet. It exists so that such a refresh degrades the one new tool rather than stopping the
 * server: the test is what turns it red.
 */
export function documentDescription(operation: GeneratedOperation): string {
  const summary = stripMarkup(operation.summary);
  const description = stripMarkup(operation.description);

  if (summary && description) {
    return description.startsWith(summary) ? description : `${summary}. ${description}`;
  }
  return description || summary || operation.operationId;
}

export function describeOperation(operation: GeneratedOperation): string {
  return DESCRIPTION_OVERRIDES[operation.operationId] ?? documentDescription(operation);
}
