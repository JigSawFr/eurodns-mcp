/**
 * Generates `src/generated/schemas.ts` and `src/generated/operations.ts` from the vendored
 * OpenAPI document.
 *
 * The EuroDNS document uses a narrow slice of JSON Schema — `type`, `properties`, `items`,
 * `enum`, `required`, `nullable`, `$ref` — with no composition keywords and no reference
 * cycles, which is why this converter can stay this small. `npm run gen` re-runs it and CI
 * fails if the committed output drifts from the document.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPEC_PATH = resolve(ROOT, 'spec/openapi.json');
const OUT_DIR = resolve(ROOT, 'src/generated');

const PAGINATION_HEADER_NAMES = new Set([
  'pagination-page',
  'pagination-size',
  'pagination-sortfield',
  'pagination-sortorder',
]);

const READ_ONLY_OPERATION_IDS = new Set([
  'searchDomains',
  'getAvailabilities',
  'checkDnsZone',
  'checkZoneProfile',
]);

const BILLING_OPERATION_IDS = new Set([
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

const DESTRUCTIVE_OPERATION_IDS = new Set([
  'deleteEmailSubscription',
  'deletePremiumDnsSubscription',
  'deleteHttpsRedirectSubscription',
  'deleteContactProfile',
  'deleteNameserverProfile',
  'revokeSslCertificate',
  'cancelSslCertificate',
  'cancelSslSan',
]);

// The OpenAPI document is untyped JSON walked structurally; `any` is the honest type here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

interface ParameterSpec {
  name: string;
  in: 'path' | 'query' | 'header';
  description?: string;
  required?: boolean;
  schema?: Json;
}

const spec: Json = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
const componentSchemas: Record<string, Json> = spec.components?.schemas ?? {};

/* ------------------------------------------------------------------ schema emission */

/**
 * Prefix applied to component-schema references while emitting. Empty inside schemas.ts,
 * where the consts are local; `S.` inside operations.ts, which imports them as a namespace.
 */
let refPrefix = '';

/** `SslSubscription` -> `SslSubscriptionSchema`, the const name in schemas.ts. */
function schemaConstName(ref: string): string {
  return `${ref}Schema`;
}

function refName(node: Json): string | null {
  const ref: unknown = node.$ref;
  if (typeof ref !== 'string') return null;
  return ref.slice(ref.lastIndexOf('/') + 1);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Single-line description, safe to pass to `.describe()`. */
function describeSuffix(node: Json): string {
  const raw: unknown = node.description;
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const flattened = raw.replace(/\s+/g, ' ').trim();
  return `.describe(${quote(flattened)})`;
}

function zodFor(node: Json | undefined, depth = 0): string {
  if (!node || typeof node !== 'object') return 'z.unknown()';

  const ref = refName(node);
  if (ref) {
    // No cycles in this document, so a plain const reference is enough.
    return componentSchemas[ref] ? `${refPrefix}${schemaConstName(ref)}` : 'z.unknown()';
  }

  let base: string;
  const enumValues: unknown = node.enum;

  if (Array.isArray(enumValues) && enumValues.length > 0) {
    base = enumValues.every((v) => typeof v === 'string')
      ? `z.enum([${enumValues.map((v) => quote(v as string)).join(', ')}])`
      : `z.union([${enumValues.map((v) => `z.literal(${JSON.stringify(v)})`).join(', ')}])`;
  } else {
    switch (node.type) {
      case 'object':
        base = objectZod(node, depth);
        break;
      case 'array':
        base = `z.array(${zodFor(node.items as Json, depth + 1)})`;
        break;
      case 'string':
        base = 'z.string()';
        break;
      case 'integer':
        base = 'z.number().int()';
        break;
      case 'number':
        base = 'z.number()';
        break;
      case 'boolean':
        base = 'z.boolean()';
        break;
      default:
        base = node.properties ? objectZod(node, depth) : 'z.unknown()';
    }
  }

  if (node.nullable === true) base += '.nullable()';
  return base + describeSuffix(node);
}

function objectZod(node: Json, depth: number): string {
  const properties: Record<string, Json> = node.properties ?? {};
  const required = new Set<string>(Array.isArray(node.required) ? node.required : []);
  const keys = Object.keys(properties);
  if (keys.length === 0) return 'z.record(z.unknown())';

  const indent = '  '.repeat(depth + 1);
  const closeIndent = '  '.repeat(depth);
  const lines = keys.map((key) => {
    const child = zodFor(properties[key], depth + 1);
    const suffix = required.has(key) ? '' : '.optional()';
    return `${indent}${JSON.stringify(key)}: ${child}${suffix},`;
  });
  return `z.object({\n${lines.join('\n')}\n${closeIndent}})`;
}

/** Emits component schemas in dependency order so each const is defined before use. */
function emitSchemasModule(): string {
  refPrefix = '';
  const emitted = new Set<string>();
  const chunks: string[] = [];

  const visit = (name: string, trail: Set<string>) => {
    if (emitted.has(name) || trail.has(name)) return;
    trail.add(name);
    const node = componentSchemas[name];
    if (!node) return;
    for (const dep of collectRefs(node)) visit(dep, trail);
    trail.delete(name);
    if (emitted.has(name)) return;
    emitted.add(name);
    chunks.push(
      `/** \`${name}\` from the EuroDNS OpenAPI document. */\n` +
        `export const ${schemaConstName(name)} = ${zodFor(node)};\n`,
    );
  };

  for (const name of Object.keys(componentSchemas).sort()) visit(name, new Set());

  return `${header()}import { z } from 'zod';\n\n${chunks.join('\n')}`;
}

function collectRefs(node: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === '$ref' && typeof value === 'string') {
        acc.add(value.slice(value.lastIndexOf('/') + 1));
      } else {
        collectRefs(value, acc);
      }
    }
  }
  return acc;
}

