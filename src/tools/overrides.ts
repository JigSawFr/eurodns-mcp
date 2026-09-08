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
    'Returns the account’s prepaid balance and its currency, the credit that orders and ' +
    'renewals are debited from. Read it before any tool described as debiting credit: an ' +
    'insufficient balance is the usual reason an order is refused, and the refusal does not ' +
    'say so. It takes no arguments and changes nothing; for what has already been billed ' +
    'use eurodns_invoice_get instead.',

  // --- DNS zones ----------------------------------------------------------------------
  getDnsZone:
    'Returns the live zone of domainName in full: every DNS record with its id, type, host, ' +
    'rdata and ttl, plus the URL forwards and mail forwards. Read it before any change, and ' +
    'to find the recordId that eurodns_dns_delete_record takes. To change one record use ' +
    'eurodns_dns_upsert_record rather than editing this document and saving it back with ' +
    'eurodns_dns_save_zone, which replaces the whole zone. A domain whose DNS is not hosted ' +
    'here answers 404.',
  saveDnsZone:
    'Replaces the entire zone of domainName with body and returns the saved zone. Every ' +
    'record, URL forward and mail forward absent from body is deleted, so it is only safe ' +
    'with a complete document just read from eurodns_dns_get_zone; to change one record use ' +
    'eurodns_dns_upsert_record instead, which validates and keeps the rest. Run ' +
    'eurodns_dns_check_zone first: a rejected save answers a generic 400, while the check ' +
    'names the offending record. Record values go in rdata, never in data.',
  checkDnsZone:
    'Validates the candidate zone in body against the API’s rules for domainName and ' +
    'returns it with a per-record report of errors, without saving anything. Use it before ' +
    'eurodns_dns_save_zone, whose rejection is a bare 400. It does not preview what a ' +
    'change would alter, which is what eurodns_dns_diff_zone reports. The body must be the ' +
    'complete zone — records, urlForwards and mailForwards — with values in rdata.',
  getDnssecStatus:
    'Returns whether the zone of domainName is DNSSEC-signed, with its keys and the DS data ' +
    'a registry needs to publish. Read it before and after eurodns_domain_set_dnssec, and ' +
    'again after moving nameservers, to confirm the zone and the registry agree. It reports ' +
    'the zone hosted here only: what the registry actually publishes is not read, so a ' +
    'domain registered elsewhere needs its registrar checked separately rather than trusted ' +
    'from this answer.',
  deleteZoneProfile:
    'Deletes the zone profile with that id permanently and returns nothing on success. A ' +
    'profile is a template for new zones, so zones already created from it keep their ' +
    'records; there is no snapshot to restore a template from, so confirm the id and ' +
    'contents with eurodns_dns_get_zone_profile first. To change a profile rather than ' +
    'remove it, use eurodns_dns_save_zone_profile instead.',
  checkZoneProfile:
    'Validates the candidate zone profile in body — name, records, urlForwards and ' +
    'mailForwards — and returns it with a per-record report, without saving. Use it before ' +
    'eurodns_dns_save_zone_profile, whose rejection is a bare 400. It checks a template, ' +
    'not a live zone: for a zone use eurodns_dns_check_zone instead.',

  // --- Domains --------------------------------------------------------------------
  getAvailabilities:
    'Checks whether the domain names listed in body.domainNames can be registered and ' +
    'returns the availability of each, as the registries answer it. Use it for names you do ' +
    'not hold, whoever holds them; for a domain already in this account use ' +
    'eurodns_domain_get instead, which returns the full record. It reads only and reserves ' +
    'nothing, and a name marked available still has to be ordered elsewhere: this server ' +
    'does not register domains.',

  // --- Profiles ---------------------------------------------------------------------
  deleteContactProfile:
    'Deletes the contact profile with that id permanently and returns nothing on success. ' +
    'Domains registered with it keep their contact data at the registry; only the reusable ' +
    'profile disappears, and it cannot be restored. Confirm the id with ' +
    'eurodns_contact_get_profile first; to change a profile rather than remove it, use ' +
    'eurodns_contact_save_profile instead.',
  setAsDefaultContactProfile:
    'Makes the contact profile with that id the default for the roles set true in body — ' +
    'org (registrant), admin, tech and billing — and returns the roles now applied. Future ' +
    'orders pick the default; domains already registered are not touched. Find the id with ' +
    'eurodns_contact_get_profile; to edit the profile’s own fields use ' +
    'eurodns_contact_save_profile instead.',
  resendContactValidationsEmails:
    'Sends each contact named in body.contactsDetails a new email carrying its validation ' +
    'link, and returns the validation state of each. Use it when a registrant validation is ' +
    'pending or about to expire; do not use it as a check, since every call sends mail. The ' +
    'contacts are identified as eurodns_domain_get returns them on the domain.',
  deleteNameserverProfile:
    'Deletes the nameserver profile with that id permanently and returns nothing on ' +
    'success. Only a profile no domain points at can be deleted, and the API refuses the ' +
    'others: eurodns_nameserver_get_profile marks the deletable ones, so read it first. To ' +
    'change the nameservers rather than remove the profile, use ' +
    'eurodns_nameserver_save_profile instead.',

  // --- Email ---------------------------------------------------------------------------
  deleteEmailSubscription:
    'Requests the deletion of the email subscription with that id, with the mailbox and ' +
    'aliases behind it, and returns the subscription with its new status. Mail is lost, and ' +
    'the deletion cannot be undone from here. Confirm the id with eurodns_subscription_get ' +
    'for product email first; to keep the mailbox until term but stop renewing it, use ' +
    'eurodns_subscription_update_autorenew_settings instead.',
  updateEmailPassword:
    'Sets a new password on the mailbox of the email subscription with that id, from ' +
    'body.password and body.passwordConfirmation, and returns the updated subscription. The ' +
    'value is written straight through to the provider and is neither stored nor logged ' +
    'here. Find the id with eurodns_subscription_get for product email; to change addresses ' +
    'rather than the password use eurodns_email_set_alias instead.',

  // --- Subscriptions ------------------------------------------------------------------
  updateSubscriptionAutorenewSettings:
    'Turns automatic renewal on or off for the subscription subscriptionId, of any product, ' +
    'from body.autoRenewEnabled and, when enabling, body.autoRenewDurationInMonths, and ' +
    'returns the updated subscription. It changes what will be charged at the next term, ' +
    'not the current one, and nothing is billed now. Find the id with ' +
    'eurodns_subscription_get; to extend the term today use the product’s renew tool ' +
    'instead.',

  // --- Premium DNS ----------------------------------------------------------------------
  deletePremiumDnsSubscription:
    'Schedules the Premium DNS subscription subscriptionId for deletion and returns it with ' +
    'its new status; the zone it serves stops being hosted at the end of the process, which ' +
    'cannot be undone from here. Confirm the id with eurodns_subscription_get for product ' +
    'premium_dns first. To keep the service until term but stop renewals, use ' +
    'eurodns_subscription_update_autorenew_settings instead.',
  createPremiumDnsSubscription:
    'Orders a Premium DNS subscription for body.domainName, with body.subscriptionProduct ' +
    'and a duration, and returns the new subscription. It creates an order and debits ' +
    'prepaid credit at once: read eurodns_account_get_prepaid_balance first, since an ' +
    'insufficient balance refuses the order. Give body.zoneProfileId, from ' +
    'eurodns_dns_get_zone_profile, to start from a template; for a lapsed subscription use ' +
    'eurodns_premium_dns_reactivate_subscription instead.',
  renewPremiumDnsSubscription:
    'Orders the renewal of the Premium DNS subscription subscriptionId for the further term ' +
    'in body.duration and body.durationUnit, and returns the updated subscription. It ' +
    'debits prepaid credit immediately and cannot be reversed here. Use it for a one-off ' +
    'extension; to have the service renew itself, set ' +
    'eurodns_subscription_update_autorenew_settings instead.',
  upgradePremiumDnsSubscription:
    'Moves the Premium DNS subscription subscriptionId to the higher ' +
    'body.subscriptionProduct and returns the updated subscription. It creates an order for ' +
    'the price difference and debits prepaid credit now. Check the current product with ' +
    'eurodns_subscription_get for product premium_dns first; to move down instead, use ' +
    'eurodns_premium_dns_downgrade_subscription.',
  downgradePremiumDnsSubscription:
    'Moves the Premium DNS subscription subscriptionId to the lower ' +
    'body.subscriptionProduct and returns the updated subscription, whose status reads ' +
    'PENDING_DOWNGRADE_PRODUCT until the change applies at the next term. Nothing is ' +
    'refunded and no credit is debited. Check the current product with ' +
    'eurodns_subscription_get for product premium_dns first; to move up instead, use ' +
    'eurodns_premium_dns_upgrade_subscription.',
  reactivatePremiumDnsSubscription:
    'Orders the reactivation of a lapsed Premium DNS subscription for body.domainName, for ' +
    'the new term in body.duration and body.durationUnit, and returns it. It debits prepaid ' +
    'credit immediately. Use it only when eurodns_subscription_get shows the subscription ' +
    'as TO_RESTORE; for a domain that never had one, use ' +
    'eurodns_premium_dns_create_subscription instead.',

  // --- SSL --------------------------------------------------------------------------
  getSslCertificate:
    'Returns one certificate of the SSL subscription subscriptionId by certificateId: ' +
    'common name, SANs, validity dates, issuance status and the certificate itself once ' +
    'issued. Both ids come from eurodns_subscription_get for product ssl, which lists the ' +
    'certificates of a subscription. It does not say how a pending name is being validated: ' +
    'for that use eurodns_ssl_get_validation instead.',
  createSslSubscription:
    'Orders a new SSL certificate from body — subscriptionProduct, encodedCsr, contacts, ' +
    'verificationMethod and verificationEmailAddress, sanEntries for a multi-domain product ' +
    '— and returns the subscription created for it. It debits prepaid credit at once and ' +
    'starts a domain validation the approver must complete before anything is issued. Read ' +
    'eurodns_account_get_prepaid_balance first, then follow the validation with ' +
    'eurodns_ssl_get_validation; to renew an existing subscription use ' +
    'eurodns_ssl_renew_subscription instead.',
  renewSslSubscription:
    'Orders the renewal of the SSL subscription subscriptionId for a further term, against ' +
    'a new body.encodedCsr or the current one when omitted, and returns the updated ' +
    'subscription. It debits prepaid credit and starts a fresh validation the approver must ' +
    'complete. To replace the certificate without extending the term, use ' +
    'eurodns_ssl_reissue_certificate instead, which makes no charge.',
  upgradeSslSubscriptionQuantity:
    'Adds SAN slots to the multi-domain SSL subscription subscriptionId — ' +
    'body.additionalSanQuantity and body.additionalSanWildcardQuantity, up to 250 names in ' +
    'total — and returns the updated subscription. It creates an order for the extra names ' +
    'and debits prepaid credit. It only applies to multi-domain products: ' +
    'eurodns_subscription_get for product ssl shows which product you hold, and a ' +
    'single-name certificate is refused rather than upgraded.',
  reissueSslCertificate:
    'Reissues certificate certificateId of the SSL subscription subscriptionId against the ' +
    'new body.encodedCsr, for example after a key rotation, and returns the new ' +
    'certificate. No charge is made and the term does not move: extending it is a separate, ' +
    'paid renewal rather than a reissue. Names added in body.sanEntries go through ' +
    'validation again, which eurodns_ssl_get_validation follows; both ids come from ' +
    'eurodns_subscription_get for product ssl.',
  getSslValidation:
    'Returns how the name sanName of certificate certificateId, in SSL subscription ' +
    'subscriptionId, is being validated — method, approver address, token or record to ' +
    'publish — and where it stands. Read it when an ordered certificate has not been ' +
    'issued; it also lists the approver addresses the authority accepts. To change the ' +
    'method or approver use eurodns_ssl_update_validation_approver, and to send the email ' +
    'again use eurodns_ssl_resend_approver_email rather than this call, which sends ' +
    'nothing.',
  updateSslValidationApprover:
    'Changes the validation method or approver address for the name sanName of certificate ' +
    'certificateId, in SSL subscription subscriptionId, from body.verificationMethod and ' +
    'the approver it names, and returns the updated validation. Use it when the current ' +
    'approver cannot receive the email; only the addresses eurodns_ssl_get_validation lists ' +
    'are accepted, any other is refused. If the address is right and only the mail was ' +
    'lost, use eurodns_ssl_resend_approver_email instead.',
  resendSslApproverEmail:
    'Sends the validation email for the name sanName of certificate certificateId, in SSL ' +
    'subscription subscriptionId, to its approver again, and returns nothing on success. ' +
    'Use it when the approver did not receive the first mail; every call sends another, so ' +
    'do not use it to check the state, which eurodns_ssl_get_validation returns. If the ' +
    'address itself is wrong, change it first with eurodns_ssl_update_validation_approver.',
  cancelSslCertificate:
    'Abandons the order for certificate certificateId of SSL subscription subscriptionId ' +
    'while it is still being validated, and returns nothing on success. The certificate is ' +
    'never issued and the order cannot be resumed; the credit spent is not refunded here. ' +
    'Use it only for an order still pending in eurodns_ssl_get_validation; for a ' +
    'certificate already issued use eurodns_ssl_revoke_certificate instead.',
  cancelSslSan:
    'Removes the name sanName from certificate certificateId of SSL subscription ' +
    'subscriptionId while its validation is pending, and returns the certificate without ' +
    'it. The other names proceed; the removed one cannot be added back to this order. Use ' +
    'it when one name cannot be validated and the rest should be issued; to abandon the ' +
    'whole order use eurodns_ssl_cancel_certificate instead.',
  revokeSslCertificate:
    'Revokes the issued certificate certificateId of SSL subscription subscriptionId ' +
    'permanently and returns nothing on success. It cannot be undone: every service still ' +
    'presenting the certificate fails for clients that check revocation, so deploy a ' +
    'replacement first. Use it only for a compromised or retired certificate; for an order ' +
    'not yet issued use eurodns_ssl_cancel_certificate instead, and to rotate a key without ' +
    'revoking use eurodns_ssl_reissue_certificate.',

  // --- HTTPS redirect ---------------------------------------------------------------
  createHttpsRedirectSubscription:
    'Orders an HTTPS redirect subscription for body.domainName, with ' +
    'body.subscriptionProduct and a duration, and returns the new subscription. It creates ' +
    'an order and debits prepaid credit at once: read eurodns_account_get_prepaid_balance ' +
    'first. Read the result back with eurodns_subscription_get for product https_redirect; ' +
    'to extend an existing one use eurodns_https_redirect_renew_subscription instead.',
  deleteHttpsRedirectSubscription:
    'Schedules the HTTPS redirect subscription subscriptionId for deletion and returns it ' +
    'with its new status; the redirect stops at the end of the process, which cannot be ' +
    'undone here. Confirm the id with eurodns_subscription_get for product https_redirect ' +
    'first. To keep the redirect until term but stop renewals, use ' +
    'eurodns_subscription_update_autorenew_settings instead.',
  renewHttpsRedirectSubscription:
    'Orders the renewal of the HTTPS redirect subscription subscriptionId for the further ' +
    'term in body.duration and body.durationUnit, and returns the updated subscription. It ' +
    'debits prepaid credit immediately. Use it for a one-off extension; to have the service ' +
    'renew itself, set eurodns_subscription_update_autorenew_settings instead.',
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
  getAvailabilities: 'Check domain availability',
  setAsDefaultContactProfile: 'Set a contact profile as default',
  getSslValidation: 'Get the validation of a certificate name',
  updateSslValidationApprover: 'Update the validation approver of a certificate name',
  createHttpsRedirectSubscription: 'Create an HTTPS redirect subscription',
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
