import { describe, expect, it } from 'vitest';
import {
  contextualSignals,
  gates,
  shadowingCandidates,
  toolCountTier,
  type ToolDefinition,
} from '../scripts/tdqs/signals.js';
import { connect, testConfig } from './harness.js';

/**
 * The deterministic TDQS rules, proven on fabricated definitions where each rule is the only
 * thing that differs — and then run over the real default surface, which is what Glama scores.
 */

const tool = (partial: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: 'eurodns_x_get',
  title: 'Get an x, or list them',
  description:
    'Returns one x by id, or lists them when id is omitted. Use it before eurodns_x_save.',
  inputSchema: { type: 'object', properties: {} },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  ...partial,
});

describe('the contextual signals', () => {
  it('count parameters, descriptions and enums, and read 100% coverage into no parameters', () => {
    const empty = contextualSignals(tool());
    expect(empty.paramCount).toBe(0);
    expect(empty.schemaDescriptionCoverage).toBe(100);
    expect(empty.schemaDepth).toBe(1);
    expect(empty.invocationCost).toBe(0);
    expect(empty.titleIsMeaningful).toBe(true);
    expect(empty.hasOutputSchema).toBe(false);

    const three = contextualSignals(
      tool({
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'string', description: 'A.' },
            b: { type: 'string', enum: ['x', 'y'] },
            c: { type: 'object', properties: {} },
          },
          required: ['a', 'b'],
        },
      }),
    );
    expect(three.paramCount).toBe(3);
    expect(three.requiredParamCount).toBe(2);
    expect(three.paramsWithDescriptions).toBe(1);
    expect(three.paramsWithEnums).toBe(1);
    expect(three.schemaDescriptionCoverage).toBe(33);
    expect(three.hasNestedObjects).toBe(true);
  });

  it('price the required subtree only: fields, depth beyond one, and union choices', () => {
    const nested = contextualSignals(
      tool({
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            body: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                ttl: { anyOf: [{ type: 'number' }, { type: 'number' }, { type: 'number' }] },
                optional: {
                  type: 'object',
                  properties: { deep: { type: 'string' } },
                  required: ['deep'],
                },
              },
              required: ['name', 'ttl'],
            },
          },
          required: ['body'],
        },
      }),
    );
    // body (1) + name, ttl (2) = 3 required fields; `optional` is not required, so its depth
    // and field are not priced. Depth: root 1, body 2. One union of three branches = 2 choices.
    expect(nested.requiredFieldCount).toBe(3);
    expect(nested.schemaDepth).toBe(2);
    expect(nested.unionChoiceCount).toBe(2);
    expect(nested.invocationCost).toBe(3 + 2 * 1 + 2 * 2);
  });

  it('read a title as meaningful only when it is longer than the name and differs from it', () => {
    expect(contextualSignals(tool({ title: 'eurodns_x_get' })).titleIsMeaningful).toBe(false);
    expect(contextualSignals(tool({ title: 'X' })).titleIsMeaningful).toBe(false);
    expect(contextualSignals(tool({ title: undefined })).titleIsMeaningful).toBe(false);
  });

  it('report absent annotations as null rather than false', () => {
    const none = contextualSignals(tool({ annotations: undefined }));
    expect(none.hasAnnotations).toBe(false);
    expect(none.annotationValues).toEqual({
      readOnly: null,
      destructive: null,
      idempotent: null,
      openWorld: null,
    });
  });
});