/* --------------------------------------------------------------- operation emission */

function riskFor(operationId: string, method: string): string {
  if (READ_ONLY_OPERATION_IDS.has(operationId)) return 'read';
  if (BILLING_OPERATION_IDS.has(operationId)) return 'billing';
  if (DESTRUCTIVE_OPERATION_IDS.has(operationId)) return 'destructive';
  return method === 'GET' ? 'read' : 'write';
}

function successResponseSchema(operation: Json): Json | undefined {
  const responses: Json = operation.responses ?? {};
  for (const code of Object.keys(responses).sort()) {
    if (!/^2\d\d$/.test(code)) continue;
    const schema = responses[code]?.content?.['application/json']?.schema;
    if (schema) return schema as Json;
  }
  return undefined;
}

function emitOperationsModule(): { source: string; count: number; tags: Set<string> } {
  refPrefix = 'S.';
  const entries: string[] = [];
  const tags = new Set<string>();
  let count = 0;

  for (const [path, item] of Object.entries<Json>(spec.paths ?? {})) {
    const sharedParams: ParameterSpec[] = (item.parameters ?? []) as ParameterSpec[];

    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation: Json | undefined = item[method];
      if (!operation) continue;

      const operationId: string = operation.operationId ?? `${method}_${path}`;
      const tag: string = operation.tags?.[0] ?? 'Default';
      tags.add(tag);
      count += 1;

      const params: ParameterSpec[] = [
        ...sharedParams,
        ...((operation.parameters ?? []) as ParameterSpec[]),
      ];
      const pathParams = params.filter((p) => p.in === 'path');
      const queryParams = params.filter((p) => p.in === 'query');
      const headerParams = params.filter(
        (p) => p.in === 'header' && !PAGINATION_HEADER_NAMES.has(p.name.toLowerCase()),
      );
      const paginated = params.some(
        (p) => p.in === 'header' && PAGINATION_HEADER_NAMES.has(p.name.toLowerCase()),
      );

      const bodySchema = operation.requestBody?.content?.['application/json']?.schema as
        Json | undefined;
      const responseSchema = successResponseSchema(operation);

      entries.push(
        [
          '  {',
          `    operationId: ${quote(operationId)},`,
          `    method: ${quote(method.toUpperCase())},`,
          `    path: ${quote(path)},`,
          `    tag: ${quote(tag)},`,
          `    summary: ${quote(flatten(operation.summary))},`,
          `    description: ${quote(flatten(operation.description))},`,
          `    risk: ${quote(riskFor(operationId, method.toUpperCase()))},`,
          `    paginated: ${paginated},`,
          `    pathParams: [${paramEntries(pathParams)}],`,
          `    queryParams: [${paramEntries(queryParams)}],`,
          `    headerParams: [${paramEntries(headerParams)}],`,
          bodySchema
            ? `    body: { required: ${operation.requestBody?.required === true}, schema: ${zodFor(bodySchema, 3)} },`
            : '    body: null,',
          responseSchema
            ? `    responseSchema: ${zodFor(responseSchema, 2)},`
            : '    responseSchema: null,',
          '  },',
        ].join('\n'),
      );
    }
  }

  const source =
    `${header()}import { z } from 'zod';\n` +
    `import * as S from './schemas.js';\n\n` +
    `${OPERATION_TYPES}\n\n` +
    `export const OPERATIONS: GeneratedOperation[] = [\n${entries.join('\n')}\n];\n\n` +
    `export const OPERATION_COUNT = ${count};\n`;

  return { source, count, tags };
}

function paramEntries(params: ParameterSpec[]): string {
  if (params.length === 0) return '';
  const rendered = params.map(
    (p) =>
      `\n      { name: ${quote(p.name)}, required: ${p.required === true}, ` +
      `description: ${quote(flatten(p.description))}, schema: ${zodFor(p.schema, 4)} },`,
  );
  return `${rendered.join('')}\n    `;
}

function flatten(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

const OPERATION_TYPES = `export type RiskClass = 'read' | 'write' | 'destructive' | 'billing';

export interface GeneratedParameter {
  name: string;
  required: boolean;
  description: string;
  schema: z.ZodTypeAny;
}

export interface GeneratedOperation {
  operationId: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  risk: RiskClass;
  /** True when the endpoint accepts the \`pagination-*\` request headers. */
  paginated: boolean;
  pathParams: GeneratedParameter[];
  queryParams: GeneratedParameter[];
  headerParams: GeneratedParameter[];
  body: { required: boolean; schema: z.ZodTypeAny } | null;
  responseSchema: z.ZodTypeAny | null;
}`;

function header(): string {
  return (
    '/* eslint-disable */\n' +
    '// Generated by scripts/gen-operations.ts from spec/openapi.json. Do not edit by hand.\n' +
    '// Run `npm run gen` after changing the OpenAPI document.\n\n'
  );
}

/* ------------------------------------------------------------------------- entrypoint */

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, 'schemas.ts'), emitSchemasModule(), 'utf8');
const { source, count, tags } = emitOperationsModule();
writeFileSync(resolve(OUT_DIR, 'operations.ts'), source, 'utf8');

process.stderr.write(
  `generated ${count} operations across ${tags.size} tags and ` +
    `${Object.keys(componentSchemas).length} schemas\n`,
);
