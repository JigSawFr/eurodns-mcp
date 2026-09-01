/**
 * Renders tool results. Large payloads are truncated with an explicit notice so an agent
 * knows the data is incomplete rather than silently reasoning on a partial list.
 */

export interface FormatResult {
  text: string;
  truncated: boolean;
}

export function formatJson(value: unknown, characterLimit: number): FormatResult {
  const pretty = JSON.stringify(value, null, 2) ?? 'null';
  if (pretty.length <= characterLimit) {
    return { text: pretty, truncated: false };
  }

  // Indentation is not information. On a list of records with nested objects — a domain
  // carries four contact blocks — pretty-printing is a large share of the payload, and it
  // is the share that buys nothing once the result is long enough that nobody reads it by
  // eye. Dropping it before dropping *data* is the right order: a whole compact answer
  // beats a truncated readable one.
  const compact = JSON.stringify(value) ?? 'null';
  if (compact.length <= characterLimit) {
    return { text: compact, truncated: false };
  }

  const kept = compact.slice(0, characterLimit);
  const omitted = compact.length - kept.length;
  return {
    text:
      `${kept}\n\n[truncated: ${omitted} of ${compact.length} characters omitted. ` +
      'Narrow the request with filters or pagination to see the rest.]',
    truncated: true,
  };
}

/**
 * Redacts a value for the audit log. Only primitives survive, and long strings are
 * reduced to a length marker — audit lines record what happened, never payload content.
 */
export function redactForAudit(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return value.length > 64 ? `<string:${value.length}>` : value;
  }
  if (Array.isArray(value)) return `<array:${value.length}>`;
  return `<object>`;
}
