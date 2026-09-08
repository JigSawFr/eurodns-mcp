import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATIONS, type GeneratedOperation } from '../src/generated/operations.js';
import { ABSORBED_OPERATION_IDS, COMPOSITES } from '../src/tools/composites.js';
import { areaFor } from '../src/tools/naming.js';
import {
  DESCRIPTION_OVERRIDES,
  TITLE_OVERRIDES,
  describeOperation,
  documentDescription,
  titleFor,
} from '../src/tools/overrides.js';
import {
  BODY_DESCRIPTIONS,
  PARAMETER_DESCRIPTIONS_BY_AREA,
  PARAMETER_DESCRIPTIONS_BY_NAME,
  PARAMETER_DESCRIPTIONS_BY_OPERATION,
  describeBody,
  describeParameter,
} from '../src/tools/parameters.js';
import { connect, testConfig } from './harness.js';

/**
 * What a model reads before it picks a tool, held to a standard.
 *
 * A tool description is scored by the clients that list this server — and, more to the
 * point, read by every model that uses it — on whether it says what the tool does, when to
 * prefer it over its neighbours, and what its arguments mean. The rules here are the ones a
 * description fails silently: a summary that restates the title, an `id` with no word on
 * which object it names, a sibling cited by a name that no longer exists after a rename.
 *
 * The shape every description follows, and the rules below check for: what it does and
 * returns, first; when to use it and when *not* to, naming the neighbour; what it does that
 * the annotations cannot say — an email sent, a document replaced whole, a 404; and what the
 * schema cannot say about the arguments, so at least one argument is named in the prose. The
 * published scoring rubric (Glama's TDQS) gives a description that merely restates a fully
 * described schema a floor of 3 out of 5 on parameter semantics, and credits when-not
 * guidance and disclosed behaviour separately: the rules are shaped to those three gaps.
 *
 * Runs against the whole surface — billing, destructive, the audit query and the
 * compatibility pair all on — because a deployment that enables a class deserves the same
 * standard as the default one.
 */

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { properties?: Record<string, { description?: string }> };
  annotations?: { readOnlyHint?: boolean };
}

const everything = testConfig({
  EURODNS_ALLOW_BILLING: 'true',
  EURODNS_ALLOW_DESTRUCTIVE: 'true',
  EURODNS_COMPAT_TOOLS: 'true',
  EURODNS_AUDIT_DESTINATION: 'file',
  EURODNS_AUDIT_FILE: join(mkdtempSync(join(tmpdir(), 'eurodns-descriptions-')), 'audit.jsonl'),
  EURODNS_AUDIT_QUERY: 'all',
});

const session = await connect({ config: everything });
const tools = (await session.client.listTools()).tools as ListedTool[];
await session.close();

const REGISTERED = new Set(tools.map((tool) => tool.name));
const COMPOSITE_READS = new Set(COMPOSITES.filter((c) => c.risk === 'read').map((c) => c.name));
const STANDALONE = OPERATIONS.filter((o) => !ABSORBED_OPERATION_IDS.has(o.operationId));

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const words = (text: string) => new Set(normalise(text).split(' ').filter(Boolean));
/** Splits on sentence ends, not on the dot of "e.g." or a domain name. */
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).filter(Boolean);
const toolNames = (text: string) => text.match(/\beurodns_[a-z0-9_]+\b/g) ?? [];

const STOPWORDS = new Set(
  'a an the of to for and or in on by with its this that it is are be as at from one'.split(' '),
);
const USAGE_CUES =
  /\b(use (it|this)|prefer|instead|before|after|when|only|rather than|start here|check (it|this)|first|needs?|requires?|omit)\b/i;
/** A contrast — when this tool is the wrong one — rather than only a condition for using it. */
const WHEN_NOT_CUES = /\b(instead|rather than|not (?:for|as|here)|only|do not|does not|never)\b/i;
/**
 * Verbs that assert a write. A read-only tool whose prose opens a sentence with one of them
 * contradicts its own annotation, which the rubric scores at the floor and flags. Tool names
 * are stripped first: "eurodns_dns_save_zone" cited inside a read is a reference, not a verb.
 */
const WRITE_VERBS =
  /^(creates?|updates?|deletes?|removes?|replaces?|saves?|signs?|sends?|orders?|revokes?)\b/i;

