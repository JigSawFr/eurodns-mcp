import { z, type ZodRawShape } from 'zod';
import { OPERATIONS, type GeneratedOperation } from '../generated/operations.js';
import type { RiskClass } from '../constants.js';
import { paginationShape, parameterShape, toCamelCase, type MutableShape } from './shapes.js';

/**
 * Tools that stand in for two generated operations.
 *
 * The document exposes its collections as pairs — `GET /invoices` and `GET /invoices/{id}`,
 * `POST /contact-profiles` and `PUT /contact-profiles/{id}`, `/sign` and `/unsign` — and a
 * tool per endpoint gave the model sixty-four tools, half of them the other half's twin. An
 * agent choosing between `eurodns_invoice_list` and `eurodns_invoice_get` is not making a
 * decision, it is spelling one: whether it holds an id. So the pair becomes one tool whose
 * arguments carry the decision — `id` present or absent, `enabled` true or false — and the
 * routing here picks the operation.
 *
 * Two rules keep this honest. **Both members share a risk class**, so that hiding a class,
 * gating a scope and asking for confirmation stay decisions about a tool rather than about
 * one of its branches; a test asserts it. And **the composite's audit line names the
 * composite**, because that is what the caller invoked — the operation it resolved to is a
 * detail of this file, not of the history.
 *
 * Everything past the routing is the generated tool's own path: `executeOperation` in the
 * registry runs the member exactly as it would have run the standalone tool.
 */

export interface CompositeAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Which member runs, and with which arguments — already in the member's own names. */
export interface CompositeRoute {
  operationId: string;
  args: Record<string, unknown>;
}

export interface CompositeTool {
  name: string;
  title: string;
  description: string;
  risk: RiskClass;
  /** The operation ids this tool stands in for. Neither is registered on its own. */
  members: readonly [string, string];
  inputSchema: z.ZodObject<ZodRawShape>;
  annotations: CompositeAnnotations;
  route(args: Record<string, unknown>): CompositeRoute;
}

const BY_ID = new Map(OPERATIONS.map((operation) => [operation.operationId, operation]));

/**
 * A member operation, by id.
 *
 * Throws at module load rather than returning undefined: a composite naming an operation the
 * document no longer has is a build that must not ship, and the message says which one.
 */
export function memberOperation(operationId: string): GeneratedOperation {
  const operation = BY_ID.get(operationId);
  if (!operation) {
    throw new Error(
      `composites.ts names an operation the document does not define: ${operationId}`,
    );
  }
  return operation;
}

const READ: CompositeAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/* ------------------------------------------------------------------- list or get */

interface ListOrGetSpec {
  name: string;
  title: string;
  description: string;
  list: string;
  get: string;
  /** Raw name of the `get` member's id path parameter: `id`, `cip-id`, `subscription-id`. */
  idParam: string;
  /** What the shared `id` argument identifies, and what omitting it does. */
  idDescription: string;
}

/**
 * `GET /things` and `GET /things/{id}` as one tool: `id` present fetches one, absent lists.
 *
 * The listing's own filters and pagination stay as they were; the id is renamed to `id` for
 * every pair so a caller never has to know that invoice profiles call theirs `cip-id`. Path
 * parameters the two members share (the zone name, for snapshots) pass through to both.
 */
function listOrGet(spec: ListOrGetSpec): CompositeTool {
  const list = memberOperation(spec.list);
  const get = memberOperation(spec.get);

  const shape: MutableShape = {
    ...parameterShape(list, list.pathParams),
    id: z.number().int().optional().describe(spec.idDescription),
    ...parameterShape(list, list.queryParams),
    ...(list.paginated ? paginationShape : {}),
  };

  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    risk: 'read',
    members: [spec.list, spec.get],
    inputSchema: z.object(shape),
    annotations: READ,
    route(args) {
      const { id, ...rest } = args;
      if (id === undefined) return { operationId: spec.list, args: rest };

      const forGet: Record<string, unknown> = {};
      for (const param of get.pathParams) {
        const key = toCamelCase(param.name);
        forGet[key] = param.name === spec.idParam ? id : args[key];
      }
      return { operationId: spec.get, args: forGet };
    },
  };
}

/* --------------------------------------------------------------- create or update */

interface CreateOrUpdateSpec {
  name: string;
  title: string;
  description: string;
  create: string;
  update: string;
  idDescription: string;
  bodyDescription: string;
}

