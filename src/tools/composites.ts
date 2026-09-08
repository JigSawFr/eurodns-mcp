import { z, type ZodRawShape } from 'zod';
import { OPERATIONS, type GeneratedOperation } from '../generated/operations.js';
import type { RiskClass } from '../constants.js';
import { paginationShape, parameterShape, toCamelCase, type MutableShape } from './shapes.js';

/**
 * Tools that stand in for several generated operations.
 *
 * The document exposes its collections as pairs — `GET /invoices` and `GET /invoices/{id}`,
 * `POST /contact-profiles` and `PUT /contact-profiles/{id}`, `/sign` and `/unsign` — and a
 * tool per endpoint gave the model sixty-four tools, half of them the other half's twin. An
 * agent choosing between `eurodns_invoice_list` and `eurodns_invoice_get` is not making a
 * decision, it is spelling one: whether it holds an id. So the pair becomes one tool whose
 * arguments carry the decision — `id` present or absent, `enabled` true or false — and the
 * routing here picks the operation.
 *
 * The same argument reaches past pairs. Five products each had a get-or-list tool that
 * differed from the next only in the product, and the two DNSSEC switches differed only in
 * whether they act at the registry or on the hosted zone; a model was asked to know that
 * before it could name a tool. Those groups are now one tool with the product or the scope
 * as an argument, which is why a composite has *at least* two members rather than exactly
 * two.
 *
 * Two rules keep this honest. **Every member shares one risk class**, so that hiding a
 * class, gating a scope and asking for confirmation stay decisions about a tool rather than
 * about one of its branches; a test asserts it. And **the composite's audit line names the
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
  /** The operation ids this tool stands in for, at least two. None is registered on its own. */
  members: readonly string[];
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

/* ------------------------------------------------------------------ get or search */

interface GetOrSearchSpec {
  name: string;
  title: string;
  description: string;
  /** `GET /things/{key}`, keyed by a string rather than a numeric id. */
  get: string;
  /** `POST /things/search`, whose body carries the criteria. */
  search: string;
  /** Raw name of the `get` member's path parameter: `domain-name`. */
  keyParam: string;
  keyDescription: string;
  bodyDescription: string;
}

/**
 * `GET /things/{name}` and `POST /things/search` as one tool: the name present fetches one,
 * absent searches with the body.
 *
 * `listOrGet` cannot serve here twice over: the key is a string, not a numeric id, and the
 * search is a POST whose criteria travel in a body rather than in the query. The routing is
 * the same idea, and the body defaults to an empty object so that a call with nothing at all
 * lists the whole collection instead of sending a POST with no body.
 */
function getOrSearch(spec: GetOrSearchSpec): CompositeTool {
  memberOperation(spec.get);
  const search = memberOperation(spec.search);
  const key = toCamelCase(spec.keyParam);
  // Asserted rather than branched: the one pair below is `POST /domains/search` with a body,
  // and `tests/composites.test.ts` checks the member against the document.
  const criteria = search.body!.schema;

  const shape: MutableShape = {
    [key]: z.string().optional().describe(spec.keyDescription),
    body: criteria.optional().describe(spec.bodyDescription),
    ...(search.paginated ? paginationShape : {}),
  };

  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    risk: 'read',
    members: [spec.get, spec.search],
    inputSchema: z.object(shape),
    annotations: READ,
    route(args) {
      const { [key]: value, body, ...rest } = args;
      if (value === undefined) {
        return { operationId: spec.search, args: { ...rest, body: body ?? {} } };
      }
      // Only what the member takes: the get has no query, so a page or a body sent along
      // with the name is dropped here rather than silently carried.
      return { operationId: spec.get, args: { [key]: value } };
    },
  };
}

/* -------------------------------------------------------------------- choose among */

interface ChoiceSpec {
  name: string;
  title: string;
  description: string;
  risk: RiskClass;
  annotations: CompositeAnnotations;
  /** The member whose path parameters every member shares; they pass through unchanged. */
  pathParamsFrom: string;
  /** The choosing arguments, consumed here and never sent upstream. */
  choices: ZodRawShape;
  members: readonly string[];
  /** Which member the choosing arguments name. */
  select(choice: Record<string, unknown>): string;
}

