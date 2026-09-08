/**
 * The deterministic half of the Tool Definition Quality Score.
 *
 * Glama scores every tool this server lists with TDQS (glama-ai/tool-definition-quality-score,
 * v1.3). The six dimension scores come from a language model and are not reproduced here.
 * What the specification defines as *code* is reproduced exactly: the contextual signals an
 * evaluator is handed, the hard gates that floor a score before any model is asked, and the
 * arithmetic that turns a schema into an invocation cost and two costs into a shadowing
 * candidate. Everything below runs on a `tools/list` result and nothing else — no network, no
 * model, no key — which is what lets it run on every pull request.
 *
 * The specification is a document without code or licence; these are its rules restated, not
 * its text.
 */

/** A JSON Schema fragment, read loosely: only the keywords the signals look at are typed. */
export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema | Schema[];
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  description?: string;
}

/** One tool as `tools/list` returns it, narrowed to what is scored. */
export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Schema;
  outputSchema?: Schema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ContextualSignals {
  paramCount: number;
  requiredParamCount: number;
  paramsWithDescriptions: number;
  paramsWithEnums: number;
  /** Percentage, rounded; 100 for a tool with no parameters. */
  schemaDescriptionCoverage: number;
  hasNestedObjects: boolean;
  requiredFieldCount: number;
  /** 1 for a flat object. */
  schemaDepth: number;
  unionChoiceCount: number;
  invocationCost: number;
  hasOutputSchema: boolean;
  hasAnnotations: boolean;
  annotationValues: {
    readOnly: boolean | null;
    destructive: boolean | null;
    idempotent: boolean | null;
    openWorld: boolean | null;
  };
  titleIsMeaningful: boolean;
  definitionBytes: number;
}

const isObject = (schema: Schema): boolean =>
  schema.type === 'object' ||
  (Array.isArray(schema.type) && schema.type.includes('object')) ||
  schema.properties !== undefined;

/**
 * Walks the *required* subtree: the fields a caller cannot leave out, which is what the
 * specification prices. An optional property costs nothing, whatever it contains.
 */
function requiredSubtree(
  schema: Schema,
  depth: number,
): { fields: number; depth: number; unions: number } {
  let fields = 0;
  let deepest = depth;
  let unions = 0;

  const visit = (node: Schema, at: number) => {
    const branches = node.anyOf ?? node.oneOf;
    if (branches) {
      unions += Math.max(0, branches.length - 1);
      for (const branch of branches) visit(branch, at);
      return;
    }
    if (isObject(node)) {
      const required = node.required ?? [];
      fields += required.length;
      for (const key of required) {
        const child = node.properties?.[key];
        if (child) visit(child, at + 1);
      }
      if (required.length > 0) deepest = Math.max(deepest, at + 1);
      return;
    }
    const items = Array.isArray(node.items) ? node.items : node.items ? [node.items] : [];
    for (const item of items) visit(item, at);
  };

  visit(schema, depth);
  return { fields, depth: deepest, unions };
}

export function contextualSignals(tool: ToolDefinition): ContextualSignals {
  const properties = tool.inputSchema.properties ?? {};
  const params = Object.values(properties);
  const paramCount = params.length;
  const withDescriptions = params.filter((p) => (p.description ?? '').trim() !== '').length;

  // The root object's own required list is depth 1; a required object inside it is depth 2.
  const subtree = requiredSubtree(tool.inputSchema, 0);
  const schemaDepth = Math.max(1, subtree.depth);
  const invocationCost = subtree.fields + 2 * Math.max(0, schemaDepth - 1) + 2 * subtree.unions;

  const annotations = tool.annotations ?? {};
  const value = (v: boolean | undefined) => (v === undefined ? null : v);
  const title = tool.title ?? '';

  return {
    paramCount,
    requiredParamCount: (tool.inputSchema.required ?? []).length,
    paramsWithDescriptions: withDescriptions,
    paramsWithEnums: params.filter((p) => Array.isArray(p.enum)).length,
    schemaDescriptionCoverage:
      paramCount === 0 ? 100 : Math.round((withDescriptions / paramCount) * 100),
    hasNestedObjects: params.some(isObject),
    requiredFieldCount: subtree.fields,
    schemaDepth,
    unionChoiceCount: subtree.unions,
    invocationCost,
    hasOutputSchema: tool.outputSchema !== undefined && Object.keys(tool.outputSchema).length > 0,
    hasAnnotations: Object.keys(annotations).length > 0,
    annotationValues: {
      readOnly: value(annotations.readOnlyHint),
      destructive: value(annotations.destructiveHint),
      idempotent: value(annotations.idempotentHint),
      openWorld: value(annotations.openWorldHint),
    },
    titleIsMeaningful: title !== '' && title !== tool.name && title.length > tool.name.length,
    definitionBytes: Buffer.byteLength(JSON.stringify(tool), 'utf8'),
  };
}