/**
 * `POST /things` and `PUT /things/{id}` as one tool: `id` present replaces, absent creates.
 *
 * Both members take the same document in the same schema, which is what makes the merge
 * safe; the description carries the one thing the schema cannot — that the PUT is a
 * replacement, so an update must send every field.
 */
function createOrUpdate(spec: CreateOrUpdateSpec): CompositeTool {
  const create = memberOperation(spec.create);
  const update = memberOperation(spec.update);
  // Every pair below is `POST /things` with a body and `PUT /things/{id}` with the same
  // body: the assertions state that shape, and `tests/composites.test.ts` checks it against
  // the document for each member rather than leaving a branch here that no build reaches.
  const idKey = toCamelCase(update.pathParams[0]!.name);

  const shape: MutableShape = {
    id: z.number().int().optional().describe(spec.idDescription),
    ...parameterShape(create, create.queryParams),
    body: create.body!.schema.describe(spec.bodyDescription),
  };

  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    risk: 'write',
    members: [spec.create, spec.update],
    inputSchema: z.object(shape),
    // Creating is not idempotent — the same document twice is two profiles — and the tool
    // is annotated for its least safe branch.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    route(args) {
      const { id, ...rest } = args;
      return id === undefined
        ? { operationId: spec.create, args: rest }
        : { operationId: spec.update, args: { ...rest, [idKey]: id } };
    },
  };
}

/* -------------------------------------------------------------------------- switch */

interface SwitchSpec {
  name: string;
  title: string;
  description: string;
  on: string;
  off: string;
  /** The argument that chooses the member, its schema, and how to read it as on/off. */
  choice: { key: string; schema: z.ZodTypeAny; isOn: (value: unknown) => boolean };
  annotations: CompositeAnnotations;
}

/**
 * Two operations that are one setting's two values — sign/unsign, add/remove, on/off — as
 * one tool with the setting as an argument. The members share their path parameters, which
 * pass through unchanged; only the choosing argument is consumed here.
 */
function switchBetween(spec: SwitchSpec): CompositeTool {
  const on = memberOperation(spec.on);

  const shape: MutableShape = {
    ...parameterShape(on, on.pathParams),
    [spec.choice.key]: spec.choice.schema,
  };

  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    risk: 'write',
    members: [spec.on, spec.off],
    inputSchema: z.object(shape),
    annotations: spec.annotations,
    route(args) {
      const { [spec.choice.key]: choice, ...rest } = args;
      return { operationId: spec.choice.isOn(choice) ? spec.on : spec.off, args: rest };
    },
  };
}

const enabled = (description: string) => ({
  key: 'enabled',
  schema: z.boolean().describe(description),
  isOn: (value: unknown) => value === true,
});

/* ------------------------------------------------------------------- the surface */