describe('every tool description', () => {
  expect(tools.length).toBe(
    OPERATIONS.length - ABSORBED_OPERATION_IDS.size + COMPOSITES.length + 7,
  );

  it.each(tools.map((tool) => [tool.name, tool] as const))('%s', (_name, tool) => {
    const description = tool.description ?? '';
    const title = tool.title ?? '';

    // Size: enough to say something, not a manual. Sentences, not a fragment.
    expect(description.length).toBeGreaterThanOrEqual(80);
    expect(description.length).toBeLessThanOrEqual(640);
    expect(description.endsWith('.')).toBe(true);
    expect(description).not.toContain('<');
    expect(description).not.toMatch(/\bthis tool\b/i);
    expect(sentences(description).length).toBeGreaterThanOrEqual(3);
    expect(sentences(description).length).toBeLessThanOrEqual(5);

    // Not a tautology: it says more than the title does.
    expect(normalise(description)).not.toBe(normalise(title));
    expect(normalise(sentences(description)[0] ?? '')).not.toBe(normalise(title));
    const beyondTitle = [...words(description)].filter(
      (word) => !words(title).has(word) && !STOPWORDS.has(word) && word.length > 2,
    );
    expect(beyondTitle.length).toBeGreaterThanOrEqual(3);

    // Usage guidance: a neighbour by name, or a condition under which to reach for it — and
    // a contrast, because "use it when X" alone leaves the model to infer when not to.
    const others = toolNames(description).filter((name) => name !== tool.name);
    expect(others.length > 0 || USAGE_CUES.test(description), 'no when-to-use').toBe(true);
    expect(WHEN_NOT_CUES.test(description), 'no when-not-to-use').toBe(true);

    // Behaviour must not contradict the annotation. Read-only tools may cite a writer by
    // name, so names go before the verb check.
    if (tool.annotations?.readOnlyHint === true) {
      const prose = description.replace(/\beurodns_[a-z0-9_]+\b/g, 'x');
      for (const sentence of sentences(prose)) {
        expect(sentence, `read-only tool asserts a write: "${sentence}"`).not.toMatch(WRITE_VERBS);
      }
    }

    // Parameter semantics: the prose says something about at least one argument that the
    // schema cannot — which requires naming it. The schema alone earns no credit.
    const argumentNames = Object.keys(tool.inputSchema.properties ?? {});
    if (argumentNames.length > 0) {
      const named = argumentNames.filter((key) => new RegExp(`\\b${key}\\b`).test(description));
      expect(named.length, 'no argument named in the description').toBeGreaterThan(0);
    }

    // Every argument means something, and says it.
    const properties = tool.inputSchema.properties ?? {};
    for (const [key, property] of Object.entries(properties)) {
      const text = property.description ?? '';
      expect(text.length, `${key} has no description`).toBeGreaterThanOrEqual(10);
      expect(normalise(text), `${key} restates its own name`).not.toBe(normalise(key));
      if (key === 'body') {
        expect(text.length).toBeGreaterThanOrEqual(20);
        expect(text).not.toMatch(/^request body\.?$/i);
      }
      // An id says which object it names and where the value comes from — except on a
      // get-or-list tool, whose own listing is the source, and on the unprefixed pair,
      // which point at each other.
      if (
        /(^id$|Id$)/.test(key) &&
        !COMPOSITE_READS.has(tool.name) &&
        tool.name.startsWith('eurodns_')
      ) {
        expect(toolNames(text).length, `${key} does not say where it comes from`).toBeGreaterThan(
          0,
        );
      }
    }

    // Title: present, distinct from the name, a phrase rather than a sentence.
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).not.toBe(tool.name);
    expect(title.endsWith('.')).toBe(false);
  });

  it('cites siblings only by names that exist, so a rename cannot orphan a reference', () => {
    for (const tool of tools) {
      const texts = [
        tool.description ?? '',
        ...Object.values(tool.inputSchema.properties ?? {}).map((p) => p.description ?? ''),
      ];
      for (const name of texts.flatMap(toolNames)) {
        expect(REGISTERED.has(name), `${tool.name} cites ${name}`).toBe(true);
        expect(name, `${tool.name} cites itself`).not.toBe(tool.name);
      }
    }
  });

  it('cites, on a default deployment, only tools that deployment advertises', async () => {
    // The rule above runs with every class on, so a read that points at a billing tool
    // passes it — and dangles on the deployment a registry actually lists. A model told to
    // "use eurodns_x instead" when eurodns_x is not there will look for it, then guess.
    const { client, close } = await connect({ config: testConfig() });
    const listed = (await client.listTools()).tools as ListedTool[];
    await close();

    const advertised = new Set(listed.map((tool) => tool.name));
    for (const tool of listed) {
      const texts = [
        tool.description ?? '',
        ...Object.values(tool.inputSchema.properties ?? {}).map((p) => p.description ?? ''),
      ];
      for (const name of texts.flatMap(toolNames)) {
        expect(advertised.has(name), `${tool.name} cites ${name}, hidden by default`).toBe(true);
      }
    }
  });

  it('is never the vendor’s own summary for a generated tool', () => {
    for (const operation of STANDALONE) {
      expect(normalise(describeOperation(operation)), operation.operationId).not.toBe(
        normalise(documentDescription(operation)),
      );
    }
  });

  it('warns that saving a zone replaces it, and points at the safe alternative', () => {
    const save = tools.find((t) => t.name === 'eurodns_dns_save_zone');
    expect(save?.description).toContain('deleted');
    expect(save?.description).toContain('eurodns_dns_upsert_record');
  });
});