describe('the gates', () => {
  const siblings = new Set(['eurodns_x_get', 'eurodns_x_save']);

  it('pass a description that says more than the name and contradicts nothing', () => {
    expect(gates(tool(), siblings, 'eurodns_')).toEqual([]);
  });

  it('fail an empty description, and stop there', () => {
    const failures = gates(tool({ description: '  ' }), siblings, 'eurodns_');
    expect(failures.map((f) => f.gate)).toEqual(['No Description']);
  });

  it('fail a description that is the name or the title', () => {
    expect(gates(tool({ description: 'Get an x, or list them' }), siblings, 'eurodns_')).toEqual([
      expect.objectContaining({ gate: 'Tautological Description' }),
    ]);
    expect(gates(tool({ description: 'EURODNS_X_GET' }), siblings, 'eurodns_')).toEqual([
      expect.objectContaining({ gate: 'Tautological Description' }),
    ]);
  });

  it('fail a read-only tool whose prose asserts a write, but not one that cites a writer', () => {
    const contradiction = gates(
      tool({ description: 'Returns an x. Creates the x when it is missing. Use it first.' }),
      siblings,
      'eurodns_',
    );
    expect(contradiction.map((f) => f.gate)).toEqual(['Annotation Contradiction']);

    // "eurodns_x_save" starts the sentence and is a name, not a verb.
    const citation = gates(
      tool({ description: 'Returns an x. eurodns_x_save replaces it. Read it first.' }),
      siblings,
      'eurodns_',
    );
    expect(citation).toEqual([]);

    // A writer may say it writes.
    const writer = gates(
      tool({
        annotations: { readOnlyHint: false },
        description: 'Creates an x and returns it. Use it once; eurodns_x_get lists them.',
      }),
      siblings,
      'eurodns_',
    );
    expect(writer).toEqual([]);
  });

  it('fail an undescribed parameter and a sibling that does not exist', () => {
    const failures = gates(
      tool({
        description: 'Returns one x. Prefer eurodns_x_list for many.',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
      }),
      siblings,
      'eurodns_',
    );
    expect(failures.map((f) => [f.gate, f.detail])).toEqual([
      ['Undescribed Parameter', 'id'],
      ['Unknown Sibling', 'eurodns_x_list'],
    ]);
  });
});

describe('the server-level rules', () => {
  it('anchor the tool count as the specification does', () => {
    expect(toolCountTier(1).score).toBe(2);
    expect(toolCountTier(2).score).toBe(3);
    expect(toolCountTier(3).score).toBe(5);
    expect(toolCountTier(15).score).toBe(5);
    expect(toolCountTier(16).score).toBe(3);
    expect(toolCountTier(25).score).toBe(3);
    expect(toolCountTier(26).score).toBe(2);
    expect(toolCountTier(49).score).toBe(2);
    expect(toolCountTier(50).score).toBe(1);
  });

  it('name a shadowing candidate only when the dearer tool costs twice as much and four more', () => {
    const costs = [
      { name: 'cheap', cost: 1 },
      { name: 'dear', cost: 6 },
      { name: 'middling', cost: 4 },
    ];
    expect(shadowingCandidates(costs)).toEqual([
      { tool: 'dear', cheaperSibling: 'cheap', cost: 6, cheaperCost: 1 },
    ]);
    // 4 is twice 1 but only three more; 6 is not twice 4.

    // The narrowing is applied before the arithmetic, so an unrelated pair never appears.
    expect(shadowingCandidates(costs, (a, b) => a === b)).toEqual([]);
  });
});

describe('the surface a registry scores', () => {
  it('passes every gate on a default deployment', async () => {
    const { client, close } = await connect({ config: testConfig() });
    const { tools } = await client.listTools();
    await close();

    const definitions = tools as unknown as ToolDefinition[];
    const names = new Set(definitions.map((t) => t.name));
    const failures = definitions.flatMap((t) => gates(t, names, 'eurodns_'));
    expect(failures).toEqual([]);

    for (const definition of definitions) {
      const signals = contextualSignals(definition);
      expect(signals.schemaDescriptionCoverage, definition.name).toBe(100);
      expect(signals.hasAnnotations, definition.name).toBe(true);
      expect(signals.hasOutputSchema, definition.name).toBe(true);
      // `titleIsMeaningful` is reported, not required: the specification reads a title
      // shorter than the name as meaningless, and `eurodns_account_get_prepaid_balance` is
      // longer than any title worth having.
    }
  });
});