/**
 * Several operations that are one action under different settings — sign or unsign, at the
 * registry or on the zone — as one tool whose arguments name the setting.
 *
 * A generalisation of `switchBetween` to more than one choosing argument and more than two
 * members. The members share their path parameters, which pass through; only the choosing
 * arguments are consumed here.
 */
function chooseAmong(spec: ChoiceSpec): CompositeTool {
  const from = memberOperation(spec.pathParamsFrom);
  const choiceKeys = Object.keys(spec.choices);

  const shape: MutableShape = {
    ...parameterShape(from, from.pathParams),
    ...spec.choices,
  };

  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    risk: spec.risk,
    members: spec.members,
    inputSchema: z.object(shape),
    annotations: spec.annotations,
    route(args) {
      const choice: Record<string, unknown> = {};
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (choiceKeys.includes(key)) choice[key] = value;
        else rest[key] = value;
      }
      return { operationId: spec.select(choice), args: rest };
    },
  };
}

/* --------------------------------------------------------- subscriptions, by product */

/** One product's get-or-list pair, or a lone get where the document offers no listing. */
interface ProductSpec {
  get: string;
  list?: string;
  /** Raw name of the `get` member's id path parameter. */
  idParam: string;
  /** The value `subscription-types` uses for this product on the cross-product search. */
  type: string;
}

interface SubscriptionSpec {
  name: string;
  title: string;
  description: string;
  /** The cross-product search, `GET /subscriptions`. */
  search: string;
  products: Record<string, ProductSpec>;
  productDescription: string;
  idDescription: string;
  /** The merged filters, by argument name, described once for every product they serve. */
  filters: Record<string, string>;
}

/**
 * Every subscription read as one tool: the cross-product search, and each product's
 * get-or-list pair, chosen by `product` and `id`.
 *
 * Five products each had their own get-or-list tool, differing from the next only in the
 * product — six tools whose descriptions all ended by pointing at each other. Here `product`
 * is an argument. The filters are the union of the listings' query parameters, merged by
 * name: `subscriptionStatus` and `domainName` mean the same thing on every product, and a
 * product-specific filter sent to a product that lacks it is dropped by `collect`, which only
 * reads the parameters the resolved operation declares.
 *
 * A product with no listing of its own (HTTPS redirect) is served, without an id, by the
 * cross-product search filtered to that type — the same answer the document can give,
 * reached without a dead end.
 */