export const COMPOSITES: readonly CompositeTool[] = [
  // --- DNS --------------------------------------------------------------------------
  listOrGet({
    name: 'eurodns_dns_get_zone_snapshot',
    title: 'Get a zone snapshot, or list them',
    list: 'listDnsZoneSnapshots',
    get: 'getSnapShot',
    idParam: 'id',
    idDescription:
      'Numeric id of the snapshot to return. Omit it to list the snapshots of the zone, ' +
      'with their ids and dates.',
    description:
      'Returns one previous state of a zone by snapshot id, or lists the zone’s snapshots ' +
      'with their dates when id is omitted. Use it to see what a zone held before an ' +
      'unintended change; to put that state back, send its records through ' +
      'eurodns_dns_save_zone.',
  }),
  listOrGet({
    name: 'eurodns_dns_get_zone_profile',
    title: 'Get a zone profile, or list them',
    list: 'listZoneProfiles',
    get: 'getProfile',
    idParam: 'id',
    idDescription:
      'Numeric id of the profile to return in full. Omit it to list the account’s zone ' +
      'profiles, optionally filtered by name.',
    description:
      'Returns one zone profile in full — its records, URL forwards and mail forwards — by ' +
      'id, or lists the account’s profiles when id is omitted. Profiles are reusable ' +
      'templates applied to new zones; read one before eurodns_dns_save_zone_profile, which ' +
      'replaces the whole profile with what you send.',
  }),
  createOrUpdate({
    name: 'eurodns_dns_save_zone_profile',
    title: 'Create or replace a zone profile',
    create: 'createZoneProfile',
    update: 'updateUserAPiZoneProfile',
    idDescription:
      'Numeric id of the profile to replace, from eurodns_dns_get_zone_profile. Omit it to ' +
      'create a new profile.',
    bodyDescription:
      'The profile: a name plus the records, urlForwards and mailForwards the template ' +
      'applies. When replacing, send the complete profile as eurodns_dns_get_zone_profile ' +
      'returned it — anything left out is dropped. Record values go in rdata.',
    description:
      'Creates a zone profile when id is omitted, or replaces the profile with that id in ' +
      'its entirety, and returns the saved profile. Records absent from the submitted ' +
      'document are dropped, so start from eurodns_dns_get_zone_profile when updating; ' +
      'eurodns_dns_check_zone_profile validates a candidate first without saving.',
  }),
  switchBetween({
    name: 'eurodns_dns_set_dnssec',
    title: 'Enable or disable DNSSEC signing on a zone',
    on: 'signZone',
    off: 'unsignZone',
    choice: enabled('true to start signing the zone, false to stop.'),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Starts (enabled: true) or stops (enabled: false) DNSSEC signing of a zone hosted ' +
      'here, and returns nothing on success. Use it only for a domain registered elsewhere: ' +
      'for a domain registered here, eurodns_domain_set_dnssec handles the DS record at the ' +
      'registry as well. Stopping while a DS record is still published makes the domain fail ' +
      'validation until it clears; check with eurodns_dns_get_dnssec_status.',
  }),
  // --- Domains ------------------------------------------------------------------------
  switchBetween({
    name: 'eurodns_domain_set_dnssec',
    title: 'Enable or disable DNSSEC on a domain registered here',
    on: 'signDomain',
    off: 'unsignDomain',
    choice: enabled('true to publish the DS records at the registry, false to withdraw them.'),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Publishes (enabled: true) or withdraws (enabled: false) the DNSSEC DS records of a ' +
      'domain registered in this account at its registry, and returns nothing on success. ' +
      'Prefer it over eurodns_dns_set_dnssec for domains held here; withdrawing while the ' +
      'zone stays signed breaks validation for resolvers that cached the DS record. Verify ' +
      'afterwards with eurodns_dns_get_dnssec_status.',
  }),
  // --- TLDs ---------------------------------------------------------------------------
  listOrGet({
    name: 'eurodns_tld_get',
    title: 'Get a TLD, or list them',
    list: 'listTld',
    get: 'getTld',
    idParam: 'id',
    idDescription:
      'Numeric id of the TLD to return. Omit it to list the TLDs this account can order, ' +
      'optionally filtered by tldName.',
    description:
      'Returns one TLD by id with its registration terms, duration limits and ' +
      'registry-specific requirements, or lists the TLDs this account can order when id is ' +
      'omitted. Check a TLD before ordering an unfamiliar extension; the full list is large, ' +
      'so filter with tldName or page through it rather than asking for everything.',
  }),
  // --- Invoices and orders --------------------------------------------------------------
  listOrGet({
    name: 'eurodns_invoice_get',
    title: 'Get an invoice, or search them',
    list: 'getInvoices',
    get: 'getInvoice',
    idParam: 'id',
    idDescription:
      'Numeric id of the invoice to return with its lines. Omit it to search invoices with ' +
      'the filters below.',
    description:
      'Returns one invoice with its lines by id, or searches invoices by date, type, status, ' +
      'order or invoice profile when id is omitted. Use it for what was billed and whether ' +
      'it is paid; the order behind a line is in eurodns_order_get, and the billing identity ' +
      'in eurodns_invoice_profile_get.',
  }),
  listOrGet({
    name: 'eurodns_invoice_profile_get',
    title: 'Get an invoice profile, or search them',
    list: 'getCustomerInvoiceProfiles',
    get: 'getCustomerInvoiceProfile',
    idParam: 'cip-id',
    idDescription:
      'Numeric id of the invoice profile to return in full. Omit it to search the account’s ' +
      'profiles with the filters below.',
    description:
      'Returns one customer invoice profile — the billing name, address and VAT details ' +
      'invoices are issued to — by id, or searches the account’s profiles by name, company, ' +
      'country and status when id is omitted. Use it to find the id a profile is billed ' +
      'under, then pass that id as cipId to eurodns_invoice_get to list its invoices.',
  }),
  listOrGet({
    name: 'eurodns_order_get',
    title: 'Get an order, or search them',
    list: 'getOrders',
    get: 'getOrder',
    idParam: 'id',
    idDescription:
      'Numeric id of the order to return with its lines. Omit it to search orders with the ' +
      'filters below.',
    description:
      'Returns one order with its lines and their delivery status by id, or searches orders ' +
      'by status, date and description when id is omitted. Use it to find out what happened ' +
      'to a subscription that was created but never became active; the invoice raised for ' +
      'it is in eurodns_invoice_get.',
  }),
  // --- Contact profiles -----------------------------------------------------------------
  listOrGet({
    name: 'eurodns_contact_get_profile',
    title: 'Get a contact profile, or list them',
    list: 'getContactProfiles',
    get: 'getContactProfile',
    idParam: 'id',
    idDescription:
      'Numeric id of the contact profile to return in full. Omit it to list the account’s ' +
      'profiles, filtered by type and role.',
    description:
      'Returns one reusable contact profile — the registrant, admin, technical or billing ' +
      'identity attached to domains — by id, or lists the account’s profiles filtered by ' +
      'type and role when id is omitted. Read a profile before eurodns_contact_save_profile, ' +
      'which needs every field; eurodns_contact_set_as_default_profile chooses which one ' +
      'future orders use.',
  }),
  createOrUpdate({
    name: 'eurodns_contact_save_profile',
    title: 'Create or update a contact profile',
    create: 'createContactProfile',
    update: 'updateContactProfile',
    idDescription:
      'Numeric id of the profile to update, from eurodns_contact_get_profile. Omit it to ' +
      'create a new profile.',
    bodyDescription:
      'The profile: contactType, profileName, the person or company name, postal address, ' +
      'countryCode, email and phone, and the isOrg, isAdmin, isTech and isBilling roles it ' +
      'may fill. When updating, send every field, changed or not: the API clears anything ' +
      'omitted.',
    description:
      'Creates a contact profile when id is omitted, or updates the profile with that id, ' +
      'and returns the saved profile. An update must carry every field, changed or not, ' +
      'because the API clears anything omitted: start from eurodns_contact_get_profile. ' +
      'Domains already registered keep their contacts; this changes what future orders use.',
  }),
  // --- Nameserver profiles --------------------------------------------------------------
  listOrGet({
    name: 'eurodns_nameserver_get_profile',
    title: 'Get a nameserver profile, or list them',
    list: 'getNameserverProfiles',
    get: 'getNameserverProfile',
    idParam: 'id',
    idDescription:
      'Numeric id of the nameserver profile to return. Omit it to list the account’s ' +
      'profiles with the filters below.',
    description:
      'Returns one reusable nameserver set by id, or lists the account’s nameserver ' +
      'profiles when id is omitted, with the default and deletable ones marked. Use it to ' +
      'find the profile a domain should point at; eurodns_nameserver_save_profile creates ' +
      'or rewrites one.',
  }),
  createOrUpdate({
    name: 'eurodns_nameserver_save_profile',
    title: 'Create or update a nameserver profile',
    create: 'createNameserverProfile',
    update: 'updateNameserverProfile',
    idDescription:
      'Numeric id of the profile to update, from eurodns_nameserver_get_profile. Omit it to ' +
      'create a new profile.',
    bodyDescription:
      'The profile: a name and its nameservers, each with an fqdn and, for glue records, ' +
      'ipV4Address and ipV6Address. When updating, send every field and every nameserver ' +
      'you keep: the API clears anything omitted.',
    description:
      'Creates a nameserver profile when id is omitted, or updates the profile with that ' +
      'id, and returns the saved profile. An update must carry every field, including the ' +
      'nameservers you keep, because the API clears anything omitted: start from ' +
      'eurodns_nameserver_get_profile.',
  }),
  // --- Email ----------------------------------------------------------------------------
  listOrGet({
    name: 'eurodns_email_get_subscription',
    title: 'Get an email subscription, or search them',
    list: 'getEmailSubscriptions',
    get: 'getEmailSubscription',
    idParam: 'id',
    idDescription:
      'Numeric id of the email subscription to return. Omit it to search the account’s ' +
      'email subscriptions with the filters below.',
    description:
      'Returns one email subscription — the mailbox, its aliases and catch-all state — by ' +
      'id, or searches the account’s email subscriptions by status, domain and user name ' +
      'when id is omitted. Its id is what eurodns_email_set_alias, ' +
      'eurodns_email_set_catchall and eurodns_email_update_password take; every product at ' +
      'once is eurodns_subscription_search.',
  }),
  switchBetween({
    name: 'eurodns_email_set_alias',
    title: 'Add or remove a mailbox alias',
    on: 'createAlias',
    off: 'deleteAlias',
    choice: {
      key: 'action',
      schema: z.enum(['add', 'remove']).describe('add creates the alias; remove deletes it.'),
      isOn: (value: unknown) => value === 'add',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Adds (action: add) or removes (action: remove) an alias address that delivers into ' +
      'the mailbox of an email subscription, and returns the updated subscription. Use it ' +
      'for a named extra address; to accept every unknown address at the domain use ' +
      'eurodns_email_set_catchall instead. The subscription id comes from ' +
      'eurodns_email_get_subscription.',
  }),
  switchBetween({
    name: 'eurodns_email_set_catchall',
    title: 'Enable or disable the catch-all of a mailbox',
    on: 'createCatchall',
    off: 'deleteCatchall',
    choice: enabled('true to deliver every unknown address at the domain here, false to stop.'),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Turns the catch-all on (enabled: true) or off (enabled: false) for an email ' +
      'subscription and returns the updated subscription. On, every address at the domain ' +
      'without a mailbox or alias of its own is delivered to this mailbox, which brings more ' +
      'unsolicited mail; off, such mail is refused. For one named address use ' +
      'eurodns_email_set_alias.',
  }),
  // --- Other subscriptions --------------------------------------------------------------
  listOrGet({
    name: 'eurodns_premium_dns_get_subscription',
    title: 'Get a Premium DNS subscription, or search them',
    list: 'getPremiumDnsSubscriptions',
    get: 'getPremiumDnsSubscription',
    idParam: 'subscription-id',
    idDescription:
      'Numeric id of the Premium DNS subscription to return. Omit it to search them by ' +
      'status and domain.',
    description:
      'Returns one Premium DNS subscription with its status, term and domain by id, or ' +
      'searches the account’s Premium DNS subscriptions by status and domain when id is ' +
      'omitted. Use it to check a renewal date or before changing a plan; ' +
      'eurodns_subscription_search covers every product at once.',
  }),
  listOrGet({
    name: 'eurodns_ssl_get_subscription',
    title: 'Get an SSL subscription, or search them',
    list: 'getSslSubscriptions',
    get: 'getSslSubscription',
    idParam: 'subscription-id',
    idDescription:
      'Numeric id of the SSL subscription to return with its certificates. Omit it to ' +
      'search SSL subscriptions with the filters below.',
    description:
      'Returns one SSL subscription with its certificates and their expiry by id, or ' +
      'searches SSL subscriptions by status, common name, SAN or renewability when id is ' +
      'omitted. Use it to find the certificateId that eurodns_ssl_get_certificate and ' +
      'eurodns_ssl_get_validation need; every product at once is eurodns_subscription_search.',
  }),
  listOrGet({
    name: 'eurodns_microsoft_get_subscription',
    title: 'Get a Microsoft subscription, or search them',
    list: 'getMicrosoftSubscriptions',
    get: 'getMicrosoftSubscription',
    idParam: 'id',
    idDescription:
      'Numeric id of the Microsoft subscription to return. Omit it to search them by status, ' +
      'Microsoft domain and account label.',
    description:
      'Returns one Microsoft 365 subscription with its status, Microsoft domain and term by ' +
      'id, or searches the account’s Microsoft subscriptions by status, domain and account ' +
      'label when id is omitted. This reads the subscription record only — nothing here ' +
      'manages the tenant; every product at once is eurodns_subscription_search.',
  }),
];

/**
 * Operations no longer registered under their own name.
 *
 * The composites’ members, plus `deleteDnsRecord`: the hand-written
 * `eurodns_dns_delete_record` accepts the raw record id as well as a type-and-host lookup,
 * so the generated `eurodns_dns_delete_record_by_id` said the same thing twice.
 */
export const ABSORBED_OPERATION_IDS: ReadonlySet<string> = new Set([
  ...COMPOSITES.flatMap((composite) => composite.members),
  'deleteDnsRecord',
]);
