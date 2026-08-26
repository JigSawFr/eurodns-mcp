/**
 * Renders tool results. Large payloads are truncated with an explicit notice so an agent
 * knows the data is incomplete rather than silently reasoning on a partial list.
 */

export interface FormatResult {
  text: string;
  truncated: boolean;
}

export function formatJson(value: unknown, characterLimit: number): FormatResult {
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  if (serialized.length <= characterLimit) {
    return { text: serialized, truncated: false };
  }

  const kept = serialized.slice(0, characterLimit);
  const omitted = serialized.length - kept.length;
  return {
    text:
      `${kept}\n\n[truncated: ${omitted} of ${serialized.length} characters omitted. ` +
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