function subscriptionReads(spec: SubscriptionSpec): CompositeTool {
  const search = memberOperation(spec.search);
  const productNames = Object.keys(spec.products) as [string, ...string[]];
  const listings = Object.values(spec.products)
    .map((p) => p.list)
    .filter((id): id is string => id !== undefined)
    .map(memberOperation);

  // First definition wins, then the spec's own text replaces every description: the merged
  // filter has to be described for all the products it serves, not for the one it came from.
  const merged: MutableShape = {};
  for (const operation of [search, ...listings]) {
    for (const [key, schema] of Object.entries(parameterShape(operation, operation.queryParams))) {
      merged[key] ??= schema;
    }
  }
  for (const [key, text] of Object.entries(spec.filters)) {
    const schema = merged[key];
    if (schema === undefined) {
      throw new Error(`${spec.name} describes a filter no member declares: ${key}`);
    }
    merged[key] = (schema as z.ZodTypeAny).describe(text);
  }

  const shape: MutableShape = {
    product: z.enum(productNames).optional().describe(spec.productDescription),
    id: z.number().int().optional().describe(spec.idDescription),
    ...merged,
    ...paginationShape,
  };

  const members = [
    spec.search,
    ...Object.values(spec.products).flatMap((p) => (p.list ? [p.get, p.list] : [p.get])),
  ];

  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    risk: 'read',
    members,
    inputSchema: z
      .object(shape)
      .refine((args) => args.id === undefined || args.product !== undefined, {
        message: 'An id names a subscription of one product: give product with it.',
      }),
    annotations: READ,
    route(args) {
      const { product, id, ...rest } = args;
      if (product === undefined) return { operationId: spec.search, args: rest };

      const chosen = spec.products[product as string]!;
      if (id !== undefined) {
        return { operationId: chosen.get, args: { [toCamelCase(chosen.idParam)]: id } };
      }
      if (chosen.list !== undefined) return { operationId: chosen.list, args: rest };
      return {
        operationId: spec.search,
        args: { ...rest, subscriptionTypes: [chosen.type] },
      };
    },
  };
}

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
      'Returns one earlier state of the zone domainName by snapshot id — its records as they ' +
      'were — or lists the zone’s snapshots with their ids and dates when id is omitted. Use ' +
      'it to see what a zone held before an unintended change; it reads only and restores ' +
      'nothing. To put a state back, send its records through eurodns_dns_save_zone, or one ' +
      'record at a time through eurodns_dns_upsert_record rather than replacing the zone.',
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
      'Returns one zone profile in full — name, records, URL forwards and mail forwards — by ' +
      'id, or lists the account’s profiles, filtered by name and paged, when id is omitted. ' +
      'Profiles are templates for new zones, not live zones: for the records a domain ' +
      'actually serves use eurodns_dns_get_zone instead. Read a profile before ' +
      'eurodns_dns_save_zone_profile, which replaces the whole profile with what you send; an ' +
      'id that does not exist answers 404.',
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
      'Creates a zone profile from body when id is omitted, or replaces the profile with that ' +
      'id in its entirety, and returns the saved profile. On a replace every record absent ' +
      'from body is dropped, so start from what eurodns_dns_get_zone_profile returned rather ' +
      'than from a partial document. Validate a candidate first with ' +
      'eurodns_dns_check_zone_profile, whose report names the offending record where a ' +
      'rejected save only answers 400. Record values go in rdata.',
  }),
  // --- Domains ------------------------------------------------------------------------
  getOrSearch({
    name: 'eurodns_domain_get',
    title: 'Get a domain, or search the account’s domains',
    get: 'getDomain',
    search: 'searchDomains',
    keyParam: 'domain-name',
    keyDescription:
      'Fully qualified name of a domain held in this account, e.g. example.com, to return in ' +
      'full. Omit it to search the account’s domains with body and the pagination arguments.',
    bodyDescription:
      'Search criteria, read only when domainName is omitted: a free-text term with its ' +
      'termMatchingMode and termMatchFields, plus boolean filters such as active, renewable, ' +
      'dnssecActivated or premiumDns. Omitted or empty, every domain is listed.',
    description:
      'Returns one domain already registered in this account — status, expiry, renewal ' +
      'method, contacts and nameservers — when domainName is given, or searches the ' +
      'account’s domains and returns one summary per match when it is omitted. It only ' +
      'knows domains held here: an unknown name answers 404 rather than an availability, so ' +
      'for a name you might register use eurodns_domain_check_availability instead. The ' +
      'search reads body for its filters and page and size for paging; a search without ' +
      'criteria lists the whole portfolio, which is the way to find a name you do not hold ' +
      'exactly.',
  }),
  chooseAmong({
    name: 'eurodns_domain_set_dnssec',
    title: 'Enable or disable DNSSEC, at the registry or on the zone',
    risk: 'write',
    pathParamsFrom: 'signDomain',
    members: ['signDomain', 'unsignDomain', 'signZone', 'unsignZone'],
    choices: {
      scope: z
        .enum(['registry', 'zone'])
        .describe(
          'registry publishes or withdraws the DS records of a domain registered here; zone ' +
            'starts or stops signing a zone hosted here, for a domain registered elsewhere.',
        ),
      enabled: z.boolean().describe('true to enable DNSSEC in that scope, false to disable it.'),
    },
    select: (choice) => {
      const on = choice.enabled === true;
      return choice.scope === 'zone'
        ? on
          ? 'signZone'
          : 'unsignZone'
        : on
          ? 'signDomain'
          : 'unsignDomain';
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Enables (enabled: true) or disables (enabled: false) DNSSEC for a domain and returns ' +
      'nothing on success. Use scope registry for a domain registered in this account: it ' +
      'signs the hosted zone and publishes the DS records at the registry in one step. Use ' +
      'scope zone only for a domain registered elsewhere whose DNS is hosted here, then ' +
      'publish the DS data at that registrar yourself. Disabling one side while the other ' +
      'stays signed breaks validation until caches expire, so read ' +
      'eurodns_dns_get_dnssec_status before and after; the call does not check that state ' +
      'for you.',
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
      'Returns one TLD by id — registration terms, minimum and maximum durations, ' +
      'registry-specific requirements — or lists the TLDs this account can order when id is ' +
      'omitted, filtered by tldName and paged. Read it before ordering an unfamiliar ' +
      'extension to learn what the registry demands. The full list runs to hundreds of ' +
      'entries, so filter with tldName or page with size rather than asking for everything; ' +
      'it says nothing about whether a name is free, which is ' +
      'eurodns_domain_check_availability.',
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
      'Returns one invoice with its lines by id, or searches invoices when id is omitted — by ' +
      'createdAfter and createdBefore, invoiceType, invoiceStatuses, orderIds or the invoice ' +
      'profile cipId — paged with page and size. Use it for what was billed and whether it is ' +
      'paid; the filters are ignored when id is given. The order behind a line is in ' +
      'eurodns_order_get and the billing identity in eurodns_invoice_profile_get, not here.',
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
      'invoices are issued to — by id, or searches the account’s profiles when id is omitted, ' +
      'by profileName, companyName, countryCode, active and defaultProfile, paged. Use it to ' +
      'find the id a profile is billed under, then pass that id as cipId to ' +
      'eurodns_invoice_get to list its invoices; the invoices themselves are not here. The ' +
      'termMatchingMode argument says how the text filters compare, EQUALS or CONTAINS for ' +
      'instance.',
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
      'when id is omitted — by statuses, startDate and endDate, a free-text term, or ' +
      'deliveryInProgress — paged with page and size. Use it to learn what happened to a ' +
      'subscription that was ordered but never became active; the filters are ignored when id ' +
      'is given. The invoice raised for an order is in eurodns_invoice_get, not here.',
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
      'identity attached to domains — by id, or lists the account’s profiles when id is ' +
      'omitted, filtered by type and by the roles isOrg, isAdmin, isTech and isBilling, ' +
      'paged. It reads the profile only, not the contacts a registered domain carries, which ' +
      'eurodns_domain_get returns. Read a profile before eurodns_contact_save_profile, which ' +
      'needs every field; eurodns_contact_set_as_default_profile chooses which one future ' +
      'orders use.',
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
      'Creates a contact profile from body when id is omitted, or updates the profile with ' +
      'that id, and returns the saved profile. An update must carry every field, changed or ' +
      'not, because the API clears anything omitted: start from what ' +
      'eurodns_contact_get_profile returned rather than from the changed fields alone. ' +
      'Domains already registered keep their contacts; this changes what future orders use, ' +
      'and does not make the profile the default, which is ' +
      'eurodns_contact_set_as_default_profile.',
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
      'Returns one reusable nameserver set by id, or lists the account’s nameserver profiles ' +
      'when id is omitted, with the default one and the deletable ones marked and, with ' +
      'includeNameservers, each profile’s servers. Use it to find the profile a domain should ' +
      'point at, or the id eurodns_nameserver_save_profile takes; it does not say which ' +
      'profile a given domain uses, which eurodns_domain_get returns. Filter with default or ' +
      'deletable rather than paging the whole list.',
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
      'Creates a nameserver profile from body when id is omitted, or updates the profile with ' +
      'that id, and returns the saved profile. An update must carry every field and every ' +
      'nameserver you keep, because the API clears anything omitted: start from ' +
      'eurodns_nameserver_get_profile rather than from the changed servers alone. Changing a ' +
      'profile changes the delegation of every domain pointing at it, so read it first ' +
      'instead of guessing what it holds.',
  }),
  // --- Email ----------------------------------------------------------------------------
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
      'Adds (action: add) or removes (action: remove) the address in alias, which delivers ' +
      'into the mailbox of the email subscription id, and returns the updated subscription. ' +
      'Use it for one named extra address; to accept every unknown address at the domain use ' +
      'eurodns_email_set_catchall instead. Removing an alias bounces mail sent to it from ' +
      'then on. The subscription id comes from eurodns_subscription_get for product email.',
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
      'Turns the catch-all on (enabled: true) or off (enabled: false) for the email ' +
      'subscription id and returns the updated subscription. On, every address at the domain ' +
      'without a mailbox or alias of its own is delivered here, which brings more unsolicited ' +
      'mail; off, such mail is refused. For one named address use eurodns_email_set_alias ' +
      'instead. The subscription id comes from eurodns_subscription_get for product email.',
  }),
  // --- Subscriptions, every product ----------------------------------------------------
  subscriptionReads({
    name: 'eurodns_subscription_get',
    title: 'Get a subscription, or search them across products',
    search: 'getSubscriptions',
    products: {
      ssl: {
        get: 'getSslSubscription',
        list: 'getSslSubscriptions',
        idParam: 'subscription-id',
        type: 'SSL',
      },
      email: {
        get: 'getEmailSubscription',
        list: 'getEmailSubscriptions',
        idParam: 'id',
        type: 'EMAIL',
      },
      premium_dns: {
        get: 'getPremiumDnsSubscription',
        list: 'getPremiumDnsSubscriptions',
        idParam: 'subscription-id',
        type: 'PREMIUM_DNS',
      },
      microsoft: {
        get: 'getMicrosoftSubscription',
        list: 'getMicrosoftSubscriptions',
        idParam: 'id',
        type: 'MICROSOFT',
      },
      https_redirect: {
        get: 'getHttpsRedirectSubscription',
        idParam: 'subscription-id',
        type: 'HTTPS_REDIRECT',
      },
    },
    productDescription:
      'Which product to read: ssl, email, premium_dns, microsoft or https_redirect. Omit it ' +
      'to search every product at once with the common filters; required whenever id is ' +
      'given, because ids are only unique within a product.',
    idDescription:
      'Numeric id of one subscription of the chosen product, from a previous search, to ' +
      'return in full. Omit it to list or search instead.',
    filters: {
      subscriptionStatus:
        'Keep only subscriptions in this lifecycle status, e.g. ACTIVE, TO_RENEW or ' +
        'PROVISIONING, for any product. Omit for every status.',
      subscriptionTypes:
        'Cross-product search only: keep these products, e.g. ["SSL", "EMAIL"]. Ignored when ' +
        'product is given, which already selects one.',
      domainName:
        'Keep only subscriptions attached to this domain, e.g. example.com. Read by the ' +
        'cross-product search and by the email and premium_dns listings; use microsoftDomain ' +
        'for Microsoft.',
      autoRenewEnabled:
        'Cross-product search only: true keeps subscriptions that renew themselves, false ' +
        'only those that will lapse.',
      commonName: 'ssl only: the common name of a certificate in the subscription.',
      sanName: 'ssl only: a Subject Alternative Name of a certificate in the subscription.',
      renewable: 'ssl only: true keeps subscriptions that can still be renewed.',
      userName: 'email only: the mailbox user name, the part before the @.',
      microsoftDomain: 'microsoft only: the Microsoft 365 domain of the subscription.',
      accountLabel: 'microsoft only: the account label the subscription was created under.',
    },
    description:
      'Returns one subscription in full when product and id are given — an SSL subscription ' +
      'with its certificates, a mailbox with its aliases, a Premium DNS, Microsoft or HTTPS ' +
      'redirect term — lists one product’s subscriptions when only product is given, or ' +
      'searches every product when both are omitted. Start with the cross-product search for ' +
      'an expiry review, then narrow by product. It reads records only and manages nothing ' +
      'behind them; a filter marked for another product is ignored, and an id without product ' +
      'is refused before any call, since ids repeat across products. Its ids feed ' +
      'eurodns_ssl_get_certificate and eurodns_email_set_alias.',
  }),
];

/**
 * Operations no longer registered under their own name.
 *
 * The composites’ members, plus two the hand-written DNS tools supersede. `deleteDnsRecord`:
 * `eurodns_dns_delete_record` accepts the raw record id as well as a type-and-host lookup,
 * so the generated `eurodns_dns_delete_record_by_id` said the same thing twice.
 * `addDnsRecords`: it appended to a zone without the validation step, and its one
 * capability the upsert lacked — a second record under an existing type and host — is now
 * the upsert's `append` argument, validated like everything else.
 */
export const ABSORBED_OPERATION_IDS: ReadonlySet<string> = new Set([
  ...COMPOSITES.flatMap((composite) => composite.members),
  'deleteDnsRecord',
  'addDnsRecords',
]);