/* ------------------------------------------------------------------------------ gates */

export type Gate =
  | 'No Description'
  | 'Tautological Description'
  | 'Annotation Contradiction'
  | 'Undescribed Parameter'
  | 'Unknown Sibling';

export interface GateFailure {
  tool: string;
  gate: Gate;
  detail: string;
}

const normalise = (text: string) => text.toLowerCase().trim();
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).filter(Boolean);

/**
 * Verbs that assert a write. The specification's example of a contradiction is a tool
 * annotated read-only whose description says it "creates"; this is that example, made a list.
 * Sibling names are stripped first, since a read may legitimately cite a writer by name.
 */
const WRITE_VERBS =
  /^(creates?|updates?|deletes?|removes?|replaces?|saves?|signs?|sends?|orders?|revokes?)\b/i;

/**
 * The hard gates, plus two checks that are not gates in the specification but that no
 * description here should fail: a parameter without a description (the coverage the
 * specification measures, held at 100 rather than merely reported), and a sibling cited by a
 * name the listing does not contain.
 *
 * `prefix` is what a sibling reference looks like — here `eurodns_` — so that ordinary
 * words are never mistaken for tool names.
 */
export function gates(
  tool: ToolDefinition,
  siblings: ReadonlySet<string>,
  prefix: string,
): GateFailure[] {
  const failures: GateFailure[] = [];
  const description = tool.description ?? '';
  const fail = (gate: Gate, detail: string) => failures.push({ tool: tool.name, gate, detail });

  if (description.trim() === '') {
    fail('No Description', 'the description is empty');
    return failures;
  }
  if (
    normalise(description) === normalise(tool.name) ||
    normalise(description) === normalise(tool.title ?? '')
  ) {
    fail('Tautological Description', 'the description restates the name or title');
  }

  if (tool.annotations?.readOnlyHint === true) {
    const prose = description.replace(new RegExp(`\\b${prefix}[a-z0-9_]+\\b`, 'g'), 'x');
    for (const sentence of sentences(prose)) {
      if (WRITE_VERBS.test(sentence)) {
        fail('Annotation Contradiction', `read-only, yet: "${sentence}"`);
      }
    }
  }

  for (const [key, property] of Object.entries(tool.inputSchema.properties ?? {})) {
    if ((property.description ?? '').trim() === '') {
      fail('Undescribed Parameter', key);
    }
  }

  const cited = description.match(new RegExp(`\\b${prefix}[a-z0-9_]+\\b`, 'g')) ?? [];
  for (const name of new Set(cited)) {
    if (name !== tool.name && !siblings.has(name)) fail('Unknown Sibling', name);
  }

  return failures;
}

/* ---------------------------------------------------------------------- server level */

/** The specification's anchors for the coherence dimension "tool count appropriateness". */
export function toolCountTier(count: number): { score: 1 | 2 | 3 | 4 | 5; anchor: string } {
  if (count >= 50) return { score: 1, anchor: 'extreme mismatch (50+ tools)' };
  if (count >= 26) return { score: 2, anchor: 'too many for the apparent scope (26+)' };
  if (count >= 16) return { score: 3, anchor: 'borderline: 16-25 feels heavy' };
  if (count >= 3) return { score: 5, anchor: 'well-scoped (3-15 tools)' };
  if (count === 2) return { score: 3, anchor: 'borderline: 1-2 tools feels thin' };
  return { score: 2, anchor: 'too few (1) for the apparent scope' };
}

export interface ShadowingCandidate {
  /** The dearer tool, which is the one that would be flagged. */
  tool: string;
  cheaperSibling: string;
  cost: number;
  cheaperCost: number;
}

/**
 * Pairs the specification would hand to a model to confirm as shadowing: the dearer tool
 * costs at least twice the cheaper one and at least four more. Purpose overlap is the model's
 * call, so these are candidates for a reader, never failures.
 *
 * `related` narrows the pairs a reader is shown. The specification compares every pair on
 * the server, and a zero-cost tool then pairs with everything above four; on this surface
 * that is a hundred rows, of which the plausible overlaps are the handful in one area. The
 * arithmetic is the specification's; the narrowing is this repository's, and is said so.
 */
export function shadowingCandidates(
  costs: ReadonlyArray<{ name: string; cost: number }>,
  related: (a: string, b: string) => boolean = () => true,
): ShadowingCandidate[] {
  const out: ShadowingCandidate[] = [];
  for (const dearer of costs) {
    for (const cheaper of costs) {
      if (dearer === cheaper || !related(dearer.name, cheaper.name)) continue;
      if (dearer.cost >= 2 * cheaper.cost && dearer.cost - cheaper.cost >= 4) {
        out.push({
          tool: dearer.name,
          cheaperSibling: cheaper.name,
          cost: dearer.cost,
          cheaperCost: cheaper.cost,
        });
      }
    }
  }
  return out;
}
