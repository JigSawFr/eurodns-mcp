import { z, type ZodRawShape } from 'zod';
import type { GeneratedOperation, GeneratedParameter } from '../generated/operations.js';
import { MAX_PAGE_SIZE } from '../constants.js';
import { describeBody, describeParameter } from './parameters.js';

/**
 * The input and output shapes of the generated tools.
 *
 * Kept apart from the registry because two modules build shapes from generated operations —
 * the registry for a tool that is one operation, `composites.ts` for a tool that is two —
 * and the registry imports the composites. Putting the shapes with the registry would have
 * made that import a cycle.
 */

/** `domain-name` -> `domainName`, so tool arguments read like ordinary parameters. */
export function toCamelCase(value: string): string {
  return value.replace(/[-_](.)/g, (_, c: string) => c.toUpperCase());
}

export const paginationShape: ZodRawShape = {
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      '1-based page number. There is no page meaning everything: walk pages until a short ' +
        'one comes back.',
    ),
  // No `-1` here, though the vendor's document offers it on three endpoints: the API rejects
  // it on all three, measured rather than assumed. See MAX_PAGE_SIZE. Accepting a sentinel the
  // upstream refuses would only move the failure from this schema to a 400 nobody expects.
  size: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe(
      `Results per page, 1 to ${MAX_PAGE_SIZE}. A wide page is truncated by the character ` +
        'limit, so prefer a filter to a large size.',
    ),
  sortField: z
    .string()
    .optional()
    .describe('Result field to sort on, spelled as in the response items. Unsorted when omitted.'),
  sortOrder: z.enum(['ASC', 'DESC']).optional().describe('ASC or DESC; only read with sortField.'),
};

/**
 * A permissive output schema.
 *
 * The API is known to deviate from its own document in places, so pinning
 * `structuredContent` to the generated response schema would turn a vendor-side surprise
 * into a hard tool failure. Wrapping instead gives callers reliable structured access to
 * the status and payload without asserting the payload's shape.
 */
export const outputSchema = z.object({
  status: z.number().int().describe('Upstream HTTP status code.'),
  data: z.unknown().describe('Response body as returned by the API.'),
});

/**
 * A shape being assembled.
 *
 * `ZodRawShape` is readonly from zod 4 on, so it describes a finished shape rather than one
 * under construction. Building in a mutable map and returning it as `ZodRawShape` keeps the
 * published type honest without fighting the library.
 */
export type MutableShape = { -readonly [K in keyof ZodRawShape]: ZodRawShape[K] };

/**
 * The arguments for one group of an operation's parameters, each described.
 *
 * `.describe()` on a zod 4 schema returns a described copy, so describing a schema the
 * generator shares between operations (`S.SubscriptionStatusSchema`) here leaves the
 * generated constant untouched. Nothing in `src/generated/` is ever edited.
 */
export function parameterShape(
  operation: GeneratedOperation,
  params: GeneratedParameter[],
): ZodRawShape {
  const shape: MutableShape = {};
  for (const param of params) {
    const text = describeParameter(operation, param);
    const described = text === undefined ? param.schema : param.schema.describe(text);
    shape[toCamelCase(param.name)] = param.required ? described : described.optional();
  }
  return shape;
}

/**
 * The input schema for one operation.
 *
 * Assembled as a shape from three parameter groups, then wrapped: from the 2026-07-28 SDK a
 * tool takes a Standard Schema object rather than a raw shape.
 */
export function buildInputSchema(operation: GeneratedOperation) {
  const shape: MutableShape = {
    ...parameterShape(operation, operation.pathParams),
    ...parameterShape(operation, operation.queryParams),
    ...parameterShape(operation, operation.headerParams),
  };

  if (operation.paginated) Object.assign(shape, paginationShape);

  if (operation.body) {
    const text = describeBody(operation);
    const schema =
      text === undefined ? operation.body.schema : operation.body.schema.describe(text);
    shape.body = operation.body.required ? schema : schema.optional();
  }

  return z.object(shape);
}