describe('the curated maps', () => {
  const standaloneIds = new Set(STANDALONE.map((o) => o.operationId));

  it('describe exactly the operations that stand on their own', () => {
    expect(new Set(Object.keys(DESCRIPTION_OVERRIDES))).toEqual(standaloneIds);
  });

  it('describe a body for exactly the standalone operations that take one', () => {
    const withBody = new Set(STANDALONE.filter((o) => o.body !== null).map((o) => o.operationId));
    expect(new Set(Object.keys(BODY_DESCRIPTIONS))).toEqual(withBody);
  });

  it('name only parameters, areas and operations the document defines', () => {
    const params = (operation: GeneratedOperation) =>
      [...operation.pathParams, ...operation.queryParams, ...operation.headerParams].map(
        (p) => p.name,
      );
    const byOperation = new Set(
      OPERATIONS.flatMap((o) => params(o).map((n) => `${o.operationId}.${n}`)),
    );
    const byArea = new Set(OPERATIONS.flatMap((o) => params(o).map((n) => `${areaFor(o)}.${n}`)));
    const byName = new Set(OPERATIONS.flatMap(params));

    for (const key of Object.keys(PARAMETER_DESCRIPTIONS_BY_OPERATION))
      expect(byOperation.has(key), key).toBe(true);
    for (const key of Object.keys(PARAMETER_DESCRIPTIONS_BY_AREA))
      expect(byArea.has(key), key).toBe(true);
    for (const key of Object.keys(PARAMETER_DESCRIPTIONS_BY_NAME))
      expect(byName.has(key), key).toBe(true);
    for (const key of Object.keys(TITLE_OVERRIDES)) expect(standaloneIds.has(key), key).toBe(true);
  });
});

describe('the resolvers', () => {
  const synthetic = (partial: Partial<GeneratedOperation> = {}): GeneratedOperation => ({
    operationId: 'op',
    method: 'GET',
    path: '/x',
    tag: 'InvoiceService',
    summary: '',
    description: '',
    risk: 'read',
    paginated: false,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    body: null,
    responseSchema: null,
    ...partial,
  });
  const param = (name: string, description = '') => ({
    name,
    required: true,
    description,
    schema: {} as GeneratedOperation['pathParams'][number]['schema'],
  });

  it('prefer the operation, then the area, then the name, then the document', () => {
    expect(
      describeParameter(synthetic({ operationId: 'getInvoices' }), param('invoice-type')),
    ).toBe(PARAMETER_DESCRIPTIONS_BY_OPERATION['getInvoices.invoice-type']);
    expect(describeParameter(synthetic({ tag: 'DnsProvider' }), param('domain-name', 'doc'))).toBe(
      PARAMETER_DESCRIPTIONS_BY_AREA['dns.domain-name'],
    );
    expect(describeParameter(synthetic(), param('cip-id', 'doc'))).toBe(
      PARAMETER_DESCRIPTIONS_BY_NAME['cip-id'],
    );
    expect(describeParameter(synthetic(), param('something-else', 'from the document'))).toBe(
      'from the document',
    );
    expect(describeParameter(synthetic(), param('something-else'))).toBeUndefined();
  });

  it('describe a body only where one was written', () => {
    expect(describeBody(synthetic({ operationId: 'saveDnsZone' }))).toBe(
      BODY_DESCRIPTIONS.saveDnsZone,
    );
    expect(describeBody(synthetic({ operationId: 'nothing' }))).toBeUndefined();
  });

  it('fall back to the document’s text, assembled, for an operation nobody described', () => {
    expect(
      documentDescription(synthetic({ summary: 'Get X', description: 'Get X in full.' })),
    ).toBe('Get X in full.');
    expect(documentDescription(synthetic({ summary: 'Get X', description: 'Returns X.' }))).toBe(
      'Get X. Returns X.',
    );
    expect(documentDescription(synthetic({ summary: 'Get X' }))).toBe('Get X');
    expect(documentDescription(synthetic({ description: 'Only <br> this.' }))).toBe('Only this.');
    expect(documentDescription(synthetic({ operationId: 'bareOp' }))).toBe('bareOp');
    expect(describeOperation(synthetic({ operationId: 'unknownOp', summary: 'S' }))).toBe('S');
  });

  it('title from the override, else the summary, else the operation id', () => {
    expect(titleFor(synthetic({ operationId: 'getDnsZone' }))).toBe(TITLE_OVERRIDES.getDnsZone);
    expect(titleFor(synthetic({ operationId: 'x', summary: 'Do X' }))).toBe('Do X');
    expect(titleFor(synthetic({ operationId: 'x' }))).toBe('x');
  });
});
