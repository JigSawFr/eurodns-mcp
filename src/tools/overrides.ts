import type { GeneratedOperation } from '../generated/operations.js';

/**
 * Hand-written descriptions for the operations agents reach for most.
 *
 * The document's own summaries ("Get domain", "Search domains") do not say what an
 * operation is for or when to prefer it over its neighbour, which is exactly the decision
 * a tool description has to support. Everything not listed here falls back to the
 * document's summary and description.
 */
export const DESCRIPTION_OVERRIDES: Record<string, string> = {};

/** Strips the light HTML the document uses inside descriptions. */
function stripMarkup(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function describeOperation(operation: GeneratedOperation): string {
  const override = DESCRIPTION_OVERRIDES[operation.operationId];
  if (override) return override;

  const summary = stripMarkup(operation.summary);
  const description = stripMarkup(operation.description);

  if (summary && description) {
    return description.startsWith(summary) ? description : `${summary}. ${description}`;
  }
  return description || summary || operation.operationId;
}
